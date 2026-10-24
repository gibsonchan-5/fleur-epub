// 在线语音合成（听书「云端声音」）：统一调度 OpenAI 兼容 / 豆包 / 千问 三类接口。
//
// 为什么需要它：Web Speech API（系统语音）在 Android WebView 里根本不存在
// （MDN：WebView Android 不支持 SpeechSynthesis），安卓平板因此没有听书能力。
// 在线合成走网络接口，安卓 / iOS / 桌面表现一致，音色也更好。
//
// 网络层用 Obsidian 的 requestUrl 而非 fetch：它不受 CORS 限制，
// 移动端 WebView 也能直连第三方语音服务（与 AI 服务同一策略）。

import { requestUrl } from 'obsidian';
import {
	buildDoubaoRequest,
	buildQwenRequest,
	describeDoubaoSynthesisFailure,
	isCloudProvider,
	parseDoubaoResponse,
	parseQwenResponse,
	providerPreset,
	providerReady,
} from './tts-providers';
import type { DoubaoChannel, TtsVoicePreset } from './tts-providers';
import {
	TENCENT_MAX_CHARS,
	TENCENT_SAMPLE_RATE,
	buildTencentRequest,
	concatBytes,
	parseTencentResponse,
	pcmToWav,
	splitTextForLimit,
} from './tts-tencent';

export { TTS_PROVIDERS, providerPreset } from './tts-providers';

/** 在线引擎当前选择是否已配置到可用状态（按提供商分别判断） */
export function onlineTtsReady(settings: object): boolean {
	const provider = readProvider(settings);
	return providerReady(settings, provider);
}

/** 当前提供商的音色列表（自定义提供商时为空，由用户手填 id） */
export function onlineVoices(provider: string): TtsVoicePreset[] {
	return providerPreset(provider)?.voices ?? [];
}

function readProvider(settings: object): string {
	const value = (settings as Record<string, unknown>).ttsOnlineProvider;
	return typeof value === 'string' && value ? value : 'openai';
}

export interface OnlineTtsRequest {
	/** 提供商 id；缺省按 OpenAI 兼容处理，兼容旧调用 */
	provider?: string;
	baseUrl: string;
	/** 主密钥；腾讯云是 SecretId */
	apiKey: string;
	/** 第二把密钥：仅腾讯云使用（SecretKey，只在本机参与签名） */
	secretKey?: string;
	model: string;
	voice: string;
	/** 语速倍数（接口侧，1 = 正常） */
	speed?: number;
	/** 文本语言提示（部分服务商用于自动选发音，未知可不传） */
	lang?: string;
	/** 豆包接入通道：标准语音 / 火山方舟 AgentPlan */
	channel?: DoubaoChannel;
}

function detailOf(text: string): string {
	return (text || '').slice(0, 240).replace(/\s+/g, ' ').trim();
}

function blobFromBytes(bytes: Uint8Array, type: string): Blob {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return new Blob([copy], { type });
}

/**
 * 合成一句话为音频 Blob。
 * 失败时抛出带状态码与响应片段的错误，便于界面提示定位问题。
 */
export async function synthesizeOnline(req: OnlineTtsRequest, text: string): Promise<Blob> {
	const provider = req.provider && isCloudProvider(req.provider) ? req.provider : 'openai';
	const preset = providerPreset(provider);
	const apiKey = req.apiKey.trim();
	const secretKey = (req.secretKey ?? '').trim();
	const voice = req.voice.trim();
	if (!apiKey) {
		throw new Error(
			provider === 'tencent'
				? '未配置腾讯云 SecretId'
				: `未配置${preset?.label ?? '在线语音'}密钥`,
		);
	}
	if (preset?.secretKeyField && !secretKey) {
		throw new Error('未配置腾讯云 SecretKey（访问管理里与 SecretId 配对的那把）');
	}
	if (!voice) throw new Error('未选择语音音色');

	if (provider === 'doubao') return synthesizeDoubao(req, text, apiKey, voice);
	if (provider === 'qwen') return synthesizeQwen(req, text, apiKey, voice);
	if (provider === 'tencent') return synthesizeTencent(req, text, apiKey, secretKey, voice);
	return synthesizeOpenAiCompatible(req, text, apiKey, voice);
}

async function synthesizeDoubao(
	req: OnlineTtsRequest,
	text: string,
	apiKey: string,
	voice: string,
): Promise<Blob> {
	const built = buildDoubaoRequest({
		apiKey,
		text,
		voice,
		speed: req.speed,
		baseUrl: req.baseUrl,
		model: req.model,
		channel: req.channel,
	});
	const res = await requestUrl({
		url: built.url,
		method: 'POST',
		contentType: 'application/json',
		headers: built.headers,
		body: built.body,
		throw: false,
	});
	if (res.status >= 400) {
		throw new Error(
			describeDoubaoSynthesisFailure(
				res.status,
				res.text || '',
				req.channel === 'agentplan' ? 'agentplan' : 'standard',
			),
		);
	}
	const bytes = parseDoubaoResponse(res.text || '');
	return blobFromBytes(bytes, 'audio/mpeg');
}

async function synthesizeQwen(
	req: OnlineTtsRequest,
	text: string,
	apiKey: string,
	voice: string,
): Promise<Blob> {
	const built = buildQwenRequest({
		apiKey,
		text,
		voice,
		model: req.model.trim() || undefined,
		lang: req.lang,
		baseUrl: req.baseUrl,
	});
	const res = await requestUrl({
		url: built.url,
		method: 'POST',
		contentType: 'application/json',
		headers: built.headers,
		body: built.body,
		throw: false,
	});
	let payload: unknown = null;
	try {
		payload = JSON.parse(res.text || '{}');
	} catch {
		const detail = detailOf(res.text);
		throw new Error(
			`千问语音合成失败（HTTP ${res.status}）${detail ? `：${detail}` : '：返回不是 JSON'}`,
		);
	}
	// 业务错误即使在 200 里也会带 code，交给解析器统一抛出可读信息
	if (res.status >= 400) {
		parseQwenResponse(payload);
		const detail = detailOf(res.text);
		throw new Error(`千问语音合成失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
	}

	const audio = parseQwenResponse(payload);
	if (audio.data) return blobFromBytes(audio.data, audio.mime);
	if (!audio.url) throw new Error('千问语音合成失败：没有返回音频数据');

	// 大多数情况返回 24 小时有效的 OSS 链接；下载后再转成 Blob，播放器无需跨域权限
	const download = await requestUrl({ url: audio.url, method: 'GET', throw: false });
	if (download.status >= 400) {
		throw new Error(`千问语音下载失败（HTTP ${download.status}）`);
	}
	const buf = download.arrayBuffer;
	if (!buf || buf.byteLength === 0) throw new Error('千问语音下载失败：空音频');
	return new Blob([buf], { type: audio.mime });
}

/**
 * 腾讯云 TextToVoice：双密钥 TC3 签名。单句超过 150 汉字时自动切块，
 * 各片 PCM 按序拼接后套 WAV 头（时长与 seek 都准）。
 */
async function synthesizeTencent(
	req: OnlineTtsRequest,
	text: string,
	secretId: string,
	secretKey: string,
	voice: string,
): Promise<Blob> {
	const pieces = splitTextForLimit(text, TENCENT_MAX_CHARS);
	if (!pieces.length) throw new Error('没有可合成的文本');
	const chunks: Uint8Array[] = [];
	for (const piece of pieces) {
		const built = buildTencentRequest({
			secretId,
			secretKey,
			text: piece,
			voice,
			baseUrl: req.baseUrl,
		});
		const res = await requestUrl({
			url: built.url,
			method: 'POST',
			contentType: 'application/json',
			headers: built.headers,
			body: built.body,
			throw: false,
		});
		let payload: unknown = null;
		try {
			payload = JSON.parse(res.text || '{}');
		} catch {
			payload = null;
		}
		if (res.status >= 400) {
			// 业务错误可能仍带 Response.Error，比裸状态码更能定位
			if (payload) parseTencentResponse(payload);
			const detail = detailOf(res.text);
			throw new Error(`腾讯云语音合成失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
		}
		if (!payload) {
			throw new Error(`腾讯云返回的不是 JSON（HTTP ${res.status}）；请检查接口地址是否指错了服务`);
		}
		chunks.push(parseTencentResponse(payload));
	}
	const pcm = concatBytes(chunks);
	if (!pcm.length) throw new Error('腾讯云语音合成失败：返回空音频');
	return blobFromBytes(pcmToWav(pcm, TENCENT_SAMPLE_RATE), 'audio/wav');
}

async function synthesizeOpenAiCompatible(
	req: OnlineTtsRequest,
	text: string,
	apiKey: string,
	voice: string,
): Promise<Blob> {
	const base = req.baseUrl.trim().replace(/\/+$/, '');
	if (!base) throw new Error('未配置在线语音接口地址');
	const body: Record<string, unknown> = {
		model: req.model,
		input: text,
		voice,
		response_format: 'mp3',
	};
	// speed 仅 OpenAI 系支持；部分兼容实现不接受该字段，故仅在非 1 时附带
	if (req.speed && Math.abs(req.speed - 1) > 0.001) body.speed = req.speed;
	const res = await requestUrl({
		url: `${base}/audio/speech`,
		method: 'POST',
		contentType: 'application/json',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: 'audio/mpeg',
		},
		body: JSON.stringify(body),
		throw: false,
	});
	if (res.status >= 400) {
		const detail = detailOf(res.text);
		throw new Error(`语音合成失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
	}
	const buf = res.arrayBuffer;
	if (!buf || buf.byteLength === 0) throw new Error('语音合成返回空音频');
	return new Blob([buf], { type: 'audio/mpeg' });
}
