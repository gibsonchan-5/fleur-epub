// FleurEPUB — Obsidian EPUB 阅读与批注插件
// M1：骨架 + foliate-js 渲染 + 进度记忆

import { Events, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { BookStore } from './store';
import { DEFAULT_SETTINGS, FleurEpubSettingTab, type FleurEpubSettings } from './settings';
import { EpubReaderView, VIEW_TYPE_EPUB } from './reader-view';
import { ShelfView, VIEW_TYPE_SHELF } from './shelf-view';

export default class FleurEpubPlugin extends Plugin {
	settings!: FleurEpubSettings;
	bookStore!: BookStore;
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
		this.addRibbonIcon('book-open', 'FleurEPUB 书架', () => {
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

	onunload(): void {
		// Obsidian 会自动 detach 我们注册的视图 leaf；无需手工清理
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
