import type FleurEpubPlugin from './main';
import { getFleurDictBridge } from './dict-bridge';

/**
 * WordWise 生词注释（Kindle 式）：在正文生词上方绘制简要注释。
 *
 * 实现约束（与 translator / overlayer 的既定红线一致）：
 * - 零 DOM 改动：不 wrap、不拆文本节点 → CFI 绝对安全；
 * - 零布局参与：注释画在 SVG overlay 上（absolute，随文档滚动/翻页自然跟随），
 *   分页点不漂移；
 * - 命中缓存：每章扫描一次（章节 render 后），绘制只需一次 layout 读取，
 *   滚动 / 翻页零重绘成本。
 *
 * 注释内容 = 生词本释义首段截断（无释义时退化为音标）；
 * 词库 = FleurDict 生词本 + fleur-epub 独立生词本合并（与同步开关无关）。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 注释最大字符数（超出截断加省略号） */
const MAX_GLOSS_CHARS = 16;
/** 短语最长词数（n-gram 匹配上限，与查词的 ≤4 词规则一致） */
const MAX_PHRASE_WORDS = 4;
/** 注释相对正文字号比例与绝对钳制 */
const GLOSS_SIZE_RATIO = 0.58;
const GLOSS_SIZE_MIN = 9;
const GLOSS_SIZE_MAX = 12.5;

interface WordMatch {
	node: Text;
	start: number;
	end: number;
	gloss: string;
}

interface Token {
	start: number;
	end: number;
	w: string;
}

/** 释义首段截断；空释义退化为音标 */
function briefGloss(meaning: string | undefined, phonetic: string | undefined): string {
	const seg = (meaning ?? '').split(/[；;\n。]/)[0].trim();
	if (!seg) return (phonetic ?? '').trim();
	return seg.length > MAX_GLOSS_CHARS ? seg.slice(0, MAX_GLOSS_CHARS) + '…' : seg;
}

/** 轻量词形归并：文章词形 → 生词本词形的候选序列（保守规则，宁缺勿滥） */
function lemmaCandidates(w: string): string[] {
	const out = [w];
	if (/(?:'|’)s$/.test(w) && w.length > 3) out.push(w.replace(/(?:'|’)s$/, ''));
	if (/ies$/.test(w) && w.length > 4) out.push(w.slice(0, -3) + 'y');
	if (/es$/.test(w) && w.length > 3) out.push(w.slice(0, -2));
	if (/s$/.test(w) && !/ss$/.test(w) && w.length > 3) out.push(w.slice(0, -1));
	if (/ing$/.test(w) && w.length > 5) {
		out.push(w.slice(0, -3));
		out.push(w.slice(0, -3) + 'e');
	}
	if (/ed$/.test(w) && w.length > 4) {
		out.push(w.slice(0, -2));
		out.push(w.slice(0, -1));
	}
	return out;
}

export class Wordwise {
	/** 合并词库：单词 key 与短语 key（小写、空格连接）共用一张表 */
	private gloss = new Map<string, string>();
	private matches: WordMatch[] = [];
	private doc: Document | null = null;
	private svg: SVGSVGElement | null = null;
	private rafId: number | null = null;
	/** 文档 DOM 变化监听（译文注入 / 字体加载 reflow 后自动重扫）；自身 SVG 变化除外 */
	private observer: MutationObserver | null = null;
	private obsTimer: number | null = null;
	/** 布局就绪重试绘制（attach 时序兜底） */
	private drawTimer: number | null = null;
	private drawTries = 0;
	/** 稳定校验：上一轮/本轮绘制位置签名（一致 = 布局不再变化） */
	private lastSig = '';
	private prevSig = '';
	/** 词库指纹轮询：FleurDict 查词窗里加词是跨插件 UI 动作，本插件无事件可听，
	 *  唯一可靠通路是低频比对词库指纹（重建几百条 Map 每次仅亚毫秒级，3s 一次开销可忽略） */
	private pollTimer: number | null = null;
	private glossSig = '';

	constructor(
		private plugin: FleurEpubPlugin,
		/** 当前章节文档 getter（reader-view 侧提供 renderer.document） */
		private getDoc: () => Document | null,
	) {}

	/** 合并两本生词本 → gloss 表（每次扫描前重建，生词本变化天然生效）；
	 *  重建后比对指纹，词库有变（任一来源加词/改词）返回 true */
	private buildGloss(): boolean {
		const before = this.glossSig;
		this.gloss.clear();
		const push = (word: string, meaning: string | undefined, phonetic: string | undefined) => {
			const w = word.trim().toLowerCase();
			if (!w || w.length > 64) return;
			const g = briefGloss(meaning, phonetic);
			if (!g) return;
			// 先到先得：FleurDict 词库优先（其词条带完整词典数据）
			if (!this.gloss.has(w)) this.gloss.set(w, g);
		};
		const bridge = getFleurDictBridge(this.plugin.app);
		try {
			for (const e of bridge?.wordbookManager?.getAllEntries() ?? []) {
				push(e.word, e.meaning, e.phonetic);
			}
		} catch {
			/* FleurDict 数据异常不阻断 */
		}
		for (const item of this.plugin.settings.wordbook ?? []) {
			push(item.word, item.meaning, item.phonetic);
		}
		this.glossSig = [...this.gloss.keys()].sort().join('\u0001');
		return this.glossSig !== before;
	}

	/** 词库指纹轮询（3s）：任一来源（含 FleurDict 弹窗内加词）变化 → 重扫重画 */
	private startPolling(): void {
		this.stopPolling();
		this.pollTimer = window.setInterval(() => {
			if (!this.enabled || !this.doc) return;
			// 只重建词库比对指纹，变了才走完整重扫（scan 内部会再 build 一次，幂等）
			const before = this.glossSig;
			this.buildGloss();
			if (this.glossSig !== before) this.rescan();
		}, 3000);
	}

	private stopPolling(): void {
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
		this.pollTimer = null;
	}

	/** 是否可启用（词库为空时扫描无意义，按钮仍可开但直接跳过绘制） */
	private get enabled(): boolean {
		return this.plugin.settings.wordwiseEnabled === true;
	}

	/**
	 * 章节加载入口（load 事件）。doc 变化 → 重扫描；同 doc → 仅重绘。
	 *
	 * 时序注意：foliate 的 load 事件在 #view 挂载 / 布局完成之前派发，
	 * 此刻 getBoundingClientRect 全为 0——所以 scan 立即做（缓存命中），
	 * draw 走「等布局就绪」的重试（同 remountAnnotationsWhenReady 的模式）。
	 */
	attach(doc: Document): void {
		if (!this.enabled) return;
		if (this.doc === doc && this.svg?.isConnected) {
			this.scheduleRedraw(doc);
			return;
		}
		this.detach();
		this.doc = doc;
		this.scan(doc);
		if (this.matches.length > 0) {
			this.drawWhenLaidOut(doc);
		}
		this.observeDoc(doc);
		this.startPolling();
		// 字体晚加载会整体 reflow（错位的另一个来源）：就绪后强制重扫重画
		try {
			doc.fonts?.ready?.then(() => {
				if (this.doc === doc && this.enabled) this.drawWhenLaidOut(doc);
			});
		} catch {
			/* 旧内核无 fonts API 时依赖稳定校验兜底 */
		}
	}

	/** 布局就绪前 40ms×50 重试绘制；绘制后再做稳定校验（位置漂移 = 字体/样式仍在重排，继续重画） */
	private drawWhenLaidOut(doc: Document): void {
		if (this.drawTimer !== null) window.clearTimeout(this.drawTimer);
		this.drawTimer = null;
		this.drawTries = 0;
		this.lastSig = '';
		const attempt = () => {
			this.drawTimer = null;
			if (this.doc !== doc) return; // 已翻章 / 关闭 / detach
			this.scan(doc); // 每次重扫：重排后节点位置缓存不可信
			const drawn = this.draw(doc);
			if (this.drawTries++ >= 50) return;
			if (drawn === 0) {
				// 有命中但画不出来 = 布局未完成，快速重试
				this.drawTimer = window.setTimeout(attempt, 40);
				return;
			}
			// 已画出：签名与上一轮一致 → 布局已稳定；不一致 → 还在重排，继续等
			if (this.lastSig !== this.prevSig) {
				this.prevSig = this.lastSig;
				this.drawTimer = window.setTimeout(attempt, 90);
			}
		};
		attempt();
	}

	/** 监听文档 DOM 变化（译文块注入、字体加载 reflow），防抖重扫；自身 SVG 变化被过滤，不会自触发 */
	private observeDoc(doc: Document): void {
		this.observer?.disconnect();
		const body = doc.body;
		if (!body) return;
		this.observer = new MutationObserver((records) => {
			const svgEl = this.svg;
			// 只统计非自身 overlay 的变化（draw 对 svg 的清空/重建不算）
			const external = records.some((r) => {
				const t = r.target as Node;
				return !(svgEl && (t === svgEl || svgEl.contains(t)));
			});
			if (!external) return;
			if (this.obsTimer !== null) window.clearTimeout(this.obsTimer);
			this.obsTimer = window.setTimeout(() => {
				this.obsTimer = null;
				this.scheduleRescan();
			}, 250);
		});
		this.observer.observe(body, { childList: true, subtree: true });
	}

	/** 排版变化（字号/字重/行距/边距等）后重扫描：布局坐标已变，缓存失效 */
	rescan(): void {
		if (!this.enabled || !this.doc) return;
		this.scan(this.doc);
		if (this.matches.length > 0) {
			this.drawWhenLaidOut(this.doc);
		} else {
			this.draw(this.doc); // 无命中：清空旧注释即可
		}
	}

	/** 排版重排（setStyles / 边距）后延迟重扫：rAF 下一帧等 foliate 重排完成再读布局 */
	scheduleRescan(): void {
		if (!this.enabled || !this.doc) return;
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.rescan();
		});
	}

	/** 开关切换入口 */
	setEnabled(on: boolean): void {
		if (!on) {
			this.detach();
			return;
		}
		const doc = this.currentDoc();
		if (doc) this.attach(doc);
	}

	detach(): void {
		this.stopPolling();
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.rafId = null;
		if (this.drawTimer !== null) window.clearTimeout(this.drawTimer);
		this.drawTimer = null;
		if (this.obsTimer !== null) window.clearTimeout(this.obsTimer);
		this.obsTimer = null;
		this.observer?.disconnect();
		this.observer = null;
		this.svg?.remove();
		this.svg = null;
		this.matches = [];
		this.doc = null;
	}

	private currentDoc(): Document | null {
		return this.getDoc();
	}

	// ── 扫描 ──

	private scan(doc: Document): void {
		this.matches = [];
		this.buildGloss();
		if (this.gloss.size === 0) return;
		const body = doc.body;
		if (!body) return;

		const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
			acceptNode: (n: Node): number => {
				const el = (n as Text).parentElement;
				if (!el) return NodeFilter.FILTER_REJECT;
				// 跳过本插件产物（译文块）与不可见骨架
				if (el.closest('[data-fleur]')) return NodeFilter.FILTER_REJECT;
				const tag = el.tagName;
				if (/^(?:SCRIPT|STYLE|TITLE)$/.test(tag)) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			},
		});

		let node = walker.nextNode() as Text | null;
		while (node) {
			const text = node.nodeValue ?? '';
			if (text.length >= 2 && /[A-Za-z]/.test(text)) {
				this.matchNode(node, text);
			}
			node = walker.nextNode() as Text | null;
		}
	}

	/** 单个文本节点：token 化 → 短语 n-gram（优先长匹配）→ 单词（含词形归并） */
	private matchNode(node: Text, text: string): void {
		const tokens: Token[] = [];
		const re = /[A-Za-z][A-Za-z'’-]*/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			tokens.push({ start: m.index, end: m.index + m[0].length, w: m[0].toLowerCase() });
		}
		if (tokens.length === 0) return;

		/** token i..i+len-1 是否构成单个空格相连的连续片段 */
		const contiguous = (i: number, len: number): boolean => {
			for (let k = i; k < i + len - 1; k++) {
				if (text.slice(tokens[k].end, tokens[k + 1].start) !== ' ') return false;
			}
			return true;
		};

		for (let i = 0; i < tokens.length; i++) {
			let matched = false;
			// 短语：从最长到最短
			for (let len = Math.min(MAX_PHRASE_WORDS, tokens.length - i); len >= 2; len--) {
				if (!contiguous(i, len)) continue;
				const key = tokens.slice(i, i + len).map((t) => t.w).join(' ');
				const g = this.gloss.get(key);
				if (g) {
					this.matches.push({ node, start: tokens[i].start, end: tokens[i + len - 1].end, gloss: g });
					matched = true;
					break;
				}
			}
			if (matched) continue;
			// 单词：先查原形，再试词形归并
			for (const cand of lemmaCandidates(tokens[i].w)) {
				const g = this.gloss.get(cand);
				if (g) {
					this.matches.push({ node, start: tokens[i].start, end: tokens[i].end, gloss: g });
					break;
				}
			}
		}
	}

	// ── 绘制 ──

	private scheduleRedraw(doc: Document): void {
		if (this.rafId !== null) cancelAnimationFrame(this.rafId);
		this.rafId = requestAnimationFrame(() => {
			this.rafId = null;
			this.drawWhenLaidOut(doc);
		});
	}

	private draw(doc: Document): number {
		// 坐标系：range.getBoundingClientRect() 返回 iframe 视口坐标，与 iframe 内
		// absolute 定位的 svg 同一坐标系；iframe 滚动（若有）由 scrollX/Y 补偿。
		// （滚动/翻页实际发生在宿主侧 shadow DOM，iframe 内 scroll 恒为 0，勿混入宿主坐标）
		const win = doc.defaultView;
		if (!win) return 0;
		const sx = win.scrollX ?? 0;
		const sy = win.scrollY ?? 0;
		const rootEl = doc.documentElement;
		const body = doc.body;
		if (!rootEl || !body) return 0;

		// overlay：absolute + 显式文档尺寸（100% 高度会塌缩到视口高）
		if (!this.svg || !this.svg.isConnected) {
			this.svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
			this.svg.setAttribute('class', 'fleur-epub-wordwise');
			this.svg.style.setProperty('position', 'absolute');
			this.svg.style.setProperty('top', '0');
			this.svg.style.setProperty('left', '0');
			this.svg.style.setProperty('pointer-events', 'none');
			this.svg.style.setProperty('z-index', '5');
			body.appendChild(this.svg);
		}
		const svg = this.svg;
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		if (this.matches.length === 0) return 0;

		const docW = Math.max(rootEl.scrollWidth, body.scrollWidth);
		const docH = Math.max(rootEl.scrollHeight, body.scrollHeight);
		svg.setAttribute('width', String(docW));
		svg.setAttribute('height', String(docH));
		svg.setAttribute('viewBox', `0 0 ${docW} ${docH}`);
		// 关键：svg 的 width/height 属性会被宿主样式钳制（实测 height 被压到单页高），
		// 触发 viewBox preserveAspectRatio 缩放+居中 → 注释整体错位。
		// 用内联 style 强制 1:1 像素映射并禁用 max 钳制。
		svg.style.setProperty('width', `${docW}px`);
		svg.style.setProperty('height', `${docH}px`);
		svg.style.setProperty('max-width', 'none');
		svg.style.setProperty('max-height', 'none');
		// 瞬态防御：flow 切换 / 重排中途布局坐标与文档尺寸可能来自旧状态，
		// 若 svg 实际渲染宽 ≠ 期望宽（被宿主样式钳制等），此刻画出来必然错位缩放，
		// 返回 0 走 drawWhenLaidOut 的重试，等布局尘埃落定再画。
		try {
			const actualW = svg.getBoundingClientRect().width;
			if (docW > 0 && Math.abs(actualW - docW) > 2) return 0;
		} catch {
			/* getBoundingClientRect 异常时按原流程继续 */
		}

		// 注释字号跟随正文字号；颜色取正文色淡化（不引入固定色，兼容明暗书页）
		let baseSize = 16;
		let color = '#555';
		try {
			baseSize = parseFloat(win.getComputedStyle(rootEl).fontSize) || 16;
			color = win.getComputedStyle(body).color || '#555';
		} catch {
			/* computed style 异常时用默认值 */
		}
		const fs = Math.min(GLOSS_SIZE_MAX, Math.max(GLOSS_SIZE_MIN, baseSize * GLOSS_SIZE_RATIO));

		const drawn: DOMRect[] = [];
		const sig: string[] = [];
		/** 两遍绘制：第一遍注释文本，第二遍虚线（跳过与注释框相交的） */
		const textEls: SVGTextElement[] = [];
		const pendingUl: { x1: number; x2: number; y: number }[] = [];
		for (const match of this.matches) {
			let rect: DOMRect | null = null;
			let fam = '';
			let lineBox = 0;
			try {
				const range = doc.createRange();
				range.setStart(match.node, match.start);
				range.setEnd(match.node, match.end);
				rect = range.getBoundingClientRect();
				// 注释字体与原文字体保持一致：取词所在元素的计算字体栈
				//（覆盖 EPUB 内嵌字体 / 跟随 Obsidian / 代码块等特殊上下文）
				const cs = match.node.parentElement
					? win.getComputedStyle(match.node.parentElement)
					: null;
				fam = cs?.fontFamily ?? '';
				// 行盒高度：注释要画进行间，可用空间取决于 half-leading
				const lh = cs?.lineHeight ?? '';
				lineBox = lh && lh !== 'normal' ? parseFloat(lh) || 0 : rect.height * 1.2;
			} catch {
				continue;
			}
			if (!rect || rect.width <= 0) continue;
			const x = rect.left + sx;
			const top = rect.top + sy;
			const bottom = rect.bottom + sy;
			// 行间可用空间 = 2×half-leading（相邻行盒紧邻、字形盒在行盒内垂直居中，
			// 上一行字形底 ≈ 词顶 − 2×halfLead）。空间够才画上方，不够退到词下方；
			// 双侧都放不下时仍画上方（配合排版层的自动行距，正常情况不会走到）。
			const halfLead = Math.max(0, (lineBox - rect.height) / 2);
			const gap = halfLead * 2;
			// needAbove 含 1.5px 避让：上一行若有注释词，其下划虚线占 gap 顶部 ~2px
			const needAbove = 4 + fs * 0.95; // 基线偏移 + 注释上伸部 + 上一行虚线避让
			// needBelow/baseline 含 2.5px 避让：下方绘制时避开本词自己的下划虚线
			const needBelow = fs * 1.3 + 2.5;
			const canAbove = top >= needAbove && gap >= needAbove;
			const canBelow = gap >= needBelow;
			let fsEff = fs;
			let above: boolean;
			if (canAbove) above = true;
			else if (canBelow) above = false;
			else {
				// 双侧都放不下（书内自带 CSS 压紧行距、floor 未生效的退化场景）：
				// 注释缩号塞进行间（≥8px 保可读）；再不行只能兜底画上方
				const fit = Math.floor((gap - 5.5) / 1.05);
				if (fit >= 8) fsEff = fit;
				above = true;
			}
			const baseline = above ? top - 2.5 : bottom + fs + 2.5;
			const cx = Math.min(Math.max(x + rect.width / 2, fs * 2), Math.max(docW - fs * 2, fs * 2));

			// 轻防重叠：与上一条注释垂直过近且水平交叠则跳过（简化碰撞处理）
			const dup = drawn.find(
				(r) => Math.abs(r.top + sy - (above ? top : bottom)) < fs * 0.9 &&
					cx + rect.width / 2 > r.left + sx && x < r.right + sx,
			);
			if (dup) continue;
			drawn.push(rect);
			sig.push(`${Math.round(x)},${Math.round(above ? top : bottom)}`);

			// 注释文本
			const t = doc.createElementNS(SVG_NS, 'text') as SVGTextElement;
			t.setAttribute('x', String(cx));
			t.setAttribute('y', String(baseline));
			t.setAttribute('text-anchor', 'middle');
			t.setAttribute('font-size', String(fsEff));
			if (fam) t.setAttribute('font-family', fam);
			t.setAttribute('fill', color);
			t.setAttribute('fill-opacity', '0.8');
			t.setAttribute('style', 'pointer-events:none');
			t.textContent = match.gloss;
			svg.appendChild(t);
			textEls.push(t);

			// 下划虚线延后到第二遍画（需先量注释框做相交检测）
			pendingUl.push({ x1: x + 0.5, x2: x + rect.width - 0.5, y: bottom + 1 });
		}

		// 第二遍：注释框先落地（读实际渲染 bbox，转文档坐标），任何与注释框
		// 相交（含 2px 缓冲）的下划虚线跳过不画——书内自带 CSS 压紧行距时几何
		// 避让可能不够，此时宁可少一条虚线也不让线压字（注释文字本身即词标记）
		const boxes: DOMRect[] = [];
		for (const t of textEls) {
			const r = t.getBoundingClientRect();
			boxes.push(new DOMRect(r.left + sx - 2, r.top + sy - 2, r.width + 4, r.height + 4));
		}
		for (const u of pendingUl) {
			const hit = boxes.some(
				(b) => u.y >= b.top && u.y <= b.bottom && u.x2 >= b.left && u.x1 <= b.right,
			);
			if (hit) continue;
			const ul = doc.createElementNS(SVG_NS, 'line') as SVGLineElement;
			ul.setAttribute('x1', String(u.x1));
			ul.setAttribute('x2', String(u.x2));
			ul.setAttribute('y1', String(u.y));
			ul.setAttribute('y2', String(u.y));
			ul.setAttribute('stroke', color);
			ul.setAttribute('stroke-opacity', '0.55');
			ul.setAttribute('stroke-width', '1');
			ul.setAttribute('stroke-dasharray', '2,2.6');
			ul.setAttribute('style', 'pointer-events:none');
			svg.appendChild(ul);
		}
		this.lastSig = sig.join('|');
		return svg.childElementCount;
	}
}
