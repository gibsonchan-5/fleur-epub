/**
 * 段落对照翻译引擎（微信读书式：原文段落尾部嵌入译文块）
 *
 * 架构约束（为什么这样插）：
 * - 译文以 span.fleur-translation（display:block）追加在段落内部末尾，
 *   不新增/删除/移动任何已有兄弟节点与文本节点 → 既有 EPUB CFI 锚定全部不受影响；
 * - 译文只存在于章节 iframe 的活动 DOM，不写回书文件，重开书后天然干净；
 * - 选区落在译文上时禁止创建标注（CFI 会指向重开书后不存在的节点）。
 *
 * 推进策略（视口优先的渐进翻译）：
 * - P0 视口内：用户**当前正在读的那一屏**最先翻译并嵌入 → 开启后立刻可见；
 * - P1 前后一屏：预取，往下翻不用等；
 * - P2 本章其余：后台静默推进，直到整章翻完；
 * - P3 相邻章节：最后。换章时立刻丢弃旧章待翻项（不为跳过的内容烧 token）。
 * 滚动 / 翻页 / 换章都会重排优先级；调度器永远取优先级最高的段落，而不是按章节从头串行。
 *
 * token 经济性：
 * - 最大单元 = 当前章节，全书永不发送；
 * - 段落**按批**请求（BATCH_SIZE 段 / 请求，分隔符协议），首屏通常 1 个请求即完成，
 *   避免「逐段串行 + 每段一次往返」的慢；分隔符数量对不上时自动退回逐段请求，宁慢勿错；
 * - 译文按「段落文本哈希」缓存进 BookData.translations，重复阅读零消耗。
 */

import { stripMarkdown } from './text-utils';
import { hashString } from './store';
import { AIService } from './ai-service';
import { translateBatchMicrosoft } from './mt-service';
import type FleurEpubPlugin from './main';

const TRANSLATION_CLASS = 'fleur-translation';
/** 文言（古汉语→白话）译文的灰显样式类 */
const CLASSICAL_CLASS = 'fleur-translation-classical';
/** 段落最小有效字符数（过短的行号、空白段不翻） */
const MIN_PARA_LEN = 4;
/** 单次请求合并的段落数（AI 分隔符协议，首屏通常 1 个请求即可完成） */
const BATCH_SIZE = 6;
/** 微软机翻单批段数（原生数组批量接口，一次可带几十段） */
const MT_BATCH_SIZE = 50;
/** 同时在飞的请求数（对上游接口友好） */
const CONCURRENCY = 2;
/** 视口判定松弛量（px）：上下各放宽一点，让临界段落一起翻 */
const VISIBLE_MARGIN = 140;
/** 视口之后预取的段数（往下翻不用等） */
const PREFETCH_AHEAD = 12;
/** 视口之前预取的段数（往回翻不用等） */
const PREFETCH_BACK = 4;
/** 视口重排节流（ms） */
const FOCUS_THROTTLE = 160;
/** 失败段落的冷却时长（ms）：避免滚动时对同一段反复重试 */
const FAIL_COOLDOWN = 30000;
/** 单书译文缓存上限（防 JSON 无限膨胀） */
const MAX_CACHE_ENTRIES = 6000;
/** 批请求分隔符（要求模型原样回传；数量对不上则退回逐段请求） */
const SEP = '<<<FLEURSEP>>>';
const SEP_RE = /<{2,}\s*FLEUR\s*_?\s*SEP\s*>{2,}/gi;

const TRANSLATE_SYSTEM_PROMPT = `你是专业的书籍翻译。对用户给出的一个段落，自动识别其语言并处理：
- 外文（英/日/韩/法/德/俄/西/葡等）→ 翻译成流畅自然的现代简体中文；
- 文言文或古汉语 → 翻译成通俗易懂的白话文；
- 内容本身已是简体中文 → 原样返回，不做改写。
要求：
- 只输出译文正文：不要任何解释、前缀、引号、编号或 markdown 标记；
- 仅当原文是文言文/古汉语时，在译文最前面加标记〔古〕（紧贴译文，之后不加空格）；
  外文翻译和原样返回的段落一律不加该标记；
- 保留原文的换行结构，诗歌逐行翻译；
- 专有名词首次出现可在括号中附注原文。
- 输入可能是多段，段与段之间用 ${SEP} 分隔；输出必须用**同一个分隔符**逐段对应返回，
  段数严格一致，既不要合并也不要拆分段落，分隔符前后不要加任何多余内容。`;

/** 文言译文标记（模型输出前缀，插入 DOM 前剥掉、转成样式类） */
const CLASSICAL_MARK = '〔古〕';
/** 宽容匹配模型可能换用的括号形态：〔古〕【古】[古] 等 */
const CLASSICAL_MARK_RE = /^[〔\[【]\s*古\s*[〕\]】]\s*/;

/**
 * 剥掉文言标记，返回是否文言译文与纯译文文本。
 * 未加标记（外文译文 / 原样返回 / 旧缓存）按普通译文处理，降级无害。
 */
function parseClassicalMark(raw: string): { classical: boolean; text: string } {
	const classical = CLASSICAL_MARK_RE.test(raw);
	return { classical, text: classical ? raw.replace(CLASSICAL_MARK_RE, '').trim() : raw };
}

/**
 * 原文是否以中文为主（不含日文假名）。
 * 用于旧缓存兜底：缓存里的译文可能没有〔古〕标记（标记功能上线前翻的），
 * 但「原文是中文 + 译文不同」本身就说明这是文言→白话翻译（现代中文原样返回的
 * 段落走 unchanged 判定，根本到不了插入这一步）；含假名的日语段排除。
 */
function looksLikeChineseSource(source: string): boolean {
	if (!source) return false;
	if (/[\u3040-\u30ff]/.test(source)) return false;
	const cjk = (source.match(/[\u4e00-\u9fff]/g) ?? []).length;
	return cjk / source.length > 0.5;
}

/**
 * 可作为「一段」采集的块级标签。
 *
 * ⚠️ 必须全小写：EPUB 章节 iframe 的文档是 application/xhtml+xml（按 XML 解析），
 * XML 文档里选择器与 tagName 都是**大小写敏感**的——用 'P' 去匹配 <p> 会得到 0 个结果，
 * 表现为「开启对照翻译后毫无反应」。（HTML 文档里小写选择器同样能匹配，故统一小写。）
 */
const BLOCK_TAGS = [
	'p', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'li', 'dd', 'dt', 'figcaption', 'pre',
] as const;

const BLOCK_TAG_SET = new Set<string>(BLOCK_TAGS);
const BLOCK_SELECTOR = BLOCK_TAGS.join(',');

/** 块级标签判定：XML 文档 tagName 为小写、HTML 文档为大写，统一转小写比较 */
function isBlockTag(el: Element | null | undefined): boolean {
	return !!el && BLOCK_TAG_SET.has(el.tagName.toLowerCase());
}

/** XHTML 命名空间（XML 文档里创建元素必须显式指定，否则插入的节点不参与正常渲染） */
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/** 采集章节内可翻译的段落（叶块去重：含子块的容器跳过；已有译文的跳过） */
export function collectParagraphs(doc: Document): HTMLElement[] {
	const body = doc?.body;
	if (!body) return [];
	const all = Array.from(body.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
	return all.filter((el) => {
		if (el.closest(`.${TRANSLATION_CLASS}`)) return false;
		// 已嵌入译文的段落不再采集
		if (el.querySelector(`:scope > .${TRANSLATION_CLASS}`)) return false;
		// 含有其他候选块的容器（blockquote > p / li > p）→ 只翻最内层
		if (el.querySelector(BLOCK_SELECTOR)) return false;
		const text = el.textContent?.trim() ?? '';
		return text.length >= MIN_PARA_LEN;
	});
}

/** 选区所在的可翻译段落（向上找最近的候选块） */
export function findParagraphEl(node: Node | null): HTMLElement | null {
	let el = node instanceof Element ? node : node?.parentElement ?? null;
	while (el && el !== el.ownerDocument?.body) {
		if (isBlockTag(el)) return el as HTMLElement;
		el = el.parentElement;
	}
	return null;
}

/** 宿主坐标下的阅读视口矩形（由 reader-view 注入） */
export interface ViewportBand {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export interface TranslatorHooks {
	/** 当前书数据（缓存写入 translations），关书后为 null */
	getData: () => { translations?: Record<string, string> } | null;
	/** 节流持久化由调用方负责 */
	save: () => void;
	/** 进度回调（视口批次变化 / 每批完成时触发） */
	onProgress?: (state: TranslateProgress) => void;
	/** 需要用户可见的提示（配置缺失 / 全章无需翻译等） */
	onNotice?: (message: string, timeout?: number) => void;
}

/** 单段翻译结果：ok=已嵌入 / same=无需翻译（已是目标语言）/ fail=请求失败 */
export type ParagraphResult = 'ok' | 'same' | 'fail';

/** 推进阶段：visible=正在翻当前视口（显示计数）/ rest=后台续翻其余内容 */
export type TranslatePhase = 'idle' | 'visible' | 'rest';

export interface TranslateProgress {
	active: boolean;
	phase: TranslatePhase;
	/** 当前视口批次的完成数 */
	done: number;
	/** 当前视口批次需要请求的段数 */
	total: number;
	/** 队列中尚待处理的段数（含在飞） */
	pending: number;
}

/** 优先级：数值越小越先执行 */
const PRIORITY = {
	/** 当前视口内 */
	VISIBLE: 0,
	/** 视口前后一屏（预取） */
	NEAR: 1,
	/** 本章其余 */
	REST: 2,
	/** 相邻章节 */
	SIBLING: 3,
} as const;

interface QueueItem {
	el: HTMLElement;
	doc: Document;
	/** 入队时的原文快照（插入译文后 textContent 会变，绝不再读） */
	source: string;
	/** 段落文本哈希（同上，必须在插入前算好） */
	key: string;
	prio: number;
	seq: number;
}

export class TranslationEngine {
	private controllers = new Set<AbortController>();
	private active = false;
	/** 待翻队列（按元素去重，同段落只排一次） */
	private queue = new Map<HTMLElement, QueueItem>();
	/** 在飞请求数 */
	private running = 0;
	private seq = 0;
	private currentDoc: Document | null = null;
	/** 当前视口批次的段落集合与进度 */
	private visibleTargets = new Set<HTMLElement>();
	private visibleDone = 0;
	private visibleTotal = 0;
	private saveTimer: number | null = null;
	private focusTimer: number | null = null;
	/** 最近一次请求失败原因（AI 未配置 / 网络 / 接口报错），供 UI 提示 */
	private lastError: string | null = null;
	/** 失败段落 → 允许重试的时间点（避免滚动时对同一段反复重试） */
	private failed = new Map<HTMLElement, number>();
	/** 模型判定「原文已是中文」的段落（内存态，不污染持久缓存） */
	private unchangedEls = new WeakSet<Element>();
	/** 整章判定为无需翻译（中文书自适应：连续多段无需翻译后直接跳过整章） */
	private skippedDocs = new WeakSet<Document>();
	private docStats = new Map<Document, { offered: number; unchanged: number }>();

	/** 章节文档提供器由 reader-view 注入（返回当前已加载的全部章节 doc） */
	docsProvider: (() => Document[]) | null = null;
	/** 阅读视口（宿主坐标）：用于判定「用户正在读的那一屏」 */
	viewportProvider: (() => ViewportBand | null) | null = null;
	/** 当前章节文档提供器 */
	currentDocProvider: (() => Document | null) | null = null;

	constructor(
		private plugin: FleurEpubPlugin,
		private hooks: TranslatorHooks,
	) {}

	isActive(): boolean {
		return this.active;
	}

	/** 当前翻译引擎（设置里选择；microsoft = 微软机翻，免密钥） */
	private useMicrosoft(): boolean {
		return (this.plugin.settings.translationEngine ?? 'ai') === 'microsoft';
	}

	/** 单批段数上限：机翻走原生数组批量接口，可以带更多段 */
	private batchSize(): number {
		return this.useMicrosoft() ? MT_BATCH_SIZE : BATCH_SIZE;
	}

	getLastError(): string | null {
		return this.lastError;
	}

	getProgress(): TranslateProgress {
		const total = this.visibleTotal;
		const done = Math.min(this.visibleDone, total);
		const pending = this.queue.size + this.running;
		const phase: TranslatePhase = !this.active
			? 'idle'
			: total > 0 && done < total ? 'visible' : pending > 0 ? 'rest' : 'idle';
		return { active: this.active, phase, done, total, pending };
	}

	private emit(): void {
		this.hooks.onProgress?.(this.getProgress());
	}

	/** 开关：开 → 视口优先翻译；关 → 中止请求并移除全部译文节点 */
	setActive(on: boolean): void {
		if (on === this.active) return;
		this.active = on;
		if (on) {
			this.failed.clear();
		} else {
			this.abortAll();
			this.queue.clear();
			this.visibleTargets.clear();
			this.visibleDone = this.visibleTotal = 0;
			this.currentDoc = null;
			this.hooks.save();
			for (const doc of this.docsProvider?.() ?? []) this.removeTranslations(doc);
		}
		this.emit();
	}

	/** 滚动 / 翻页 / 换章 → 重排优先级（节流，避免滚动过程中反复重排） */
	scheduleFocus(doc?: Document | null): void {
		if (!this.active) return;
		if (this.focusTimer !== null) window.clearTimeout(this.focusTimer);
		this.focusTimer = window.setTimeout(() => {
			this.focusTimer = null;
			this.focus(this.resolvedDoc(doc ?? null));
		}, FOCUS_THROTTLE);
	}

	/**
	 * 立即重排：视口内 P0 → 前后一屏 P1 → 本章其余 P2 → 相邻章节 P3。
	 * 命中缓存的段落同步秒插，不等网络。
	 */
	focus(doc?: Document | null): void {
		if (!this.active) return;
		const target = doc ?? this.resolvedDoc(null) ?? this.currentDoc;
		if (target && target !== this.currentDoc) {
			// 换章：丢弃已离开章节的待翻项（不为跳过的内容烧 token）
			for (const [el, it] of this.queue) if (it.doc !== target) this.queue.delete(el);
			this.currentDoc = target;
		}
		const cur = this.currentDoc;
		if (!cur || this.skippedDocs.has(cur)) return;

		const band = this.viewportProvider?.() ?? null;
		const list = collectParagraphs(cur);
		if (!list.length) {
			this.visibleTargets = new Set();
			this.visibleDone = this.visibleTotal = 0;
			this.pump();
			this.emit();
			return;
		}

		const idx = new Map<HTMLElement, number>();
		list.forEach((p, i) => idx.set(p, i));

		// ① 视口内的段落（当前正在读的一屏）
		let visible: HTMLElement[] = band ? list.filter((p) => this.inBand(cur, p, band, VISIBLE_MARGIN)) : [];
		// 视口里一段都没有（整屏是图片 / 空白）→ 以「视口之后的第一段」为锚
		if (!visible.length) {
			const a = this.anchorIndex(cur, list, band);
			if (a >= 0) visible = [list[a]];
		}
		const first = visible.length ? idx.get(visible[0])! : -1;
		const last = visible.length ? idx.get(visible[visible.length - 1])! : -1;

		// 视口批次进度：只统计「需要请求」的段落（命中缓存的会瞬间嵌入）
		const targets = new Set<HTMLElement>();
		for (const el of visible) {
			if (this.needsRequest(cur, el)) targets.add(el);
		}
		this.rebuildVisibleBatch(targets);

		// ② 入队：先视口，再前后一屏，再本章其余，最后相邻章节
		if (first >= 0) {
			for (let i = first; i <= last; i++) this.offer(list[i], cur, PRIORITY.VISIBLE);
			for (let i = Math.max(0, first - PREFETCH_BACK); i < first; i++) this.offer(list[i], cur, PRIORITY.NEAR);
			for (let i = last + 1; i <= Math.min(list.length - 1, last + PREFETCH_AHEAD); i++) {
				this.offer(list[i], cur, PRIORITY.NEAR);
			}
		}
		for (const p of list) this.offer(p, cur, PRIORITY.REST);
		for (const d of this.docsProvider?.() ?? []) {
			if (d === cur) continue;
			for (const p of collectParagraphs(d)) this.offer(p, d, PRIORITY.SIBLING);
		}

		this.pump();
		this.emit();
	}

	/** 单段翻译（选区工具条「译」按钮入口） */
	async translateParagraphEl(p: HTMLElement): Promise<ParagraphResult> {
		const cached = this.hooks.getData()?.translations?.[this.keyOf(p)];
		if (cached) {
			this.insertTranslation(p, cached);
			return 'ok';
		}
		this.lastError = null;
		const { text, error } = await this.requestTranslation((p.textContent ?? '').trim());
		if (error) {
			this.lastError = error;
			return 'fail';
		}
		if (!text || parseClassicalMark(text).text === (p.textContent ?? '').trim()) return 'same';
		this.insertTranslation(p, text);
		this.cache(this.keyOf(p), text);
		this.scheduleSave();
		return 'ok';
	}

	/** 移除某章节文档里的全部译文节点 */
	removeTranslations(doc: Document): void {
		doc.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((el) => el.remove());
	}

	// ──────────────── 调度 ────────────────

	/** 补满并发槽：每槽取一批（同优先级同章节，按入队顺序） */
	private pump(): void {
		if (!this.active) return;
		while (this.running < CONCURRENCY) {
			const batch = this.takeBatch();
			if (!batch.length) return;
			this.running++;
			void this.runBatch(batch)
				.catch(() => { /* runBatch 内部已兜底 */ })
				.finally(() => {
					this.running--;
					this.emit();
					this.pump();
				});
		}
	}

	/** 按「优先级 → 入队顺序」取一批待翻段落 */
	private takeBatch(): QueueItem[] {
		const all = Array.from(this.queue.values());
		if (!all.length) return [];
		all.sort((a, b) => (a.prio - b.prio) || (a.seq - b.seq));
		const head = all[0];
		const batch: QueueItem[] = [head];
		const cap = this.batchSize();
		for (const it of all) {
			if (batch.length >= cap) break;
			if (it === head) continue;
			if (it.prio === head.prio && it.doc === head.doc) batch.push(it);
		}
		for (const it of batch) this.queue.delete(it.el);
		// 同批内按自然顺序排列，便于模型逐段对应
		batch.sort((a, b) => a.seq - b.seq);
		return batch;
	}

	private async runBatch(items: QueueItem[]): Promise<void> {
		if (!this.active) return;
		this.lastError = null;

		if (items.length === 1) {
			const it = items[0];
			const { text, error } = await this.requestTranslation(it.source);
			if (!this.active) return;
			if (error) {
				this.markFailed(it, error);
				return;
			}
			if (!text) {
				this.markUnchanged(it);
				return;
			}
			// 模型原样回传 = 这段本来就是中文 → 判定无需翻译（剥掉可能的误加标记再比较）
			if (parseClassicalMark(text).text === it.source) {
				this.markUnchanged(it);
				return;
			}
			this.commit(items, [text]);
			return;
		}

		const { texts, error } = await this.requestBatch(items.map((i) => i.source));
		if (!this.active) return;
		if (error) {
			this.markFailedBatch(items, error);
			return;
		}
		if (texts) {
			this.commit(items, texts);
			return;
		}

		// 分隔符数量对不上（模型不听话）→ 退回逐段请求，宁慢勿错
		for (const it of items) {
			if (!this.active) return;
			const r = await this.requestTranslation(it.source);
			if (!this.active) return;
			if (r.error) {
				this.markFailed(it, r.error);
				return;
			}
			if (!r.text || parseClassicalMark(r.text).text === it.source) {
				this.markUnchanged(it);
				continue;
			}
			this.commit([it], [r.text]);
		}
	}

	/**
	 * 嵌入译文。
	 * 版式位移不用自己补偿：foliate 的 ResizeObserver 在章节内容尺寸变化时会
	 * 自动重锚（paginator `onExpand → #scrollToAnchor(#anchor)`），把阅读位置钉住；
	 * 再叠加一层像素补偿会变成重复补偿（实测把位移从 135px 放大到 780px）。
	 */
	private commit(items: QueueItem[], texts: (string | null)[]): void {
		let inserted = 0;

		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			const text = texts[i]?.trim();
			// 模型原样回传 = 这段本来就是中文 → 判定无需翻译（绝不能把原文当译文插进去，
			// 否则中文书开启对照翻译会出现整段重复；剥掉可能的误加标记再比较）
			if (!text || parseClassicalMark(text).text === it.source) {
				this.markUnchanged(it);
				continue;
			}
			if (it.el.querySelector(`:scope > .${TRANSLATION_CLASS}`)) continue;
			this.insertTranslation(it.el, text);
			this.cache(it.key, text);
			this.bumpVisible(it.el);
			inserted++;
		}

		if (inserted) this.scheduleSave();
		this.emit();
	}

	/** 视口批次进度 +1（仅当前视口批次内的段落计入） */
	private bumpVisible(el: HTMLElement): void {
		if (!this.visibleTargets.has(el)) return;
		this.visibleTargets.delete(el);
		this.visibleDone++;
	}

	/** 新视口批次：集合是旧批次的子集（同一屏内重复 focus）时沿用旧进度 */
	private rebuildVisibleBatch(targets: Set<HTMLElement>): void {
		const same = targets.size > 0 && Array.from(targets).every((el) => this.visibleTargets.has(el));
		if (!same) {
			this.visibleTargets = targets;
			this.visibleDone = 0;
			this.visibleTotal = targets.size;
			return;
		}
		const remaining = targets.size;
		this.visibleTotal = Math.max(this.visibleTotal, this.visibleDone + remaining);
	}

	private markFailed(it: QueueItem, error: string): void {
		this.lastError = error;
		this.failed.set(it.el, Date.now() + FAIL_COOLDOWN);
	}

	private markFailedBatch(items: QueueItem[], error: string): void {
		this.lastError = error;
		const until = Date.now() + FAIL_COOLDOWN;
		for (const it of items) this.failed.set(it.el, until);
	}

	private markUnchanged(it: QueueItem): void {
		this.unchangedEls.add(it.el);
		const st = this.docStats.get(it.doc) ?? { offered: 0, unchanged: 0 };
		st.unchanged++;
		this.docStats.set(it.doc, st);
		// 中文书自适应：连续多段判定无需翻译 → 整章跳过，不再逐段发请求
		if (st.offered >= 6 && st.unchanged / st.offered > 0.7 && !this.skippedDocs.has(it.doc)) {
			this.skippedDocs.add(it.doc);
			for (const [el, q] of this.queue) if (q.doc === it.doc) this.queue.delete(el);
			this.hooks.onNotice?.('本章原文已是中文，已自动跳过对照翻译', 2600);
		}
	}

	/** 该段落是否还需要发请求（未缓存、未判定中文、未在冷却期、未在队列里） */
	private needsRequest(doc: Document, el: HTMLElement): boolean {
		if (this.unchangedEls.has(el)) return false;
		if (el.querySelector(`:scope > .${TRANSLATION_CLASS}`)) return false;
		const key = this.keyOf(el);
		if (this.hooks.getData()?.translations?.[key]) return false;
		return true;
	}

	/** 入队（命中缓存直接嵌入；同段落已在队列则只提升优先级） */
	private offer(el: HTMLElement, doc: Document, prio: number): void {
		if (this.skippedDocs.has(doc)) return;
		if (el.querySelector(`:scope > .${TRANSLATION_CLASS}`)) return;
		if (this.unchangedEls.has(el)) return;
		const until = this.failed.get(el);
		if (until !== undefined) {
			if (Date.now() < until) return;
			this.failed.delete(el);
		}
		const source = (el.textContent ?? '').trim();
		if (source.length < MIN_PARA_LEN) return;
		const key = hashString(source);

		const cached = this.hooks.getData()?.translations?.[key];
		if (cached) {
			this.insertTranslation(el, cached);
			return;
		}

		const exist = this.queue.get(el);
		if (exist) {
			if (prio < exist.prio) {
				exist.prio = prio;
				exist.seq = ++this.seq;
			}
			return;
		}
		const st = this.docStats.get(doc) ?? { offered: 0, unchanged: 0 };
		st.offered++;
		this.docStats.set(doc, st);
		this.queue.set(el, { el, doc, source, key, prio, seq: ++this.seq });
	}

	/** 视口内段落的文档序索引（图片页等无段落场景返回 -1） */
	private anchorIndex(doc: Document, list: HTMLElement[], band: ViewportBand | null): number {
		if (!band) return list.length ? 0 : -1;
		for (let i = 0; i < list.length; i++) {
			const r = this.hostRect(doc, list[i]);
			if (!r) continue;
			if (r.bottom > band.top) return i;
		}
		return -1;
	}

	// ──────────────── 几何：iframe 坐标 → 宿主坐标 ────────────────

	/**
	 * 段落矩形换算到宿主坐标。
	 * foliate 的章节 iframe 里，iframe 视口尺寸 = iframe 盒子尺寸
	 * （滚动模式 iframe 高 = 内容高，翻页模式 iframe 宽 = N 列宽），
	 * 因此 iframe 内坐标与宿主坐标是 1:1 平移，缩放因子只作保险。
	 */
	private hostRect(doc: Document, el: Element): ViewportBand | null {
		const win = doc.defaultView;
		if (!win) return null;
		const r = el.getBoundingClientRect();
		if (!r.width && !r.height) return null;
		const fe = win.frameElement as HTMLElement | null;
		if (!fe) return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
		const fr = fe.getBoundingClientRect();
		const sx = win.innerWidth > 0 ? (fr.width || win.innerWidth) / win.innerWidth : 1;
		const sy = win.innerHeight > 0 ? (fr.height || win.innerHeight) / win.innerHeight : 1;
		return {
			top: fr.top + r.top * sy,
			bottom: fr.top + r.bottom * sy,
			left: fr.left + r.left * sx,
			right: fr.left + r.right * sx,
		};
	}

	private inBand(doc: Document, el: Element, band: ViewportBand, margin: number): boolean {
		const r = this.hostRect(doc, el);
		if (!r) return false;
		return r.bottom > band.top - margin && r.top < band.bottom + margin
			&& r.right > band.left && r.left < band.right;
	}

	private resolvedDoc(doc: Document | null): Document | null {
		if (doc?.body) return doc;
		const fromProvider = this.currentDocProvider?.() ?? null;
		if (fromProvider?.body) return fromProvider;
		return null;
	}

	// ──────────────── 请求 ────────────────

	/** 单段翻译请求：机翻走微软批量接口（单元素数组），AI 走流式通道 */
	private async requestTranslation(source: string): Promise<{ text: string | null; error: string | null }> {
		if (this.useMicrosoft()) {
			const r = await translateBatchMicrosoft([source]);
			if (r.error) return { text: null, error: r.error };
			// detectedLanguage 为 zh（原文即中文）→ text 为 null → 调用方判 unchanged
			return { text: r.items[0]?.text ?? null, error: null };
		}
		const controller = new AbortController();
		this.controllers.add(controller);
		let error: string | null = null;
		try {
			let out = '';
			const service = new AIService(this.plugin);
			await service.streamChat(
				[
					{ role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
					{ role: 'user', content: source },
				],
				(chunk) => { out += chunk; },
				undefined,
				(err) => {
					console.warn('[FleurEPUB] 翻译请求失败', err);
					error = err || 'AI 请求失败';
				},
				controller.signal,
			);
			if (error) return { text: null, error };
			return { text: stripMarkdown(out).trim() || null, error: null };
		} catch (err) {
			console.warn('[FleurEPUB] 翻译异常', err);
			return { text: null, error: err instanceof Error ? err.message : '翻译请求异常' };
		} finally {
			this.controllers.delete(controller);
		}
	}

	/**
	 * 批量翻译请求。
	 * 微软机翻：原生数组批量接口，逐段对齐返回（中文段 text=null → unchanged）；
	 * AI：多段用分隔符合并成一次往返。
	 * 返回 null 表示「无法可靠切分」→ 调用方退回逐段请求（仅 AI 路径）。
	 */
	private async requestBatch(sources: string[]): Promise<{ texts: (string | null)[] | null; error: string | null }> {
		if (this.useMicrosoft()) {
			const r = await translateBatchMicrosoft(sources);
			if (r.error) return { texts: null, error: r.error };
			return { texts: r.items.map((it) => it.text), error: null };
		}
		const controller = new AbortController();
		this.controllers.add(controller);
		let error: string | null = null;
		try {
			let out = '';
			const service = new AIService(this.plugin);
			await service.streamChat(
				[
					{ role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
					{ role: 'user', content: sources.join(`\n${SEP}\n`) },
				],
				(chunk) => { out += chunk; },
				undefined,
				(err) => {
					console.warn('[FleurEPUB] 批量翻译失败', err);
					error = err || 'AI 请求失败';
				},
				controller.signal,
			);
			if (error) return { texts: null, error };
			const raw = stripMarkdown(out).trim();
			if (!raw) return { texts: null, error: null };
			const parts = raw.split(SEP_RE).map((s) => s.trim());
			// 段数对不上 → 让调用方退回逐段，宁可慢一点也不错位
			if (parts.length !== sources.length) {
				console.warn('[FleurEPUB] 批量译文段数不匹配，退回逐段翻译', parts.length, sources.length);
				return { texts: null, error: null };
			}
			return { texts: parts, error: null };
		} catch (err) {
			console.warn('[FleurEPUB] 批量翻译异常', err);
			return { texts: null, error: err instanceof Error ? err.message : '翻译请求异常' };
		} finally {
			this.controllers.delete(controller);
		}
	}

	// ──────────────── 写入 ────────────────

	/** 译文按「段落文本哈希」缓存（上限保护），重复阅读零消耗 */
	private cache(key: string, text: string): void {
		const data = this.hooks.getData();
		if (!data) return;
		if (!data.translations) data.translations = {};
		if (Object.keys(data.translations).length >= MAX_CACHE_ENTRIES) return;
		data.translations[key] = text;
	}

	private keyOf(p: HTMLElement): string {
		return hashString((p.textContent ?? '').trim());
	}

	private insertTranslation(p: HTMLElement, raw: string): void {
		if (p.querySelector(`:scope > .${TRANSLATION_CLASS}`)) return;
		// 文言译文带〔古〕标记（缓存文本同样可能带）→ 剥掉并转为灰显样式类；
		// 旧缓存无标记时兜底：原文以中文为主（无假名）→ 也是文言→白话，同样灰显
		const { classical: marked, text } = parseClassicalMark(raw);
		const classical =
			marked || (text !== (p.textContent ?? '').trim() && looksLikeChineseSource((p.textContent ?? '').trim()));
		const doc = p.ownerDocument;
		// XML（XHTML）文档中 createElement 产出的节点无命名空间、不参与正常渲染，
		// 必须走 createElementNS；同时用 setAttribute('class') 以免 XML 下 className 失效
		const ns = doc.documentElement?.namespaceURI || XHTML_NS;
		const span = doc.createElementNS(ns, 'span') as HTMLElement;
		span.setAttribute('class', classical ? `${TRANSLATION_CLASS} ${CLASSICAL_CLASS}` : TRANSLATION_CLASS);
		span.setAttribute('data-fleur', 'translation');
		span.textContent = text;
		// 追加在段落内部末尾：不改变既有兄弟索引与文本偏移 → CFI 安全
		p.appendChild(span);
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			this.hooks.save();
		}, 4000);
	}

	private abortAll(): void {
		for (const c of this.controllers) c.abort();
		this.controllers.clear();
	}
}
