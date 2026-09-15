// 在线语音合成（听书「在线引擎」）：面向任意 OpenAI 兼容的 /audio/speech 接口。
//
// 为什么需要它：Web Speech API（系统语音）在 Android WebView 里根本不存在
// （MDN：WebView Android 不支持 SpeechSynthesis），安卓平板因此没有听书能力。
// 在线合成走网络接口，安卓 / iOS / 桌面表现一致，音色也更好。
//
// 网络层用 Obsidian 的 requestUrl 而非 fetch：它不受 CORS 限制，
// 移动端 WebView 也能直连第三方语音服务（与 AI 服务同一策略）。

import { requestUrl } from 'obsidian';

export interface OnlineTtsPreset {
	label: string;
	baseUrl: string;
	model: string;
	/** 常用音色（id 用于请求，label 用于界面） */
	voices: { id: string; label: string }[];
	/** 申请 / 说明页提示（设置界面展示） */
	hint?: string;
}

/** 预置提供商：均为 OpenAI 兼容 /audio/speech 接口 */
export const ONLINE_TTS_PRESETS: Record<string, OnlineTtsPreset> = {
	openai: {
		label: 'OpenAI（tts-1 系列）',
		baseUrl: 'https://api.openai.com/v1',
		model: 'tts-1',
		voices: [
			{ id: 'alloy', label: 'alloy · 中性' },
			{ id: 'echo', label: 'echo · 男声' },
			{ id: 'fable', label: 'fable · 叙述' },
			{ id: 'onyx', label: 'onyx · 低沉' },
			{ id: 'nova', label: 'nova · 女声' },
			{ id: 'shimmer', label: 'shimmer · 柔和' },
		],
		hint: '需海外网络环境；模型可选 tts-1 / tts-1-hd / gpt-4o-mini-tts',
	},
	siliconflow: {
		label: '硅基流动 · CosyVoice2（国内直连）',
		baseUrl: 'https://api.siliconflow.cn/v1',
		model: 'FunAudioLLM/CosyVoice2-0.5B',
		voices: [
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:alex', label: 'alex · 男声' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:benjamin', label: 'benjamin · 男声' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:charles', label: 'charles · 男声' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:david', label: 'david · 男声' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:anna', label: 'anna · 女声' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:bella', label: 'bella · 女声' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:claire', label: 'claire · 女声' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:diana', label: 'diana · 女声' },
		],
		hint: '国内可直连，注册即赠额度；中文音色自然',
	},
	custom: {
		label: '自定义（任意 OpenAI 兼容接口）',
		baseUrl: '',
		model: 'tts-1',
		voices: [],
		hint: '填入服务商给出的 Base URL、模型与音色 id 即可',
	},
};

/** 在线引擎是否已配置到可用状态（有密钥与地址） */
export function onlineTtsReady(s: { ttsOnlineBaseUrl: string; ttsOnlineApiKey: string }): boolean {
	return !!s.ttsOnlineBaseUrl.trim() && !!s.ttsOnlineApiKey.trim();
}

/** 当前提供商的音色列表（自定义提供商时为空，由用户手填） */
export function onlineVoices(provider: string): { id: string; label: string }[] {
	return ONLINE_TTS_PRESETS[provider]?.voices ?? [];
}

export interface OnlineTtsRequest {
	baseUrl: string;
	apiKey: string;
	model: string;
	voice: string;
	/** 语速倍数（接口侧，1 = 正常） */
	speed?: number;
	/** 文本语言提示（部分服务商用于自动选发音，未知可不传） */
	lang?: string;
}

/**
 * 合成一句话为 mp3 Blob。
 * 失败时抛出带状态码与响应片段的错误，便于界面提示定位问题。
 */
export async function synthesizeOnline(
	req: OnlineTtsRequest,
	text: string,
): Promise<Blob> {
	const base = req.baseUrl.trim().replace(/\/+$/, '');
	if (!base) throw new Error('未配置在线语音接口地址');
	if (!req.apiKey.trim()) throw new Error('未配置在线语音密钥');
	const body: Record<string, unknown> = {
		model: req.model,
		input: text,
		voice: req.voice,
		response_format: 'mp3',
	};
	// speed 仅 OpenAI 系支持；部分兼容实现不接受该字段，故仅在非 1 时附带
	if (req.speed && Math.abs(req.speed - 1) > 0.001) body.speed = req.speed;
	const res = await requestUrl({
		url: `${base}/audio/speech`,
		method: 'POST',
		contentType: 'application/json',
		headers: {
			Authorization: `Bearer ${req.apiKey.trim()}`,
			Accept: 'audio/mpeg',
		},
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status >= 400) {
		const detail = (res.text || '').slice(0, 200).replace(/\s+/g, ' ');
		throw new Error(`语音合成失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
	}
	const buf = res.arrayBuffer;
	if (!buf || buf.byteLength === 0) throw new Error('语音合成返回空音频');
	return new Blob([buf], { type: 'audio/mpeg' });
}
