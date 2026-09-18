// FleurEPUB — Obsidian EPUB 阅读与批注插件
// M1：骨架 + foliate-js 渲染 + 进度记忆

import { Events, Notice, Platform, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { BookStore, computeFingerprint, isMainDataFileName, type BookData } from './store';
import { CoverCache } from './cover-cache';
import { DEFAULT_SETTINGS, FleurEpubSettingTab, type FleurEpubSettings } from './settings';
import { EpubReaderView, VIEW_TYPE_EPUB } from './reader-view';
import { ShelfView, VIEW_TYPE_SHELF } from './shelf-view';
import { FontLibrary } from './font-library';
import { installCompatPolyfills } from './compat';
import {
	hydrateSecrets,
	scrubSecretsForPersistence,
	secretStorageAvailable,
	migrateSecrets,
	resolveBackend,
	type SecretBackend,
} from './secret-store';
import { applyMobileBodyClass, isMobileUI } from './platform';

export default class FleurEpubPlugin extends Plugin {
	settings!: FleurEpubSettings;
	/** 本机 Obsidian 是否支持官方 SecretStorage（系统钥匙串）。 */
	secretStorageAvailable = false;

	/** 当前实际生效的密钥后端（system=钥匙串，vault=data.json 明文）。 */
	get secretBackend(): SecretBackend {
		return resolveBackend(this.app, this.settings.secretStorageMode);
	}
	bookStore!: BookStore;
	/** 书籍封面缓存（书架网格视图用） */
	coverCache!: CoverCache;
	/** 在线字体库（开源字体按需下载 / 缓存 / 注入） */
	fontLibrary!: FontLibrary;
	/** 插件内事件总线：阅读器 ↔ 侧边栏联动（批注变化 / 开书） */
	events = new Events();

	/** 批注数据变化后广播（侧边栏刷新用） */
	notifyAnnotationsChanged(): void {
		this.events.trigger('fleur-epub:annotations-changed');
	}

	/** 当前已加载书的阅读器视图（无则 null） */
	getActiveReader(): EpubReaderView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB);
		for (const leaf of leaves) {
			const view = leaf.view as EpubReaderView;
			if (view?.isBookLoaded()) return view;
		}
		return null;
	}

	async onload(): Promise<void> {
		// 旧 WebView 兼容层（Android：Array.at / replaceAll），必须最先执行
		installCompatPolyfills();
		await this.loadSettings();
		this.bookStore = new BookStore(this.app, this);
		this.coverCache = new CoverCache(this.app, this);
		this.fontLibrary = new FontLibrary(this);

		// 移动端标记类：真机移动端挂到 body，移动端样式全部限定在该作用域下（桌面端永不挂载）
		applyMobileBodyClass(this);

		// ── 移动端错误浮出（同一错误只提示一次，避免刷屏）──
		// 背景：真机开书空白且无任何报错，移动端又看不到控制台，需把错误浮到 Notice。
		// 普通使用不弹启动探针（已随「移动端调试模式」移除）；真实错误仍会浮出。
		if (Platform.isMobile) {
			const reported = new Set<string>();
			const report = (label: string, e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				const stack = e instanceof Error ? (e.stack ?? '') : '';
				// 只浮与本插件相关的错误（foliate/fleur），避免打扰其他插件
				if (!/foliate|fleur|epub/i.test(msg + stack)) return;
				if (reported.has(msg)) return;
				reported.add(msg);
				new Notice(`[FleurEPUB ${label}] ${msg}`, 8000);
			};
			window.addEventListener('error', (ev) => report('err', ev.error ?? ev.message));
			window.addEventListener('unhandledrejection', (ev) => report('promise', ev.reason));
		}

		// 指纹迁移：旧版 identifier 撞号（z-lib 通用 UUID）修复后，按新算法重命名历史数据文件
		// （数据目录跟随「跨设备同步批注数据」开关：开启后在 Vault 内，关闭时在配置目录）
		await this.migrateBookFingerprints();

		this.registerView(VIEW_TYPE_EPUB, (leaf: WorkspaceLeaf) =>
			new EpubReaderView(leaf, this),
		);

		this.registerView(VIEW_TYPE_SHELF, (leaf: WorkspaceLeaf) =>
			new ShelfView(leaf, this),
		);

		try {
			// 接管 .epub 扩展名：文件浏览器点击即用本插件的视图打开
			this.registerExtensions(['epub'], VIEW_TYPE_EPUB);
		} catch (e) {
			// 被其他插件占用时 openFile 会回退「系统默认程序打开」（Windows 上 .epub 常关联 WPS），
			// 书架点击有强制视图兜底（openInReader），这里给出可见提示帮助排查文件列表入口
			console.warn('[FleurEPUB] epub 扩展名已被其他插件占用', e);
			new Notice('FleurEPUB：.epub 扩展名已被其他插件占用，文件列表点击可能无法用内置阅读器打开', 6000);
		}
		try {
			// 部分 Windows 用户的文件扩展名是大写 .EPUB（注册表按原样匹配，需单独接管）
			this.registerExtensions(['EPUB'], VIEW_TYPE_EPUB);
		} catch {
			/* 已注册 / 已占用：忽略 */
		}

		// 左侧 ribbon：打开右侧书架
		this.addRibbonIcon('library', 'FleurEPUB 书架', () => {
			void this.openShelf();
		});

		this.addCommand({
			id: 'open-shelf',
			name: '打开书架',
			callback: () => {
				void this.openShelf();
			},
		});

		this.addCommand({
			id: 'open-active-epub',
			name: '打开当前 EPUB 文件',
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension.toLowerCase() !== 'epub') return false;
				if (!checking) void this.openEpub(file);
				return true;
			},
		});

		this.addSettingTab(new FleurEpubSettingTab(this.app, this));
	}

	/**
	 * 数据目录迁移（一次性、幂等）：把 .obsidian/plugins/fleur-epub/data 下的书数据
	 * 复制到 Vault 内普通目录（settings.dataDir，默认 FleurEpub/data）。
	 * 由设置页「跨设备同步批注数据」开关触发（用户自主选择），启动时不自动跑。
	 *
	 * 规则刻意保守，多端场景安全：
	 * - 旧目录不存在 / 为空 → 无事可做（全新用户、已迁移后清空过）；
	 * - 新目录已有 .json（另一端同步来的）→ **跳过**，绝不覆盖；
	 * - 其余 → 逐个复制（同名不覆盖）；**旧目录保留不删**——它同时是关闭开关后的回退位置。
	 */
	async migrateDataDirIntoVault(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const oldDir = `${this.app.vault.configDir}/plugins/fleur-epub/data`;
		const newDir = this.bookStore.dataDir();
		if (oldDir === newDir) return; // dataDir 为空回落旧位置时，无迁移可言
		try {
			if (!(await adapter.exists(oldDir))) return;
			const oldFiles = (await adapter.list(oldDir)).files.filter((p) => p.endsWith('.json'));
			if (!oldFiles.length) return;
			let newFiles: string[] = [];
			try {
				newFiles = (await adapter.list(newDir)).files;
			} catch {
				// 新目录还不存在 → 视为空
			}
			if (newFiles.some((p) => p.endsWith('.json'))) return; // 同步来的数据优先
			await this.ensureVaultDir(newDir);
			let copied = 0;
			for (const src of oldFiles) {
				const name = src.split('/').pop() ?? src;
				const dst = `${newDir}/${name}`;
				if (await adapter.exists(dst)) continue;
				await adapter.write(dst, await adapter.read(src));
				copied++;
			}
			console.debug('[FleurEPUB] 数据目录迁移完成', oldDir, '→', newDir, `共 ${copied} 个文件`);
		} catch (e) {
			// 迁移失败绝不阻塞启动：数据仍在旧目录，下次启动重试
			console.warn('[FleurEPUB] 数据目录迁移失败（数据仍在原位置，将在下次启动重试）', e);
		}
	}

	/** 逐级创建 Vault 内目录（adapter.mkdir 不保证递归创建） */
	private async ensureVaultDir(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const parts = path.split('/').filter(Boolean);
		let cur = '';
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
		}
	}

	/**
	 * 指纹迁移：v0.1.12 修复 identifier 撞号（不同书籍共用同一 UUID → 批注/进度跨书互串），
	 * 数据文件名由旧指纹改为新指纹。按文件内记录的 book 元信息重算新指纹：
	 * - 新旧一致 → 跳过（已迁移 / 无 identifier 书籍本就走 fallback，算法不变）
	 * - 目标文件已存在 → 保留两者（不覆盖任何数据，交由人工核对）
	 */
	private async migrateBookFingerprints(): Promise<void> {
		const adapter = this.app.vault.adapter;
		const dir = this.bookStore.dataDir();
		if (!(await adapter.exists(dir))) return;
		const list = await adapter.list(dir);
		for (const path of list.files) {
			// 只处理主文件 <指纹>.json；分域文件（<指纹>.progress.json / <指纹>.trans.json）
			// 必须先按文件名排除，否则会被当成书数据解析而在里面找 book 字段 → 每次启动报错。
			// 它们也不参与迁移：本迁移只服务 0.1.12 之前的单文件数据，早已迁移完毕。
			const name = path.split('/').pop() ?? path;
			if (!isMainDataFileName(name)) continue;
			try {
				const data = JSON.parse(await adapter.read(path)) as BookData;
				if (!data || typeof data.fingerprint !== 'string' || !data.book) continue;
				const newFp = computeFingerprint(data.book);
				if (!newFp || newFp === data.fingerprint) continue;
				const target = `${dir}/${newFp}.json`;
				if (await adapter.exists(target)) {
					console.warn('[FleurEPUB] 指纹迁移：目标文件已存在，跳过', path, '→', target);
					continue;
				}
				data.fingerprint = newFp;
				await adapter.write(target, JSON.stringify(data, null, 2));
				await adapter.remove(path);
				// console.debug：审核规则只允许 warn / error / debug（console.log 会被判为多余日志），
				// 换级别不丢信息，仍可在开发者控制台看到。
				console.debug('[FleurEPUB] 指纹迁移完成', path, '→', target);
			} catch (e) {
				console.warn('[FleurEPUB] 指纹迁移失败', path, e);
			}
		}
	}

	/** 打开书架视图：桌面进右侧栏 leaf；移动端进主区 tab（Obsidian 移动端主区即全屏，避免右栏抽屉的挤压体验） */
	async openShelf(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_SHELF);
		const leaf = leaves.length
			? leaves[0]
			: isMobileUI(this)
				? workspace.getLeaf(true)
				: workspace.getRightLeaf(false);
		await leaf?.setViewState({ type: VIEW_TYPE_SHELF, state: {} });
		if (leaf) await workspace.revealLeaf(leaf);
		// 移动端：退出书 → 直接落在书架列表（书内面板功能已由底部工具栏承担）。
		// 复用已有 shelf leaf 时 onOpen 不重跑，这里显式切换；新建视图则由 onOpen 的移动端分支兜底。
		if (isMobileUI(this) && leaf?.view instanceof ShelfView) leaf.view.forceShelfMode();
	}

	/** 用阅读器视图打开 EPUB（优先复用已存在的 leaf） */
	async openEpub(file: TFile): Promise<void> {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(VIEW_TYPE_EPUB);
		if (existing.length) {
			const leaf = existing[0];
			if ((leaf.view as EpubReaderView).file?.path === file.path) {
				await workspace.revealLeaf(leaf);
				return;
			}
			await this.openInReader(leaf, file);
			return;
		}
		await this.openInReader(workspace.getLeaf('tab'), file);
	}

	/**
	 * 在指定 leaf 用内置阅读器打开书。
	 *
	 * ⚠️ 必须校验视图类型：leaf.openFile 依赖「扩展名已接管」——.epub 注册被其他插件
	 * 占用、或文件扩展名是大写 .EPUB 时，Obsidian 会回退到「系统默认程序打开」，
	 * Windows 上 .epub 常关联 WPS → 表现为「点书架弹出 WPS」。
	 * 打开后视图不是本插件的阅读器，就强制 setViewState 切换（不再依赖扩展名注册）。
	 */
	private async openInReader(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
		try {
			await leaf.openFile(file, { active: true });
			if ((leaf.view as EpubReaderView).getViewType() !== VIEW_TYPE_EPUB) {
				await leaf.setViewState(
					{ type: VIEW_TYPE_EPUB, state: { file: file.path } },
					{ active: true },
				);
			}
		} catch (e) {
			// 移动端无法看控制台：错误浮出为 Notice（同时保留 console.error）
			const msg = e instanceof Error ? `${e.message}` : String(e);
			console.error('[FleurEPUB] 打开书籍失败', file.path, e);
			new Notice(`FleurEPUB 打开失败：${msg}`, 6000);
		}
	}

	/** 通知书架视图重绘（设置变更等场景） */
	refreshShelf(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SHELF)) {
			(leaf.view as ShelfView)?.refresh();
		}
	}

	onunload(): void {
		this.coverCache?.dispose();
		// Obsidian 会自动 detach 我们注册的视图 leaf；无需手工清理
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
		// 纯白主题已下线（与浅色几乎无差异），旧配置自动回落浅色
		if ((this.settings.theme as string) === 'white') this.settings.theme = 'light';
		// 迁移旧版单自定义提示词（customPrompt: string）→ 三槽（customPrompts: string[]）
		const legacy = (this.settings as unknown as Record<string, unknown>).customPrompt;
		if (typeof legacy === 'string' && legacy.trim()) {
			if (!(this.settings.customPrompts?.[0] ?? '').trim()) {
				this.settings.customPrompts[0] = legacy;
			}
			delete (this.settings as unknown as Record<string, unknown>).customPrompt;
		}
		// 防止共享 DEFAULT_SETTINGS 数组引用；并补齐长度
		const arr = Array.isArray(this.settings.customPrompts) ? this.settings.customPrompts : ['', '', ''];
		this.settings.customPrompts = [arr[0] ?? '', arr[1] ?? '', arr[2] ?? ''];
		// 兼容更旧的 'custom' 模式键 → custom-1
		if ((this.settings.promptPreset as string) === 'custom') {
			this.settings.promptPreset = 'custom-1';
		}

		// API Key 存入系统钥匙串；磁盘上若还留有明文，在这里迁走并清掉。
		// 用户切到 data.json 模式时则反其道行之：文件即真相，不写钥匙串。
		this.secretStorageAvailable = secretStorageAvailable(this.app);
		const secretState = await hydrateSecrets(
			this.app,
			this.settings as unknown as Record<string, unknown>,
			raw,
			this.secretBackend,
		);
		if (secretState.migrated.length > 0) {
			await this.saveSettings();
			new Notice('FleurEPUB：API Key 已移入系统钥匙串，data.json 中不再保存明文');
		}
	}

	async saveSettings(): Promise<void> {
		// 密钥只写系统钥匙串；写盘时从副本里抹掉（钥匙串不可用时保留明文，避免丢密钥）。
		// data.json 模式下原样落盘——明文正是用户的选择。
		await this.saveData(
			await scrubSecretsForPersistence(
				this.app,
				this.settings as unknown as Record<string, unknown>,
				this.secretBackend,
			),
		);
	}

	/**
	 * 切换密钥保存位置并搬迁现有密钥。
	 *
	 * 搬入钥匙串逐字段校验；任何一步写不进去就回滚到原模式，
	 * 宁可维持明文也不丢密钥。
	 */
	async setSecretStorageMode(
		mode: 'system' | 'vault',
	): Promise<{ ok: boolean; failed: string[] }> {
		const previous = this.settings.secretStorageMode;
		const target = resolveBackend(this.app, mode);

		this.settings.secretStorageMode = mode;
		const result = await migrateSecrets(
			this.app,
			this.settings as unknown as Record<string, unknown>,
			target,
		);

		if (!result.ok) {
			this.settings.secretStorageMode = previous;
			await this.saveSettings();
			return { ok: false, failed: [...result.failed] };
		}

		await this.saveSettings();
		return { ok: true, failed: [] };
	}
}
