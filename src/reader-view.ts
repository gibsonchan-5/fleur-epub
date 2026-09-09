// EPUB 阅读器视图：foliate-view 自定义元素嵌入 Obsidian leaf。
// 阅读体验对齐微信读书 / Apple Books：
//   - 排版：衬线正文 + 完整标题层级，setStyles 注入（foliate 每章加载后自动重注入）
//   - 双模式：滚动 / 翻页（paginator 的 flow 属性，可随时切换）
//   - 翻页模式：右击下一页、左击上一页（点按区域，不干扰选段），支持方向键
// 继承 FileView：registerExtensions 接管 .epub 后，Obsidian 打开文件时回调 onLoadFile。

import { FileView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import type FleurEpubPlugin from './main';
import { computeFingerprint, type BookData, type BookMeta, type EpubAnnotation, type AnnotationKind } from './store';
import { Overlayer } from '../vendor/foliate-js/overlayer.js';
import { AIChatPanel } from './ai-chat-modal';
import type { ReaderTheme } from './settings';
import '../vendor/foliate-js/view.js';

export const VIEW_TYPE_EPUB = 'fleur-epub-view';

/** 左右点按翻页的区域宽度占比（与微信读书一致的左右各 ~38%） */
const ZONE_RATIO = 0.38;

/** 标注颜色（键持久化到书数据；值用于 overlayer 绘制） */
export const HIGHLIGHT_COLORS: Record<string, string> = {
	yellow: '#f2c14e',
	green: '#7bc47f',
	blue: '#64a6e8',
	pink: '#ef8a8a',
	purple: '#ab8de8',
};

/** 阅读主题色板：章节文档（setStyles 注入）与宿主侧（CSS 变量）共用同一套值 */
export const READER_THEMES: Record<ReaderTheme, {
	label: string; bg: string; text: string; muted: string; border: string;
	link: string; hover: string; selection: string; codeBg: string; chrome: string;
}> = {
	light: {
		label: '浅色', bg: '#fcfbf7', text: '#262421', muted: '#6b686a',
		border: 'rgba(0,0,0,.13)', link: '#3a6ea5', hover: 'rgba(0,0,0,.045)',
		selection: 'rgba(90,140,200,.22)', codeBg: 'rgba(0,0,0,.05)', chrome: '#fffdf9',
	},
	dark: {
		label: '深色', bg: '#191817', text: '#c9c7c2', muted: '#9b9891',
		border: 'rgba(255,255,255,.14)', link: '#7aa7d8', hover: 'rgba(255,255,255,.07)',
		selection: 'rgba(90,140,200,.35)', codeBg: 'rgba(255,255,255,.07)', chrome: '#1e1d1c',
	},
	sepia: {
		label: '暖黄', bg: '#f6ecd7', text: '#463c2c', muted: '#8a7c60',
		border: 'rgba(120,90,40,.22)', link: '#9a6b1f', hover: 'rgba(120,90,40,.08)',
		selection: 'rgba(180,120,40,.25)', codeBg: 'rgba(120,90,40,.08)', chrome: '#f4e9d2',
	},
	green: {
		label: '豆绿', bg: '#e7efe4', text: '#2e3b2e', muted: '#6d7f6c',
		border: 'rgba(60,90,60,.22)', link: '#3f7050', hover: 'rgba(0,0,0,.05)',
		selection: 'rgba(70,130,80,.25)', codeBg: 'rgba(60,90,60,.08)', chrome: '#e3ece0',
	},
};

/** 预置字体（macOS 系统自带为主，值为完整 CSS font-family 栈；'' = 默认宋体栈） */
const PRESET_FONTS: Array<{ label: string; stack: string }> = [
	{ label: '默认 · 宋体', stack: '' },
	{ label: '宋体 — Songti SC', stack: '"Songti SC", "STSong", "SimSun", serif' },
	{ label: '苹方 — PingFang SC', stack: '"PingFang SC", "Helvetica Neue", sans-serif' },
	{ label: '楷体 — Kaiti SC', stack: '"Kaiti SC", "STKaiti", "KaiTi", serif' },
	{ label: '仿宋 — STFangsong', stack: '"STFangsong", "FangSong", serif' },
	{ label: '黑体 — Heiti SC', stack: '"Heiti SC", "STHeiti", "SimHei", sans-serif' },
	{ label: '圆体 — Yuanti SC', stack: '"Yuanti SC", "HYYaKu", sans-serif' },
	{ label: '兰亭黑 — Lantinghei SC', stack: '"Lantinghei SC", "PingFang SC", sans-serif' },
	{ label: '手札体 — Hannotate SC', stack: '"Hannotate SC", "Kaiti SC", cursive' },
	{ label: '行楷 — Xingkai SC', stack: '"Xingkai SC", "Kaiti SC", cursive' },
	{ label: '等宽 — Menlo', stack: 'Menlo, "SF Mono", monospace' },
	{ label: 'Georgia', stack: 'Georgia, "Times New Roman", serif' },
	{ label: 'Helvetica Neue', stack: '"Helvetica Neue", Arial, sans-serif' },
	{ label: 'Times New Roman', stack: '"Times New Roman", Times, serif' },
];

/** 本机字体扫描结果缓存（本次会话内有效） */
let scannedFonts: string[] = [];

export class EpubReaderView extends FileView {
	private foliateView: any = null;
	private bookData: BookData | null = null;
	private fingerprint = '';
	private saveTimer: number | null = null;
	private percentEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private readerEl!: HTMLElement;
	private modeBtnScroll!: HTMLElement;
	private modeBtnPage!: HTMLElement;
	private loadedPath: string | null = null;
	// ── 标注引擎状态 ──
	private lastMouseHost = { x: 0, y: 0 };
	private selToolbar: HTMLElement | null = null;
	private annPopup: HTMLElement | null = null;
	/** 批注卡片的全局关闭监听清理函数（外点 / Esc） */
	private annPopupClose: (() => void) | null = null;
	private currentSelDoc: Document | null = null;
	private selSnapshot = '';

	constructor(leaf: WorkspaceLeaf, private plugin: FleurEpubPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_EPUB;
	}
	getDisplayText(): string {
		return this.file ? this.file.basename : 'FleurEPUB';
	}
	getIcon(): string {
		return 'book-open';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('fleur-epub-root');

		// 顶栏：书名 · 居中；右侧：模式切换 + 进度
		const bar = createDiv('fleur-epub-bar');
		this.titleEl = createSpan('fleur-epub-title');
		const right = createDiv('fleur-epub-bar-right');

		const seg = createDiv('fleur-epub-mode-seg');
		this.modeBtnScroll = createSpan('fleur-epub-mode-btn');
		this.modeBtnScroll.setText('滚动');
		this.modeBtnPage = createSpan('fleur-epub-mode-btn');
		this.modeBtnPage.setText('翻页');
		this.modeBtnScroll.addEventListener('click', () => this.setFlow('scrolled'));
		this.modeBtnPage.addEventListener('click', () => this.setFlow('paginated'));
		seg.appendChild(this.modeBtnScroll);
		seg.appendChild(this.modeBtnPage);

		this.percentEl = createSpan('fleur-epub-percent');

		// Aa 阅读外观按钮（微信读书式：字号/行距/段距/页边距/背景主题/字体）
		const aaBtn = createSpan('fleur-epub-bar-btn');
		aaBtn.setText('Aa');
		aaBtn.setAttribute('aria-label', '阅读外观');
		aaBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleAppearancePanel(aaBtn);
		});

		right.appendChild(aaBtn);
		right.appendChild(seg);
		right.appendChild(this.percentEl);
		bar.appendChild(this.titleEl);
		bar.appendChild(right);

		this.readerEl = createDiv('fleur-epub-reader');
		this.contentEl.appendChild(bar);
		this.contentEl.appendChild(this.readerEl);

		// 宿主侧键盘翻页（焦点在宿主时生效；iframe 内的由 bindDocEvents 覆盖）
		this.contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
			this.handleKey(e);
		});

		// 宿主侧滚轮：短章节时 iframe 高度只有内容高（可能不足一屏），
		// iframe 下方空白区的滚轮不会进入 iframe 文档，若不在此接住就会「卡住滚不动」。
		// iframe 内的滚轮不会冒泡出 iframe，两侧监听天然互补、不会重复触发。
		this.registerDomEvent(
			this.readerEl,
			'wheel',
			(e: WheelEvent) => this.onReaderWheel(e),
			{ passive: false },
		);
	}

	/** Obsidian 打开 .epub 文件时的入口 */
	async onLoadFile(file: TFile): Promise<void> {
		// 同一文件已加载则跳过（leaf 复用 / 重渲染场景）
		if (this.loadedPath === file.path && this.foliateView) return;
		await this.teardownBook();
		this.readerEl.empty();
		await this.loadBook(file);
	}

	async onUnloadFile(_file: TFile): Promise<void> {
		// 切走文件前把进度落盘
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.closeAppearancePanel();
		if (this.bookData) await this.plugin.bookStore.save(this.bookData);
	}

	private async loadBook(file: TFile): Promise<void> {
		try {
			const bytes = await this.app.vault.readBinary(file);
			// foliate-js makeBook 直接接受 File 对象（内部走 vendor/zip.js 解压）
			const fileObj = new File([bytes], file.name, { type: 'application/epub+zip' });

			this.readerEl.empty();

			const view = this.foliateView = document.createElement('foliate-view') as any;

			view.addEventListener('relocate', (e: CustomEvent) => {
				const d = e.detail ?? {};
				const percent = typeof d.fraction === 'number' ? Math.round(d.fraction * 100) : undefined;
				if (percent !== undefined) this.percentEl.setText(`${percent}%`);
				this.scheduleSaveProgress(d.cfi, percent);
			});

			// 每章文档加载完成：绑定 iframe 内交互 + 重新挂载全部标注
			//（foliate 只在 overlayer 上持有当前章节的标注，翻章即失效，需每次重挂；
			//  addAnnotation 内部解析 CFI，非当前章节自动跳过，全部重挂开销可忽略）
			view.addEventListener('load', (e: CustomEvent) => {
				const doc = e.detail?.doc as Document | undefined;
				if (doc) {
					this.bindDocEvents(doc);
					// 清掉书内自带的 title 属性：许多 EPUB 在正文节点上带
					// pagenumber 之类的 title，悬停会弹原生灰条提示，干扰阅读
					doc.querySelectorAll('[title]').forEach((el) => el.removeAttribute('title'));
				}
				if (this.bookData) {
					for (const a of this.bookData.annotations) {
						void view.addAnnotation({ value: a.cfi, ...a }).catch(() => {});
					}
				}
			});

			// 标注绘制：按 kind 分发到 overlayer 的三种画法（对齐 fleur-pdf 高亮/划线/波浪线）
			view.addEventListener('draw-annotation', (e: CustomEvent) => {
				const { draw, annotation } = e.detail ?? {};
				const a = annotation as EpubAnnotation & { value: string };
				const color = HIGHLIGHT_COLORS[a?.color ?? 'yellow'] ?? HIGHLIGHT_COLORS.yellow;
				if (a?.kind === 'underline') draw(Overlayer.underline, { color, width: 2 });
				else if (a?.kind === 'wavy') draw(Overlayer.squiggly, { color, width: 1.4 });
				else draw(Overlayer.highlight, { color });
			});

			// 点击 / 侧边栏定位标注 → 批注卡片（优先用标注 range 定位，避免依赖陈旧鼠标坐标）
			// 仅展示有批注内容的标注：纯高亮/划线点击不弹窗（微信读书式，换色与删除走侧边栏）
			view.addEventListener('show-annotation', (e: CustomEvent) => {
				const { value, range } = e.detail ?? {};
				const ann = this.bookData?.annotations.find((x) => x.cfi === value);
				if (!ann?.comment) return;
				let host = this.lastMouseHost;
				const doc = range?.startContainer?.ownerDocument as Document | undefined;
				if (doc && typeof range.getClientRects === 'function') {
					const rects = (Array.from(range.getClientRects() as DOMRectList) as DOMRect[])
						.filter((r) => r.width > 0 || r.height > 0);
					const rect = rects[0];
					if (rect) host = this.toHostCoords(doc, rect.left, rect.bottom);
				}
				this.showAnnotationPopup(ann, host.x, host.y);
			});

			// 翻页 / 滚动时收起全部浮层
			view.addEventListener('relocate', () => {
				this.hideSelectionToolbar();
				this.hideAnnPopup();
				// 滚动模式章节接力：新章节上屏后，把接力期间累积的滚轮位移一次性补滚，
				// 让跨章滚动连成一体（这是消除「过章卡一下」的关键）
				if (this.pendingChain) {
					const p = this.pendingChain;
					this.pendingChain = null;
					if (this.chainFailTimer !== null) {
						window.clearTimeout(this.chainFailTimer);
						this.chainFailTimer = null;
					}
					const r = this.foliateView?.renderer;
					if (r && typeof r.scrollBy === 'function' && p.acc > 0) {
						window.setTimeout(() => {
							try {
								// 补滚量扣除补滚前用户已原生滚过的部分，避免把已滚动的位置往回拽（顿挫感）
								const cur = typeof r.start === 'number' ? r.start : 0;
								let delta = p.dir * p.acc;
								if (p.dir === 1) delta = Math.max(0, p.acc - cur);
								else {
									const top = (typeof r.viewSize === 'number' ? r.viewSize : 0) - (typeof r.size === 'number' ? r.size : 0);
									// 反向：新章锚定在末尾（start≈viewSize-size），用户可能已向上滚过
									delta = Math.min(0, top - p.acc - cur);
								}
								if (delta !== 0) r.scrollBy(0, delta);
							} catch { /* 滚动失败忽略 */ }
						}, 60);
					}
				}
			});

			this.readerEl.appendChild(view);
			await view.open(fileObj);

			// 阅读模式与翻页动画
			this.applyFlow();

			// 排版：衬线正文 + 标题层级 + 段落节奏（微信读书 / Apple Books 风格）
			this.applyReaderStyles();

			// 元信息 → 书指纹 → 恢复进度
			const meta: BookMeta = {
				title: view.book?.metadata?.title,
				creator: view.book?.metadata?.author ?? view.book?.metadata?.creator,
				language: view.book?.metadata?.language,
				identifier: view.book?.metadata?.identifier,
			};
			this.fingerprint = computeFingerprint(meta);
			this.bookData =
				(await this.plugin.bookStore.load(this.fingerprint)) ?? {
					fingerprint: this.fingerprint,
					book: meta,
					progress: {},
					annotations: [],
				};
			this.bookData.book = meta;

			this.titleEl.setText(meta.title ?? file.basename);

			const cfi = this.bookData.progress?.cfi;
			if (cfi) {
				try {
					await view.goTo(cfi);
				} catch {
					new Notice('上次阅读位置无法恢复，已回到开头', 3000);
					await view.init({ lastLocation: undefined });
				}
			} else {
				await view.init({ lastLocation: undefined });
			}

			this.loadedPath = file.path;
			this.plugin.events.trigger('fleur-epub:book-opened');
			console.log(`[FleurEPUB] 已打开：${file.basename}（指纹 ${this.fingerprint}）`);
		} catch (err) {
			console.error('[FleurEPUB] 打开 EPUB 失败', err);
			new Notice('EPUB 打开失败，请查看控制台', 4000);
			this.readerEl.empty();
			this.readerEl
				.createDiv('fleur-epub-error')
				.setText('无法打开此 EPUB 文件。可能文件损坏或格式不受支持。');
		}
	}

	/** 应用阅读模式（滚动 / 翻页）：设置 renderer 属性并刷新分段控件状态 */
	private applyFlow(): void {
		const flow = this.plugin.settings.flow;
		const renderer = this.foliateView?.renderer;
		if (renderer) {
			renderer.setAttribute('flow', flow);
			// 翻页模式启用平滑翻页动画
			if (flow === 'paginated') renderer.setAttribute('animated', '');
			else renderer.removeAttribute('animated');
			this.applyColumnLayout();
		}
		this.modeBtnScroll.toggleClass('is-active', flow === 'scrolled');
		this.modeBtnPage.toggleClass('is-active', flow === 'paginated');
	}

	/** 应用分栏设置（翻页模式）：max-column-count 1 = 单栏 2 = 双栏；设置页变更时即时调用 */
	applyColumnLayout(): void {
		const renderer = this.foliateView?.renderer;
		if (!renderer) return;
		const count = this.plugin.settings.flow === 'paginated' ? this.plugin.settings.columns : 1;
		renderer.setAttribute('max-column-count', String(count));
	}

	/** 切换阅读模式（顶栏分段控件） */
	private setFlow(flow: 'scrolled' | 'paginated'): void {
		if (this.plugin.settings.flow === flow) return;
		this.plugin.settings.flow = flow;
		void this.plugin.saveSettings();
		this.applyFlow();
	}

	/** 排版样式：注入章节文档（foliate 在每次章节加载后自动重注入 setStyles） */
	applyReaderStyles(): void {
		// 宿主侧顶栏 / 阅读区底色随主题联动
		this.contentEl.setAttribute('data-reader-theme', this.plugin.settings.theme);
		const renderer = this.foliateView?.renderer;
		if (renderer?.setStyles) renderer.setStyles(this.buildTypographyCss());
		// 页边距：foliate observed attribute（滚动/翻页两种 flow 均生效，设置即重排）
		if (renderer) renderer.setAttribute('margin', `${this.plugin.settings.pageMargin}px`);
	}

	/** 微信读书 / Apple Books 风格排版 CSS（fontSize 为根字号，其余全 em 缩放） */
	private buildTypographyCss(): string {
		const s = this.plugin.settings;
		const fontSize = s.fontSize;
		const t = READER_THEMES[s.theme] ?? READER_THEMES.light;
		const dark = s.theme === 'dark';
		const bodyFont = s.fontFamily || '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", Georgia, "Times New Roman", serif';
		// 合成字重：多数中文字体（含大量 EPUB 内嵌字体）只提供「常规 / 粗」两个字面，
		// 单靠 font-weight 时 300 与 500 都回退到 400，档位看不出差别。
		// 这里叠加 -webkit-text-stroke 做笔画增减：细档用背景色侵蚀笔画变细，
		// 中/粗档用文字色描边加粗（实测 Chromium 下墨色随档位单调递增）。
		const w = s.fontWeight;
		const synthStroke = w < 400
			? `-webkit-text-stroke: 0.0075em ${t.bg};`
			: w === 500
				? `-webkit-text-stroke: 0.018em ${t.text};`
				: w > 500
					? `-webkit-text-stroke: 0.012em ${t.text};`
					: '';
		return `
			html { font-size: ${fontSize}px; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; --overlayer-highlight-opacity: .32; --overlayer-highlight-blend-mode: ${dark ? 'screen' : 'multiply'}; }
			body {
				font-family: ${bodyFont};
				font-weight: ${w};
				${synthStroke}
				line-height: ${s.lineHeight};
				letter-spacing: .01em;
				color: ${t.text};
				background: ${t.bg} !important;
				text-align: justify;
				word-break: break-word;
			}
			/* 正文段落：两字首行缩进 + 可调段距（微信读书中文排版惯例） */
			p { margin: 0 0 ${s.paraSpacing}em; text-indent: 2em; }
			/* 标题层级：章节题醒目，小节题收敛 */
			h1, h2, h3, h4, h5, h6 {
				font-weight: ${w >= 700 ? 900 : 700};
				line-height: 1.45;
				text-align: left;
				color: ${t.text};
			}
			h1 { font-size: 1.55em; margin: 2.4em 0 1.4em; letter-spacing: .02em; }
			h2 { font-size: 1.3em; margin: 2em 0 1.1em; }
			h3 { font-size: 1.12em; margin: 1.7em 0 .9em; }
			h4, h5, h6 { font-size: 1em; margin: 1.5em 0 .8em; }
			/* 章首元素（往往是标题）上方不要大空白：由阅读区顶部留白统一控制 */
			body > :first-child, body > *:first-child { margin-top: 0 !important; }
			/* 引用：Apple Books 式左线 */
			blockquote {
				margin: 1.2em 0;
				padding: .1em 0 .1em 1em;
				border-left: 3px solid ${t.border};
				color: ${t.muted};
			}
			blockquote p { text-indent: 0; }
			/* 列表 */
			ul, ol { margin: 0 0 1em; padding-left: 1.6em; }
			li { margin: .3em 0; }
			li p { text-indent: 0; margin: 0 0 .3em; }
			/* 图片与表格 */
			img, svg, video { max-width: 100%; height: auto; }
			table {
				border-collapse: collapse;
				margin: 1.2em auto;
				font-size: .92em;
				line-height: 1.6;
			}
			th, td { padding: .4em .8em; border: 1px solid ${t.border}; }
			/* 分隔线：居中短线（微信读书式） */
			hr {
				border: none;
				border-top: 1px solid ${t.border};
				width: 42%;
				margin: 2.2em auto;
			}
			/* 链接与强调 */
			a { color: ${t.link}; text-decoration: none; }
			em, i { font-style: italic; }
			strong, b { font-weight: 700; }
			/* 代码 */
			code, pre, kbd, samp {
				font-family: "SF Mono", Menlo, Consolas, monospace;
				font-size: .88em;
			}
			pre {
				margin: 1.1em 0;
				padding: .8em 1em;
				background: ${t.codeBg};
				border-radius: 6px;
				overflow-x: auto;
				line-height: 1.6;
			}
			pre code { background: transparent; padding: 0; }
			code { background: ${t.codeBg}; padding: .1em .35em; border-radius: 4px; }
			/* 角注 */
			sup, sub { line-height: 0; }
			/* 链接/按钮等交互元素不做首行缩进 */
			a, button { text-indent: 0; }
			::selection { background: ${t.selection}; }
		`;
	}

	/** 给章节文档绑定 iframe 内交互：点按翻页 + 滚轮翻页 + 键盘翻页 */
	private bindDocEvents(doc: Document): void {
		// 点击书内区域 → 收起外观面板（iframe 内的点击不会冒泡到主文档，
		// 主文档上的外点关闭监听收不到，必须在这里补一层）
		doc.addEventListener('mousedown', () => {
			if (this.appearPanel) this.closeAppearancePanel();
		}, true);
		doc.addEventListener('click', (e: MouseEvent) => {
			// 点击命中已有标注 → 交给 foliate 的 show-annotation 弹批注卡片，不翻页
			const entry = (this.foliateView?.renderer?.getContents?.() ?? []).find((c: any) => c.doc === doc);
			if (entry?.overlayer) {
				const [hit] = entry.overlayer.hitTest({ x: e.clientX, y: e.clientY });
				if (hit) return;
			}
			// 点击空白处收起浮层
			this.hideSelectionToolbar();
			this.hideAnnPopup();
			if (this.plugin.settings.flow !== 'paginated') return;
			const target = e.target as HTMLElement;
			// 交互元素放行：链接 / 按钮 / 可点击元素
			if (target.closest('a, button, [role="button"], input, textarea, select, video, audio')) return;
			// 有选段时不翻页（避免破坏用户复制意图）
			const sel = doc.getSelection();
			if (sel && !sel.isCollapsed) return;
			// 关键：翻页模式下 foliate 直接平移 iframe（容器 scrollLeft 恒 0），
			// 点击的 clientX 是内容坐标，须换算回可视窗口内的相对位置：
			// 用 iframe 元素（同源可取 frameElement）在宿主中的盒子反推可视区间。
			let rel = 0.5;
			const fe = doc.defaultView?.frameElement as HTMLElement | null;
			const hostBox = this.readerEl.getBoundingClientRect();
			const feBox = fe?.getBoundingClientRect();
			if (feBox && feBox.width > 0) {
				const visStart = Math.max(0, hostBox.left - feBox.left);
				const visEnd = Math.min(feBox.width, hostBox.right - feBox.left);
				if (visEnd > visStart) rel = (e.clientX - visStart) / (visEnd - visStart);
			} else {
				// 兜底：renderer 记账坐标（start = 可视窗末的内容坐标、size = 可视宽）
				const r = this.foliateView?.renderer;
				const size = typeof r?.size === 'number' ? r.size : 0;
				const start = typeof r?.start === 'number' ? r.start : 0;
				if (size > 0) rel = (e.clientX - start) / size + 1;
			}
			if (rel > 1 - ZONE_RATIO) void this.foliateView?.next();
			else if (rel < ZONE_RATIO) void this.foliateView?.prev();
		});

		// 翻页模式：滚轮 / 触摸板横滑 → 翻页（微信读书行为）
		// 滚动模式：到章末继续向下滚 → 自动接力下一章；章首向上滚 → 上一章末尾
		//（foliate-js 每次只加载一个章节，无法真·全书连续滚动，用接力模拟连续体验；
		//  接力加载窗口内的滚轮位移会被累积，新章节上屏后一次性补滚，消除「卡住」死区）
		// 同一处理器同时服务 iframe 文档（bindDocEvents）与宿主容器（短章节空白区）。
		doc.addEventListener('wheel', (e: WheelEvent) => this.onReaderWheel(e), { passive: false });

		doc.addEventListener('keydown', (e: KeyboardEvent) => this.handleKey(e));

		// 选段结束 → 弹出选择工具条（mouseup 后选区才稳定）
		doc.addEventListener('mouseup', (e: MouseEvent) => {
			this.lastMouseHost = this.toHostCoords(doc, e.clientX, e.clientY);
			window.setTimeout(() => {
				const sel = doc.getSelection();
				if (sel && !sel.isCollapsed && sel.rangeCount > 0) this.showSelectionToolbar(doc);
			}, 10);
		});

		// 右键：有选段 → 工具条（命中标注则附加擦除项）；无选段命中标注 → 弹「清除」菜单（不直接擦除）；否则走浏览器默认菜单
		doc.addEventListener('contextmenu', (e: MouseEvent) => {
			const host = this.toHostCoords(doc, e.clientX, e.clientY);
			this.lastMouseHost = host;
			const entry = (this.foliateView?.renderer?.getContents?.() ?? []).find((c: any) => c.doc === doc);
			const [hitValue] = entry?.overlayer ? entry.overlayer.hitTest({ x: e.clientX, y: e.clientY }) : [];
			const hitAnn = hitValue ? this.bookData?.annotations.find((x) => x.cfi === hitValue) : undefined;
			const sel = doc.getSelection();
			if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
				e.preventDefault();
				this.showSelectionToolbar(doc, hitAnn ? [hitAnn] : []);
				return;
			}
			if (hitAnn) {
				// 右键命中标注 → 弹出「清除标注」菜单（对齐 fleur-pdf：给出明确选项，不直接擦除）
				e.preventDefault();
				this.showClearAnnotationMenu(host.x, host.y, [hitAnn]);
			}
		});
	}

	/** 滚轮手势 → 翻页：小位移累积、过阈值触发、触发后冷却（防触摸板惯性连翻） */
	private wheelAcc = 0;
	private wheelLastAt = 0;
	private wheelCoolUntil = 0;
	/** 滚动模式章节接力：进行中的接力方向与累积滚轮位移（新章节 relocate 后一次性补滚） */
	private pendingChain: { dir: 1 | -1; acc: number } | null = null;
	/** 接力兜底计时：relocate 迟迟不来时解除累积状态，避免滚轮永久失效 */
	private chainFailTimer: number | null = null;

	/** 滚轮处理总入口（iframe 文档与宿主容器共用，见 onOpen / bindDocEvents） */
	private onReaderWheel(e: WheelEvent): void {
		if (this.plugin.settings.flow === 'paginated') {
			e.preventDefault();
			this.handleWheelGesture(e.deltaY >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX);
			return;
		}
		const r = this.foliateView?.renderer;
		if (!r || typeof r.viewSize !== 'number' || typeof r.end !== 'number') return;
		if (this.pendingChain) {
			// 接力加载中：累积位移，等 relocate（新章节上屏）后补滚
			this.pendingChain.acc = Math.min(this.pendingChain.acc + Math.abs(e.deltaY), 1600);
			e.preventDefault();
			return;
		}
		const atBottom = r.viewSize - r.end <= 2;
		const atTop = r.start <= 2;
		if (e.deltaY > 0 && atBottom) {
			e.preventDefault();
			this.startChain(1);
			void this.foliateView?.next();
		} else if (e.deltaY < 0 && atTop) {
			e.preventDefault();
			this.startChain(-1);
			void this.foliateView?.prev();
		}
		// 其余情况不拦截：交给浏览器在滚动容器内原生滚动
	}

	private startChain(dir: 1 | -1): void {
		this.pendingChain = { dir, acc: 0 };
		if (this.chainFailTimer !== null) window.clearTimeout(this.chainFailTimer);
		this.chainFailTimer = window.setTimeout(() => {
			this.pendingChain = null;
			this.chainFailTimer = null;
		}, 4000);
	}

	private handleWheelGesture(delta: number): void {
		const now = Date.now();
		if (now < this.wheelCoolUntil) return;
		if (now - this.wheelLastAt > 300) this.wheelAcc = 0;
		this.wheelLastAt = now;
		this.wheelAcc += delta;
		if (Math.abs(this.wheelAcc) < 80) return;
		const forward = this.wheelAcc > 0;
		this.wheelAcc = 0;
		this.wheelCoolUntil = now + 650;
		if (forward) void this.foliateView?.next();
		else void this.foliateView?.prev();
	}

	/** 键盘翻页（宿主与 iframe 共用） */
	private handleKey(e: KeyboardEvent): void {
		if (this.plugin.settings.flow !== 'paginated') return;
		switch (e.key) {
			case 'ArrowRight':
			case 'PageDown':
			case ' ':
				e.preventDefault();
				void this.foliateView?.next();
				break;
			case 'ArrowLeft':
			case 'PageUp':
				e.preventDefault();
				void this.foliateView?.prev();
				break;
		}
	}

	// ════════ 标注引擎（M2）：选段 → CFI → overlayer 绘制 → 书数据持久化 ════════

	/** iframe 内视口坐标 → 宿主视口坐标（同源 frameElement 平移；翻页模式下 iframe 被横移时依然成立） */
	private toHostCoords(doc: Document, x: number, y: number): { x: number; y: number } {
		const fe = doc.defaultView?.frameElement as HTMLElement | null;
		if (!fe) return { x, y };
		const r = fe.getBoundingClientRect();
		return { x: r.left + x, y: r.top + y };
	}

	private saveBookData(): void {
		if (this.bookData) void this.plugin.bookStore.save(this.bookData);
	}

	/** 在当前选段上创建标注（选段 doc 由工具条记录，避免弹层期间选区漂移） */
	private async createAnnotation(kind: AnnotationKind, color: string): Promise<EpubAnnotation | null> {
		const doc = this.currentSelDoc;
		const sel = doc?.getSelection();
		if (!doc || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		const text = sel.toString();
		const entry = (this.foliateView?.renderer?.getContents?.() ?? []).find((c: any) => c.doc === doc);
		if (!entry) return null;
		let cfi: string;
		try {
			cfi = this.foliateView.getCFI(entry.index, range);
		} catch (err) {
			console.warn('[FleurEPUB] 生成 CFI 失败', err);
			new Notice('标注创建失败', 3000);
			return null;
		}
		const ann: EpubAnnotation = {
			id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			cfi,
			text,
			kind,
			color,
			createdAt: Date.now(),
		};
		this.bookData?.annotations.push(ann);
		try {
			// 绘制并取章节标题（addAnnotation 返回 { index, label }）
			const res = await this.foliateView.addAnnotation({ value: cfi, ...ann });
			if (res?.label) ann.chapterLabel = res.label;
		} catch (err) {
			console.warn('[FleurEPUB] 标注绘制失败', err);
		}
		this.saveBookData();
		this.plugin.notifyAnnotationsChanged();
		new Notice(kind === 'highlight' ? '已高亮' : kind === 'wavy' ? '已加波浪线' : '已划线', 1600);
		return ann;
	}

	private async deleteAnnotation(ann: EpubAnnotation): Promise<void> {
		try {
			await this.foliateView?.deleteAnnotation({ value: ann.cfi });
		} catch { /* 忽略移除异常 */ }
		const list = this.bookData?.annotations;
		if (list) {
			const i = list.findIndex((x) => x.id === ann.id);
			if (i >= 0) list.splice(i, 1);
		}
		this.saveBookData();
		this.plugin.notifyAnnotationsChanged();
		new Notice('已删除标注', 1500);
	}

	// ── 选择工具条：高亮五色 / 划线 / 波浪线 / 复制 / AI ──

	private showSelectionToolbar(doc: Document, eraseTargets: EpubAnnotation[] = []): void {
		const sel = doc.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
		const text = sel.toString();
		if (!text.trim()) return;
		this.hideAnnPopup();
		this.hideSelectionToolbar();
		this.currentSelDoc = doc;
		this.selSnapshot = text;

		const rect = sel.getRangeAt(0).getBoundingClientRect();
		const host = this.toHostCoords(doc, rect.left, rect.top);

		const bar = document.body.createDiv('fleur-epub-selbar');
		this.selToolbar = bar;

		const press = (el: HTMLElement) => el.addEventListener('mousedown', (e) => e.preventDefault());

		// 高亮五色
		for (const [key, color] of Object.entries(HIGHLIGHT_COLORS)) {
			const dot = bar.createSpan('fleur-epub-selbar-dot');
			dot.setCssStyles({ background: color });
			dot.setAttribute('aria-label', '高亮');
			press(dot);
			dot.addEventListener('click', () => {
				void this.createAnnotation('highlight', key);
				this.hideSelectionToolbar();
			});
		}
		bar.createDiv('fleur-epub-selbar-sep');

		const mkBtn = (label: string, title: string, fn: () => void) => {
			const b = bar.createSpan('fleur-epub-selbar-btn');
			b.setText(label);
			b.setAttribute('aria-label', title);
			press(b);
			b.addEventListener('click', () => {
				fn();
				this.hideSelectionToolbar();
			});
			return b;
		};
		mkBtn('U', '划线（直线）', () => void this.createAnnotation('underline', 'blue'));
		mkBtn('~', '划线（波浪线）', () => void this.createAnnotation('wavy', 'purple'));
		mkBtn('✎', '批注', () => {
			void this.createAnnotation('highlight', 'yellow').then((ann) => {
				if (ann) this.showAnnotationPopup(ann, host.x, host.y, true);
			});
		});
		bar.createDiv('fleur-epub-selbar-sep');
		mkBtn('⧉', '复制选段', () => {
			void navigator.clipboard.writeText(this.selSnapshot).then(() => new Notice('已复制', 1500));
		});
		mkBtn('AI', 'AI 解释', () => {
			new AIChatPanel(this.plugin, this.selSnapshot, 'explain').open(host.x, host.y);
		});
		mkBtn('译', '翻译', () => {
			new AIChatPanel(this.plugin, this.selSnapshot, 'translate').open(host.x, host.y);
		});

		// 右键处命中已有标注 → 工具条附加擦除项（对齐 fleur-pdf：清除项进右键菜单，不直接擦除）
		if (eraseTargets.length > 0) {
			bar.createDiv('fleur-epub-selbar-sep');
			mkBtn('⌫', '擦除标注', () => {
				for (const ann of eraseTargets) void this.deleteAnnotation(ann);
			});
		}

		// 定位：选段上方居中；顶部放不下换到下方
		window.requestAnimationFrame(() => {
			const bw = bar.offsetWidth;
			const bh = bar.offsetHeight;
			let left = host.x + rect.width / 2 - bw / 2;
			let top = host.y - bh - 8;
			left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
			if (top < 8) top = host.y + rect.height + 8;
			bar.setCssStyles({ left: `${left}px`, top: `${top}px` });
		});
	}

	private hideSelectionToolbar(): void {
		if (this.selToolbar) {
			this.selToolbar.remove();
			this.selToolbar = null;
		}
		this.currentSelDoc = null;
	}

	// ── 阅读外观面板（Aa）：主题 / 字体 / 字号 / 行距 / 段距 / 页边距 ──

	private appearPanel: HTMLElement | null = null;
	private appearPanelClose: (() => void) | null = null;

	private toggleAppearancePanel(anchor: HTMLElement): void {
		if (this.appearPanel) {
			this.closeAppearancePanel();
			return;
		}
		const s = this.plugin.settings;
		const panel = document.body.createDiv('fleur-epub-appear');
		this.appearPanel = panel;

		// 行构造器：左侧标签、右侧控件
		const mkRow = (label: string) => {
			const row = panel.createDiv('fleur-epub-appear-row');
			row.createSpan('fleur-epub-appear-label').setText(label);
			return row;
		};
		const persist = () => {
			void this.plugin.saveSettings();
			this.applyReaderStyles();
		};

		// ── 背景主题：四色圆形 swatch ──
		const themeRow = mkRow('背景');
		themeRow.addClass('is-themes');
		for (const [key, t] of Object.entries(READER_THEMES)) {
			const sw = themeRow.createDiv('fleur-epub-appear-swatch');
			sw.setAttribute('aria-label', t.label);
			sw.setCssStyles({ background: t.bg });
			if (s.theme === key) sw.addClass('is-active');
			sw.addEventListener('click', () => {
				s.theme = key as ReaderTheme;
				persist();
				themeRow.findAll('.fleur-epub-appear-swatch').forEach((d) => d.removeClass('is-active'));
				sw.addClass('is-active');
			});
		}

		// ── 字体：预置 + 本机扫描 + 自定义输入 ──
		const fontRow = mkRow('字体');
		const fontSel = fontRow.createEl('select', 'fleur-epub-appear-select dropdown');
		const fillFontOptions = () => {
			fontSel.empty();
			for (const f of PRESET_FONTS) {
				const opt = document.createElement('option');
				opt.value = f.stack;
				opt.textContent = f.label;
				fontSel.appendChild(opt);
			}
			if (scannedFonts.length) {
				const group = document.createElement('optgroup');
				group.label = '本机字体';
				for (const name of scannedFonts) {
					const opt = document.createElement('option');
					opt.value = `"${name}"`;
					opt.textContent = name;
					group.appendChild(opt);
				}
				fontSel.appendChild(group);
			}
			// 当前值不在选项里（如自定义输入过）→ 追加一项保持选中态
			if (s.fontFamily && !Array.from(fontSel.options).some((o) => o.value === s.fontFamily)) {
				const opt = document.createElement('option');
				opt.value = s.fontFamily;
				opt.textContent = `自定义 · ${s.fontFamily.replace(/"/g, '')}`;
				fontSel.appendChild(opt);
			}
			fontSel.value = s.fontFamily;
		};
		fillFontOptions();
		fontSel.addEventListener('change', () => {
			s.fontFamily = fontSel.value;
			persist();
		});
		const scanBtn = fontRow.createEl('button', 'fleur-epub-appear-mini');
		scanBtn.setText('扫描本机');
		scanBtn.addEventListener('click', async () => {
			const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string; fullName: string }>> }).queryLocalFonts;
			if (typeof q !== 'function') {
				new Notice('当前环境不支持枚举本机字体，可在下方直接输入字体名', 2500);
				return;
			}
			try {
				const fonts = await q.call(window);
				const seen = new Set<string>();
				scannedFonts = [];
				for (const f of fonts) {
					if (!seen.has(f.family) && scannedFonts.length < 400) {
						seen.add(f.family);
						scannedFonts.push(f.family);
					}
				}
				scannedFonts.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
				fillFontOptions();
				new Notice(`已载入 ${scannedFonts.length} 个本机字体`, 1500);
			} catch {
				new Notice('获取本机字体失败，可在下方直接输入字体名', 2500);
			}
		});
		const customRow = mkRow('自定义字体');
		const customInput = customRow.createEl('input', 'fleur-epub-appear-input text-input');
		customInput.setAttr('placeholder', '输入字体名，如 LanPingFang');
		customInput.addEventListener('change', () => {
			const v = customInput.value.trim();
			s.fontFamily = v ? `"${v}"` : '';
			fillFontOptions();
			persist();
		});

		// ── 字号：− 值 ＋ 步进器（按 A− → 数值 → A＋ 顺序创建） ──
		const sizeRow = mkRow('字号');
		const mkStepBtn = (text: string, fn: () => void) => {
			const b = sizeRow.createEl('button', 'fleur-epub-appear-mini');
			b.setText(text);
			b.addEventListener('click', fn);
			return b;
		};
		const renderSize = () => sizeVal.setText(`${s.fontSize}`);
		mkStepBtn('A−', () => {
			s.fontSize = Math.max(12, s.fontSize - 1);
			renderSize();
			persist();
		});
		const sizeVal = sizeRow.createSpan('fleur-epub-appear-value');
		mkStepBtn('A＋', () => {
			s.fontSize = Math.min(32, s.fontSize + 1);
			renderSize();
			persist();
		});
		renderSize();

		// ── 字重：细 / 常规 / 中等 / 粗 档位 ──
		const weightRow = mkRow('字重');
		const WEIGHTS: Array<{ v: number; label: string }> = [
			{ v: 300, label: '细' },
			{ v: 400, label: '常规' },
			{ v: 500, label: '中等' },
			{ v: 700, label: '粗' },
		];
		const weightBtns: HTMLElement[] = [];
		const renderWeight = () =>
			weightBtns.forEach((x, i) => x.toggleClass('is-active', WEIGHTS[i].v === s.fontWeight));
		for (const w of WEIGHTS) {
			const b = weightRow.createEl('button', 'fleur-epub-appear-mini is-weight');
			b.setText(w.label);
			// 按钮文字本身按该档字重渲染，选中前即可预览效果
			b.setCssStyles({ fontWeight: String(w.v) });
			b.addEventListener('click', () => {
				s.fontWeight = w.v;
				renderWeight();
				persist();
			});
			weightBtns.push(b);
		}
		renderWeight();

		// ── 行距 / 段距 / 页边距：滑杆 + 数值 ──
		const mkSlider = (
			label: string, min: number, max: number, step: number,
			get: () => number, set: (v: number) => void, fmt: (v: number) => string,
		) => {
			const row = mkRow(label);
			const slider = row.createEl('input', 'fleur-epub-appear-range');
			slider.setAttr('type', 'range');
			slider.setAttr('min', String(min));
			slider.setAttr('max', String(max));
			slider.setAttr('step', String(step));
			slider.setAttr('value', String(get()));
			const val = row.createSpan('fleur-epub-appear-value');
			val.setText(fmt(get()));
			slider.addEventListener('input', () => {
				const v = parseFloat(slider.value);
				set(v);
				val.setText(fmt(v));
				persist();
			});
		};
		mkSlider('行距', 1.4, 2.6, 0.05, () => s.lineHeight, (v) => (s.lineHeight = v), (v) => v.toFixed(2));
		mkSlider('段距', 0, 2, 0.05, () => s.paraSpacing, (v) => (s.paraSpacing = v), (v) => `${v.toFixed(2)}em`);
		mkSlider('页边距', 0, 80, 4, () => s.pageMargin, (v) => (s.pageMargin = v), (v) => `${v}px`);

		// ── 重置 ──
		const resetRow = panel.createDiv('fleur-epub-appear-row is-reset');
		const resetBtn = resetRow.createEl('button', 'fleur-epub-appear-mini');
		resetBtn.setText('恢复默认排版');
		resetBtn.addEventListener('click', () => {
			s.fontSize = 16;
			s.lineHeight = 1.9;
			s.paraSpacing = 0.85;
			s.pageMargin = 36;
			s.fontFamily = '';
			s.fontWeight = 400;
			s.theme = 'light';
			fillFontOptions();
			renderSize();
			renderWeight();
			panel.findAll('.fleur-epub-appear-swatch').forEach((d, i) => d.toggleClass('is-active', i === 0));
			persist();
		});

		// 定位：锚点按钮下方右对齐
		panel.setCssStyles({ visibility: 'hidden' });
		window.requestAnimationFrame(() => {
			const rect = anchor.getBoundingClientRect();
			const bw = panel.offsetWidth;
			const left = Math.max(8, Math.min(rect.right - bw, window.innerWidth - bw - 8));
			panel.setCssStyles({ left: `${left}px`, top: `${rect.bottom + 8}px`, visibility: '' });
		});

		// 外点 / Esc 关闭（面板内交互不关闭）
		const outside = (e: MouseEvent) => {
			if (!panel.contains(e.target as Node) && e.target !== anchor) this.closeAppearancePanel();
		};
		const esc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') this.closeAppearancePanel();
		};
		this.appearPanelClose = () => {
			document.removeEventListener('mousedown', outside, true);
			document.removeEventListener('keydown', esc, true);
		};
		window.setTimeout(() => {
			document.addEventListener('mousedown', outside, true);
			document.addEventListener('keydown', esc, true);
		}, 0);
	}

	private closeAppearancePanel(): void {
		if (this.appearPanelClose) {
			this.appearPanelClose();
			this.appearPanelClose = null;
		}
		if (this.appearPanel) {
			this.appearPanel.remove();
			this.appearPanel = null;
		}
	}

	// ── 右键清除菜单：命中标注 → 原生菜单列出清除项（对齐 fleur-pdf，不直接擦除） ──

	private showClearAnnotationMenu(hostX: number, hostY: number, anns: EpubAnnotation[]): void {
		const menu = new Menu();
		for (const ann of anns) {
			menu.addItem((item) => {
				item.setTitle(this.describeAnnotation(ann)).setIcon('eraser');
				item.onClick(() => void this.deleteAnnotation(ann));
			});
		}
		menu.showAtPosition({ x: hostX, y: hostY });
	}

	/** 清除项标签：按标注类型给出具体名称（对齐 fleur-pdf） */
	private describeAnnotation(ann: EpubAnnotation): string {
		if (ann.kind === 'underline') return '清除直线';
		if (ann.kind === 'wavy') return '清除波浪线';
		return ann.comment ? '清除高亮与批注' : '清除高亮';
	}

	// ── 批注卡片：换色 / 编辑批注 / 删除 ──

	private showAnnotationPopup(ann: EpubAnnotation, hostX: number, hostY: number, focusComment = false): void {
		this.hideSelectionToolbar();
		this.hideAnnPopup();
		const pop = document.body.createDiv('fleur-epub-annpop');
		this.annPopup = pop;

		// 顶部拖拽手柄（可拖动，位置记忆；尺寸自适应内容，不做固定宽高）
		const grip = pop.createDiv('fleur-epub-annpop-grip');
		grip.setAttribute('aria-label', '拖动');
		let drag: { sx: number; sy: number; ox: number; oy: number } | null = null;
		grip.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			const rect = pop.getBoundingClientRect();
			drag = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top };
			try {
				grip.setPointerCapture(e.pointerId);
			} catch { /* 忽略 */ }
		});
		grip.addEventListener('pointermove', (e) => {
			if (!drag) return;
			pop.setCssStyles({
				left: `${drag.ox + e.clientX - drag.sx}px`,
				top: `${drag.oy + e.clientY - drag.sy}px`,
			});
		});
		const endDrag = () => {
			if (!drag) return;
			drag = null;
			const rect = pop.getBoundingClientRect();
			this.plugin.settings.annPopPos = { left: Math.round(rect.left), top: Math.round(rect.top) };
			void this.plugin.saveSettings();
		};
		grip.addEventListener('pointerup', endDrag);
		grip.addEventListener('pointercancel', endDrag);

		// 右上角 ✕ 关闭按钮
		const closeBtn = pop.createSpan('fleur-epub-annpop-close');
		closeBtn.setText('✕');
		closeBtn.setAttribute('aria-label', '关闭');
		closeBtn.addEventListener('click', () => this.hideAnnPopup());

		// 图标按钮（编辑 ✏️ / 保存 ✓ / 删除 🗑，Obsidian 内置 lucide 图标）
		const mkIconBtn = (row: HTMLElement, icon: string, label: string, cls: string, fn: () => void) => {
			const b = row.createEl('button', `fleur-epub-annpop-icon ${cls}`);
			b.setAttribute('aria-label', label);
			setIcon(b, icon);
			b.addEventListener('click', fn);
			return b;
		};
		const mkDelBtn = (row: HTMLElement) => {
			mkIconBtn(row, 'trash-2', '删除标注', 'is-danger', () => {
				void this.deleteAnnotation(ann);
				this.hideAnnPopup();
			});
		};

		// 批注正文区：有批注 → 只读内容视图（微信读书式，点标注即看内容）；无批注 → 输入框
		// 「编辑」切到输入态，保存后回到内容视图
		const body = pop.createDiv('fleur-epub-annpop-body');
		let ta: HTMLTextAreaElement | null = null;
		const renderEdit = () => {
			body.empty();
			ta = body.createEl('textarea', 'fleur-epub-annpop-input');
			ta.placeholder = '添加批注…';
			ta.value = ann.comment ?? '';
			const row = body.createDiv('fleur-epub-annpop-actions');
			mkIconBtn(row, 'check', '保存批注', 'is-primary', () => {
				ann.comment = ta?.value.trim() || undefined;
				this.saveBookData();
				// 广播变更（侧边栏即时刷新）
				this.plugin.notifyAnnotationsChanged();
				new Notice('批注已保存', 1500);
				if (ann.comment) renderView();
				else this.hideAnnPopup();
			});
			mkDelBtn(row);
			if (focusComment) ta.focus();
		};
		const renderView = () => {
			body.empty();
			ta = null;
			// 批注内容以正常字体、纯文本展示，不暴露任何 Markdown 源码
			const content = body.createDiv('fleur-epub-annpop-comment');
			content.setText(ann.comment ?? '');
			const row = body.createDiv('fleur-epub-annpop-actions');
			mkIconBtn(row, 'pencil', '编辑', '', () => renderEdit());
			mkDelBtn(row);
		};
		if (ann.comment) renderView();
		else renderEdit();

		// 全局关闭：点击卡片外部或按 Esc 均可关闭（点击卡片内部不关闭）
		const outside = (e: MouseEvent) => {
			if (!pop.contains(e.target as Node)) this.hideAnnPopup();
		};
		const esc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') this.hideAnnPopup();
		};
		this.annPopupClose = () => {
			document.removeEventListener('mousedown', outside, true);
			document.removeEventListener('keydown', esc, true);
		};
		window.setTimeout(() => {
			document.addEventListener('mousedown', outside, true);
			document.addEventListener('keydown', esc, true);
		}, 0);

		pop.setCssStyles({ visibility: 'hidden' });
		window.requestAnimationFrame(() => {
			const bw = pop.offsetWidth;
			const bh = pop.offsetHeight;
			const saved = this.plugin.settings.annPopPos;
			let left: number;
			let top: number;
			if (saved) {
				// 用户拖拽过 → 记忆位置（钳制在视口内）
				left = Math.min(Math.max(8, saved.left), window.innerWidth - bw - 8);
				top = Math.min(Math.max(8, saved.top), window.innerHeight - bh - 8);
			} else {
				// 默认出现在标注文本旁
				left = Math.max(8, Math.min(hostX - bw / 2, window.innerWidth - bw - 8));
				top = hostY + 14;
				if (top + bh > window.innerHeight - 8) top = Math.max(8, hostY - bh - 14);
			}
			pop.setCssStyles({ left: `${left}px`, top: `${top}px`, visibility: '' });
			if (focusComment && ta) ta.focus();
		});
	}

	private hideAnnPopup(): void {
		if (this.annPopupClose) {
			this.annPopupClose();
			this.annPopupClose = null;
		}
		if (this.annPopup) {
			this.annPopup.remove();
			this.annPopup = null;
		}
	}

	// ════════ 侧边栏联动 API（M3）：目录 / 定位 / 检索 ════════

	/** 是否已加载书（侧边栏判断当前是否处于书模式） */
	isBookLoaded(): boolean {
		return !!this.foliateView && !!this.bookData;
	}

	/** 当前已加载书的 vault 路径（侧边栏判断点击的是否为正在读的书） */
	getLoadedFilePath(): string | null {
		return this.loadedPath;
	}

	/** 书内目录（扁平化，含层级深度） */
	getTOC(): { label: string; href: string; depth: number }[] {
		const out: { label: string; href: string; depth: number }[] = [];
		const walk = (items: any[], depth: number) => {
			for (const it of items ?? []) {
				if (it?.href) {
					out.push({ label: String(it.label ?? '').trim(), href: it.href, depth });
				}
				walk(it?.subitems ?? [], depth + 1);
			}
		};
		walk(this.foliateView?.book?.toc ?? [], 0);
		return out;
	}

	/** 跳转到目录项 / 检索结果（href 或 CFI 均可） */
	async goToTarget(target: string): Promise<void> {
		try {
			await this.foliateView?.goTo(target);
		} catch (err) {
			console.warn('[FleurEPUB] 跳转失败', target, err);
		}
	}

	/** 全部标注（侧边栏批注 tab） */
	getAnnotations(): EpubAnnotation[] {
		return this.bookData?.annotations ?? [];
	}

	/** 更新批注文字（侧边栏内联编辑 / AI 生成批注共用；comment 为 undefined 表示清除） */
	async updateAnnotationComment(id: string, comment: string | undefined): Promise<void> {
		const ann = this.bookData?.annotations.find((x) => x.id === id);
		if (!ann) return;
		ann.comment = comment;
		this.saveBookData();
		this.plugin.notifyAnnotationsChanged();
	}

	/** 一键擦除标注（侧边栏与右键共用） */
	async eraseAnnotation(ann: EpubAnnotation): Promise<void> {
		await this.deleteAnnotation(ann);
	}

	/** 定位到标注：跳转、闪烁提示位置并弹批注卡片（foliate showAnnotation → show-annotation 事件） */
	async locateAnnotation(cfi: string): Promise<void> {
		try {
			await this.foliateView?.showAnnotation({ value: cfi });
			const ann = this.bookData?.annotations.find((x) => x.cfi === cfi);
			if (ann) this.flashAnnotation(ann);
		} catch (err) {
			console.warn('[FleurEPUB] 标注定位失败', err);
		}
	}

	/**
	 * 定位闪烁：反复以醒目红色重绘 3 次，最后恢复原色。
	 * foliate addAnnotation 同 key 重绘即替换，无需触碰 overlayer 内部。
	 */
	private flashAnnotation(ann: EpubAnnotation): void {
		const base = { value: ann.cfi, ...ann };
		let n = 0;
		const tick = () => {
			if (!this.foliateView) return;
			const flashOn = n % 2 === 0;
			void this.foliateView
				.addAnnotation({ ...base, color: flashOn ? 'pink' : ann.color })
				.catch(() => {});
			if (++n < 6) window.setTimeout(tick, 360);
		};
		tick();
	}

	/** 全书检索：逐条回调（label 章节名 / excerpt 摘录 / cfi 定位），进度回调可选 */
	async runSearch(
		query: string,
		onResult: (label: string, excerpt: string, cfi: string) => void,
		onProgress?: (p: number) => void,
	): Promise<void> {
		const view = this.foliateView;
		if (!view || !query.trim()) return;
		view.clearSearch();
		const iter = view.search({
			query,
			matchCase: false,
			matchDiacritics: false,
			matchWholeWords: false,
		});
		for await (const r of iter) {
			if (r === 'done') break;
			if (typeof r?.progress === 'number') onProgress?.(r.progress);
			if (r?.subitems) {
				for (const item of r.subitems) onResult(r.label ?? '', item.excerpt, item.cfi);
			} else if (r?.cfi) {
				onResult('', r.excerpt, r.cfi);
			}
		}
	}

	/** 清除检索高亮与结果 */
	clearBookSearch(): void {
		try {
			this.foliateView?.clearSearch();
		} catch { /* 忽略 */ }
	}

	private scheduleSaveProgress(cfi?: string, percent?: number): void {
		if (!this.bookData) return;
		if (cfi) this.bookData.progress.cfi = cfi;
		if (typeof percent === 'number') this.bookData.progress.percent = percent;
		this.bookData.progress.updatedAt = Date.now();
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			if (this.bookData) void this.plugin.bookStore.save(this.bookData);
		}, 800);
	}

	private async teardownBook(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.bookData) {
			await this.plugin.bookStore.save(this.bookData);
			this.bookData = null;
		}
		try {
			await this.foliateView?.destroy?.();
		} catch { /* 忽略销毁异常 */ }
		this.foliateView = null;
		this.loadedPath = null;
		this.hideSelectionToolbar();
		this.hideAnnPopup();
	}

	async onClose(): Promise<void> {
		await this.teardownBook();
		this.contentEl.empty();
	}
}
