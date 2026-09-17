// 「外侧留白」（左右白边）取值逻辑。
//
// 独立成纯函数的原因：这套映射同时要满足四个约束（默认逐像素不变 / 窄屏直接见效 /
// 宽屏也能压到底 / 双栏不能塌成单栏），靠肉眼看不出对错，必须能被测量台直接引入验证
// —— 与 store.ts 的 isMainDataFileName 同一思路，测的是真代码而不是抄一份的副本。
//
// 背景（fleurEpub 实测）：
//   · 窄屏（手机 390）：两侧留白 = 视口宽 × 7%，全部来自 foliate `--_gap: 7%`
//     （一半是 grid 外侧列、一半是 iframe 内 html 的左右 padding）。
//   · 宽屏单栏（桌面 ≥760）：`--_max-inline-size: 720px` 才是主因 —— 内容轨被限宽后
//     居中，1400 窗口每侧 367px。此时只改 gap 几乎无效（367→340）。
//   · 双栏：`--_max-inline-size` 是单栏宽度的除数依据，放大到 `ceil(size / maxInline)`
//     掉到 1 时双栏会塌成单栏，故双栏下不动它，只调 gap（gap 同时也是栏间距）。

/** 默认外侧留白（%）。7 = foliate `--_gap: 7%` 原值 = 升级前现状。 */
export const OUTER_GAP_DEFAULT = 7;

/** 外侧留白上限（%）。再大没有意义：那是「比现状还宽」，需要的是左右边距滑块。 */
export const OUTER_GAP_MAX = 7;

/** foliate 原生 `--_max-inline-size` 默认值（px，comfortable line width）。 */
export const MAX_INLINE_BASE = 720;

/** outerGap 每降低 1%，行宽上限放宽的像素数。 */
export const MAX_INLINE_PER_PERCENT = 240;

/** 行宽上限封顶（px）：0% 时 720 + 7×240 = 2400，足够任何常见显示器顶满。 */
export const MAX_INLINE_CAP = 2400;

export interface OuterGapAttrs {
	/** foliate `gap` 属性值 */
	gap: string;
	/** foliate `max-inline-size` 属性值 */
	maxInline: string;
	/** 生效栏数（滚动模式下 foliate 恒按单栏布局） */
	columns: number;
}

/** 把任意输入收敛到合法的外侧留白值；非法（undefined / NaN，如老数据无此字段）回落默认。 */
export function clampOuterGap(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return OUTER_GAP_DEFAULT;
	return Math.min(OUTER_GAP_MAX, Math.max(0, n));
}

/**
 * 由设置值算出要写到 foliate 渲染器上的两个属性。
 *
 * 默认值（7）下 `gap` = 7%、`maxInline` = 720px，与 foliate 原生 CSS 默认严格相同
 * → 老用户升级后逐像素不变。
 */
export function outerGapAttrs(
	outerGap: unknown,
	opts: { flow: 'scrolled' | 'paginated'; columns: 1 | 2 },
): OuterGapAttrs {
	const v = clampOuterGap(outerGap);
	const columns = opts.flow === 'scrolled' ? 1 : opts.columns === 2 ? 2 : 1;
	// 双栏保持 foliate 默认宽度：放大它会让 ceil(size / maxInline) 掉到 1、双栏塌成单栏
	const maxInline =
		columns === 2
			? MAX_INLINE_BASE
			: Math.min(MAX_INLINE_CAP, Math.round(MAX_INLINE_BASE + (OUTER_GAP_MAX - v) * MAX_INLINE_PER_PERCENT));
	return { gap: `${v}%`, maxInline: `${maxInline}px`, columns };
}
