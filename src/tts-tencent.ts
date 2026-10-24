// 腾讯云语音合成（TextToVoice）纯层：TC3 签名、请求体、150 字切块、PCM→WAV、响应/错误。
//
// 为什么这个文件不 import 任何东西：`node --test` 直接跑 .ts 时不做无扩展名解析，
// 而移动端也拿不到 node:crypto。SHA-256/HMAC 因此自带纯 JS 实现（几十行），
// 误差一位服务端只会回一个笼统的 401，所以测试既对 RFC 4231 向量，也与 Node crypto 逐组对照。
//
// 安全边界：SecretKey 只在本机参与签名，绝不出现在 URL / header / body 里；
// 请求体只有待朗读文本与音色参数。

export const TENCENT_TTS_HOST = 'tts.tencentcloudapi.com';
export const TENCENT_TTS_ENDPOINT = `https://${TENCENT_TTS_HOST}`;
export const TENCENT_TTS_ACTION = 'TextToVoice';
export const TENCENT_TTS_VERSION = '2019-08-23';
/** 官方单次上限：150 个汉字 / 500 个英文字母。按码点切，英文只会更早断，不会超。 */
export const TENCENT_MAX_CHARS = 150;
export const TENCENT_SAMPLE_RATE = 16000;

const K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SENTENCE_BREAK = new Set(Array.from('。！？!?；;\n'));
const SOFT_BREAK = new Set(Array.from('，,、：: '));

function rotr(value: number, bits: number): number {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function asBytes(input: string | Uint8Array): Uint8Array {
	return typeof input === 'string' ? new TextEncoder().encode(input) : input;
}

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
	return out;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
	for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i) & 0xff;
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
	const len = data.length;
	const paddedLen = (((len + 8) >> 6) + 1) << 6;
	const padded = new Uint8Array(paddedLen);
	padded.set(data);
	padded[len] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLen - 8, Math.floor(len / 536870912));
	view.setUint32(paddedLen - 4, (len << 3) >>> 0);

	let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
	let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
	const w = new Uint32Array(64);

	for (let offset = 0; offset < paddedLen; offset += 64) {
		for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i += 1) {
			const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}

		let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
		for (let i = 0; i < 64; i += 1) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;
			h = g; g = f; f = e;
			e = (d + temp1) >>> 0;
			d = c; c = b; b = a;
			a = (temp1 + temp2) >>> 0;
		}
		h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
	}

	const out = new Uint8Array(32);
	const outView = new DataView(out.buffer);
	[h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, i) => outView.setUint32(i * 4, word));
	return out;
}

export function sha256Hex(input: string | Uint8Array): string {
	return toHex(sha256Bytes(asBytes(input)));
}

export function hmacSha256(key: string | Uint8Array, message: string | Uint8Array): Uint8Array {
	let keyBytes = asBytes(key);
	if (keyBytes.length > 64) keyBytes = sha256Bytes(keyBytes);
	const msg = asBytes(message);
	const block = new Uint8Array(64);
	block.set(keyBytes);
	// 内层必须是 64 + 消息长度：多留的零字节会被当成消息参与哈希，签名整体错位。
	const inner = new Uint8Array(64 + msg.length);
	for (let i = 0; i < 64; i += 1) inner[i] = block[i] ^ 0x36;
	inner.set(msg, 64);
	const innerHash = sha256Bytes(inner);
	const outer = new Uint8Array(64 + 32);
	for (let i = 0; i < 64; i += 1) outer[i] = block[i] ^ 0x5c;
	outer.set(innerHash, 64);
	return sha256Bytes(outer);
}

export function hmacSha256Hex(key: string | Uint8Array, message: string | Uint8Array): string {
	return toHex(hmacSha256(key, message));
}

/**
 * 接口地址归一化：默认官方端点；允许自建代理，但只收 https
 * （本机代理例外），且不许把凭据塞进 URL。
 */
function endpointOf(baseUrl?: string): { url: string; host: string; path: string } {
	const raw = (baseUrl?.trim() || TENCENT_TTS_ENDPOINT);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`腾讯云接口地址不合法：${raw}`);
	}
	const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
	if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localhost)) {
		throw new Error('腾讯云接口地址必须是 https（本机代理可用 http://localhost）');
	}
	if (parsed.username || parsed.password) throw new Error('接口地址里不能内嵌账号或密钥');
	const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '/';
	return {
		url: `${parsed.protocol}//${parsed.host}${path === '/' ? '' : path}`,
		host: parsed.host,
		path,
	};
}

export interface BuiltTencentRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

/**
 * 组装一次 TextToVoice 请求。timestamp 只给测试固定；生产取当前秒。
 * 签名规范：https://cloud.tencent.com/document/api/1073/37995（TC3-HMAC-SHA256）
 */
export function buildTencentRequest(req: {
	secretId: string;
	secretKey: string;
	text: string;
	voice: string;
	baseUrl?: string;
	timestamp?: number;
	sampleRate?: number;
}): BuiltTencentRequest {
	const voiceType = Number(String(req.voice || '').trim());
	if (!Number.isInteger(voiceType) || voiceType <= 0) {
		throw new Error(
			`腾讯云音色 id 必须是数字（当前：${req.voice || '空'}）；101xxx 是精品音色`,
		);
	}
	const endpoint = endpointOf(req.baseUrl);
	const body = JSON.stringify({
		Text: req.text,
		VoiceType: voiceType,
		Volume: 0,
		Speed: 0,
		ModelType: 1,
		SampleRate: req.sampleRate || TENCENT_SAMPLE_RATE,
		Codec: 'pcm',
	});

	const timestamp = Math.floor(
		typeof req.timestamp === 'number' ? req.timestamp : Date.now() / 1000,
	);
	const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
	const contentType = 'application/json; charset=utf-8';
	const action = TENCENT_TTS_ACTION.toLowerCase();
	const canonicalHeaders = `content-type:${contentType}\nhost:${endpoint.host}\nx-tc-action:${action}\n`;
	const signedHeaders = 'content-type;host;x-tc-action';
	const canonicalRequest = `POST\n${endpoint.path}\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256Hex(body)}`;
	const scope = `${date}/tts/tc3_request`;
	const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256Hex(canonicalRequest)}`;

	const kDate = hmacSha256(`TC3${req.secretKey}`, date);
	const kService = hmacSha256(kDate, 'tts');
	const kSigning = hmacSha256(kService, 'tc3_request');
	const signature = hmacSha256Hex(kSigning, stringToSign);

	return {
		url: endpoint.url,
		headers: {
			'Content-Type': contentType,
			'X-TC-Action': TENCENT_TTS_ACTION,
			'X-TC-Version': TENCENT_TTS_VERSION,
			'X-TC-Timestamp': String(timestamp),
			Authorization: `TC3-HMAC-SHA256 Credential=${req.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
		},
		body,
	};
}

/** 把 PCM 裸流套上 44 字节 WAV 头：浏览器才知道时长，seek 也才准。 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number = TENCENT_SAMPLE_RATE): Uint8Array {
	const header = new Uint8Array(44);
	const view = new DataView(header.buffer);
	writeAscii(header, 0, 'RIFF');
	view.setUint32(4, 36 + pcm.length, true);
	writeAscii(header, 8, 'WAVE');
	writeAscii(header, 12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(header, 36, 'data');
	view.setUint32(40, pcm.length, true);
	const out = new Uint8Array(44 + pcm.length);
	out.set(header);
	out.set(pcm, 44);
	return out;
}

export type TencentErrorKind = 'auth' | 'rate' | 'upstream' | 'unsupported';

export function classifyTencentError(code: string): { kind: TencentErrorKind; retryable: boolean } {
	if (/^AuthFailure\./i.test(code) || /^UnauthorizedOperation\./i.test(code)) {
		return { kind: 'auth', retryable: false };
	}
	if (/NotEnoughBalance|ServiceIsolate|NoFreeAmount|Arrears|ResourceInsufficient/i.test(code)) {
		return { kind: 'auth', retryable: false };
	}
	if (/^RequestLimitExceeded/i.test(code)) return { kind: 'rate', retryable: true };
	if (/^InternalError/i.test(code) || /ServiceUnavailable|TryAgain/i.test(code)) {
		return { kind: 'upstream', retryable: true };
	}
	if (/^InvalidParameter/i.test(code) || /^UnsupportedOperation/i.test(code) || /TextTooLong/i.test(code)) {
		return { kind: 'unsupported', retryable: false };
	}
	return { kind: 'upstream', retryable: false };
}

export function describeTencentError(code: string, message: string): string {
	const detail = (message || '').trim();
	const tail = detail ? ` 服务端返回：${detail}` : '';
	if (/SignatureFailure|SignatureExpire|SignatureMissing/i.test(code)) {
		return `腾讯云签名校验失败（${code}）：请核对 SecretKey 是否与 SecretId 配对，以及本机时间是否准确。${tail}`;
	}
	if (/SecretIdNotFound|InvalidSecretId/i.test(code)) {
		return `腾讯云 SecretId 不存在（${code}）：请核对访问管理里的 SecretId，注意别把 SecretKey 填进这一格。${tail}`;
	}
	if (/ServiceIsolate|NoFreeAmount|NotEnoughBalance|Arrears|ResourceInsufficient/i.test(code)) {
		return `腾讯云语音合成不可用（${code}）：服务未开通、账户欠费或免费额度已用尽。${tail}`;
	}
	if (/TextTooLong/i.test(code)) {
		return `腾讯云单次文本超限（${code}）：单次最多 150 个汉字，插件会自动切分。${tail}`;
	}
	return `腾讯云语音合成失败（${code}）${detail ? `：${detail}` : ''}`;
}

function decodeBase64(value: string): Uint8Array {
	const clean = value.replace(/\s+/g, '');
	if (!clean) return new Uint8Array(0);
	if (typeof atob === 'function') {
		const binary = atob(clean);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
		return out;
	}
	const bufferCtor = (globalThis as { Buffer?: { from: (v: string, enc: string) => Uint8Array } }).Buffer;
	if (bufferCtor) return new Uint8Array(bufferCtor.from(clean, 'base64'));
	throw new Error('当前环境不支持 base64 解码');
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
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

/** 解析 TextToVoice 响应：成功取 base64 Audio；业务错误在 HTTP 200 里也会带 Error。 */
export function parseTencentResponse(payload: unknown): Uint8Array {
	const root = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
	const response = (root.Response && typeof root.Response === 'object' ? root.Response : {}) as Record<
		string,
		unknown
	>;
	const error = response.Error;
	if (error && typeof error === 'object') {
		const rec = error as Record<string, unknown>;
		const code = typeof rec.Code === 'string' && rec.Code ? rec.Code : 'UnknownError';
		const message = typeof rec.Message === 'string' ? rec.Message : '';
		throw new Error(describeTencentError(code, message));
	}
	const audio = typeof response.Audio === 'string' ? response.Audio.trim() : '';
	if (!audio) throw new Error('腾讯云语音合成失败：没有返回音频数据');
	return decodeBase64(audio);
}

/** 按码点切块，优先句末、其次逗号；拼回去与原文一字不差。 */
export function splitTextForLimit(text: string, maxChars: number = TENCENT_MAX_CHARS): string[] {
	const source = typeof text === 'string' ? text : '';
	if (!source.trim()) return [];
	const cps = Array.from(source);
	const max = Math.max(1, Math.floor(maxChars));
	if (cps.length <= max) return [source];

	const out: string[] = [];
	let start = 0;
	while (start < cps.length) {
		let end = Math.min(start + max, cps.length);
		if (end < cps.length) {
			// 至少过半再断，避免出现「开头两个字 + 一大片」这种碎块
			const minEnd = start + Math.max(1, Math.floor(max / 2));
			let cut = -1;
			for (let i = end - 1; i >= minEnd; i -= 1) {
				if (SENTENCE_BREAK.has(cps[i])) {
					cut = i + 1;
					break;
				}
			}
			if (cut < 0) {
				for (let i = end - 1; i >= minEnd; i -= 1) {
					if (SOFT_BREAK.has(cps[i])) {
						cut = i + 1;
						break;
					}
				}
			}
			if (cut > start) end = cut;
		}
		out.push(cps.slice(start, end).join(''));
		start = end;
	}
	return out;
}
