// EPUB 阅读器视图：foliate-view 自定义元素嵌入 Obsidian leaf。
// 阅读体验对齐微信读书 / Apple Books：
//   - 排版：衬线正文 + 完整标题层级，setStyles 注入（foliate 每章加载后自动重注入）
//   - 双模式：滚动 / 翻页（paginator 的 flow 属性，可随时切换）
//   - 翻页模式：右击下一页、左击上一页（点按区域，不干扰选段），支持方向键
// 继承 FileView：registerExtensions 接管 .epub 后，Obsidian 打开文件时回调 onLoadFile。

import { EventRef, FileView, Menu, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import type FleurEpubPlugin from './main';
import { computeFingerprint, type BookData, type BookMeta, type EpubAnnotation, type AnnotationKind } from './store';
import { Overlayer } from '../vendor/foliate-js/overlayer.js';
import { AIChatPanel } from './ai-chat-modal';
import { exportAnnotationsToNote } from './annotation-export';
import { cleanAnnotationText } from './text-utils';
import { TranslationEngine, findParagraphEl, collectParagraphs } from './translator';
import type { ReaderTheme } from './settings';
import { isMobileUI } from './platform';
import { MobileChrome } from './mobile-chrome';
import { ReaderTTS } from './tts';
import { TTSPlayerModal } from './tts-player';
import '../vendor/foliate-js/view.js';

export const VIEW_TYPE_EPUB = 'fleur-epub-view';

/** 左右点按翻页的区域宽度占比（与微信读书一致的左右各 ~38%） */
const ZONE_RATIO = 0.38;

/** 右上角进度环几何：SVG viewBox 36×36，进度用 dashoffset 表达 */
const RING_RADIUS = 15.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 滚动模式跨章·新手势间隔：滚轮事件间隔超过该毫秒数视为「松手后再滚」，立即翻章 */
const SCROLL_GESTURE_GAP = 250;
/** 滚动模式跨章·章缘累计门槛：停到章顶/章底后，继续推过该像素量（约 1/3 屏）即翻章 */
const EDGE_CHAIN_ACC = 300;
/** 跨章冷却：翻章后短暂冷却，防止短章节落位前被二次触发连翻两章 */
const CHAIN_COOL = 400;

/** 标注颜色（键持久化到书数据；值用于 overlayer 绘制） */
export const HIGHLIGHT_COLORS: Record<string, string> = {
	yellow: '#f2c14e',
	green: '#7bc47f',
	blue: '#64a6e8',
	pink: '#ef8a8a',
	purple: '#ab8de8',
};

/** 选区工具条展示的高亮三色（微信读书式）；pink/purple 不再作为新标注入口，
 *  仅保留在 HIGHLIGHT_COLORS 中供旧数据渲染兜底与划线/波浪线用色 */
export const HIGHLIGHT_COLOR_KEYS = ['yellow', 'green', 'blue'] as const;

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

/** 预置字体（macOS 系统自带为主，值为完整 CSS font-family 栈；'' = 跟随 Obsidian 全局文本字体） */
const PRESET_FONTS: Array<{ label: string; stack: string }> = [
	{ label: '默认 · 跟随 Obsidian', stack: '' },
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

/**
 * 在元素内定位一段（空白归一化后的）文本，返回覆盖它的文本节点区间。
 * TTS 跟读高亮用：句子文本来自 innerText 归一化，需映射回真实 DOM 节点
 * （跨 <em>/<strong> 等内联元素的句子也能整体覆盖）。
 */
function findTextInElement(
	el: HTMLElement,
	text: string,
): Array<{ node: Text; start: number; end: number }> {
	const ownerDoc = el.ownerDocument;
	if (!ownerDoc) return [];
	const target = text.replace(/\s+/g, ' ').trim();
	if (!target) return [];

	const tw = ownerDoc.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode: (n) => {
			const tag = n.parentElement?.tagName;
			return tag === 'SCRIPT' || tag === 'STYLE'
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT;
		},
	});
	const nodes: Text[] = [];
	let n = tw.nextNode() as Text | null;
	while (n) {
		nodes.push(n);
		n = tw.nextNode() as Text | null;
	}
	if (!nodes.length) return [];

	// 拼接原文并建立「归一化索引 → (节点, 原始偏移)」映射：
	// 连续空白折叠为一个空格，只映射到该空白段的第一个字符
	let seq = '';
	const idxMap: Array<{ node: Text; off: number }> = [];
	for (const node of nodes) {
		const data = node.data;
		for (let i = 0; i < data.length; i++) {
			if (/\s/.test(data[i])) {
				if (seq.length && seq[seq.length - 1] !== ' ') {
					seq += ' ';
					idxMap.push({ node, off: i });
				}
				while (i + 1 < data.length && /\s/.test(data[i + 1])) i++;
			} else {
				seq += data[i];
				idxMap.push({ node, off: i });
			}
		}
	}
	const start = seq.indexOf(target);
	if (start < 0) return [];
	const end = start + target.length;

	// 逐归一化字符回溯来源坐标，同节点相邻区间合并
	const ranges: Array<{ node: Text; start: number; end: number }> = [];
	for (let i = start; i < end; i++) {
		const m = idxMap[i];
		if (!m) continue;
		const last = ranges[ranges.length - 1];
		if (last && last.node === m.node && last.end === m.off) last.end = m.off + 1;
		else ranges.push({ node: m.node, start: m.off, end: m.off + 1 });
	}
	return ranges;
}

export class EpubReaderView extends FileView {
	private foliateView: any = null;
	private bookData: BookData | null = null;
	private fingerprint = '';
	private saveTimer: number | null = null;
	/** 标注重挂就绪轮询计时（foliate load 事件早于 overlayer 创建，需延迟挂载） */
	private annMountTimer: number | null = null;
	/** 右上角进度环：环形进度条 + 中心百分数（滚动/翻页两种模式通用） */
	private progressEl!: HTMLElement;
	private progressArcEl!: SVGCircleElement;
	private progressNumEl!: HTMLElement;
	/** 页脚角标：右下章节页码（翻页模式；滚动模式隐藏） */
	private pageEl!: HTMLElement;
	private titleEl!: HTMLElement;
	private readerEl!: HTMLElement;
	private modeBtnScroll!: HTMLElement;
	private modeBtnPage!: HTMLElement;
	private loadedPath: string | null = null;
	// ── 标注引擎状态 ──
	private lastMouseHost = { x: 0, y: 0 };
	/** 移动端选区稳定判定定时器（selectionchange 防抖） */
	private selChangeTimer: number | null = null;
	/** 选段工具条最近一次弹出时间：collapse 事件的宽限期判定用 */
	private selBarShownAt = 0;
	/** 侧边栏「定位标注」进行中：移动端抑制 show-annotation 弹 action sheet */
	private locating = false;
	private selToolbar: HTMLElement | null = null;
	private annPopup: HTMLElement | null = null;
	/** 批注卡片的全局关闭监听清理函数（外点 / Esc） */
	private annPopupClose: (() => void) | null = null;
	/** 批注弹窗最近一次弹出时间：relocate 宽限期判定用（键盘弹出/字体加载的浮动重排不得闪掉弹窗） */
	private annPopupShownAt = 0;
	/** 打开 AI 面板时捕获的选区锚点（供「写入批注」延迟落点，选区塌缩后仍可写入） */
	private aiAnnotSeed: { cfi: string; text: string } | null = null;
	/** 上一次 relocate 的全书比例：判定位置是否真的变化（snap 校正等未变时不得关浮层） */
	private lastRelocateFrac: number | null = null;
	private currentSelDoc: Document | null = null;
	private selSnapshot = '';
	// ── 段落对照翻译 ──
	private translator: TranslationEngine | null = null;
	private translateBtn: HTMLElement | null = null;
	// ── 移动端 chrome（底部工具栏 + 显隐状态机；桌面端为 null）──
	private chrome: MobileChrome | null = null;
	/** 移动端「听」（Web Speech API 朗读；桌面端为 null） */
	private tts: ReaderTTS | null = null;
	private ttsBtn: HTMLElement | null = null;
	/** TTS 跟读高亮的 span 列表（朗读推进/停止时恢复原状） */
	private ttsHighlightSpans: HTMLSpanElement[] = [];
	/** TTS 状态订阅取消函数（onClose 时解绑） */
	private ttsUnsub: (() => void) | null = null;
	/** 沉浸全屏状态 + 顶栏按钮 + 自动退出订阅 */
	private immersive = false;
	private fsBtn: HTMLElement | null = null;
	private leafChangeRef: EventRef | null = null;
	/** 桌面端听书播放器 Modal（关闭仅收起面板，朗读继续） */
	private ttsModal: TTSPlayerModal | null = null;

	constructor(leaf: WorkspaceLeaf, public plugin: FleurEpubPlugin) {
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
		// 移动端：顶栏左侧「返回书架」（微信读书式 chevron）；桌面不渲染
		if (isMobileUI(this.plugin)) {
			const backBtn = createSpan('fleur-epub-bar-btn fleur-epub-bar-back');
			setIcon(backBtn, 'chevron-left');
			backBtn.setAttribute('aria-label', '返回书架');
			backBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.plugin.openShelf();
			});
			bar.appendChild(backBtn);
		}
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

		// 对照翻译开关（与 Aa 并置）：外语→现代中文 / 文言→白话，AI 自动识别语言
		const trBtn = createSpan('fleur-epub-bar-btn fleur-epub-bar-btn-translate');
		trBtn.setText('译');
		// 不设 aria-label：Obsidian 会把它渲染成悬浮 tooltip，干扰顶栏观感
		trBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.toggleChapterTranslation();
		});
		this.translateBtn = trBtn;

		// 顶栏「听」：微信读书式听书。
		// 移动端恒显示（安卓 WebView 无系统语音，但可走在线引擎，按钮必须可点）；
		// 桌面端仅在系统语音可用时显示，与旧版一致。
		if (ReaderTTS.buttonVisible(this.plugin)) {
			this.tts = new ReaderTTS(this);
			// 播放状态 → 顶栏「听」点亮/熄灭（暂停时半亮，由 CSS 处理）
			this.ttsUnsub = this.tts.onStateChange((s) => {
				this.ttsBtn?.toggleClass('is-active', s.active && !s.paused);
				this.ttsBtn?.toggleClass('is-paused', s.active && s.paused);
			});
			const ttsBtn = createSpan('fleur-epub-bar-btn fleur-epub-bar-btn-tts');
			ttsBtn.setText('听');
			ttsBtn.setAttribute('aria-label', '听书播放器');
			ttsBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.chrome) {
					// 移动端：bottom sheet 播放器
					this.chrome.openTTSPlayer();
				} else {
					// 桌面端：居中 Modal 播放器（关闭仅收起，朗读继续）
					const tts = this.tts;
					if (!tts) return;
					if (!tts.isActive()) tts.start();
					this.ttsModal?.close();
					this.ttsModal = new TTSPlayerModal(this.app, this);
					this.ttsModal.open();
				}
			});
			this.ttsBtn = ttsBtn;
		}

		// Aa 阅读外观按钮：仅桌面顶栏保留（移动端入口在底部工具栏「排版」，避免重复）
		if (!isMobileUI(this.plugin)) {
			const aaBtn = createSpan('fleur-epub-bar-btn');
			aaBtn.setText('Aa');
			aaBtn.setAttribute('aria-label', '阅读外观');
			aaBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.toggleAppearancePanel(aaBtn);
			});
			right.appendChild(aaBtn);
		}

		right.appendChild(trBtn);
		if (this.ttsBtn) right.appendChild(this.ttsBtn);

		// 沉浸全屏（仅移动端）：隐藏 Obsidian 移动端顶部导航，阅读区铺满整屏
		if (isMobileUI(this.plugin)) {
			const fsBtn = createSpan('fleur-epub-bar-btn fleur-epub-bar-btn-fs');
			setIcon(fsBtn.createSpan('fleur-epub-bar-btn-icon'), 'maximize');
			fsBtn.setAttribute('aria-label', '沉浸全屏');
			fsBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.setImmersive(!this.immersive);
			});
			this.fsBtn = fsBtn;
			right.appendChild(fsBtn);
		}

		right.appendChild(seg);
		bar.appendChild(this.titleEl);
		bar.appendChild(right);

		this.readerEl = createDiv('fleur-epub-reader');
		this.contentEl.appendChild(bar);
		this.contentEl.appendChild(this.readerEl);

		// 页脚角标：右下章节页码（仅翻页模式显示；滚动模式 CSS 隐藏）
		const badges = createDiv('fleur-epub-pagebadges');
		this.pageEl = createSpan('fleur-epub-pagenum');
		badges.appendChild(this.pageEl);
		this.readerEl.appendChild(badges);

		// 右上角进度环（阅读区浮层）：环形进度 + 中心百分数，滚动/翻页都可见
		this.readerEl.appendChild(this.buildProgressRing());

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

		// Obsidian 全局字体 / 主题变化 → 重新注入排版（默认字体跟随 --font-text，需重取值）
		this.registerEvent(
			this.app.workspace.on('css-change', () => {
				if (this.foliateView) this.applyReaderStyles();
			}),
		);

		// 移动端：创建底部工具栏并让 chrome 初始隐藏（沉浸开局，中央点按呼出）。
		// 桌面端不实例化，此后的所有移动分支均以 this.chrome 是否存在为判断。
		if (isMobileUI(this.plugin)) {
			this.chrome = new MobileChrome(this);
			this.contentEl.appendChild(this.chrome.toolbarEl);
			this.contentEl.addClass('is-chrome-hidden');
			// 沉浸全屏自动退出：切到其它视图/面板时撤掉全局隐藏类，避免影响其它界面
			this.leafChangeRef = this.app.workspace.on('active-leaf-change', () => {
				if (!this.immersive) return;
				if (this.app.workspace.getActiveViewOfType(EpubReaderView) !== this) this.setImmersive(false);
			});
		}
	}

	/** 沉浸全屏：隐藏 Obsidian 移动端顶部导航（navbar / tab 头 / view 头），阅读区铺满 */
	setImmersive(on: boolean): void {
		this.immersive = on;
		document.body.toggleClass('fleur-epub-immersive', on);
		this.fsBtn?.toggleClass('is-active', on);
	}

	/**
	 * 右上角进度环：细描边环 + 中心百分数。
	 * 放阅读区浮层而非页脚，是为了滚动模式也有进度可看（翻页模式另在右下角显示章节页码）。
	 */
	private buildProgressRing(): HTMLElement {
		const wrap = createDiv('fleur-epub-progress');
		wrap.setAttribute('role', 'img');
		wrap.setAttribute('aria-label', '阅读进度');
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('viewBox', '0 0 36 36');
		svg.setAttribute('aria-hidden', 'true');
		const mkCircle = (cls: string): SVGCircleElement => {
			const c = document.createElementNS(NS, 'circle') as SVGCircleElement;
			c.setAttribute('class', cls);
			c.setAttribute('cx', '18');
			c.setAttribute('cy', '18');
			c.setAttribute('r', String(RING_RADIUS));
			return c;
		};
		const track = mkCircle('fleur-epub-progress-track');
		const arc = mkCircle('fleur-epub-progress-arc');
		arc.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
		arc.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));
		svg.appendChild(track);
		svg.appendChild(arc);
		wrap.appendChild(svg);
		this.progressNumEl = createSpan('fleur-epub-progress-num');
		this.progressNumEl.setText('0');
		wrap.appendChild(this.progressNumEl);
		this.progressArcEl = arc;
		this.progressEl = wrap;
		return wrap;
	}

	/** 刷新进度环（percent：0–100；首次收到位置后才显形，避免开书瞬间闪 0） */
	private setProgress(percent: number): void {
		const p = Math.max(0, Math.min(100, Math.round(percent)));
		if (this.progressArcEl) {
			this.progressArcEl.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - p / 100));
		}
		this.progressNumEl?.setText(String(p));
		this.progressEl?.setAttribute('aria-label', `阅读进度 ${p}%`);
		this.progressEl?.addClass('is-ready');
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
		// 移动端诊断浮标（0.2.2 临时）：书架正常但开书空白且无报错，
		// 需要用户反馈停在哪一阶段（ suspected：移动端 WebView/CSP 拦截 blob iframe，init 永挂不抛错）
		const dbg = isMobileUI(this.plugin);
		const stage = (msg: string, long = false) => {
			if (dbg) new Notice(`[FleurEPUB] ${msg}`, long ? 8000 : 2200);
		};
		try {
			const bytes = await this.app.vault.readBinary(file);
			// foliate-js makeBook 直接接受 File 对象（内部走 vendor/zip.js 解压）
			const fileObj = new File([bytes], file.name, { type: 'application/epub+zip' });
			stage('① EPUB 数据已读取');

			this.readerEl.empty();

			const view = this.foliateView = document.createElement('foliate-view') as any;

			view.addEventListener('relocate', (e: CustomEvent) => {
				const d = e.detail ?? {};
				const percent = typeof d.fraction === 'number' ? Math.round(d.fraction * 100) : undefined;
				if (percent !== undefined) this.setProgress(percent);
				// 章节页码（右下角标）：foliate 的 pages 含首尾 2 个空列，实际页数 = pages - 2
				const r = view.renderer;
				if (r && typeof r.page === 'number' && typeof r.pages === 'number' && r.pages > 2) {
					this.pageEl.setText(`${r.page}/${r.pages - 2}`);
				} else {
					this.pageEl.setText('');
				}
				this.scheduleSaveProgress(d.cfi, percent);
			});

			// 每章文档加载完成：绑定 iframe 内交互 + 重新挂载全部标注
			//（foliate 只在 overlayer 上持有当前章节的标注，翻章即失效，需每次重挂；
			//  addAnnotation 内部解析 CFI，非当前章节自动跳过，全部重挂开销可忽略）
			view.addEventListener('load', (e: CustomEvent) => {
				// 翻章 = 阅读位置变了，停止朗读避免与画面脱节
				this.tts?.stop();
				this.ttsBtn?.removeClass('is-active');
				const doc = e.detail?.doc as Document | undefined;
				if (doc) {
					this.bindDocEvents(doc);
					// 清掉书内自带的 title 属性：许多 EPUB 在正文节点上带
					// pagenumber 之类的 title，悬停会弹原生灰条提示，干扰阅读
					doc.querySelectorAll('[title]').forEach((el) => el.removeAttribute('title'));
				// 对照翻译开启时：新章节按「视口优先」续翻（最大单元仍是本章）
				if (this.translator?.isActive() && doc.body?.textContent?.trim()) {
					this.translator.scheduleFocus(doc);
				}
				}
				if (this.bookData) {
					// 注意时序：foliate 的 load 事件在 create-overlayer / #view 切换之前派发，
					// 此时立即 addAnnotation 会因 #getOverlayer 查不到 overlayer 被静默丢弃
					//（重开书、跨章节时标注全部消失的根因）——延迟到 overlayer 就绪后再重挂
					this.remountAnnotationsWhenReady(view, typeof e.detail?.index === 'number' ? e.detail.index : null);
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
			// 桌面端仅展示有批注内容的标注：纯高亮/划线点击不弹窗（清除走右键菜单与侧边栏）；
			// 移动端纯高亮/划线点按 → 清除动作卡（见 showAnnotationActionSheet）
			view.addEventListener('show-annotation', (e: CustomEvent) => {
				const { value, range } = e.detail ?? {};
				const ann = this.bookData?.annotations.find((x) => x.cfi === value);
				// 移动端：点按标注 → action sheet（查看 / 编辑 / 清除），替代桌面右键清除菜单语义；
				// 侧边栏「定位标注」触发的 show-annotation 只闪位置，不弹 sheet
				if (isMobileUI(this.plugin)) {
					if (ann && !this.locating) this.showAnnotationActionSheet(ann, this.annHostFromRange(range));
					return;
				}
				if (!ann?.comment) return;
				const dhost = this.annHostFromRange(range);
				this.showAnnotationViewer(ann, dhost.x, dhost.y);
			});

			// 书内链接接管（微信读书式）：先 preventDefault 拿下控制权，再异步分类——
			// 脚注/尾注 → 内容卡片弹窗；其余链接 → 自行 goTo 保持跳转。
			// 不能放行默认跳转再异步弹卡，否则脚注会「跳转 + 弹卡」双触发。
			view.addEventListener('link', (e: CustomEvent) => {
				e.preventDefault();
				void this.handleBookLink(e.detail?.a, e.detail?.href);
			});

			// 翻页 / 滚动时收起全部浮层，并按新视口重排翻译优先级（节流）
			view.addEventListener('relocate', (e: CustomEvent) => {
				// 位置未变的 relocate 不得关闭浮层：移动端每次 touchend 都会触发 snap 校正，
				// 即便无位移也会派发 relocate——点按标注/按钮刚弹出的浮层会在同帧被关掉（表现为闪退）
				const frac = typeof e.detail?.fraction === 'number' ? e.detail.fraction : null;
				const moved = frac === null || this.lastRelocateFrac === null
					|| Math.abs(frac - this.lastRelocateFrac) > 1e-9;
				this.lastRelocateFrac = frac;
				if (!moved) return;
				// 宽限期：批注弹窗刚弹出（<600ms）后的浮动重排（键盘弹出/字体加载 expand）不闪掉弹窗
				// 编辑弹窗（含 textarea）永不因 relocate 自动关闭：平板上编辑时软键盘弹出 →
				// 视口 resize → 重排 relocate，若此刻拆掉编辑窗，表现为「编辑时闪退」。
				// 编辑窗只通过 ✕ / 取消 / 保存 / 点击外部 关闭。
				const isEditor = !!this.annPopup?.querySelector('textarea');
				if (!isEditor && (!this.annPopup || Date.now() - this.annPopupShownAt >= 600)) this.hideAnnPopup();
				// 选区仍活动 → 保留选段工具条：选段本身可能触发布局微调型 relocate；
				// 真翻页时选区塌缩，下轮 selectionchange 自然收起
				const sel = this.currentSelDoc?.getSelection();
				const selAlive = !!(sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim());
				if (!selAlive) this.hideSelectionToolbar();
				// 移动端：翻页 / 跳转后自动收起 chrome（sheet 打开时保持，供进度 slider 连续拖动）
				this.chrome?.onRelocate();
				this.translator?.scheduleFocus();
			});

			this.readerEl.appendChild(view);
			await view.open(fileObj);
			stage('② EPUB 格式解析完成');

			// 渲染看门狗：首个章节 load 事件 15s 内未到 → 大概率 iframe（blob:）被移动端拦
			let firstLoad = false;
			view.addEventListener('load', () => {
				firstLoad = true;
				stage('③ 章节 iframe 已加载');
			}, { once: true });

			// 阅读模式与翻页动画
			this.applyFlow();

			// 排版：衬线正文 + 标题层级 + 段落节奏（微信读书 / Apple Books 风格）
			this.applyReaderStyles();

			// 段落对照翻译引擎（章节粒度 + 缓存，详见 translator.ts）
			this.initTranslator();

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
			const watchdog = window.setTimeout(() => {
				if (!firstLoad) {
					// 诊断链：vendor load() 埋点（blob/srcdoc 路径选择、fetch、srcdoc 设置）
					const chain = (window as any).__fleur_epub_diag as string[] | undefined;
					const tail = chain?.length ? `\n${chain.slice(-6).join('\n')}` : '\n[诊断链为空：srcdoc 分支未执行]';
					stage(`③ 渲染超时：章节 iframe 15s 未加载${tail}`, true);
				}
			}, 15000);
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
			window.clearTimeout(watchdog);
			stage('④ 渲染完成，可以阅读');

			this.loadedPath = file.path;
			this.plugin.events.trigger('fleur-epub:book-opened');
			console.log(`[FleurEPUB] 已打开：${file.basename}（指纹 ${this.fingerprint}）`);
		} catch (err) {
			console.error('[FleurEPUB] 打开 EPUB 失败', err);
			// 移动端无控制台：直接浮出错误信息（诊断用）
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`EPUB 打开失败：${msg}`, 8000);
			this.readerEl.empty();
			this.readerEl
				.createDiv('fleur-epub-error')
				.setText('无法打开此 EPUB 文件。可能文件损坏或格式不受支持。');
		}
	}

	// ════════ 段落对照翻译（微信读书式，视口优先 + 渐进推进 + 缓存） ════════

	private initTranslator(): void {
		this.translator = new TranslationEngine(this.plugin, {
			getData: () => this.bookData,
			save: () => this.saveBookData(),
			onNotice: (msg, timeout) => new Notice(msg, timeout ?? 2400),
		});
		this.translator.docsProvider = () =>
			(this.foliateView?.renderer?.getContents?.() ?? [])
				.map((c: { doc?: Document }) => c.doc)
				.filter((d: Document | undefined): d is Document => !!d && !!d.body);
		this.translator.currentDocProvider = () => this.currentChapterDoc();
		// 阅读视口 = paginator 元素的矩形（宿主坐标），用于判定「当前正在读的那一屏」
		this.translator.viewportProvider = () => {
			const el = this.foliateView?.renderer as HTMLElement | undefined;
			const r = el?.getBoundingClientRect?.();
			if (!r || !r.height) return null;
			return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
		};
		this.renderTranslateState();
	}

	/** 当前章节文档（foliate 预载的相邻章节不算） */
	private currentChapterDoc(): Document | null {
		const view = this.foliateView as any;
		const contents = view?.renderer?.getContents?.() ?? [];
		const index = view?.lastLocation?.index;
		if (typeof index === 'number') {
			const hit = contents.find((c: { index?: number }) => c.index === index);
			if (hit?.doc) return hit.doc as Document;
		}
		return (contents[0]?.doc as Document | undefined) ?? null;
	}

	/**
	 * 对照翻译的进度反馈策略：完全静默。
	 * 译文逐段出现本身就是进度；开启/失败/整章跳过走 Notice。
	 * （原常驻进度胶囊在连续滚动时会反复弹收、闪烁干扰阅读，已移除。）
	 */

	/** 顶栏「译」：对照翻译开关（当前页优先嵌入，其余后台逐章续翻） */
	private async toggleChapterTranslation(): Promise<void> {
		if (!this.foliateView) {
			new Notice('请先打开一本 EPUB', 1800);
			return;
		}
		if (!this.translator) this.initTranslator();
		const engine = this.translator;
		if (!engine) return;

		if (engine.isActive()) {
			engine.setActive(false);
			this.renderTranslateState();
			new Notice('已关闭对照翻译', 1400);
			return;
		}

		// AI 引擎需要密钥；微软机翻免密钥（无 Key 的用户也可用对照翻译）
		const useMt = (this.plugin.settings.translationEngine ?? 'ai') === 'microsoft';
		if (!useMt && !this.plugin.settings.apiKey) {
			new Notice('当前引擎为 AI 翻译，请先在设置中配置 API Key，或切换为微软机翻', 3600);
			return;
		}

		const doc = this.currentChapterDoc();
		if (!doc || !collectParagraphs(doc).length) {
			new Notice('本章没有需要对照翻译的段落（翻到下一章会自动续翻）', 2600);
			return;
		}

		engine.setActive(true);
		this.renderTranslateState();
		engine.focus(doc);
		new Notice(
			useMt
				? '已开启对照翻译（微软机翻）：当前页优先，其余后台续翻；机翻不支持文言文→白话'
				: '已开启对照翻译：当前页优先，其余后台续翻',
			2600,
		);
	}

	/** 同步「译」按钮的开启态 */
	private renderTranslateState(): void {
		const active = this.translator?.isActive() ?? false;
		if (!this.translateBtn) return;
		this.translateBtn.toggleClass('is-active', active);
		this.translateBtn.removeAttribute('aria-label');
	}

	/** 选区工具条「译」：翻译选区所在段落（整段对照，命中缓存零消耗） */
	private translateSelectionParagraph(doc: Document): void {
		const sel = doc.getSelection();
		if (!sel || sel.rangeCount === 0) return;
		const range = sel.getRangeAt(0);
		const startEl = range.startContainer instanceof Element
			? range.startContainer
			: range.startContainer.parentElement;
		const p = findParagraphEl(startEl ?? null);
		if (!p) {
			new Notice('未找到可翻译的段落', 1800);
			return;
		}
		if (!this.translator) this.initTranslator();
		const engine = this.translator;
		if (!engine) return;
		// AI 引擎需要密钥；微软机翻免密钥
		const useMt = (this.plugin.settings.translationEngine ?? 'ai') === 'microsoft';
		if (!useMt && !this.plugin.settings.apiKey) {
			new Notice('当前引擎为 AI 翻译，请先在设置中配置 API Key，或切换为微软机翻', 3600);
			return;
		}
		void engine.translateParagraphEl(p).then((r) => {
			if (r === 'ok') new Notice('已嵌入译文', 1500);
			else if (r === 'fail') new Notice(`翻译失败：${engine.getLastError() ?? '请检查 AI 设置与网络'}`, 4000);
			else new Notice('该段无需翻译（已是中文或与原文本相同）', 2000);
		});
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
		// 页脚角标联动：滚动模式隐藏章节页码（CSS 作用域）
		this.contentEl.setAttribute('data-flow', flow);
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

	/** 播放器/移动端交互取用 TTS 实例 */
	getTTS(): ReaderTTS | null {
		return this.tts;
	}

	/** TTS 素材：当前章节按块级元素切段（段落边界即自然停顿）+ 文档语言；无内容返回 null */
	/** 当前章节语言（声源列表排序用，轻量不扫正文） */
	getTTSChapterLang(): string {
		const view = this.foliateView;
		const renderer = view?.renderer;
		const contents: Array<{ doc: Document; index: number }> = renderer?.getContents?.() ?? [];
		const doc = contents[0]?.doc;
		return (
			doc?.documentElement?.getAttribute('lang') ||
			String((view?.book?.metadata as any)?.language ?? '')
		);
	}

	/** TTS 朗读单元：句子文本 + 所在段落元素（用于跟读高亮定位） */
	getTTSChapter(): { items: Array<{ el: HTMLElement; text: string }>; lang: string } | null {
		const view = this.foliateView;
		const renderer = view?.renderer;
		const contents: Array<{ doc: Document; index: number }> = renderer?.getContents?.() ?? [];
		if (!contents.length) return null;
		const cur = typeof renderer?.index === 'number' ? renderer.index : contents[0].index;
		const entry = contents.find((c) => c.index === cur) ?? contents[0];
		const doc = entry.doc;
		const lang =
			doc?.documentElement?.getAttribute('lang') ||
			String((view?.book?.metadata as any)?.language ?? '');
		const blocks = Array.from(
			doc.body?.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, dd, dt') ?? [],
		) as HTMLElement[];
		const items: Array<{ el: HTMLElement; text: string }> = [];
		for (const el of blocks) {
			const t = el.innerText?.replace(/\s+/g, ' ').trim();
			if (!t) continue;
			// 句级切分：按中英句读断句，跟读高亮粒度与微信读书对齐
			const parts = t
				.split(/(?<=[。！？!?…]["」』”’)]?)/)
				.map((s) => s.trim())
				.filter(Boolean);
			for (const s of parts) {
				// 过短碎片（如引号残留）并入前一句，避免朗读碎片化
				if (items.length && s.length < 2) {
					items[items.length - 1].text += s;
				} else {
					items.push({ el, text: s });
				}
			}
		}
		return items.length ? { items, lang } : null;
	}

	/** TTS 跟读：清除上一句高亮，在段落原文中定位本句并加灰底高亮 */
	highlightTTSSentence(el: HTMLElement, text: string): void {
		try {
			const doc = el.ownerDocument;
			if (!doc) return;
			this.clearTTSHighlight();
			// 首次注入高亮样式到 iframe 文档（每次章节加载是新 doc，幂等）
			if (!doc.getElementById('fleur-epub-tts-style')) {
				const style = doc.createElement('style');
				style.id = 'fleur-epub-tts-style';
				style.textContent =
					'.fleur-epub-tts-hl{background:rgba(127,127,127,.28);border-radius:2px;'+
					'-webkit-box-decoration-break:clone;box-decoration-break:clone;}';
				(doc.head ?? doc.documentElement).appendChild(style);
			}
			const ranges = findTextInElement(el, text);
			// 从后往前包裹，避免 splitText 使先前捕获的引用失效
			for (let i = ranges.length - 1; i >= 0; i--) {
				const { node, start, end } = ranges[i];
				if (end <= start) continue;
				let target = node;
				if (end < target.length) target.splitText(end);
				if (start > 0) target = target.splitText(start);
				const span = doc.createElement('span');
				span.className = 'fleur-epub-tts-hl';
				target.parentNode?.insertBefore(span, target);
				span.appendChild(target);
				this.ttsHighlightSpans.push(span);
			}
			// 跟读翻页：滚动模式平滑滚动居中；翻页模式目标句不在当前页时自动翻页
			const span = this.ttsHighlightSpans[0];
			if (!span) return;
			if (this.plugin.settings.flow !== 'paginated') {
				span.scrollIntoView({ block: 'center', behavior: 'smooth' });
			} else {
				const renderer = this.foliateView?.renderer as any;
				if (renderer?.scrollToAnchor) {
					// 分页模式：iframe 视口横跨全部列（翻页靠外层容器横向滚动），
					// client rects 相对 iframe 视口，无法用视口判可见性；
					// 直接交给 foliate scrollToAnchor：同页时 scrollLeft 未变 = 无操作，跨页 = 翻页
					void renderer.scrollToAnchor(span);
				} else {
					span.scrollIntoView({ block: 'center', behavior: 'smooth' });
				}
			}
		} catch {
			/* 高亮是锦上添花，任何异常都不打断朗读 */
		}
	}

	/** 清除全部 TTS 跟读高亮（恢复为普通文本节点） */
	clearTTSHighlight(): void {
		for (const span of this.ttsHighlightSpans) {
			const parent = span.parentNode;
			if (!parent) continue;
			parent.insertBefore(span.ownerDocument.createTextNode(span.textContent ?? ''), span);
			span.remove();
			parent.normalize();
		}
		this.ttsHighlightSpans = [];
	}

	/** 移动端背景 sheet：当前主题 key */
	getReaderTheme(): string {
		return this.plugin.settings.theme;
	}

	/** 移动端背景 sheet：切换主题（持久化 + 重应用样式；Aa 面板下次打开同步） */
	async setReaderTheme(theme: ReaderTheme): Promise<void> {
		if (this.plugin.settings.theme === theme) return;
		this.plugin.settings.theme = theme;
		await this.plugin.saveSettings();
		this.applyReaderStyles();
	}

	/**
	 * 默认正文字体：跟随 Obsidian 全局文本字体（body 上的 --font-text）。
	 * 章节文档是独立 iframe，拿不到宿主 CSS 变量，故在宿主侧取值后写入注入样式。
	 * 取值顺序：override 变量（Obsidian 外观设置 / Custom Font Loader 均写这里）
	 * → --font-text → --font-default → 宋体栈。
	 */
	private resolveDefaultFont(): string {
		const cs = getComputedStyle(document.body);
		const read = (name: string) => cs.getPropertyValue(name).replace(/\s+/g, ' ').trim();
		const stack = read('--font-text-override') || read('--font-text') || read('--font-default');
		if (stack && !stack.startsWith('var(')) return stack;
		return '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", Georgia, "Times New Roman", serif';
	}

	/**
	 * 收集字体栈中字体名对应的宿主 @font-face 规则（含 base64 数据，Custom Font Loader
	 * 等插件通过它跨平台提供字体）。书籍 iframe 是独立文档，宿主注册的 @font-face 不可见，
	 * 不注入的话「跟随 Obsidian」只能拿到字体名却没有字体本体，静默回退宋体。
	 * 同时遍历 document.styleSheets 与 adoptedStyleSheets（新版插件用 constructable sheets）。
	 */
	private collectFontFaceCss(fontStack: string): string {
		const names = new Set<string>();
		for (const m of fontStack.matchAll(/"([^"]+)"|'([^']+)'|([^,]+)(?=,|$)/g)) {
			const name = (m[1] ?? m[2] ?? m[3])?.trim().replace(/^["']|["']$/g, '');
			if (name && !/^(serif|sans-serif|monospace|cursive|fantasy|ui-[\w-]+)$/i.test(name))
				names.add(name.toLowerCase());
		}
		const sheets: Array<CSSStyleSheet> = [];
		for (let i = 0; i < document.styleSheets.length; i++) sheets.push(document.styleSheets[i]);
		for (const sheet of (document as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets ?? [])
			sheets.push(sheet);
		const faces: string[] = [];
		for (const sheet of sheets) {
			let rules: ArrayLike<CSSRule>;
			try {
				rules = sheet.cssRules;
			} catch {
				continue; // 跨域样式表不可枚举，跳过
			}
			for (const rule of Array.from(rules)) {
				if (!(rule instanceof CSSFontFaceRule)) continue;
				const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase();
				if (family && names.has(family)) faces.push(rule.cssText);
			}
		}
		return faces.join('\n');
	}

	/** 排版样式：注入章节文档（foliate 在每次章节加载后自动重注入 setStyles） */
	applyReaderStyles(): void {
		// 宿主侧顶栏 / 阅读区底色随主题联动
		this.contentEl.setAttribute('data-reader-theme', this.plugin.settings.theme);
		const renderer = this.foliateView?.renderer;
		if (renderer?.setStyles) renderer.setStyles(this.buildTypographyCss());
		// 页边距：foliate observed attribute（滚动/翻页两种 flow 均生效，设置即重排）
		if (renderer) {
			renderer.setAttribute('margin', `${this.plugin.settings.pageMargin}px`);
			// 左右边距（独立调节）：在对称页边距基础上给 renderer 加额外 padding。
			// paginator 内部有 ResizeObserver 监听自身尺寸，padding 变化自动触发重排；
			// 不侵入 foliate 分栏/翻页数学，滚动与翻页两种 flow 均适用。
			renderer.style.paddingLeft = `${this.plugin.settings.marginLeft ?? 0}px`;
			renderer.style.paddingRight = `${this.plugin.settings.marginRight ?? 0}px`;
		}
	}

	/** 微信读书 / Apple Books 风格排版 CSS（fontSize 为根字号，其余全 em 缩放） */
	private buildTypographyCss(): string {
		const s = this.plugin.settings;
		const fontSize = s.fontSize;
		const t = READER_THEMES[s.theme] ?? READER_THEMES.light;
		const dark = s.theme === 'dark';
		const bodyFont = s.fontFamily || this.resolveDefaultFont();
		// 跟随 Obsidian 时须把宿主 @font-face 一并注入，iframe 内才有字体本体可用
		const fontFaces = s.fontFamily ? '' : this.collectFontFaceCss(bodyFont);
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
			${fontFaces}
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
			/* 正文段落：首行缩进两字（可切换顶格）+ 可调段距（微信读书中文排版惯例） */
			p { margin: 0 0 ${s.paraSpacing}em; text-indent: ${s.paraIndent === false ? '0' : '2em'}; }
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
			/* 章首分隔区（微信读书式）：章节标题上方留出呼吸感，
			   跨章滚动时章节点在视野中有可感知的驻留时长 */
			body > :first-child { margin-top: 2.6em !important; }
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
			/* 段落对照翻译：原文段落尾部嵌入的译文块（微信读书式），
			   追加于段落内部末尾，不影响既有 CFI 锚定；
			   排版与正文保持一致（不加边杠 / 不缩进 / 不淡化） */
			.fleur-translation {
				display: block;
				margin: 0;
			}
			/* 文言→白话的译文：灰显「退后半步」（字号不变，不打断版式节奏） */
			.fleur-translation-classical {
				color: ${t.muted};
			}
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
			// 移动端点按路由：中央呼出 chrome、左右分区翻页（滚动模式点按即呼出）
			if (this.chrome) {
				this.handleMobileTap(doc, e);
				return;
			}
			// 点击命中已有标注 → 交给 foliate 的 show-annotation 弹批注卡片，不翻页
			const entry = (this.foliateView?.renderer?.getContents?.() ?? []).find((c: any) => c.doc === doc);
			if (entry?.overlayer) {
				const [hit] = entry.overlayer.hitTest({ x: e.clientX, y: e.clientY });
				if (hit) return;
			}
			// 听书中点按当前句（灰底高亮）→ 暂停；暂停中再点 → 续播（与移动端对齐）
			if (this.tts?.isActive() && (e.target as HTMLElement).closest?.('.fleur-epub-tts-hl')) {
				this.tts.toggle();
				return;
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
			const rel = this.tapRelX(doc, e.clientX);
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
		// 移动分支改走 selectionchange：触摸选段没有 mouseup 语义，靠「选区 300ms 不再变化」判定稳定
		if (!isMobileUI(this.plugin)) {
			doc.addEventListener('mouseup', (e: MouseEvent) => {
				this.lastMouseHost = this.toHostCoords(doc, e.clientX, e.clientY);
				window.setTimeout(() => {
					const sel = doc.getSelection();
					if (sel && !sel.isCollapsed && sel.rangeCount > 0) this.showSelectionToolbar(doc);
				}, 10);
			});
		} else {
			doc.addEventListener('selectionchange', () => {
				if (this.selChangeTimer) window.clearTimeout(this.selChangeTimer);
				this.selChangeTimer = window.setTimeout(() => {
					this.selChangeTimer = null;
					// 章节已切换 / 文档已脱离 → 丢弃（旧 doc 的选区不再有意义）
					if (!doc.isConnected) return;
					const sel = doc.getSelection();
					if (sel && !sel.isCollapsed && sel.rangeCount > 0 && sel.toString().trim()) {
						this.showSelectionToolbar(doc, [], true);
					} else if (
						this.selToolbar && this.currentSelDoc === doc
						// 宽限期：刚弹出（<350ms）就到的 collapse 视为选段收尾竞态，忽略
						&& Date.now() - this.selBarShownAt > 350
					) {
						// 选区消失（点击空白收起手柄）→ 收起工具条
						this.hideSelectionToolbar();
					}
				}, 300);
			});
		}

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

		// 移动端滚动模式：内容滚动即收起 chrome（微信读书行为；sheet 打开时不收）
		if (this.chrome) {
			doc.addEventListener('scroll', () => this.chrome?.onContentScroll(), { passive: true });
		}
	}

	/**
	 * 点击位置在可视窗内的相对横向比例（0~1）。
	 * 翻页模式下 foliate 直接平移 iframe（容器 scrollLeft 恒 0），点击的 clientX 是
	 * 内容坐标，须换算回可视窗口内的相对位置：用 iframe 元素（同源可取 frameElement）
	 * 在宿主中的盒子反推可视区间。桌面点按翻页与移动端分区点按共用。
	 */
	private tapRelX(doc: Document, clientX: number): number {
		let rel = 0.5;
		const fe = doc.defaultView?.frameElement as HTMLElement | null;
		const hostBox = this.readerEl.getBoundingClientRect();
		const feBox = fe?.getBoundingClientRect();
		if (feBox && feBox.width > 0) {
			const visStart = Math.max(0, hostBox.left - feBox.left);
			const visEnd = Math.min(feBox.width, hostBox.right - feBox.left);
			if (visEnd > visStart) rel = (clientX - visStart) / (visEnd - visStart);
		} else {
			// 兜底：renderer 记账坐标（start = 可视窗末的内容坐标、size = 可视宽）
			const r = this.foliateView?.renderer;
			const size = typeof r?.size === 'number' ? r.size : 0;
			const start = typeof r?.start === 'number' ? r.start : 0;
			if (size > 0) rel = (clientX - start) / size + 1;
		}
		return rel;
	}

	/**
	 * 移动端点按路由（与桌面 click 处理互斥，chrome 存在即移动分支）：
	 * 命中标注 → 放行给 foliate；中央 24% 呼出/收起 chrome；左右 38% 翻页；
	 * 滚动模式点按任意空白处即呼出。翻页后 chrome 自动收起（微信读书行为）。
	 */
	private handleMobileTap(doc: Document, e: MouseEvent): void {
		const entry = (this.foliateView?.renderer?.getContents?.() ?? []).find((c: any) => c.doc === doc);
		if (entry?.overlayer) {
			const [hit] = entry.overlayer.hitTest({ x: e.clientX, y: e.clientY });
			// 命中已有标注 → foliate 自己派发 show-annotation，不干预
			if (hit) return;
		}
		const target = e.target as HTMLElement;
		// 交互元素放行：链接 / 按钮 / 可点击元素
		if (target.closest('a, button, [role="button"], input, textarea, select, video, audio')) return;
		// 朗读中点按当前句（灰底高亮）→ 暂停；暂停中再点 → 续播（微信读书式）
		if (this.tts?.isActive() && target.closest('.fleur-epub-tts-hl')) {
			this.tts.toggle();
			return;
		}
		// 有选段时不干预、也不拆浮层：选段结束时浏览器会补发 click，若该 click 晚于
		// 工具条弹出到达（触摸端 click 延迟尤其明显），「先拆再查选区」就会弹出即收。
		// 顺序必须是：先查选区 → 后收浮层。
		const sel = doc.getSelection();
		if (sel && !sel.isCollapsed) return;
		this.hideSelectionToolbar();
		this.hideAnnPopup();
		const chrome = this.chrome;
		if (!chrome) return;
		if (this.plugin.settings.flow !== 'paginated') {
			chrome.toggle();
			return;
		}
		const rel = this.tapRelX(doc, e.clientX);
		if (rel > 1 - ZONE_RATIO) {
			chrome.hide();
			// 翻页 = 阅读位置变了，停止朗读避免与画面脱节
			this.tts?.stop();
			this.ttsBtn?.removeClass('is-active');
			void this.foliateView?.next();
		} else if (rel < ZONE_RATIO) {
			chrome.hide();
			this.tts?.stop();
			this.ttsBtn?.removeClass('is-active');
			void this.foliateView?.prev();
		} else {
			chrome.toggle();
		}
	}

	/** 滚轮手势 → 翻页：小位移累积、过阈值触发、触发后冷却（防触摸板惯性连翻） */
	private wheelAcc = 0;
	private wheelLastAt = 0;
	private wheelCoolUntil = 0;
	/** 滚动模式：上次 wheel 事件时间戳，用于识别「新手势」（松手后再滚） */
	private scrolledWheelAt = 0;
	/** 章缘累计滚轮量：仅在已停到章顶/章底之后开始累计，离开章缘即清零 */
	private edgeAcc: number | null = null;
	/** 跨章冷却：防止短章节落位前被二次触发、连翻两章 */
	private chainCoolUntil = 0;

	/** 滚轮处理总入口（iframe 文档与宿主容器共用，见 onOpen / bindDocEvents） */
	private onReaderWheel(e: WheelEvent): void {
		if (this.plugin.settings.flow === 'paginated') {
			e.preventDefault();
			this.handleWheelGesture(e.deltaY >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX);
			return;
		}
		const r = this.foliateView?.renderer;
		if (!r || typeof r.viewSize !== 'number' || typeof r.end !== 'number') return;
		// 章缘（顶/底）同方向滚轮一律 preventDefault：防 macOS 橡皮筋回弹、防惯性直接穿章。
		// 跨章判定 = 新手势（松手停顿 > GAP 后再滚，立即翻章）
		//          或 章缘继续推过 EDGE_ACC（~1/3 屏，不停车也能翻，避免「卡住不动」）。
		// 触控板惯性阶段事件间隔 < 50ms，且从章缘刚停住时累计从零开始，
		// 因此既不会一推就穿章，也不会永远停在章节点。
		const now = e.timeStamp;
		const isNewGesture = now - this.scrolledWheelAt > SCROLL_GESTURE_GAP;
		this.scrolledWheelAt = now;
		const atBottom = r.viewSize - r.end <= 2;
		const atTop = r.start <= 2;
		if (atBottom && e.deltaY > 0) {
			e.preventDefault();
			this.edgeAcc = (this.edgeAcc ?? 0) + e.deltaY;
			if (isNewGesture || (this.edgeAcc >= EDGE_CHAIN_ACC && now > this.chainCoolUntil)) {
				this.edgeAcc = null;
				this.chainCoolUntil = now + CHAIN_COOL;
				void this.foliateView?.next();
			}
		} else if (atTop && e.deltaY < 0) {
			e.preventDefault();
			this.edgeAcc = (this.edgeAcc ?? 0) - e.deltaY;
			if (isNewGesture || (this.edgeAcc >= EDGE_CHAIN_ACC && now > this.chainCoolUntil)) {
				this.edgeAcc = null;
				this.chainCoolUntil = now + CHAIN_COOL;
				void this.foliateView?.prev();
			}
		} else {
			// 已离开章缘或反方向：清零累计
			this.edgeAcc = null;
		}
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
		const seed = this.captureSelectionAnchor();
		if (!seed) return null;
		const ann = await this.createAnnotationAt(seed.cfi, seed.text, kind, color);
		new Notice(kind === 'highlight' ? '已高亮' : kind === 'wavy' ? '已加波浪线' : '已划线', 1600);
		return ann;
	}

	/** 捕获当前选区的 CFI 锚点（打开 AI 面板前快照，供「写入批注」延迟落点） */
	private captureSelectionAnchor(): { cfi: string; text: string } | null {
		const doc = this.currentSelDoc;
		const sel = doc?.getSelection();
		if (!doc || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		const text = sel.toString();
		const entry = (this.foliateView?.renderer?.getContents?.() ?? []).find((c: any) => c.doc === doc);
		if (!entry) return null;
		try {
			return { cfi: this.foliateView.getCFI(entry.index, range), text };
		} catch (err) {
			console.warn('[FleurEPUB] 生成 CFI 失败', err);
			new Notice('标注创建失败', 3000);
			return null;
		}
	}

	/** 在既有 CFI 锚点上创建标注（AI「写入批注」复用：选区可能在点击时已塌缩） */
	private async createAnnotationAt(cfi: string, text: string, kind: AnnotationKind, color: string,
		comment?: string): Promise<EpubAnnotation> {
		const ann: EpubAnnotation = {
			id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			cfi,
			text,
			kind,
			color,
			createdAt: Date.now(),
		};
		if (comment) ann.comment = comment;
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
		return ann;
	}

	/** AI 面板「写入批注」：把 AI 回答写为打开面板时捕获选段上的高亮批注 */
	private async saveAIAnnotation(comment: string): Promise<boolean> {
		const seed = this.aiAnnotSeed;
		if (!seed) {
			new Notice('写入失败：选区已失效，请重新选段', 2500);
			return false;
		}
		await this.createAnnotationAt(seed.cfi, seed.text, 'highlight', 'yellow', comment);
		new Notice('已写入批注', 1800);
		return true;
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

	private showSelectionToolbar(doc: Document, eraseTargets: EpubAnnotation[] = [], mobile = false): void {
		// 工具条形态一律以运行环境为准：Android 平板长按选段会合成 contextmenu（走下方桌面分支调用），
		// 不带 mobile 标记会建出桌面工具条（小图标 + 复制按钮），移动端加大样式也不会命中
		mobile = mobile || isMobileUI(this.plugin);
		const sel = doc.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
		const range0 = sel.getRangeAt(0);
		// 选区落在译文块上 → 不弹工具条：译文节点重开书后不存在，
		// 对其创建的 CFI 会失效（只允许对原文标注）
		const startEl = range0.startContainer instanceof Element
			? range0.startContainer
			: range0.startContainer.parentElement;
		if (startEl?.closest('.fleur-translation')) return;
		const text = sel.toString();
		if (!text.trim()) return;
		// 移动端：同一文档上工具条已在显示 → 不拆建（selectionchange 偶发连发时防闪烁），仅刷新快照
		if (mobile && this.selToolbar && this.currentSelDoc === doc) {
			this.selSnapshot = text;
			return;
		}
		this.selBarShownAt = Date.now();
		this.hideAnnPopup();
		this.hideSelectionToolbar();
		this.currentSelDoc = doc;
		this.selSnapshot = text;

		const range = sel.getRangeAt(0);
		// 跨页选区：union rect 的起点在当前页之外（位于前面的页），
		// 直接定位会把工具条/批注弹窗算到屏幕外（表现为「无法跨页标注」）。
		// 改用「当前视口内可见的最后一个 rect」（mouseup 端）作为定位锚。
		const anchorRect = this.visibleAnchorRect(range);
		const host = this.toHostCoords(doc, anchorRect.left, anchorRect.top);

		const bar = document.body.createDiv(mobile ? 'fleur-epub-mselbar' : 'fleur-epub-selbar');
		this.selToolbar = bar;

		const press = (el: HTMLElement) => el.addEventListener('mousedown', (e) => e.preventDefault());

		// 高亮三色（微信读书式；pink/purple 仅为旧数据兜底，不作为新标注入口）
		for (const key of HIGHLIGHT_COLOR_KEYS) {
			const color = HIGHLIGHT_COLORS[key];
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
				if (ann) this.showAnnotationEditor(ann, host.x, host.y);
			});
		});
		bar.createDiv('fleur-epub-selbar-sep');
		if (!mobile) {
			// 桌面专属：复制选段。移动端按决策①不放复制——避开 iOS/Android 系统
			// 选择菜单的冲突面，工具条只留系统菜单没有的能力（高亮/划线/AI/翻译）
			mkBtn('⧉', '复制选段', () => {
				void navigator.clipboard.writeText(this.selSnapshot).then(() => new Notice('已复制', 1500));
			});
		}
		mkBtn('AI', 'AI 解释', () => {
			// 打开面板前快照选区锚点：等用户点「写入批注」时选区多半已塌缩
			this.aiAnnotSeed = this.captureSelectionAnchor();
			// 收起原选区：Android 上选区手柄由合成器绘制，会浮在面板之上（表现为面板里残留「划线文本」）
			try { this.currentSelDoc?.getSelection()?.removeAllRanges(); } catch { /* 忽略 */ }
			new AIChatPanel(this.plugin, this.selSnapshot, 'explain', (comment) => this.saveAIAnnotation(comment)).open(host.x, host.y);
		});
		mkBtn('译', '翻译本段（原文下方嵌入译文）', () => {
			this.translateSelectionParagraph(doc);
		});

		// 右键处命中已有标注 → 工具条附加擦除项（对齐 fleur-pdf：清除项进右键菜单，不直接擦除）
		if (eraseTargets.length > 0) {
			bar.createDiv('fleur-epub-selbar-sep');
			mkBtn('⌫', '擦除标注', () => {
				for (const ann of eraseTargets) void this.deleteAnnotation(ann);
			});
		}

		if (mobile) {
			// 移动端：微信读书式——优先浮在选中文本正上方（带小箭头间距），
			// 上方放不下换到选段下方；上下都放不下才回退底部固定（CSS 默认 bottom）。
			window.requestAnimationFrame(() => {
				const bw = bar.offsetWidth;
				const bh = bar.offsetHeight;
				const margin = 8;
				// iOS：系统选择菜单（拷贝/查询/翻译…）悬浮在选段上方，本地工具条若
				// 同样贴近选段必然与它打架（截图实测重叠）；改为常驻底部居中
				// （微信读书同款位置），与系统菜单互不相扰。
				if (Platform.isIosApp) {
					const left = Math.max(margin, (window.innerWidth - bw) / 2);
					bar.setCssStyles({
						left: `${left}px`,
						top: 'auto',
						bottom: 'calc(72px + var(--fleur-epub-safe-bottom, 0px))',
					});
					return;
				}
				let left = host.x + anchorRect.width / 2 - bw / 2;
				left = Math.max(margin, Math.min(left, window.innerWidth - bw - margin));
				const topAbove = host.y - bh - 10;
				const topBelow = host.y + anchorRect.height + 10;
				if (topAbove >= margin + 48) {
					// 上方空间充足（避开顶栏 48px）
					bar.setCssStyles({ left: `${left}px`, top: `${topAbove}px`, bottom: 'auto' });
				} else if (topBelow + bh + margin <= window.innerHeight - 72) {
					// 下方空间充足（避开底部工具栏 72px）
					bar.setCssStyles({ left: `${left}px`, top: `${topBelow}px`, bottom: 'auto' });
				} else {
					// 上下都放不下（选段顶到边）→ 回退底部固定
					bar.setCssStyles({
						left: `${left}px`,
						top: 'auto',
						bottom: 'calc(72px + var(--fleur-epub-safe-bottom, 0px))',
					});
				}
			});
			return;
		}
		// 定位：可见选段上方居中；顶部放不下换到下方
		window.requestAnimationFrame(() => {
			const bw = bar.offsetWidth;
			const bh = bar.offsetHeight;
			let left = host.x + anchorRect.width / 2 - bw / 2;
			let top = host.y - bh - 8;
			left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
			if (top < 8) top = host.y + anchorRect.height + 8;
			bar.setCssStyles({ left: `${left}px`, top: `${top}px` });
		});
	}

	/** 跨页选区的定位锚：翻页模式下取与当前视口相交的最后一个选区 rect（mouseup 端）；
	 *  滚动模式或无匹配时回退 union rect。 */
	private visibleAnchorRect(range: Range): DOMRect {
		const rects = Array.from(range.getClientRects()).filter((x) => x.width > 0 && x.height > 0);
		if (this.plugin.settings.flow !== 'paginated' || rects.length === 0) {
			return rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
		}
		const r = this.foliateView?.renderer;
		const size = typeof r?.size === 'number' ? r.size : 0;
		const start = typeof r?.start === 'number' ? r.start : 0;
		if (size > 0) {
			const inView = rects.filter((x) => x.right > start + 8 && x.left < start + size - 8);
			if (inView.length) return inView[inView.length - 1];
		}
		return rects[rects.length - 1];
	}

	private hideSelectionToolbar(): void {
		// 移动端选区防抖定时器一并取消：翻页 / 收起后旧定时器不得复活工具条
		if (this.selChangeTimer) {
			window.clearTimeout(this.selChangeTimer);
			this.selChangeTimer = null;
		}
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
		// 移动端：bottom sheet 形态（纯 CSS 定位，见 styles.css 移动端段）
		if (isMobileUI(this.plugin)) panel.addClass('fleur-epub-appear--sheet');

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

		// ── 背景主题：五色圆形 swatch（纯白 · 浅色 · 深色 · 暖黄 · 豆绿）──
		const themeRow = mkRow('背景');
		themeRow.addClass('is-themes');
		for (const [key, t] of Object.entries(READER_THEMES)) {
			const sw = themeRow.createDiv('fleur-epub-appear-swatch');
			sw.setAttribute('aria-label', t.label);
			// 记 key：重置时按 key 找 active swatch（不依赖位置索引）
			sw.dataset.theme = key;
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

		// ── 首行：缩进 / 顶格 ──
		const indentRow = mkRow('首行');
		const indentBtns: HTMLElement[] = [];
		const INDENT_OPTS: Array<{ v: boolean; label: string }> = [
			{ v: true, label: '缩进' },
			{ v: false, label: '顶格' },
		];
		const renderIndent = () =>
			indentBtns.forEach((x, i) => x.toggleClass('is-active', INDENT_OPTS[i].v === (s.paraIndent !== false)));
		for (const o of INDENT_OPTS) {
			const b = indentRow.createEl('button', 'fleur-epub-appear-mini');
			b.setText(o.label);
			b.addEventListener('click', () => {
				s.paraIndent = o.v;
				renderIndent();
				persist();
			});
			indentBtns.push(b);
		}
		renderIndent();

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
		// 左右边距：独立于对称页边距的额外偏移，可做不对称排版（如左 70 / 右 40）
		mkSlider('左边距', 0, 80, 4, () => s.marginLeft ?? 0, (v) => (s.marginLeft = v), (v) => `${v}px`);
		mkSlider('右边距', 0, 80, 4, () => s.marginRight ?? 0, (v) => (s.marginRight = v), (v) => `${v}px`);

		// 对照翻译开关已移至顶栏（与 Aa 并置），此处不再重复提供

		// ── 重置 ──
		const resetRow = panel.createDiv('fleur-epub-appear-row is-reset');
		const resetBtn = resetRow.createEl('button', 'fleur-epub-appear-mini');
		resetBtn.setText('恢复默认排版');
		resetBtn.addEventListener('click', () => {
			s.fontSize = 16;
			s.lineHeight = 1.9;
			s.paraSpacing = 0.85;
			s.pageMargin = 36;
			s.marginLeft = 0;
			s.marginRight = 0;
			s.fontFamily = '';
			s.fontWeight = 400;
			s.paraIndent = true;
			s.theme = 'light';
			fillFontOptions();
			renderSize();
			renderWeight();
			renderIndent();
			panel.findAll('.fleur-epub-appear-swatch').forEach((d) => d.toggleClass('is-active', d.dataset.theme === 'light'));
			persist();
		});

		// 定位：移动端 = 底部 sheet（纯 CSS）；桌面 = 锚点下方右对齐（放不下改上方）
		if (panel.hasClass('fleur-epub-appear--sheet')) {
			panel.setCssStyles({ visibility: '' });
		} else {
			panel.setCssStyles({ visibility: 'hidden' });
			window.requestAnimationFrame(() => {
				const rect = anchor.getBoundingClientRect();
				const bw = panel.offsetWidth;
				const bh = panel.offsetHeight;
				const left = Math.max(8, Math.min(rect.right - bw, window.innerWidth - bw - 8));
				// 默认弹在锚点下方；下方放不下（移动端底部工具栏锚点、矮窗口）→ 改弹上方
				let top = rect.bottom + 8;
				if (top + bh > window.innerHeight - 8) top = Math.max(8, rect.top - bh - 8);
				panel.setCssStyles({ left: `${left}px`, top: `${top}px`, visibility: '' });
			});
		}

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

	/** 标注定位锚：优先用标注 range 的首个 rect（iframe 内容坐标 → 宿主坐标），兜底 lastMouseHost */
	private annHostFromRange(range?: Range): { x: number; y: number } {
		const doc = range?.startContainer?.ownerDocument as Document | undefined;
		if (doc && typeof range?.getClientRects === 'function') {
			const rects = (Array.from(range.getClientRects() as DOMRectList) as DOMRect[])
				.filter((r) => r.width > 0 || r.height > 0);
			const rect = rects[0];
			if (rect) return this.toHostCoords(doc, rect.left, rect.bottom);
		}
		return this.lastMouseHost;
	}

	/**
	 * 移动端点按标注 → 轻量批注卡：
	 * 有批注 → 批注内容直接可见，下方小工具栏（编辑 / 删除图标）；
	 * 纯高亮/划线（无批注）→ 只给「清除高亮/直线/波浪线」动作，不展示原文。
	 */
	private showAnnotationActionSheet(ann: EpubAnnotation, host: { x: number; y: number }): void {
		this.hideSelectionToolbar();
		this.hideAnnPopup();
		const pop = document.body.createDiv('fleur-epub-annview fleur-epub-annquick');
		this.annPopup = pop;

		// 纯高亮 / 划线（无批注内容）：点按不给「批注内容」，直接给清除动作（微信读书式）。
		// 把高亮原文当批注内容展示是错误的语义——高亮不是批注。
		const comment = cleanAnnotationText(ann.comment ?? '');
		if (!comment) {
			const clearLabel = this.describeAnnotation(ann);
			const row = pop.createDiv('fleur-epub-annview-clear');
			const btn = row.createDiv('fleur-epub-annquick-btn is-wide');
			btn.setAttribute('aria-label', clearLabel);
			setIcon(btn.createSpan('fleur-epub-annquick-icon'), 'eraser');
			btn.createSpan('fleur-epub-annquick-clearlabel').setText(clearLabel);
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.hideAnnPopup();
				void this.deleteAnnotation(ann);
			});
			this.mountAnnPopupClose(pop);
			this.placeAnnPopup(pop, host.x, host.y);
			return;
		}

		// 内容区：批注文字（120 字截断 + 展开切换）
		const MAX_CHARS = 120;
		const isLong = comment.length > MAX_CHARS;
		let expanded = false;
		const content = pop.createDiv('fleur-epub-annview-text');
		content.setText(isLong ? comment.slice(0, MAX_CHARS) + '...' : comment);
		if (isLong) {
			const hint = pop.createDiv('fleur-epub-annview-toggle');
			hint.setText('展开全文 ›');
			hint.addEventListener('click', (e) => {
				e.stopPropagation();
				expanded = !expanded;
				content.setText(expanded ? comment : comment.slice(0, MAX_CHARS) + '...');
				hint.setText(expanded ? '收起 ▲' : '展开全文 ›');
			});
		}

		// 小工具栏：纯图标按钮（编辑 / 删除），不带文字
		const bar = pop.createDiv('fleur-epub-annquick-bar');
		const editBtn = bar.createDiv('fleur-epub-annquick-btn');
		editBtn.setAttribute('aria-label', '编辑批注');
		setIcon(editBtn.createSpan('fleur-epub-annquick-icon'), 'pencil');
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.showAnnotationEditor(ann, host.x, host.y);
		});
		const delBtn = bar.createDiv('fleur-epub-annquick-btn is-danger');
		delBtn.setAttribute('aria-label', '删除批注');
		setIcon(delBtn.createSpan('fleur-epub-annquick-icon'), 'trash-2');
		delBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.hideAnnPopup();
			void this.deleteAnnotation(ann);
		});

		this.mountAnnPopupClose(pop);
		this.placeAnnPopup(pop, host.x, host.y);
	}

	// ── 批注弹窗（两个独立窗口，互不共享尺寸/位置）──
	// 编辑弹窗 fleur-epub-annpop：fleurPDF Comment Dialog 式（引用块 +「注释」标签 + 输入 + 取消/保存），
	//   高度自适应内容、按钮行永远可见；仅拖拽位置与宽度记忆。
	// 查看气泡 fleur-epub-annview：FleurAnnotation tooltip 式（轻量、高度自适应、展开/收起），无任何记忆。

	/** 编辑弹窗：添加/编辑批注（选区工具条 ✎ 进入） */
	private showAnnotationEditor(ann: EpubAnnotation, hostX: number, hostY: number): void {
		this.hideSelectionToolbar();
		this.hideAnnPopup();
		const pop = document.body.createDiv('fleur-epub-annpop');
		this.annPopup = pop;

		// 只恢复用户记忆的宽度；高度自适应内容（此前高度记忆会遮住底部按钮行，已废弃）
		const savedSize = this.plugin.settings.annPopSize;
		if (savedSize?.w) {
			pop.setCssStyles({ width: `${savedSize.w}px` });
		}

		// 标题栏：整条可拖拽（仅当次生效，不记忆位置，每次打开仍贴批注文本旁），右侧 ✕ 关闭
		const header = pop.createDiv('fleur-epub-annpop-header');
		header.createDiv('fleur-epub-annpop-header-title').setText('批注');
		const closeBtn = header.createSpan('fleur-epub-annpop-close');
		closeBtn.setText('✕');
		closeBtn.setAttribute('aria-label', '关闭');
		closeBtn.addEventListener('click', () => this.hideAnnPopup());

		let drag: { sx: number; sy: number; ox: number; oy: number } | null = null;
		header.addEventListener('pointerdown', (e) => {
			// ✕ 按钮上按下不进入拖拽
			if (closeBtn.contains(e.target as Node)) return;
			e.preventDefault();
			const rect = pop.getBoundingClientRect();
			drag = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top };
			try {
				header.setPointerCapture(e.pointerId);
			} catch { /* 忽略 */ }
		});
		header.addEventListener('pointermove', (e) => {
			if (!drag) return;
			pop.setCssStyles({
				left: `${drag.ox + e.clientX - drag.sx}px`,
				top: `${drag.oy + e.clientY - drag.sy}px`,
			});
		});
		const endDrag = () => {
			drag = null;
		};
		header.addEventListener('pointerup', endDrag);
		header.addEventListener('pointercancel', endDrag);

		// 右下角缩放手柄：只调宽度（高度由内容自适应，不出屏）
		const resize = pop.createDiv('fleur-epub-annpop-resize');
		resize.setAttribute('aria-label', '调整大小');
		let rs: { sx: number; sy: number; w: number } | null = null;
		resize.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const rect = pop.getBoundingClientRect();
			rs = { sx: e.clientX, sy: e.clientY, w: rect.width };
			try {
				resize.setPointerCapture(e.pointerId);
			} catch { /* 忽略 */ }
		});
		resize.addEventListener('pointermove', (e) => {
			if (!rs) return;
			const w = Math.max(260, Math.min(rs.w + e.clientX - rs.sx, window.innerWidth - 16));
			pop.setCssStyles({ width: `${w}px` });
		});
		const endResize = () => {
			if (!rs) return;
			rs = null;
			const rect = pop.getBoundingClientRect();
			this.plugin.settings.annPopSize = { w: Math.round(rect.width), h: 0 };
			void this.plugin.saveSettings();
		};
		resize.addEventListener('pointerup', endResize);
		resize.addEventListener('pointercancel', endResize);

		// 正文区（fleurPDF Comment Dialog 式）：标注原文引用块 →「注释」标签 → 输入框 → 按钮行
		const body = pop.createDiv('fleur-epub-annpop-body');
		if (ann.text) {
			const quote = body.createDiv('fleur-epub-annpop-quote');
			quote
				.createDiv('fleur-epub-annpop-quote-bar')
				.setCssProps({ '--fleur-hl-color': HIGHLIGHT_COLORS[ann.color] ?? '#f2c14e' });
			quote.createDiv('fleur-epub-annpop-quote-text').setText(ann.text);
		}
		body.createDiv('fleur-epub-annpop-label').setText('注释');
		const ta = body.createEl('textarea', 'fleur-epub-annpop-input');
		ta.placeholder = '写下你的想法…';
		ta.value = ann.comment ?? '';

		const doSave = () => {
			ann.comment = ta.value.trim() || undefined;
			this.saveBookData();
			// 广播变更（侧边栏即时刷新）
			this.plugin.notifyAnnotationsChanged();
			new Notice('批注已保存', 1500);
			this.hideAnnPopup();
		};

		// 按钮行：右「取消 / 保存」（对齐 fleurPDF；删除标注走侧边栏，此处不放）
		const row = body.createDiv('fleur-epub-annpop-btnrow');
		const right = row.createDiv('fleur-epub-annpop-btnrow-right');
		const cancel = right.createEl('button', 'fleur-epub-annpop-btn is-ghost');
		cancel.setText('取消');
		cancel.addEventListener('click', () => this.hideAnnPopup());
		const ok = right.createEl('button', 'fleur-epub-annpop-btn is-accent');
		ok.setText('保存');
		ok.addEventListener('click', doSave);
		ta.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSave();
		});

		this.mountAnnPopupClose(pop);
		this.placeAnnPopup(pop, hostX, hostY);
		window.setTimeout(() => ta.focus(), 60);
	}

	/** 查看气泡：点击已有批注弹出（FleurAnnotation tooltip 式，高度自适应 + 展开/收起） */
	private showAnnotationViewer(ann: EpubAnnotation, hostX: number, hostY: number): void {
		this.hideSelectionToolbar();
		this.hideAnnPopup();
		const pop = document.body.createDiv('fleur-epub-annview');
		this.annPopup = pop;

		// 顶部拖拽手柄：默认贴标注旁出现，可拖拽挪开（位置不记忆，下次仍在标注旁）
		const grip = pop.createDiv('fleur-epub-annview-grip');
		grip.setAttribute('aria-label', '拖拽移动');
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
			const w = pop.offsetWidth;
			const h = pop.offsetHeight;
			const left = Math.min(Math.max(8, drag.ox + e.clientX - drag.sx), window.innerWidth - w - 8);
			const top = Math.min(Math.max(8, drag.oy + e.clientY - drag.sy), window.innerHeight - h - 8);
			pop.setCssStyles({ left: `${left}px`, top: `${top}px` });
		});
		const endDrag = () => {
			drag = null;
		};
		grip.addEventListener('pointerup', endDrag);
		grip.addEventListener('pointercancel', endDrag);

		// 批注内容以正常字体、纯文本展示：去 Markdown 源码，120 字截断 +「展开全文 ›/收起 ▲」
		const comment = cleanAnnotationText(ann.comment ?? '');
		const MAX_CHARS = 120;
		const isLong = comment.length > MAX_CHARS;
		let expanded = false;
		const content = pop.createDiv('fleur-epub-annview-text');
		content.setText(isLong ? comment.slice(0, MAX_CHARS) + '...' : comment);
		if (isLong) {
			const hint = pop.createDiv('fleur-epub-annview-toggle');
			hint.setText('展开全文 ›');
			hint.addEventListener('click', (e) => {
				e.stopPropagation();
				expanded = !expanded;
				content.setText(expanded ? comment : comment.slice(0, MAX_CHARS) + '...');
				hint.setText(expanded ? '收起 ▲' : '展开全文 ›');
			});
		}

		this.mountAnnPopupClose(pop);
		this.placeAnnPopup(pop, hostX, hostY);
	}

	/** 弹窗定位：统一贴批注文本旁（放不下翻到上方）；不记忆拖拽位置，每次打开都重新定位 */
	private placeAnnPopup(pop: HTMLElement, hostX: number, hostY: number): void {
		pop.setCssStyles({ visibility: 'hidden' });
		window.requestAnimationFrame(() => {
			const bw = pop.offsetWidth;
			const bh = pop.offsetHeight;
			const left = Math.max(8, Math.min(hostX - bw / 2, window.innerWidth - bw - 8));
			let top = hostY + 14;
			if (top + bh > window.innerHeight - 8) top = Math.max(8, hostY - bh - 14);
			pop.setCssStyles({ left: `${left}px`, top: `${top}px`, visibility: '' });
		});
	}

	/**
	 * 书内链接接管（微信读书式脚注弹卡）：
	 * 分级识别脚注 → 弹脚注内容卡；其余链接保持跳转。
	 * 任何环节失败都退回 goTo——最坏情况等于旧版行为。
	 */
	private async handleBookLink(a: HTMLElement | null | undefined, href: string | undefined): Promise<void> {
		if (!href) return;
		const trace = (msg: string) => {
			if (this.plugin.settings.mobileDebug) new Notice(`fleur-epub link: ${msg}`, 4000);
		};
		try {
			const view = this.foliateView;
			const book = view?.book;
			if (!view || !book?.resolveHref) return void view?.goTo(href);
			const resolved = book.resolveHref(href);
			if (!resolved || typeof resolved.index !== 'number') {
				trace(`${href} → jump（resolveHref 失败）`);
				return void view.goTo(href);
			}
			const { index, anchor } = resolved;

			// 目标元素：同章用 live doc（即时、免解析），跨章用 createDocument 离线解析
			let doc: Document | null = null;
			const live = (view.renderer?.getContents?.() ?? []).find((c: { index?: number }) => c.index === index);
			if (live?.doc) doc = live.doc as Document;
			else doc = (await book.sections?.[index]?.createDocument?.()) ?? null;
			let el: Element | null | undefined = doc ? anchor?.(doc) : null;
			// 兜底：folio 的 getHTMLFragment 只认 id，部分书用 name 属性锚点
			if (!el && doc && href.includes('#')) {
				const hash = decodeURIComponent(href.split('#')[1] ?? '');
				if (hash) el = doc.getElementById(hash) ?? doc.querySelector(`[name="${CSS.escape(hash)}"]`);
			}
			if (!el) {
				trace(`${href} → jump（目标元素未找到）`);
				return void view.goTo(href);
			}

			// 分级识别脚注（标准标记 → class → 结构启发式）
			if (!this.isFootnoteLink(a, el)) {
				trace(`${href} → jump（非脚注链接）`);
				return void view.goTo(href);
			}

			const text = this.extractFootnoteText(el, a?.textContent ?? '');
			if (!text) {
				trace(`${href} → jump（脚注内容为空）`);
				return void view.goTo(href);
			}

			// 卡片锚定引用处：取引用元素在宿主坐标的位置（iframe 内 rect → 宿主坐标）
			let host = this.lastMouseHost;
			try {
				const rect = a?.getBoundingClientRect?.();
				if (a?.ownerDocument && rect) host = this.toHostCoords(a.ownerDocument, rect.left, rect.bottom);
			} catch { /* 忽略，退回鼠标位置 */ }
			trace(`${href} → 弹卡`);
			this.showFootnoteCard(text, href, host);
		} catch (err) {
			trace(`${href} → jump（异常 ${err instanceof Error ? err.message : err}）`);
			this.foliateView?.goTo(href);
		}
	}

	/**
	 * 分级识别脚注链接：
	 * ① 标准标记：引用侧 epub:type/role=noteref；目标侧 footnote/note、doc-footnote、aside
	 * ② class 兜底：footnote / noteref / endnote / sidenote（避免过宽的 note 全匹配）
	 * ③ 结构启发式：短文本标记（上标 / 数字 / 符号序号）指向小块元素 → 视为脚注
	 */
	private isFootnoteLink(a: HTMLElement | null | undefined, el: Element | null | undefined): boolean {
		const mark = (x: Element | null | undefined) =>
			`${x?.getAttribute?.('epub:type') ?? ''} ${x?.getAttribute?.('role') ?? ''}`;
		const cls = (x: Element | null | undefined) => x?.getAttribute?.('class') ?? '';
		if (/noteref/i.test(mark(a))) return true;
		if (/footnote|sidenote|endnote|\bnote\b/i.test(mark(el))) return true;
		if (el?.tagName?.toLowerCase() === 'aside') return true;
		if (/(^|[\s_-])(footnote|noteref|endnote|sidenote)/i.test(`${cls(a)} ${cls(el)}`)) return true;
		// 结构启发式：引用是短文本（≤8 字符）且含序号形态（数字/星号/剑号/圈码），目标为小块正文
		const refText = (a?.textContent ?? '').trim();
		const elText = (el?.textContent ?? '').trim();
		const markerLike = !!a?.querySelector?.('sup')
			|| a?.parentElement?.tagName?.toLowerCase() === 'sup'
			|| /[\d\*\u2020\u2021\u00a7\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]/.test(refText);
		const shortRef = refText.length > 0 && refText.length <= 8;
		const smallTarget = elText.length > 0 && elText.length <= 500 && !/^h[1-6]$/i.test(el?.tagName ?? '');
		return !!(markerLike && shortRef && smallTarget);
	}

	/** 提取脚注纯文本：按块级元素分段；剥掉回链小链接（↩ / 返回 / ↑ 等）避免噪声 */
	private extractFootnoteText(el: Element, refText = ''): string {
		const collect = (node: Element): string => {
			const clone = node.cloneNode(true) as Element;
			clone.querySelectorAll('a[href]').forEach((x) => {
				const t = (x.textContent ?? '').trim();
				// 仅剥回链符号（↩ ↑ ← 返回 等）；普通链接（哪怕短）保文字去壳，不丢内容
				if (!t || /^[↩↑←⟲⌂🔙\s]+$/.test(t) || t === '返回') x.remove();
				else x.replaceWith(...Array.from(x.childNodes));
			});
			// 嵌套脚注容器（<div id=n2>(2)…<div id=n3>…</div>…）：截掉带 id 的后续子块，只留本条
			const idKids = Array.from(clone.children).filter((c) => c.hasAttribute('id') || c.hasAttribute('name'));
			if (idKids.length >= 2) {
				const cut = Array.prototype.indexOf.call(clone.children, idKids[1]);
				if (cut > 0) while (clone.children.length > cut) clone.children[clone.children.length - 1].remove();
			}
			const blocks = Array.from(clone.querySelectorAll('p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6'));
			const lines = blocks.length
				? blocks.map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
				: [(clone.textContent ?? '').replace(/\s+/g, ' ').trim()];
			return lines.filter(Boolean).join('\n');
		};
		// 纯序号形态：「(1)」「[2]」「*」「①」等——说明锚点落在词典 dt / 独立标记节点上
		const isMarkerOnly = (t: string) => /^[(\[]?[0-9*†‡§①-⑳]{1,4}[)\].。]?$/.test(t.replace(/\s+/g, ''));
		// 同一父级内、锚点之后直到下一个带 id 元素（下一条标记）之间的内容 = 本条正文
		const collectTail = (node: Element): string => {
			let out = '';
			let n: Node | null = node.nextSibling;
			while (n) {
				if (n.nodeType === Node.ELEMENT_NODE) {
					const e = n as Element;
					if (e.hasAttribute('id') || e.hasAttribute('name')) break;
					// 内联壳（span/sup 等）：剥回链符号后并入
					out += (e.textContent ?? '').replace(/[↩↑←⟲⌂🔙]/g, '');
				} else {
					out += n.textContent ?? '';
				}
				n = n.nextSibling;
			}
			return out.replace(/\s+/g, ' ').trim();
		};
		// 序号分段：提取结果含多条脚注（无 id 平铺容器）时，按引用序号切出对应条目
		const sliceByMarker = (full: string, want: number): string | null => {
			const ms = Array.from(full.matchAll(/[(（\[]?(\d{1,3})[)）\].、．]/g));
			if (ms.length < 2) return null;
			const nums = ms.map((m) => parseInt(m[1]!, 10));
			const idx = nums.indexOf(want);
			if (idx < 0) return null;
			let inc = 0;
			for (let i = 1; i < nums.length; i++) if (nums[i]! > nums[i - 1]!) inc++;
			if (inc < nums.length - 2) return null; // 序号非递增 → 不是脚注列表，不切
			const start = ms[idx]!.index ?? 0;
			const end = idx + 1 < ms.length ? ms[idx + 1]!.index ?? full.length : full.length;
			return full.slice(start, end).trim() || null;
		};
		let text = collect(el).trim();
		if (text && isMarkerOnly(text)) {
			// ① 本条正文是同一父级内、锚点之后的节点（p.fnote：<a id>(2)</a> 沈佺期诗：…）——
			//    nextElementSibling 会跳过文本节点误取下一条，必须先沿 nextSibling 收集
			const tail = collectTail(el);
			if (tail && !isMarkerOnly(tail)) {
				return `${text}\n${tail}`;
			}
			// ② 正文在相邻元素（dd / 下一段 / 下一个 li）——向后找最多 3 个兄弟
			let sib = el.nextElementSibling;
			for (let i = 0; sib && i < 3; i++) {
				const t = collect(sib).trim();
				if (t && !isMarkerOnly(t)) {
					text = `${text}\n${t}`;
					return text;
				}
				sib = sib.nextElementSibling;
			}
			// ③ 兜底：el 是包裹层的子标记（如 <li><sup id>…</sup></li>），从父层的下一个兄弟找
			const parent = el.parentElement;
			if (parent && parent !== el.ownerDocument?.body) {
				let psib = parent.nextElementSibling;
				for (let i = 0; psib && i < 3; i++) {
					const t = collect(psib).trim();
					if (t && !isMarkerOnly(t)) {
						text = `${text}\n${t}`;
						return text;
					}
					psib = psib.nextElementSibling;
				}
			}
		}
		// 引用侧带数字且提取文本包含多条递增序号 → 只保留对应条目
		if (text) {
			const refNum = refText.match(/\d{1,3}/);
			if (refNum) {
				const seg = sliceByMarker(text, parseInt(refNum[0], 10));
				if (seg && seg.length < text.length) text = seg;
			}
		}
		return text;
	}

	/** 脚注卡片（微信读书式）：标题 + 可滚动内容 + 「查看脚注位置」跳转（长尾注兜底） */
	private showFootnoteCard(text: string, href: string, host: { x: number; y: number }): void {
		this.hideSelectionToolbar();
		this.hideAnnPopup();
		const pop = document.body.createDiv('fleur-epub-annview fleur-epub-fnview');
		this.annPopup = pop;
		pop.createDiv('fleur-epub-fnview-head').setText('脚注');
		pop.createDiv('fleur-epub-fnview-body').setText(text);
		const jump = pop.createEl('button', 'fleur-epub-fnview-jump');
		jump.setText('查看脚注位置 ›');
		jump.addEventListener('click', (ev) => {
			ev.stopPropagation();
			this.hideAnnPopup();
			void this.foliateView?.goTo(href);
		});
		this.mountAnnPopupClose(pop);
		this.placeAnnPopup(pop, host.x, host.y);
	}

	/** 全局关闭：点击卡片外部或按 Esc（同一时刻只显示一个弹窗） */
	private mountAnnPopupClose(pop: HTMLElement): void {
		// 记录弹出时间：relocate 监听在宽限期内不闪掉刚弹出的弹窗
		this.annPopupShownAt = Date.now();
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

	/** 当前阅读进度百分比（移动端进度 sheet 用） */
	getCurrentPercent(): number | null {
		const p = this.bookData?.progress?.percent;
		return typeof p === 'number' ? p : null;
	}

	/** 移动端工具栏 AI：自由问答面板（不依赖选段，与划词「AI 解释」互补） */
	openAIAsk(): void {
		new AIChatPanel(this.plugin, '', 'ask').open();
	}

	/** 导出当前书全部批注为 Markdown 笔记（移动端批注 sheet 入口；与桌面书架共用实现） */
	exportAnnotations(): void {
		void exportAnnotationsToNote(this.plugin, this);
	}

	/** 按全书比例跳转（移动端进度 slider 用，foliate goToFraction） */
	async goToFraction(frac: number): Promise<void> {
		const view = this.foliateView;
		if (!view || typeof view.goToFraction !== 'function') return;
		try {
			await view.goToFraction(Math.max(0, Math.min(1, frac)));
		} catch (err) {
			console.warn('[FleurEPUB] 比例跳转失败', err);
		}
	}

	/** 移动端底部工具栏「设置」入口：复用桌面 Aa 外观面板（定位自适应上/下方） */
	openAppearancePanelFrom(anchor: HTMLElement): void {
		this.toggleAppearancePanel(anchor);
	}

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
			// 移动端：定位触发的 show-annotation 只闪位置，不弹 action sheet
			this.locating = true;
			await this.foliateView?.showAnnotation({ value: cfi });
			const ann = this.bookData?.annotations.find((x) => x.cfi === cfi);
			if (ann) this.flashAnnotation(ann);
		} catch (err) {
			console.warn('[FleurEPUB] 标注定位失败', err);
		} finally {
			window.setTimeout(() => {
				this.locating = false;
			}, 400);
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

	/**
	 * 重挂全部标注：等待目标章节的 overlayer 就绪后再执行。
	 * foliate 的 load 事件（paginator afterLoad）先于 create-overlayer 派发、
	 * 更先于 renderer.#view 切换，load 时机挂载会被 #getOverlayer 静默丢弃。
	 * addAnnotation 内部按当前 section 过滤，非当前章节自动跳过，全量重挂开销可忽略。
	 */
	private remountAnnotationsWhenReady(view: any, index: number | null): void {
		if (this.annMountTimer !== null) {
			window.clearTimeout(this.annMountTimer);
			this.annMountTimer = null;
		}
		let tries = 0;
		const attempt = () => {
			this.annMountTimer = null;
			if (!this.bookData || this.foliateView !== view) return;
			const contents = view.renderer?.getContents?.() ?? [];
			const ready = contents.some((c: any) => c.overlayer && (index === null || c.index === index));
			if (!ready && tries++ < 50) {
				// overlayer 未就绪（章节文档尚未完成渲染），40ms 后重试
				this.annMountTimer = window.setTimeout(attempt, 40);
				return;
			}
			for (const a of this.bookData.annotations) {
				void view.addAnnotation({ value: a.cfi, ...a }).catch(() => {});
			}
		};
		attempt();
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
		// 停掉翻译引擎（中止在途请求）
		this.translator?.setActive(false);
		this.translator = null;
		this.renderTranslateState();
		if (this.annMountTimer !== null) {
			window.clearTimeout(this.annMountTimer);
			this.annMountTimer = null;
		}
		if (this.bookData) {
			await this.plugin.bookStore.save(this.bookData);
			this.bookData = null;
		}
		try {
			// foliate-view 的 View 只有 close()（销毁 renderer 并移除元素），没有 destroy()；
			// 之前只调 destroy?.() 是静默 no-op，paginator 从未销毁，关书后布局变化仍会
			// 触发 render → columnize 读到 null documentElement（连弹 err toast 的根因）
			this.foliateView?.close?.();
			await this.foliateView?.destroy?.();
		} catch { /* 忽略销毁异常 */ }
		this.foliateView = null;
		this.loadedPath = null;
		this.hideSelectionToolbar();
		this.hideAnnPopup();
	}

	async onClose(): Promise<void> {
		this.setImmersive(false);
		if (this.leafChangeRef) {
			this.app.workspace.offref(this.leafChangeRef);
			this.leafChangeRef = null;
		}
		this.ttsModal?.close();
		this.ttsModal = null;
		this.ttsUnsub?.();
		this.ttsUnsub = null;
		this.tts?.destroy();
		this.tts = null;
		await this.teardownBook();
		this.chrome?.destroy();
		this.chrome = null;
		this.contentEl.empty();
	}
}
