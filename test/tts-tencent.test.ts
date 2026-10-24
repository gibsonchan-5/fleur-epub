// 腾讯云 TextToVoice 纯层测试：TC3 签名、150 字切块、PCM→WAV、响应/错误。
// 签名是自带纯 JS（移动端拿不到 node:crypto），所以既要对标准向量，也要与 Node crypto 逐组对照。
// 运行：node --test test/tts-tencent.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import {
	TENCENT_MAX_CHARS,
	TENCENT_SAMPLE_RATE,
	TENCENT_TTS_HOST,
	TENCENT_TTS_VERSION,
	buildTencentRequest,
	classifyTencentError,
	describeTencentError,
	hmacSha256Hex,
	parseTencentResponse,
	pcmToWav,
	sha256Hex,
	splitTextForLimit,
} from '../src/tts-tencent.ts';

const nodeSha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const nodeHmac = (key: string | Uint8Array, msg: string) =>
	createHmac('sha256', key).update(msg, 'utf8').digest();

/** 只用 Node crypto 独立实现一遍 TC3 签名，用来对照自家纯 JS 版。 */
function nodeTc3(secretKey: string, timestamp: number, body: string): string {
	const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
	const canonicalHeaders =
		`content-type:application/json; charset=utf-8\nhost:${TENCENT_TTS_HOST}\nx-tc-action:texttovoice\n`;
	const signedHeaders = 'content-type;host;x-tc-action';
	const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${nodeSha256(body)}`;
	const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${date}/tts/tc3_request\n${nodeSha256(canonicalRequest)}`;
	const kDate = nodeHmac(`TC3${secretKey}`, date);
	const kService = nodeHmac(kDate, 'tts');
	const kSigning = nodeHmac(kService, 'tc3_request');
	return nodeHmac(kSigning, stringToSign).toString('hex');
}

test('SHA-256：标准向量与 Node 逐组一致（含多字节）', () => {
	assert.equal(
		sha256Hex('abc'),
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
	assert.equal(
		sha256Hex(''),
		'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	);
	for (const s of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), '中文 😀']) {
		assert.equal(sha256Hex(s), nodeSha256(s), `长度 ${s.length}`);
	}
});

test('HMAC-SHA256：RFC 4231 向量与 Node 逐组一致（长消息不能留尾零）', () => {
	assert.equal(
		hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
		'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
	);
	const cases: Array<[string, string]> = [
		['k', 'v'],
		['a'.repeat(64), 'b'.repeat(200)],
		['中文密钥', '中文消息'],
		['', ''],
	];
	for (const [key, msg] of cases) {
		assert.equal(hmacSha256Hex(key, msg), nodeHmac(key, msg).toString('hex'));
	}
});

test('TC3 请求：签名与 Node 独立实现一致，SecretKey 不进任何 header/body', () => {
	const timestamp = 1551113065;
	const built = buildTencentRequest({
		secretId: 'AKIDEXAMPLE',
		secretKey: 'SECRET-EXAMPLE',
		text: '你好，腾讯云。',
		voice: '101001',
		timestamp,
	});
	assert.equal(built.url, `https://${TENCENT_TTS_HOST}`);
	assert.equal(built.headers['X-TC-Action'], 'TextToVoice');
	assert.equal(built.headers['X-TC-Version'], TENCENT_TTS_VERSION);
	assert.equal(built.headers['X-TC-Timestamp'], String(timestamp));

	const signature = nodeTc3('SECRET-EXAMPLE', timestamp, built.body);
	const auth = built.headers.Authorization;
	assert.match(auth, /^TC3-HMAC-SHA256 /);
	assert.ok(auth.includes('Credential=AKIDEXAMPLE/2019-02-25/tts/tc3_request'));
	assert.ok(auth.includes('SignedHeaders=content-type;host;x-tc-action'));
	assert.ok(auth.includes(`Signature=${signature}`), `签名不一致：${auth}`);

	const body = JSON.parse(built.body);
	assert.equal(body.Text, '你好，腾讯云。');
	assert.equal(body.VoiceType, 101001);
	assert.equal(body.Codec, 'pcm');
	assert.equal(body.SampleRate, TENCENT_SAMPLE_RATE);
	assert.equal(body.ModelType, 1);
	assert.equal(body.Speed, 0);
	assert.ok(!JSON.stringify({ headers: built.headers, body }).includes('SECRET-EXAMPLE'));
});

test('TC3 请求：非数字音色 id 直接拒绝；接口地址可覆盖', () => {
	assert.throws(
		() =>
			buildTencentRequest({
				secretId: 'id',
				secretKey: 'key',
				text: '甲',
				voice: 'Cherry',
			}),
		/数字/,
	);
	const proxied = buildTencentRequest({
		secretId: 'id',
		secretKey: 'key',
		text: '甲',
		voice: '101001',
		baseUrl: 'https://proxy.example.com/tts',
	});
	assert.equal(proxied.url, 'https://proxy.example.com/tts');
});

test(`切块：每片不超过 ${TENCENT_MAX_CHARS} 字，拼回去与原文一致`, () => {
	const text = '甲'.repeat(200) + '，乙。丙'.repeat(40);
	const pieces = splitTextForLimit(text, TENCENT_MAX_CHARS);
	assert.ok(pieces.length >= 2);
	for (const p of pieces) assert.ok(Array.from(p).length <= TENCENT_MAX_CHARS);
	assert.equal(pieces.join(''), text);
});

test('PCM→WAV：44 字节头字段正确，数据区原样拼接', () => {
	const pcm = new Uint8Array([1, 2, 3, 4, 5]);
	const wav = pcmToWav(pcm, TENCENT_SAMPLE_RATE);
	assert.equal(wav.length, 49);
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	const ascii = (n: number) => String.fromCharCode(...wav.slice(n, n + 4));
	assert.equal(ascii(0), 'RIFF');
	assert.equal(ascii(8), 'WAVE');
	assert.equal(ascii(12), 'fmt ');
	assert.equal(view.getUint16(20, true), 1);
	assert.equal(view.getUint16(22, true), 1);
	assert.equal(view.getUint32(24, true), TENCENT_SAMPLE_RATE);
	assert.equal(view.getUint32(28, true), TENCENT_SAMPLE_RATE * 2);
	assert.equal(view.getUint16(32, true), 2);
	assert.equal(view.getUint16(34, true), 16);
	assert.equal(view.getUint32(40, true), pcm.length);
	assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4, 5]);
});

test('响应解析：base64 音频可解；业务错误按码分型并给出可照做的提示', () => {
	const audio = parseTencentResponse({
		Response: { Audio: Buffer.from([9, 8, 7]).toString('base64'), RequestId: 'r' },
	});
	assert.deepEqual([...audio], [9, 8, 7]);

	assert.deepEqual(classifyTencentError('AuthFailure.SignatureFailure'), {
		kind: 'auth',
		retryable: false,
	});
	assert.deepEqual(classifyTencentError('RequestLimitExceeded'), { kind: 'rate', retryable: true });
	assert.equal(classifyTencentError('InvalidParameterValue').kind, 'unsupported');
	assert.equal(classifyTencentError('InternalError').retryable, true);

	assert.throws(
		() =>
			parseTencentResponse({
				Response: {
					Error: { Code: 'AuthFailure.SignatureFailure', Message: 'bad sign' },
					RequestId: 'r',
				},
			}),
		/SecretKey|签名/,
	);
	const msg = describeTencentError('FailedOperation.ServiceIsolate', 'service not activated');
	assert.match(msg, /开通|欠费|额度/);
});
