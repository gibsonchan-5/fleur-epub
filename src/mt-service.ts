/**
 * 微软机翻服务（Edge 免认证通道）
 *
 * 端点：POST https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false
 * - 免密钥：无需注册与 API Key（Edge 浏览器同款通道，社区多个开源项目稳定使用）；
 * - 批量：请求体为字符串数组，响应逐段对齐返回，并带 detectedLanguage；
 * - 中文输入：detectedLanguage 为 zh-Hans/zh-Hant 且译文与原文一致 → 调用方判「无需翻译」；
 *   文言文会被误判（如 en score 0.0）但译文仍与原文相同 → 同样落入 unchanged 判定，
 *   因此机翻引擎天然不支持文言→白话（设置里已向用户说明）；
 * - 国内可直连（微软端点未被墙），对没有代理 / 没有 AI Key 的用户是零门槛路径。
 *
 * 稳健性：
 * - 未公开的官方接口，随时可能变化 → 失败时返回 error，由翻译引擎提示用户切换 AI；
 * - 内部按「段数 + 字符数」双重上限分块，避免超长请求被拒。
 */

import { requestUrl } from 'obsidian';

/** 单块最大段数与字符数（官方 API 限制的保守取值） */
const CHUNK_TEXTS = 50;
const CHUNK_CHARS = 18000;
/** 单请求超时（ms） */
const TIMEOUT_MS = 30000;

const MT_URL =
	'https://edge.microsoft.com/translate/translatetext?from=&to=zh-Hans&isEnterpriseClient=false';

/** 段落翻译结果：text 为 null 表示无需翻译（原文即中文） */
export interface MtItemResult {
	text: string | null;
}

export interface MtBatchResult {
	items: MtItemResult[];
	error: string | null;
}

/** 将段落列表按段数 / 字符数切成请求块 */
function chunkTexts(texts: string[]): string[][] {
	const chunks: string[][] = [];
	let cur: string[] = [];
	let chars = 0;
	for (const t of texts) {
		if (cur.length >= CHUNK_TEXTS || (cur.length > 0 && chars + t.length > CHUNK_CHARS)) {
			chunks.push(cur);
			cur = [];
			chars = 0;
		}
		cur.push(t);
		chars += t.length;
	}
	if (cur.length) chunks.push(cur);
	return chunks;
}

interface MtResponseItem {
	detectedLanguage?: { language?: string; score?: number };
	translations?: { text?: string; to?: string }[];
}

/** 单次 HTTP 调用（一组原文 → 一组响应项） */
async function callOnce(texts: string[]): Promise<MtResponseItem[]> {
	const res = await requestUrl({
		url: MT_URL,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			// 微软端点对无 UA 的请求偶发拒绝，带一个浏览器 UA 稳妥
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
		},
		body: JSON.stringify(texts),
		throw: false,
	});
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`微软机翻请求失败（HTTP ${res.status}）`);
	}
	const data = res.json as MtResponseItem[];
	if (!Array.isArray(data) || data.length !== texts.length) {
		throw new Error('微软机翻返回段数与请求不一致');
	}
	return data;
}

/**
 * 批量翻译：入参段落原文数组，返回逐段对齐的结果。
 * - detectedLanguage 以 zh 开头（原文即中文）→ text = null（无需翻译）；
 * - 其余段取 translations[0].text（文言段落译文=原文，由引擎的 unchanged 判定兜底）。
 */
export async function translateBatchMicrosoft(texts: string[]): Promise<MtBatchResult> {
	if (!texts.length) return { items: [], error: null };
	const items: MtItemResult[] = [];
	try {
		for (const chunk of chunkTexts(texts)) {
			const resp = await callOnce(chunk);
			for (let i = 0; i < chunk.length; i++) {
				const item = resp[i];
				const detected = item.detectedLanguage?.language ?? '';
				const out = item.translations?.[0]?.text?.trim() ?? '';
				const isChineseSource = /^zh/i.test(detected);
				items.push({ text: isChineseSource ? null : out || null });
			}
		}
		return { items, error: null };
	} catch (err) {
		console.warn('[FleurEPUB] 微软机翻失败', err);
		return {
			items,
			error: err instanceof Error ? err.message : '微软机翻请求异常',
		};
	}
}
