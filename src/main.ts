// FleurEPUB — Obsidian EPUB 阅读与批注插件
// M1：骨架 + foliate-js 渲染 + 进度记忆

import { Events, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { BookStore } from './store';
import { CoverCache } from './cover-cache';
import { DEFAULT_SETTINGS, FleurEpubSettingTab, type FleurEpubSettings } from './settings';
import { EpubReaderView, VIEW_TYPE_EPUB } from './reader-view';
import { ShelfView, VIEW_TYPE_SHELF } from './shelf-view';

export default class FleurEpubPlugin extends Plugin {
	settings!: FleurEpubSettings;
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
			console.warn('[FleurEPUB] epub 扩展名已被其他插件占用', e);
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
				if (!file || file.extension !== 'epub') return false;
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
			await leaf.openFile(file, { active: true });
			return;
		}
		await workspace.getLeaf('tab').openFile(file, { active: true });
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
