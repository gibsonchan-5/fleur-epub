/**
 * 「字间距 / 单词间距」取值与 CSS 输出（纯函数，可被测量台直接引入验证）。
 *
 * 设计要点：
 * 1. 单位一律用 em —— 随正文字号等比缩放，用户换字号时字距的视觉比例不变。
 *    （用 px 会出现「小字号觉得紧、大字号觉得松」的割裂感）
 * 2. **默认值必须精确复刻改造前的硬编码结果**，老用户升级后逐像素不变：
 *      旧：body { letter-spacing: .01em }   h1 { letter-spacing: .02em }
 *      新：body { letter-spacing: .01em }   h1 { letter-spacing: calc(.01em + .01em) }
 *    字距**必须继续挂在 body 上、不能挪到 html**：letter-spacing 继承的是「计算值」，
 *    而 em 是在声明所在元素上按该元素的 font-size 解析成 px 的。旧版锚点是 body，
 *    若挪到 html，当 EPUB 自带 `body { font-size: … }` 时（很常见）两者算出的 px 会不同
 *    → 老用户排版会变。锚点不动，只把常量换成变量，才是真正的零风险。
 * 3. word-spacing 仅在「非 0」时输出声明：CSS 初始值 `normal` 对 word-spacing 就等于 0，
 *    但「干脆不输出」能让默认状态下的样式表与旧版**字面一致**，规避任何边缘差异。
 * 4. 字距不收负值（汉字会粘连、可读性崩坏，不存在合理的负向需求）；
 *    词距**收负值**——这不是「更紧的排版偏好」，而是修正项：部分中文字体（如用户常用的
 *    京华老宋体）自带拉丁空格宽达 0.5em，是常规拉丁字体的两倍，英文原著与对照译文里
 *    词距会明显偏宽，只有负 word-spacing 能把它压回正常观感。下限 −0.3em 足够覆盖
 *    「0.5em 空格 → 0.2em」的修正幅度，再负就开始让单词粘连了。
 */

export const LETTER_SPACING_DEFAULT = 0.01;
export const LETTER_SPACING_MAX = 0.3;
export const WORD_SPACING_DEFAULT = 0;
export const WORD_SPACING_MIN = -0.3;
export const WORD_SPACING_MAX = 0.5;

/** h1 相对正文的额外字距（旧版硬编码 .02em，恰好 = 正文 .01em + 本值） */
export const H1_EXTRA = 0.01;

function toNum(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
	const n = toNum(value);
	if (n === null) return fallback;
	// 三位小数足够（0.005em ≈ 0.1px @21px 字号，已低于可感知阈值）
	return Math.round(Math.min(max, Math.max(min, n)) * 1000) / 1000;
}

export function clampLetterSpacing(value: unknown): number {
	return clamp(value, LETTER_SPACING_DEFAULT, 0, LETTER_SPACING_MAX);
}

export function clampWordSpacing(value: unknown): number {
	return clamp(value, WORD_SPACING_DEFAULT, WORD_SPACING_MIN, WORD_SPACING_MAX);
}

export interface SpacingCss {
	/** 挂在 body 元素上的声明串（正文与全部后代继承） */
	body: string;
	/** 挂在 h1 上的声明串 */
	h1: string;
	letterSpacing: number;
	wordSpacing: number;
}

export function spacingCss(letterSpacing: unknown, wordSpacing: unknown): SpacingCss {
	const ls = clampLetterSpacing(letterSpacing);
	const ws = clampWordSpacing(wordSpacing);
	return {
		// ws !== 0（而不是 ws > 0）：负值也是有效输入。`-0` 不输出——JS 里 -0 === 0，
		// 且 default 0 经过 clamp 的四舍五入可能得到 -0，必须归一为「不输出」。
		body: `letter-spacing: ${ls}em;${ws !== 0 ? ` word-spacing: ${ws}em;` : ''}`,
		// 标题在正文基础上再加一点，保持「标题比正文更疏」的既有观感
		h1: `letter-spacing: calc(${ls}em + ${H1_EXTRA}em);`,
		letterSpacing: ls,
		wordSpacing: ws,
	};
}
