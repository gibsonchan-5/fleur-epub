// FleurEPUB — Obsidian EPUB 阅读与批注插件
// M1：骨架 + foliate-js 渲染 + 进度记忆

import { Events, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { BookStore } from './store';
import { CoverCache } from './cover-cache';
import { DEFAULT_SETTINGS, FleurEpubSettingTab, type FleurEpubSettings } from './settings';
import { EpubReaderView, VIEW_TYPE_EPUB } from './reader-view';
import { ShelfView, VIEW_TYPE_SHELF } from './shelf-view';
import {
	hydrateSecrets,
	scrubSecretsForPersistence,
	secretStorageAvailable,
	migrateSecrets,
	resolveBackend,
	type SecretBackend,
} from './secret-store';

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
		await this.loadSettings();
		this.bookStore = new BookStore(this.app, this);
		this.coverCache = new CoverCache(this.app, this);

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

	/** 打开右侧书架视图（复用已有 leaf） */
	async openShelf(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_SHELF);
		const leaf = leaves.length
			? leaves[0]
			: workspace.getRightLeaf(false);
		await leaf?.setViewState({ type: VIEW_TYPE_SHELF, state: {} });
		if (leaf) await workspace.revealLeaf(leaf);
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
		await leaf.openFile(file, { active: true });
		if ((leaf.view as EpubReaderView).getViewType() !== VIEW_TYPE_EPUB) {
			await leaf.setViewState(
				{ type: VIEW_TYPE_EPUB, state: { file: file.path } },
				{ active: true },
			);
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
