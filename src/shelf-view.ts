// FleurEPUB 侧边栏：书架 + 书内面板（目录 / 批注 / 检索 三 tab）。
// 批注 tab 对齐 fleur-pdf 的 HiNote 风格卡片：色条 + 类型图标 + 选中文本（点击展开）
// + 悬停操作（定位 / AI 批注 / 删除）+ 批注区（内联编辑、>120 字折叠）+ 时间戳；
// 按章节分组，支持一键导出批注笔记（Markdown）。

import { ItemView, WorkspaceLeaf, Notice, TFile, debounce } from 'obsidian';
import type FleurEpubPlugin from './main';
import { HIGHLIGHT_COLORS } from './reader-view';
import { AIService } from './ai-service';
import { resolveSystemPrompt } from './ai-prompts';
import { stripMarkdown, cleanAnnotationText } from './text-utils';
import type { EpubAnnotation } from './store';

export const VIEW_TYPE_SHELF = 'fleur-epub-shelf';

type Tab = 'toc' | 'ann' | 'search';

interface SearchResultItem {
	label: string;
	excerpt: string;
	cfi: string;
}

// ── SVG 辅助（SVG 标签不在 HTMLElementTagNameMap，须 createElementNS）──

function createSvgEl(parent: Node, tag: string, attrs?: Record<string, string>): SVGElement {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	parent.appendChild(el);
	return el;
}

function appendSvg(
	container: Node,
	attrs: Record<string, string>,
	children: Array<{ tag: string; attrs: Record<string, string> }>,
): SVGElement {
	const svg = createSvgEl(container, 'svg', attrs);
	for (const child of children) createSvgEl(svg, child.tag, child.attrs);
	return svg;
}

const SVG_ATTRS = {
	width: '14',
	height: '14',
	viewBox: '0 0 24 24',
	fill: 'none',
	stroke: 'currentColor',
	'stroke-width': '2',
	'stroke-linecap': 'round',
	'stroke-linejoin': 'round',
};

/** 按背景亮度选可读前景色（导出 Markdown 高亮底色用） */
function pickReadableFg(bg: string): string {
	const hex = bg.replace('#', '');
	if (hex.length !== 3 && hex.length !== 6) return '#000';
	const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.slice(0, 2), 16);
	const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.slice(2, 4), 16);
	const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.slice(4, 6), 16);
	const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luma > 0.6 ? '#000' : '#fff';
}

/** 空白收敛为单行（EPUB 选段常带换行） */
function normalizeWhitespace(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

export class ShelfView extends ItemView {
	private mode: 'shelf' | 'book' = 'shelf';
	private tab: Tab = 'ann';
	/**
	 * 用户是否手动固定在书架模式（点过 back 按钮）。
	 * 启用后即便有书在读也保持书架模式；开新书时自动解除。
	 * 解决「shelf 错过 book-opened 事件导致一直停在书架」的问题。
	 */
	private manualShelf = false;
	private headerEl!: HTMLElement;
	private backBtn!: HTMLElement;
	private titleEl!: HTMLElement;
	private tabbarEl!: HTMLElement;
	private tabBtns: Partial<Record<Tab, HTMLElement>> = {};
	private listEl!: HTMLElement;
	private emptyEl!: HTMLElement;
	private query = '';
	private searchInputEl!: HTMLInputElement;
	private searchResults: SearchResultItem[] = [];
	private searching = false;

	constructor(leaf: WorkspaceLeaf, private plugin: FleurEpubPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SHELF;
	}
	getDisplayText(): string {
		return 'FleurEPUB';
	}
	getIcon(): string {
		return 'library';
	}

	async onOpen(): Promise<void> {
		this.buildSkeleton();

		// vault 变化自动刷新书架（防抖 300ms）
		const refreshShelf = debounce(() => {
			if (this.mode === 'shelf') this.renderShelf();
		}, 300, true);
		this.registerEvent(this.app.vault.on('create', refreshShelf));
		this.registerEvent(this.app.vault.on('delete', refreshShelf));
		this.registerEvent(this.app.vault.on('rename', refreshShelf));

		// 开书 → 切书内面板（同时解除 manualShelf 固定，回归自动跟随）
		this.registerEvent(
			this.plugin.events.on('fleur-epub:book-opened', () => {
				this.manualShelf = false;
				this.mode = 'book';
				this.renderAll();
			}),
		);
		// 批注变化 → 刷新批注 tab
		this.registerEvent(
			this.plugin.events.on('fleur-epub:annotations-changed', () => {
				if (this.mode === 'book' && this.tab === 'ann') this.renderList();
			}),
		);

		// onOpen 时根据当前 active reader 决定初始 mode（兜底：若 onOpen 之前
		// book-opened 已经触发过、shelf 错过了，同步到 book 模式）
		const active = !!this.plugin.getActiveReader();
		this.mode = active ? 'book' : 'shelf';
		this.renderAll();
	}

	/** 骨架：头部（返回 + 标题）+ tab 栏 + 列表区 */
	private buildSkeleton(): void {
		this.contentEl.empty();
		this.contentEl.addClass('fleur-epub-shelf');

		this.headerEl = createDiv('fleur-epub-shelf-header');
		this.backBtn = createSpan('fleur-epub-shelf-back');
		this.backBtn.setText('‹ 书架');
		this.backBtn.addEventListener('click', () => {
			// 用户主动固定到书架模式；新开书时 book-opened 事件会解除
			this.manualShelf = true;
			this.mode = 'shelf';
			this.renderAll();
		});
		this.headerEl.appendChild(this.backBtn);
		this.titleEl = createSpan({ text: 'FleurEPUB', cls: 'fleur-epub-shelf-title' });
		this.headerEl.appendChild(this.titleEl);
		this.contentEl.appendChild(this.headerEl);

		this.tabbarEl = createDiv('fleur-epub-shelf-tabs');
		for (const [key, label] of [['toc', '目录'], ['ann', '批注'], ['search', '检索']] as const) {
			const btn = createSpan('fleur-epub-shelf-tab');
			btn.setText(label);
			btn.addEventListener('click', () => {
				this.tab = key;
				this.renderAll();
			});
			this.tabBtns[key] = btn;
			this.tabbarEl.appendChild(btn);
		}
		this.contentEl.appendChild(this.tabbarEl);

		this.listEl = createDiv('fleur-epub-shelf-list');
		this.emptyEl = createDiv('fleur-epub-shelf-empty');
		this.contentEl.appendChild(this.listEl);
		this.contentEl.appendChild(this.emptyEl);
	}

	/** 供外部（设置页等）触发重绘 */
	refresh(): void {
		if (this.listEl) this.renderAll();
	}

	/** 封面异步就绪后的兜底重绘（防抖，避免多本书同时就绪触发风暴） */
	private queueRedraw = debounce(() => {
		if (this.mode === 'shelf') this.renderShelf();
	}, 200, true);

	private renderAll(): void {
		// 同步 mode 状态：
		// ① 没书在读 → 强制 shelf
		// ② 用户手动固定 shelf（点过 back） → 保持 shelf
		// ③ 否则 → 自动跟随（active reader 在则 book）
		const active = !!this.plugin.getActiveReader();
		if (!active) this.manualShelf = false;
		this.mode = this.manualShelf ? 'shelf' : active ? 'book' : 'shelf';

		this.backBtn.toggle(this.mode === 'book');
		this.titleEl.setText(
			this.mode === 'book' ? this.plugin.getActiveReader()?.getDisplayText() ?? '' : '书架',
		);
		this.tabbarEl.toggle(this.mode === 'book');
		for (const [key, btn] of Object.entries(this.tabBtns)) {
			btn?.toggleClass('is-active', this.tab === (key as Tab));
		}
		if (this.mode === 'shelf') this.renderShelf();
		else this.renderList();
	}

	// ── 书架 ──

	private renderShelf(): void {
		this.listEl.empty();
		this.listEl.toggle(true);
		this.emptyEl.toggle(false);
		const files = this.app.vault
			.getFiles()
			.filter((f) => f.extension === 'epub')
			.filter((f) => !this.query || f.basename.toLowerCase().includes(this.query))
			.sort((a, b) => a.basename.localeCompare(b.basename));

		// 有书在读时，书架顶部显示「继续阅读」入口（用户点 back 停在书架后的回路）
		if (!this.query) this.renderReadingEntry();

		if (files.length === 0) {
			this.emptyEl.toggle(true);
			this.emptyEl.setText(this.query ? '没有匹配的书。' : 'vault 中还没有 EPUB 文件。\n把 .epub 放进任意文件夹后会自动出现在这里。');
			return;
		}

		for (const file of files) this.renderBookRow(file);
	}

	/** 点击书架条目的统一入口：正在读的书直接回书内面板，其余交给 openEpub */
	private openShelfItem(file: TFile): void {
		const reader = this.plugin.getActiveReader();
		if (reader?.getLoadedFilePath() === file.path) {
			// 正在读的书：显示阅读器 leaf 并切回书内面板（目录 / 批注 / 检索）
			this.manualShelf = false;
			this.mode = 'book';
			this.renderAll();
			void this.plugin.openEpub(file);
			return;
		}
		void this.plugin.openEpub(file);
	}

	/** 书架顶部「继续阅读」条目（仅当有书在读且无搜索词时显示） */
	private renderReadingEntry(): void {
		const reader = this.plugin.getActiveReader();
		const path = reader?.getLoadedFilePath() ?? null;
		const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
		if (!reader || !(file instanceof TFile)) return;

		const entry = createDiv('fleur-epub-shelf-reading');
		const label = entry.createSpan({ text: '继续阅读', cls: 'fleur-epub-shelf-reading-label' });
		label.createSpan({ text: '›', cls: 'fleur-epub-shelf-reading-arrow' });
		entry.createSpan({ text: reader.getDisplayText(), cls: 'fleur-epub-shelf-reading-name' });
		entry.addEventListener('click', () => {
			this.manualShelf = false;
			this.mode = 'book';
			this.renderAll();
			void this.plugin.openEpub(file);
		});
		this.listEl.appendChild(entry);
	}

	/** 列表行：小封面缩略图 + 书名 + 路径 */
	private renderBookRow(file: TFile): void {
		const item = createDiv('fleur-epub-shelf-item');
		const thumb = item.createDiv('fleur-epub-shelf-thumb');
		const text = item.createDiv('fleur-epub-shelf-item-text');
		const name = text.createSpan({ text: file.basename, cls: 'fleur-epub-shelf-item-name' });
		const path = text.createSpan({ text: file.parent?.path ?? '', cls: 'fleur-epub-shelf-item-path' });

		const cached = this.plugin.coverCache?.peek(file);
		if (cached?.url) {
			thumb.addClass('is-loaded');
			thumb.style.backgroundImage = `url("${cached.url}")`;
		}
		if (cached) name.setText(cached.title || file.basename);
		else {
			void this.plugin.coverCache
				?.get(file)
				.then((info) => {
					if (!item.isConnected) {
						if (this.mode === 'shelf' && this.plugin.coverCache?.peek(file)) this.queueRedraw();
						return;
					}
					if (info.url) {
						thumb.addClass('is-loaded');
						thumb.style.backgroundImage = `url("${info.url}")`;
					}
					if (info.title) name.setText(info.title);
				})
				.catch(() => {});
		}

		item.addEventListener('click', () => this.openShelfItem(file));
		this.listEl.appendChild(item);
	}

	// ── 书内面板（目录 / 批注 / 检索）──

	private renderList(): void {
		this.listEl.empty();
		// 从书架网格切回书内面板时，必须摘掉 is-grid（92px 网格列会把批注卡挤成竖条）
		this.listEl.removeClass('is-grid');
		this.listEl.toggle(true);
		this.emptyEl.toggle(false);
		if (this.tab === 'toc') this.renderTOC();
		else if (this.tab === 'ann') this.renderAnnotations();
		else this.renderSearch();
	}

	private renderTOC(): void {
		const reader = this.plugin.getActiveReader();
		const toc = reader?.getTOC() ?? [];
		if (toc.length === 0) {
			this.emptyEl.toggle(true);
			this.emptyEl.setText('这本书没有目录信息。');
			return;
		}
		for (const item of toc) {
			const row = createDiv('fleur-epub-toc-item');
			row.addClass(`depth-${Math.min(item.depth, 3)}`);
			row.setText(item.label || '（无标题）');
			row.addEventListener('click', () => void reader?.goToTarget(item.href));
			this.listEl.appendChild(row);
		}
	}

	// ════════ 批注 tab（HiNote 风格，对齐 fleur-pdf）════════

	private renderAnnotations(): void {
		const reader = this.plugin.getActiveReader();
		const list = reader?.getAnnotations() ?? [];

		// 面板头：标题 + 数量徽章 + 导出笔记
		const head = createDiv('fleur-epub-ann-panel-head');
		const titleWrap = createDiv('fleur-epub-ann-panel-title-wrap');
		titleWrap.createSpan({ text: '批注', cls: 'fleur-epub-ann-panel-title' });
		titleWrap.createSpan({ text: `${list.length}`, cls: 'fleur-epub-ann-panel-count' });
		head.appendChild(titleWrap);
		const exportBtn = createEl('button', 'fleur-epub-ann-export-btn');
		exportBtn.setAttribute('aria-label', '导出所有批注为笔记');
		appendSvg(exportBtn, SVG_ATTRS, [
			{ tag: 'path', attrs: { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' } },
			{ tag: 'polyline', attrs: { points: '14 2 14 8 20 8' } },
			{ tag: 'line', attrs: { x1: '12', y1: '18', x2: '12', y2: '12' } },
			{ tag: 'polyline', attrs: { points: '9 15 12 18 15 15' } },
		]);
		exportBtn.createSpan({ text: ' 导出笔记' });
		exportBtn.addEventListener('click', () => void this.exportNotes());
		head.appendChild(exportBtn);
		this.listEl.appendChild(head);

		if (list.length === 0) {
			this.emptyEl.toggle(true);
			this.emptyEl.setText('还没有批注。\n在正文里划选文字，用工具条上的色点高亮、✎ 写批注。');
			return;
		}

		// 按章节分组（组序 = 首条批注出现顺序；对位 fleur-pdf 的按页分组）
		const grouped = new Map<string, EpubAnnotation[]>();
		for (const ann of list) {
			const key = ann.chapterLabel?.trim() || '未命名章节';
			if (!grouped.has(key)) grouped.set(key, []);
			grouped.get(key)!.push(ann);
		}

		for (const [chapter, items] of grouped) {
			const section = createDiv('fleur-epub-ann-section');
			const tag = createDiv('fleur-epub-ann-section-tag');
			tag.setText(chapter);
			section.appendChild(tag);
			// 组内按创建时间先后
			items
				.slice()
				.sort((a, b) => a.createdAt - b.createdAt)
				.forEach((ann) => this.renderAnnotationCard(section, ann));
			this.listEl.appendChild(section);
		}
	}

	/** 单条批注卡片（色条 + 类型图标 + 选中文本 + 悬停操作 + 批注区 + 时间戳） */
	private renderAnnotationCard(parent: HTMLElement, ann: EpubAnnotation): void {
		const card = parent.createDiv('fleur-epub-card');

		// 顶部色条
		const bar = card.createDiv('fleur-epub-card-bar');
		bar.setCssProps({ '--fleur-bar-color': HIGHLIGHT_COLORS[ann.color] ?? HIGHLIGHT_COLORS.yellow });

		const main = card.createDiv('fleur-epub-card-main');

		// 选中文本行（带悬停操作）
		const row = main.createDiv('fleur-epub-card-row');

		// 类型图标：高亮 = 笔；直线/波浪 = 下划线
		const typeIcon = row.createDiv('fleur-epub-card-type-icon');
		if (ann.kind === 'highlight') {
			appendSvg(typeIcon, SVG_ATTRS, [
				{ tag: 'path', attrs: { d: 'M12 20h9' } },
				{ tag: 'path', attrs: { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' } },
			]);
		} else {
			appendSvg(typeIcon, SVG_ATTRS, [
				{ tag: 'path', attrs: { d: 'M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3' } },
				{ tag: 'line', attrs: { x1: '4', y1: '21', x2: '20', y2: '21' } },
			]);
		}

		// 选中文本：默认 3 行截断，点击展开/收起
		const textWrap = row.createDiv('fleur-epub-card-text-wrap');
		const textEl = textWrap.createDiv('fleur-epub-card-text');
		textEl.textContent = normalizeWhitespace(ann.text);
		textEl.setAttribute('title', '点击查看完整内容');
		textEl.addEventListener('click', () => textEl.toggleClass('is-expanded', !textEl.hasClass('is-expanded')));

		// 批注区：有批注显示文本 + 悬停编辑/删除；无批注显示「+ 添加批注」入口
		const slot = main.createDiv('fleur-epub-comment-slot');
		slot.dataset['slotFor'] = ann.id;
		if (ann.comment) this.renderCommentDisplay(slot, ann);
		else this.renderAddCommentHint(slot, ann);

		// 悬停操作：定位 / AI 批注 / 删除
		const actions = row.createDiv('fleur-epub-card-actions');

		const locateBtn = actions.createEl('button', 'fleur-epub-icon-btn');
		locateBtn.title = '定位到原文';
		appendSvg(locateBtn, SVG_ATTRS, [
			{ tag: 'path', attrs: { d: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z' } },
			{ tag: 'circle', attrs: { cx: '12', cy: '10', r: '3' } },
		]);
		locateBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const r = this.plugin.getActiveReader();
			if (r) void r.locateAnnotation(ann.cfi);
		});

		const aiBtn = actions.createEl('button', 'fleur-epub-icon-btn');
		aiBtn.title = 'AI 生成批注';
		appendSvg(aiBtn, SVG_ATTRS, [
			{ tag: 'path', attrs: { d: 'M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22' } },
			{ tag: 'path', attrs: { d: 'M12 2a4 4 0 0 0-4 4c0 1.95 1.4 3.58 3.25 3.93' } },
			{ tag: 'path', attrs: { d: 'M8 6h8' } },
			{ tag: 'path', attrs: { d: 'M9 10h6' } },
			{ tag: 'path', attrs: { d: 'M10 14h4' } },
			{ tag: 'path', attrs: { d: 'M11 18h2' } },
		]);
		aiBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.generateAIComment(ann, slot);
		});

		const delBtn = actions.createEl('button', 'fleur-epub-icon-btn is-danger');
		delBtn.title = '删除标注';
		appendSvg(delBtn, SVG_ATTRS, [
			{ tag: 'line', attrs: { x1: '18', y1: '6', x2: '6', y2: '18' } },
			{ tag: 'line', attrs: { x1: '6', y1: '6', x2: '18', y2: '18' } },
		]);
		delBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			const r = this.plugin.getActiveReader();
			if (r) void r.eraseAnnotation(ann);
		});

		// 时间戳
		const footer = main.createDiv('fleur-epub-card-footer');
		footer.textContent = new Date(ann.createdAt).toLocaleString('zh-CN');
	}

	/** 批注显示：纯文本（去 MD 源码）+ 长批注折叠 + 悬停编辑/删除 */
	private renderCommentDisplay(slot: HTMLElement, ann: EpubAnnotation): void {
		slot.empty();
		const wrap = slot.createDiv('fleur-epub-comment-display');
		const text = wrap.createDiv('fleur-epub-comment-text');
		const plain = ann.comment ? cleanAnnotationText(normalizeWhitespace(ann.comment)) : '';
		text.textContent = plain;

		// 按「实际渲染行数」折叠：超过 3 行（与 CSS line-clamp 一致）才显示展开/收起。
		// 不能按字符数判定——窄侧边栏里 120 字符早已十多行，会导致长批注整段铺开。
		window.requestAnimationFrame(() => {
			if (!text.isConnected) return;
			const lineH = parseFloat(getComputedStyle(text).lineHeight) || 18;
			if (text.scrollHeight > lineH * 3 + 2) {
				text.addClass('is-clamped');
				const toggle = wrap.createDiv({ text: '展开全文', cls: 'fleur-epub-comment-toggle' });
				toggle.addEventListener('click', () => {
					if (text.hasClass('is-clamped')) {
						text.removeClass('is-clamped');
						toggle.textContent = '收起';
					} else {
						text.addClass('is-clamped');
						toggle.textContent = '展开全文';
					}
				});
			}
		});

		const ops = wrap.createDiv('fleur-epub-comment-ops');
		const editBtn = ops.createEl('button', 'fleur-epub-comment-ops-btn');
		editBtn.title = '编辑批注';
		appendSvg(editBtn, { ...SVG_ATTRS, width: '12', height: '12' }, [
			{ tag: 'path', attrs: { d: 'M12 20h9' } },
			{ tag: 'path', attrs: { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' } },
		]);
		editBtn.addEventListener('click', () => this.openCommentEditor(slot, ann, true));

		const delCommentBtn = ops.createEl('button', 'fleur-epub-comment-ops-btn is-danger');
		delCommentBtn.title = '删除批注（保留高亮）';
		appendSvg(delCommentBtn, { ...SVG_ATTRS, width: '12', height: '12' }, [
			{ tag: 'polyline', attrs: { points: '3 6 5 6 21 6' } },
			{ tag: 'path', attrs: { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' } },
		]);
		delCommentBtn.addEventListener('click', () => {
			const r = this.plugin.getActiveReader();
			if (r) void r.updateAnnotationComment(ann.id, undefined).then(() => new Notice('已删除批注', 1500));
			this.renderAddCommentHint(slot, ann);
		});
	}

	/** 无批注时的「+ 添加批注」低调入口 */
	private renderAddCommentHint(slot: HTMLElement, ann: EpubAnnotation): void {
		slot.empty();
		const hint = slot.createDiv('fleur-epub-add-hint');
		appendSvg(hint, { ...SVG_ATTRS, width: '12', height: '12' }, [
			{ tag: 'line', attrs: { x1: '12', y1: '5', x2: '12', y2: '19' } },
			{ tag: 'line', attrs: { x1: '5', y1: '12', x2: '19', y2: '12' } },
		]);
		hint.createSpan({ text: ' 添加批注' });
		hint.addEventListener('click', () => this.openCommentEditor(slot, ann, false));
	}

	/** 批注区切换为内联 textarea 编辑器（Enter 保存 / Esc 取消） */
	private openCommentEditor(slot: HTMLElement, ann: EpubAnnotation, isEdit: boolean): void {
		slot.empty();
		const wrap = slot.createDiv('fleur-epub-editor-wrap');
		const textarea = wrap.createEl('textarea', 'fleur-epub-editor-textarea');
		textarea.value = ann.comment ?? '';
		textarea.placeholder = '写批注…';

		const btnRow = wrap.createDiv('fleur-epub-editor-btn-row');
		if (isEdit) {
			const cancelBtn = btnRow.createEl('button', { text: '取消', cls: 'fleur-epub-editor-btn is-cancel' });
			cancelBtn.addEventListener('click', () => this.renderCommentDisplay(slot, ann));
			const delBtn = btnRow.createEl('button', { text: '删除批注', cls: 'fleur-epub-editor-btn is-danger' });
			delBtn.addEventListener('click', () => {
				const r = this.plugin.getActiveReader();
				if (r) void r.updateAnnotationComment(ann.id, undefined);
				this.renderAddCommentHint(slot, ann);
			});
		}
		const saveBtn = btnRow.createEl('button', { text: '保存', cls: 'fleur-epub-editor-btn is-save' });
		saveBtn.addEventListener('click', () => {
			const val = textarea.value.trim();
			if (!val) {
				new Notice('批注不能为空');
				return;
			}
			ann.comment = val;
			const r = this.plugin.getActiveReader();
			if (r) void r.updateAnnotationComment(ann.id, val);
			this.renderCommentDisplay(slot, ann);
			new Notice('批注已保存', 1500);
		});

		textarea.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				saveBtn.click();
			}
			if (e.key === 'Escape') {
				if (isEdit) this.renderCommentDisplay(slot, ann);
				else this.renderAddCommentHint(slot, ann);
			}
		});

		window.setTimeout(() => textarea.focus(), 30);
	}

	/** AI 生成批注：流式写入批注区，完成后保存（提示词/字数限制与 fleur-pdf 同源） */
	private async generateAIComment(ann: EpubAnnotation, slot: HTMLElement): Promise<void> {
		if (!this.plugin.settings.apiKey) {
			new Notice('请先在设置中配置 AI API Key');
			return;
		}
		slot.empty();
		const loading = slot.createDiv('fleur-epub-ai-loading');
		loading.createDiv('fleur-epub-ai-spinner');
		loading.createDiv({ text: 'AI 正在生成批注…', cls: 'fleur-epub-ai-loading-text' });
		const streamEl = loading.createDiv('fleur-epub-ai-stream');

		const systemPrompt = resolveSystemPrompt(this.plugin.settings.promptPreset, this.plugin.settings.customPrompts, {
			applyLimit: true,
			sourceTextLength: ann.text.length,
			baseLimit: this.plugin.settings.annotationLimit,
		});

		const ai = new AIService(this.plugin);
		const full: string[] = [];
		await ai.streamChat(
			[
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: `请为以下选段写一条批注：\n\n${ann.text}` },
			],
			(chunk) => {
				full.push(chunk);
				streamEl.textContent += chunk;
			},
			() => {
				// 存储前清洗：去 Markdown 标记 + 去「批注：×××」标题行（批注内容不出现原文）
				const val = cleanAnnotationText(full.join('').trim());
				if (!val) {
					new Notice('AI 未返回内容');
					this.renderAddCommentHint(slot, ann);
					return;
				}
				ann.comment = val;
				const r = this.plugin.getActiveReader();
				if (r) void r.updateAnnotationComment(ann.id, val);
				this.renderCommentDisplay(slot, ann);
				new Notice('AI 批注已生成', 1500);
			},
			(err) => {
				new Notice(`AI 生成失败：${err}`, 4000);
				this.renderAddCommentHint(slot, ann);
			},
		);
	}

	/** 导出批注笔记（Markdown，按章节分组；同名自动覆盖，与 fleur-pdf 一致） */
	private async exportNotes(): Promise<void> {
		const reader = this.plugin.getActiveReader();
		const list = reader?.getAnnotations() ?? [];
		if (!reader) {
			new Notice('请先打开一本书');
			return;
		}
		if (list.length === 0) {
			new Notice('当前书没有批注可导出');
			return;
		}

		const noteName = `${reader.getDisplayText()} - 批注笔记`;
		// 导出文件夹（设置项，默认 FleurEpub；'' = vault 根目录）— fleur-pdf 同款逻辑
		const folder = this.plugin.settings.noteFolder?.trim() || '';
		const notePath = folder ? `${folder}/${noteName}.md` : `${noteName}.md`;

		try {
			// 确保导出文件夹存在（默认 FleurEpub，首次导出自动创建）
			if (folder) {
				const folderExists = await this.app.vault.adapter.exists(folder);
				if (!folderExists) await this.app.vault.createFolder(folder);
			}

			const exists = await this.app.vault.adapter.exists(notePath);
			if (exists) {
				const existing = this.app.vault.getAbstractFileByPath(notePath);
				if (existing) await this.app.vault.trash(existing, false);
			}

			let md = `> 导出时间：${new Date().toLocaleString('zh-CN')}\n\n`;
			const grouped = new Map<string, EpubAnnotation[]>();
			for (const ann of list) {
				const key = ann.chapterLabel?.trim() || '未命名章节';
				if (!grouped.has(key)) grouped.set(key, []);
				grouped.get(key)!.push(ann);
			}
			for (const [chapter, items] of grouped) {
				md += `## ${chapter}\n\n`;
				for (const ann of items) {
					const t = normalizeWhitespace(ann.text);
					const color = HIGHLIGHT_COLORS[ann.color] ?? HIGHLIGHT_COLORS.yellow;
					if (ann.kind === 'highlight') {
						const fg = pickReadableFg(color);
						md += `<span style="background-color:${color};color:${fg};padding:0 2px;border-radius:2px">${t}</span>\n\n`;
					} else {
						const style = ann.kind === 'wavy' ? 'wavy' : 'solid';
						md += `<span style="text-decoration:underline;text-decoration-color:${color};text-decoration-style:${style}">${t}</span>\n\n`;
					}
					if (ann.comment) md += `> ${cleanAnnotationText(normalizeWhitespace(ann.comment))}\n\n`;
					md += `---\n\n`;
				}
			}

			await this.app.vault.create(notePath, md);
			new Notice('笔记已导出', 2000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`导出失败：${msg}`);
		}
	}

	// ── 检索 tab ──

	private renderSearch(): void {
		const reader = this.plugin.getActiveReader();
		if (!reader) {
			this.emptyEl.toggle(true);
			this.emptyEl.setText('没有正在阅读的书。');
			return;
		}

		const box = createDiv('fleur-epub-search-box');
		this.searchInputEl = createEl('input', {
			type: 'text',
			placeholder: '在本书中检索…（回车执行）',
			cls: 'fleur-epub-shelf-search-input',
		});
		this.searchInputEl.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void this.doSearch();
			}
		});
		box.appendChild(this.searchInputEl);
		this.listEl.appendChild(box);

		const progressEl = createDiv('fleur-epub-search-progress');
		this.listEl.appendChild(progressEl);

		const resultsEl = createDiv('fleur-epub-search-results');
		this.listEl.appendChild(resultsEl);

		if (this.searchResults.length) {
			progressEl.setText(`共 ${this.searchResults.length} 条结果`);
			for (const r of this.searchResults) this.appendSearchRow(resultsEl, r);
		} else {
			this.searchInputEl.focus();
		}
	}

	private appendSearchRow(resultsEl: HTMLElement, r: SearchResultItem): void {
		const row = createDiv('fleur-epub-search-item');
		if (r.label) {
			const label = createDiv('fleur-epub-search-label');
			label.setText(r.label);
			row.appendChild(label);
		}
		const excerpt = createDiv('fleur-epub-search-excerpt');
		excerpt.setText(r.excerpt);
		row.appendChild(excerpt);
		const reader = this.plugin.getActiveReader();
		row.addEventListener('click', () => void reader?.goToTarget(r.cfi));
		resultsEl.appendChild(row);
	}

	private async doSearch(): Promise<void> {
		const reader = this.plugin.getActiveReader();
		const q = this.searchInputEl?.value.trim();
		if (!reader || !q || this.searching) return;
		this.searching = true;
		this.searchResults = [];

		const resultsEl = this.contentEl.getElementsByClassName('fleur-epub-search-results')[0] as HTMLElement | undefined;
		const progressEl = this.contentEl.getElementsByClassName('fleur-epub-search-progress')[0] as HTMLElement | undefined;
		if (resultsEl) resultsEl.empty();
		if (progressEl) progressEl.setText('检索中…');

		try {
			await reader.runSearch(
				q,
				(label, excerpt, cfi) => {
					this.searchResults.push({ label, excerpt, cfi });
					if (progressEl) progressEl.setText(`已找到 ${this.searchResults.length} 条…`);
					if (resultsEl) {
						const row = createDiv('fleur-epub-search-item');
						if (label) {
							const l = createDiv('fleur-epub-search-label');
							l.setText(label);
							row.appendChild(l);
						}
						const ex = createDiv('fleur-epub-search-excerpt');
						ex.setText(excerpt);
						row.appendChild(ex);
						row.addEventListener('click', () => void this.plugin.getActiveReader()?.goToTarget(cfi));
						resultsEl.appendChild(row);
					}
				},
				(p) => {
					if (progressEl && this.searchResults.length === 0) {
						progressEl.setText(`检索中… ${Math.round(p * 100)}%`);
					}
				},
			);
			if (progressEl) {
				progressEl.setText(this.searchResults.length ? `共 ${this.searchResults.length} 条结果` : '没有找到匹配内容。');
			}
		} catch (err) {
			console.warn('[FleurEPUB] 检索失败', err);
			if (progressEl) progressEl.setText('检索失败，请查看控制台。');
		} finally {
			this.searching = false;
		}
	}

	async onClose(): Promise<void> {
		const reader = this.plugin.getActiveReader();
		if (this.searchResults.length) reader?.clearBookSearch();
		this.contentEl.empty();
	}
}
