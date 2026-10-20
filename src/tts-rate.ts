// 听书语速：播放器滑杆给出连续值，这里统一边界、精度与显示格式。
// 纯函数，不依赖 Obsidian，可直接 node --test。

export const TTS_RATE_MIN = 0.5;
export const TTS_RATE_MAX = 2.5;
export const TTS_RATE_STEP = 0.05;

/** 收敛到可朗读区间并保留两位小数；非法输入回退到 fallback。 */
export function normalizeTtsRate(value: number, fallback = 1): number {
	if (!Number.isFinite(value)) return fallback;
	const clamped = Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, value));
	return Math.round(clamped * 100) / 100;
}

/** 滑杆旁的值：1 → `1x`，1.25 → `1.25x`，1.05 → `1.05x`。 */
export function formatTtsRate(value: number): string {
	return `${Number(normalizeTtsRate(value).toFixed(2))}x`;
}
