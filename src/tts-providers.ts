// 语音提供商：纯数据与纯函数，不依赖 Obsidian，可直接用 node --test 跑。
// 责任边界：只回答「有哪些声音」「怎么算就绪」「请求体长什么样」「响应怎么拆」，
// 不做网络、不碰设置界面。

export type TtsProviderId = 'system' | 'openai' | 'siliconflow' | 'doubao' | 'qwen' | 'custom';
export type CloudTtsProviderId = Exclude<TtsProviderId, 'system'>;
export type TtsProviderKind = 'openai' | 'doubao' | 'qwen';

export interface TtsVoicePreset {
	id: string;
	label: string;
	note?: string;
	lang?: 'zh' | 'en' | 'multi';
}

export interface TtsModelPreset {
	id: string;
	label: string;
}

export interface TtsProviderPreset {
	id: CloudTtsProviderId;
	label: string;
	shortLabel: string;
	kind: TtsProviderKind;
	baseUrl: string;
	model: string;
	/** 模型下拉的预设项；自定义服务为空，由用户手填 */
	models: TtsModelPreset[];
	voices: TtsVoicePreset[];
	defaultVoice: string;
	hint?: string;
	keyPlaceholder?: string;
}

export const TTS_PROVIDERS: Record<CloudTtsProviderId, TtsProviderPreset> = {
	openai: {
		id: 'openai',
		label: 'OpenAI',
		shortLabel: 'OpenAI',
		kind: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		model: 'tts-1',
		models: [
			{ id: 'tts-1', label: 'tts-1（标准）' },
			{ id: 'tts-1-hd', label: 'tts-1-hd（高清）' },
			{ id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts（新一代）' },
		],
		defaultVoice: 'alloy',
		keyPlaceholder: 'sk-…',
		hint: '接口稳定、音色中性；国内需自备网络。',
		voices: [
			{ id: 'alloy', label: 'Alloy', note: '中性', lang: 'multi' },
			{ id: 'echo', label: 'Echo', note: '沉稳男声', lang: 'multi' },
			{ id: 'fable', label: 'Fable', note: '叙事', lang: 'multi' },
			{ id: 'onyx', label: 'Onyx', note: '低沉男声', lang: 'multi' },
			{ id: 'nova', label: 'Nova', note: '清亮女声', lang: 'multi' },
			{ id: 'shimmer', label: 'Shimmer', note: '柔和女声', lang: 'multi' },
		],
	},
	siliconflow: {
		id: 'siliconflow',
		label: '硅基流动',
		shortLabel: '硅基流动',
		kind: 'openai',
		baseUrl: 'https://api.siliconflow.cn/v1',
		model: 'FunAudioLLM/CosyVoice2-0.5B',
		models: [
			{ id: 'FunAudioLLM/CosyVoice2-0.5B', label: 'CosyVoice 2（0.5B）' },
		],
		defaultVoice: 'anna',
		keyPlaceholder: 'sk-…',
		hint: 'OpenAI 兼容接口，中文自然，按量计费。',
		voices: [
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:anna', label: 'Anna', note: '温柔女声', lang: 'zh' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:bella', label: 'Bella', note: '活泼女声', lang: 'zh' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:claire', label: 'Claire', note: '知性女声', lang: 'zh' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:diana', label: 'Diana', note: '沉稳女声', lang: 'zh' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:alex', label: 'Alex', note: '阳光男声', lang: 'zh' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:benjamin', label: 'Benjamin', note: '磁性男声', lang: 'zh' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:charles', label: 'Charles', note: '低沉男声', lang: 'zh' },
			{ id: 'FunAudioLLM/CosyVoice2-0.5B:david', label: 'David', note: '叙事男声', lang: 'zh' },
		],
	},
	doubao: {
		id: 'doubao',
		label: '豆包 · 火山引擎',
		shortLabel: '豆包',
		kind: 'doubao',
		baseUrl: 'https://openspeech.bytedance.com',
		model: 'seed-tts-2.0',
		models: [{ id: 'seed-tts-2.0', label: '豆包语音合成 2.0' }],
		defaultVoice: 'zh_female_vv_uranus_bigtts',
		keyPlaceholder: '语音技术 / AgentPlan 的 API Key',
		hint: '标准通道用「语音技术 → API Key 管理」的 Key；方舟 AgentPlan 套餐请切到对应接入方式并使用其专属 Key。',
		voices: [
			{ id: 'zh_female_vv_uranus_bigtts', label: 'Vivi', note: '自然女声', lang: 'zh' },
			{ id: 'zh_female_mengyatou_uranus_bigtts', label: '萌丫头', note: '俏皮女声', lang: 'zh' },
			{ id: 'zh_female_zhixingnv_uranus_bigtts', label: '知性女声', note: '播报', lang: 'zh' },
			{ id: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说男声', note: '解说', lang: 'zh' },
			{ id: 'zh_male_yangguangqingnian_uranus_bigtts', label: '阳光青年', note: '清朗男声', lang: 'zh' },
			{ id: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客', note: '低缓男声', lang: 'zh' },
		],
	},
	qwen: {
		id: 'qwen',
		label: '阿里千问',
		shortLabel: '千问',
		kind: 'qwen',
		baseUrl: 'https://dashscope.aliyuncs.com',
		model: 'qwen3-tts-flash',
		models: [
			{ id: 'qwen3-tts-flash', label: 'qwen3-tts-flash（推荐）' },
			{ id: 'qwen-tts', label: 'qwen-tts' },
		],
		defaultVoice: 'Cherry',
		keyPlaceholder: 'DashScope API Key',
		hint: '千问 TTS，中英皆可；按字符计费，首次使用需在百炼开通。',
		voices: [
			{ id: 'Cherry', label: 'Cherry', note: '亲和女声', lang: 'zh' },
			{ id: 'Serena', label: 'Serena', note: '温柔女声', lang: 'zh' },
			{ id: 'Chelsie', label: 'Chelsie', note: '知性女声', lang: 'zh' },
			{ id: 'Ethan', label: 'Ethan', note: '阳光男声', lang: 'zh' },
		],
	},
	custom: {
		id: 'custom',
		label: '自定义',
		shortLabel: '自定义',
		kind: 'openai',
		baseUrl: '',
		model: 'tts-1',
		models: [],
		defaultVoice: '',
		keyPlaceholder: 'sk-…',
		hint: '任何 OpenAI 兼容的 /audio/speech 服务。',
		voices: [],
	},
};

export function isCloudProvider(value: string): value is CloudTtsProviderId {
	return Object.prototype.hasOwnProperty.call(TTS_PROVIDERS, value);
}

export function providerPreset(value: string): TtsProviderPreset | null {
	return isCloudProvider(value) ? TTS_PROVIDERS[value] : null;
}

/** 每家提供商对应的独立密钥字段；旧版只有一个 ttsOnlineApiKey。 */
const PROVIDER_KEY_FIELDS: Record<CloudTtsProviderId, string> = {
	openai: 'ttsOpenaiApiKey',
	siliconflow: 'ttsSiliconflowApiKey',
	doubao: 'ttsDoubaoApiKey',
	qwen: 'ttsQwenApiKey',
	custom: 'ttsCustomApiKey',
};

export function providerKeyField(provider: CloudTtsProviderId): string {
	return PROVIDER_KEY_FIELDS[provider];
}

function readString(source: object, key: string): string {
	const value = (source as Record<string, unknown>)[key];
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * 读取某家提供商的密钥。旧版单一密钥只回退给 OpenAI 兼容系
 * （openai / siliconflow / custom），豆包与千问从不借用别人的密钥。
 */
export function providerApiKey(settings: object, provider: string): string {
	if (!isCloudProvider(provider)) return '';
	const own = readString(settings, PROVIDER_KEY_FIELDS[provider]);
	if (own) return own;
	if (provider === 'openai' || provider === 'siliconflow' || provider === 'custom') {
		return readString(settings, 'ttsOnlineApiKey');
	}
	return '';
}

/** 内置云服务只差一把密钥；自定义服务还必须有接口地址。 */
export function providerReady(settings: object, provider: string): boolean {
	if (provider === 'system') return true;
	if (!isCloudProvider(provider)) return false;
	if (!providerApiKey(settings, provider)) return false;
	if (provider === 'custom') {
		return /^https?:\/\//i.test(providerConfig(settings, provider).baseUrl);
	}
	return true;
}

/**
 * 豆包的两条接入通道：同一个 v3 协议、同一套音色，只是端点与密钥来源不同。
 * - standard：语音技术控制台，/api/v3/tts/unidirectional
 * - agentplan：火山方舟 Agent Plan 套餐，/api/v3/plan/tts/unidirectional
 */
export type DoubaoChannel = 'standard' | 'agentplan';

export interface TtsProviderConfig {
	baseUrl: string;
	model: string;
	/** 仅豆包使用；缺省按标准语音通道 */
	channel?: DoubaoChannel;
}

function readDoubaoChannel(entry: Record<string, unknown> | null): DoubaoChannel {
	const value = entry ? entry.channel : undefined;
	return value === 'agentplan' ? 'agentplan' : 'standard';
}

/** 各提供商的接口覆盖存在这里（按 provider 分键，互不串号）。 */
const PROVIDER_CONFIG_FIELD = 'ttsProviderConfigs';

/**
 * 读出某家提供商实际使用的接口地址与模型：
 * 用户覆盖 → 预设默认。自定义服务在没有独立配置时沿用旧版全局字段，
 * 保证升级前的自定义接口配置不丢。
 */
export function providerConfig(settings: object, provider: string): TtsProviderConfig {
	const preset = providerPreset(provider);
	if (!preset) return { baseUrl: '', model: '' };
	const rec = settings as Record<string, unknown>;
	const all = rec[PROVIDER_CONFIG_FIELD];
	const entry = all && typeof all === 'object' ? (all as Record<string, unknown>)[provider] : null;
	const saved = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
	const storedBase = saved ? readString(saved, 'baseUrl') : '';
	const storedModel = saved ? readString(saved, 'model') : '';
	if (provider === 'custom') {
		return {
			baseUrl: storedBase || readString(rec, 'ttsOnlineBaseUrl') || preset.baseUrl,
			model: storedModel || readString(rec, 'ttsOnlineModel') || preset.model,
		};
	}
	const config: TtsProviderConfig = {
		baseUrl: storedBase || preset.baseUrl,
		model: storedModel || preset.model,
	};
	if (provider === 'doubao') config.channel = readDoubaoChannel(saved);
	return config;
}

/** 写入某家提供商的接口/模型覆盖；传空字符串即回到预设默认。 */
export function setProviderConfig(
	settings: object,
	provider: string,
	patch: Partial<TtsProviderConfig>,
): void {
	if (!isCloudProvider(provider)) return;
	const rec = settings as Record<string, unknown>;
	const allRaw = rec[PROVIDER_CONFIG_FIELD];
	const all: Record<string, unknown> =
		allRaw && typeof allRaw === 'object' ? { ...(allRaw as Record<string, unknown>) } : {};
	const entryRaw = all[provider];
	const entry: Record<string, unknown> =
		entryRaw && typeof entryRaw === 'object' ? { ...(entryRaw as Record<string, unknown>) } : {};
	if (patch.baseUrl !== undefined) entry.baseUrl = patch.baseUrl.trim();
	if (patch.model !== undefined) entry.model = patch.model.trim();
	if (provider === 'doubao' && patch.channel !== undefined) {
		entry.channel = patch.channel === 'agentplan' ? 'agentplan' : 'standard';
	}
	all[provider] = entry;
	rec[PROVIDER_CONFIG_FIELD] = all;
}

export interface TtsSelectionSettings {
	ttsEngine: 'system' | 'online';
	ttsVoiceURI: string;
	ttsOnlineProvider: string;
	ttsOnlineBaseUrl: string;
	ttsOnlineModel: string;
	ttsOnlineVoice: string;
}

/** 统一声音下拉里的稳定取值：`system:<voiceURI>` 或 `<provider>:<voiceId>`。 */
export function currentSelectionKey(settings: TtsSelectionSettings): string {
	if (settings.ttsEngine === 'system') return `system:${settings.ttsVoiceURI}`;
	return `${settings.ttsOnlineProvider}:${settings.ttsOnlineVoice}`;
}

/**
 * 统一声音下拉选中后写回设置：
 * - 系统声音只改 ttsEngine / ttsVoiceURI，云端选择原样保留；
 * - 云端声音只切提供商与音色。接口地址和模型由 providerConfig() 按提供商
 *   取默认值/覆盖值，不再改写共享的旧版全局字段——否则选一次内置声音就会
 *   把「自定义接口」的配置冲掉。
 */
export function applyVoiceSelection(
	settings: TtsSelectionSettings,
	provider: TtsProviderId,
	voiceId: string,
): void {
	if (provider === 'system') {
		settings.ttsEngine = 'system';
		settings.ttsVoiceURI = voiceId;
		return;
	}
	const preset = TTS_PROVIDERS[provider];
	settings.ttsEngine = 'online';
	settings.ttsOnlineProvider = provider;
	settings.ttsOnlineVoice = normalizeVoiceId(provider, voiceId) || preset.defaultVoice;
}

/**
 * 旧音色 id 迁移。豆包 2.0 的「知性女声」官方 id 是 zhixingnv，
 * 早期版本误写成 zhixingnvsheng，导致该音色请求被服务端拒绝。
 */
const VOICE_ID_ALIASES: Record<string, Record<string, string>> = {
	doubao: {
		zh_female_zhixingnvsheng_uranus_bigtts: 'zh_female_zhixingnv_uranus_bigtts',
	},
};

export function normalizeVoiceId(provider: string, voiceId: string): string {
	const aliases = VOICE_ID_ALIASES[provider];
	return (aliases && aliases[voiceId]) || voiceId;
}

// ── 请求构造与响应解析 ──────────────────────────────────────────────

export interface BuiltSpeechRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

export const DOUBAO_TTS_PATH = '/api/v3/tts/unidirectional';
export const DOUBAO_PLAN_TTS_PATH = '/api/v3/plan/tts/unidirectional';
export const DOUBAO_TTS_URL = `${TTS_PROVIDERS.doubao.baseUrl}${DOUBAO_TTS_PATH}`;
export const DOUBAO_PLAN_TTS_URL = `${TTS_PROVIDERS.doubao.baseUrl}${DOUBAO_PLAN_TTS_PATH}`;
export const DOUBAO_RESOURCE_ID = 'seed-tts-2.0';
export const QWEN_TTS_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
export const QWEN_TTS_URL = `${TTS_PROVIDERS.qwen.baseUrl}${QWEN_TTS_PATH}`;

/** 拼接自定义端点：已带完整路径时不重复追加。 */
function joinEndpoint(base: string | undefined, fallback: string, path: string): string {
	const root = (base?.trim() || fallback).replace(/\/+$/, '');
	if (root.endsWith(path)) return root;
	return `${root}${path}`;
}

/**
 * 豆包 Base URL 归一化：用户若把完整端点粘进「接口地址」（尤其从标准版
 * 切到 AgentPlan 时），先剥掉旧路径再按当前通道拼，避免出现
 * /api/v3/tts/unidirectional/api/v3/plan/... 这类叠路径。
 */
function doubaoRoot(baseUrl: string | undefined): string {
	const raw = (baseUrl?.trim() || TTS_PROVIDERS.doubao.baseUrl).replace(/\/+$/, '');
	for (const suffix of [DOUBAO_PLAN_TTS_PATH, DOUBAO_TTS_PATH]) {
		if (raw.endsWith(suffix)) return raw.slice(0, -suffix.length);
	}
	return raw;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function newRequestId(): string {
	try {
		const uuid = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.();
		if (uuid) return uuid;
	} catch {
		/* 忽略：退回时间戳 */
	}
	return `fleur-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 豆包语音合成 2.0（v3 单向流式 HTTP）：换行分隔的 JSON，音频为 base64 片段。 */
export function buildDoubaoRequest(req: {
	apiKey: string;
	text: string;
	voice: string;
	requestId?: string;
	speed?: number;
	/** 覆盖官方端点（代理/自建网关时使用） */
	baseUrl?: string;
	/** 资源 ID，默认 seed-tts-2.0 */
	model?: string;
	/** 接入通道：标准语音 / 火山方舟 Agent Plan，决定端点路径 */
	channel?: DoubaoChannel;
}): BuiltSpeechRequest {
	const audioParams: Record<string, unknown> = {
		format: 'mp3',
		sample_rate: 24000,
	};
	if (typeof req.speed === 'number' && Number.isFinite(req.speed)) {
		audioParams.speech_rate = clamp(Math.round((req.speed - 1) * 100), -50, 100);
	}
	const path = req.channel === 'agentplan' ? DOUBAO_PLAN_TTS_PATH : DOUBAO_TTS_PATH;
	return {
		url: `${doubaoRoot(req.baseUrl)}${path}`,
		headers: {
			'Content-Type': 'application/json',
			'X-Api-Key': req.apiKey,
			'X-Api-Resource-Id': req.model?.trim() || DOUBAO_RESOURCE_ID,
			'X-Api-Request-Id': req.requestId || newRequestId(),
		},
		body: JSON.stringify({
			user: { uid: 'fleur-epub' },
			req_params: {
				text: req.text,
				speaker: req.voice,
				audio_params: audioParams,
			},
		}),
	};
}

/** 千问 TTS：DashScope 多模态生成接口，返回内联 base64 或 24 小时有效的 OSS 地址。 */
export function buildQwenRequest(req: {
	apiKey: string;
	text: string;
	voice: string;
	model?: string;
	lang?: string;
	/** 覆盖官方端点（代理/自建网关时使用） */
	baseUrl?: string;
}): BuiltSpeechRequest {
	const input: Record<string, unknown> = { text: req.text, voice: req.voice };
	const language = qwenLanguageType(req.lang);
	if (language) input.language_type = language;
	return {
		url: joinEndpoint(req.baseUrl, TTS_PROVIDERS.qwen.baseUrl, QWEN_TTS_PATH),
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${req.apiKey}`,
		},
		body: JSON.stringify({
			model: req.model || TTS_PROVIDERS.qwen.model,
			input,
		}),
	};
}

function qwenLanguageType(lang?: string): string | null {
	if (!lang) return null;
	const lower = lang.toLowerCase();
	if (lower.startsWith('en')) return 'English';
	if (lower.startsWith('zh')) return 'Chinese';
	return null;
}

export function decodeBase64(value: string): Uint8Array {
	const clean = value.replace(/\s+/g, '');
	if (!clean) return new Uint8Array(0);
	if (typeof atob === 'function') {
		const binary = atob(clean);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
		return out;
	}
	const bufferCtor = (globalThis as { Buffer?: { from: (v: string, enc: string) => Uint8Array } })
		.Buffer;
	if (bufferCtor) return new Uint8Array(bufferCtor.from(clean, 'base64'));
	throw new Error('当前环境不支持 base64 解码');
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const chunk of chunks) total += chunk.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/**
 * 解析豆包 v3 的换行分隔 JSON。成功片段带 base64 `data`，最后一行为空数据；
 * 任何非成功 code 立即抛出，避免把错误 JSON 当音频播出去。
 */
export function parseDoubaoResponse(text: string): Uint8Array {
	const chunks: Uint8Array[] = [];
	const lines = text.split(/\r?\n/);
	for (const rawLine of lines) {
		let line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith('data:')) line = line.slice(5).trim();
		if (!line || line === '[DONE]') continue;
		let payload: Record<string, unknown>;
		try {
			payload = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		const code = payload.code;
		const ok = code === 0 || code === 20000000 || code === '0' || code === '20000000';
		if (!ok) {
			const message = typeof payload.message === 'string' ? payload.message : '未知错误';
			throw new Error(`豆包语音合成失败（${String(code)}）：${message}`);
		}
		const data = payload.data;
		if (typeof data === 'string' && data.trim()) chunks.push(decodeBase64(data));
	}
	if (!chunks.length) throw new Error('豆包语音合成失败：没有返回音频数据');
	return concatBytes(chunks);
}

function detailOf(text: string): string {
	return (text || '').slice(0, 240).replace(/\s+/g, ' ').trim();
}

/**
 * 把豆包的 HTTP 错误翻译成能照着做的提示。
 *
 * 45000010 / Invalid X-Api-Key 是鉴权失败，但两条通道的 Key 不通用：
 * 标准语音走「语音技术 → API Key 管理」，AgentPlan 走方舟套餐的专属 Key。
 * 把普通方舟推理 Key 填进标准端点，或把语音技术 Key 填进 /plan 端点，都会 401。
 */
export function describeDoubaoSynthesisFailure(
	status: number,
	body: string,
	channel: DoubaoChannel = 'standard',
): string {
	const detail = detailOf(body);
	// 45000030 走的是 403，但含义不是 Key 无效，而是套餐/席位拒绝抵扣，
	// 必须排在鉴权判断之前，否则会把账号侧的开关问题误报成密钥问题。
	if (/AgentPlanDeductNotEnabled|45000030/i.test(body)) {
		return (
			'豆包语音合成失败（45000030）：Agent Plan 拒绝从套餐抵扣。' +
			'原因通常是该账号/席位未开通语音模型的抵扣，或这把 Key 不属于有效的 Agent Plan 套餐。' +
			'请到火山方舟控制台「开通管理 → Agent Plan」确认套餐在有效期内并开启语音抵扣' +
			'（企业席位需管理员为该席位开通）；若这把 Key 来自 Coding Plan 或普通方舟推理，' +
			'请换成 Agent Plan 专属 API Key。' +
			(detail ? ` 服务端返回：${detail}` : '')
		);
	}
	const authFailed = status === 401 || status === 403 || /Invalid X-Api-Key|45000010/i.test(body);
	if (authFailed) {
		if (channel === 'agentplan') {
			return (
				`豆包语音合成失败（HTTP ${status}）：AgentPlan 专属 API Key 未被接受。` +
				'请确认这把 Key 是在火山方舟 Agent Plan 控制台创建的专属 Key、套餐仍在有效期内；' +
				'语音技术控制台的 Key 与普通方舟推理 Key 都不能用于 AgentPlan 语音接口。' +
				(detail ? ` 服务端返回：${detail}` : '')
			);
		}
		return (
			`豆包语音合成失败（HTTP ${status}）：密钥无效。请到火山引擎「语音技术 → API Key 管理」` +
			'为「豆包语音合成 2.0」创建 API Key；旧版控制台的 Access Token 也不能用于标准通道。' +
			'若你用的是方舟 AgentPlan 套餐，请把「接入方式」切到 AgentPlan 并使用套餐专属 Key。' +
			(detail ? ` 服务端返回：${detail}` : '')
		);
	}
	return `豆包语音合成失败（HTTP ${status}）${detail ? `：${detail}` : ''}`;
}

export interface QwenSpeechAudio {
	data?: Uint8Array;
	url?: string;
	mime: string;
}

/** 解析千问响应：优先内联 base64（不依赖外链有效期），否则读 OSS 地址。 */
export function parseQwenResponse(payload: unknown): QwenSpeechAudio {
	const root = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
	const statusCode = typeof root.status_code === 'number' ? root.status_code : 200;
	const code = root.code;
	const message = typeof root.message === 'string' ? root.message : '未知错误';
	const stringCode = typeof code === 'string' && code.trim() ? code.trim() : '';
	const numericCode = typeof code === 'number' ? code : null;
	const failed =
		statusCode >= 400 ||
		Boolean(stringCode) ||
		(numericCode !== null && numericCode !== 0 && numericCode !== 200);
	if (failed) {
		const label = stringCode || String(numericCode ?? statusCode);
		throw new Error(`千问语音合成失败（${label}）：${message}`);
	}

	const output = (root.output && typeof root.output === 'object' ? root.output : {}) as Record<
		string,
		unknown
	>;
	const audio = (output.audio && typeof output.audio === 'object' ? output.audio : {}) as Record<
		string,
		unknown
	>;
	const inline = typeof audio.data === 'string' ? audio.data.trim() : '';
	if (inline) {
		return { data: decodeBase64(inline), mime: 'audio/wav' };
	}
	const url = typeof audio.url === 'string' ? audio.url.trim() : '';
	if (url) {
		return { url, mime: audioMimeFromUrl(url) };
	}
	throw new Error('千问语音合成失败：没有返回音频数据');
}

export function audioMimeFromUrl(url: string): string {
	let path = url;
	try {
		path = new URL(url).pathname;
	} catch {
		path = url.split('?')[0];
	}
	const ext = path.toLowerCase().split('.').pop() || '';
	if (ext === 'wav' || ext === 'wave') return 'audio/wav';
	if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
	if (ext === 'm4a' || ext === 'mp4' || ext === 'aac') return 'audio/mp4';
	return 'audio/mpeg';
}


