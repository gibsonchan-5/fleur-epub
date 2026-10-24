// 语音提供商纯逻辑测试：不触网、不依赖 Obsidian。
// 运行：node --test test/tts-providers.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	TTS_PROVIDERS,
	applyVoiceSelection,
	buildDoubaoRequest,
	buildQwenRequest,
	currentSelectionKey,
	decodeBase64,
	describeDoubaoSynthesisFailure,
	parseDoubaoResponse,
	parseQwenResponse,
	providerApiKey,
	providerConfig,
	providerReady,
	providerSecretKey,
	setProviderConfig,
} from '../src/tts-providers.ts';
import type { TtsSelectionSettings } from '../src/tts-providers.ts';

function baseSettings(): TtsSelectionSettings & Record<string, unknown> {
	return {
		ttsEngine: 'system',
		ttsVoiceURI: '',
		ttsOnlineProvider: 'openai',
		ttsOnlineBaseUrl: 'https://api.openai.com/v1',
		ttsOnlineModel: 'tts-1',
		ttsOnlineVoice: 'alloy',
		ttsOnlineApiKey: '',
		ttsOpenaiApiKey: '',
		ttsSiliconflowApiKey: '',
		ttsDoubaoApiKey: '',
		ttsQwenApiKey: '',
		ttsTencentSecretId: '',
		ttsTencentSecretKey: '',
		ttsCustomApiKey: '',
	};
}

test('密钥读取：各提供商独立保存，旧版单一密钥只回退给 OpenAI 兼容系', () => {
	const s = baseSettings();
	s.ttsOnlineApiKey = 'legacy-key';
	assert.equal(providerApiKey(s, 'openai'), 'legacy-key');
	assert.equal(providerApiKey(s, 'siliconflow'), 'legacy-key');
	assert.equal(providerApiKey(s, 'custom'), 'legacy-key');
	assert.equal(providerApiKey(s, 'doubao'), '');
	assert.equal(providerApiKey(s, 'qwen'), '');
	assert.equal(providerApiKey(s, 'tencent'), '');

	s.ttsDoubaoApiKey = 'doubao-key';
	s.ttsQwenApiKey = 'qwen-key';
	s.ttsTencentSecretId = 'secret-id';
	assert.equal(providerApiKey(s, 'doubao'), 'doubao-key');
	assert.equal(providerApiKey(s, 'qwen'), 'qwen-key');
	assert.equal(providerApiKey(s, 'tencent'), 'secret-id');
	// 双密钥：SecretKey 是第二把，不能和 SecretId 混读
	assert.equal(providerSecretKey(s, 'tencent'), '');
	assert.equal(providerSecretKey(s, 'openai'), '');
});

test('腾讯云就绪：SecretId 与 SecretKey 缺一不可', () => {
	const s = baseSettings();
	assert.equal(providerReady(s, 'tencent'), false);
	s.ttsTencentSecretId = 'id';
	assert.equal(providerReady(s, 'tencent'), false);
	s.ttsTencentSecretKey = 'key';
	assert.equal(providerReady(s, 'tencent'), true);
});

test('腾讯云音色目录：只收精品与大模型，不含超自然音色', () => {
	const p = TTS_PROVIDERS.tencent;
	assert.ok(p.voices.length >= 4);
	for (const v of p.voices) {
		// 精品是 101xxx，大模型是 501xxx；40xxxx / 502xxx 属超自然大模型，单价更高
		assert.match(v.id, /^(101|501)\d{3}$/, `超范围音色 ${v.id}`);
	}
	assert.equal(p.defaultVoice, '101001');
});

test('就绪判断：内置云服务只需要密钥，自定义还需要接口地址', () => {
	const s = baseSettings();
	assert.equal(providerReady(s, 'doubao'), false);
	s.ttsDoubaoApiKey = 'k';
	assert.equal(providerReady(s, 'doubao'), true);
	assert.equal(providerReady(s, 'qwen'), false);
	s.ttsQwenApiKey = 'k';
	assert.equal(providerReady(s, 'qwen'), true);

	assert.equal(providerReady(s, 'openai'), false);
	s.ttsOpenaiApiKey = 'k';
	assert.equal(providerReady(s, 'openai'), true);
	assert.equal(providerReady(s, 'custom'), false);
	s.ttsCustomApiKey = 'k';
	s.ttsOnlineBaseUrl = 'https://example.com/v1';
	assert.equal(providerReady(s, 'custom'), true);
});

test('当前选择键：系统与云端互不混淆', () => {
	const s = baseSettings();
	assert.equal(currentSelectionKey(s), 'system:');
	s.ttsVoiceURI = 'voice-1';
	assert.equal(currentSelectionKey(s), 'system:voice-1');
	s.ttsEngine = 'online';
	s.ttsOnlineProvider = 'doubao';
	s.ttsOnlineVoice = 'zh_female_vv_uranus_bigtts';
	assert.equal(currentSelectionKey(s), 'doubao:zh_female_vv_uranus_bigtts');
});

test('应用选择：切到豆包会换引擎并填入该家默认地址、模型与音色', () => {
	const s = baseSettings();
	applyVoiceSelection(s, 'doubao', 'zh_male_cixingjieshuonan_uranus_bigtts');
	assert.equal(s.ttsEngine, 'online');
	assert.equal(s.ttsOnlineProvider, 'doubao');
	assert.equal(providerConfig(s, 'doubao').baseUrl, TTS_PROVIDERS.doubao.baseUrl);
	assert.equal(providerConfig(s, 'doubao').model, TTS_PROVIDERS.doubao.model);
	assert.equal(s.ttsOnlineVoice, 'zh_male_cixingjieshuonan_uranus_bigtts');
	// 旧版全局字段不再被别的提供商改写，自定义服务的配置不会被顺带清掉
	assert.equal(s.ttsOnlineBaseUrl, 'https://api.openai.com/v1');
	assert.equal(s.ttsOnlineModel, 'tts-1');

	applyVoiceSelection(s, 'system', 'voice-2');
	assert.equal(s.ttsEngine, 'system');
	assert.equal(s.ttsVoiceURI, 'voice-2');
	// 云端选择保留，切回在线时还在原处
	assert.equal(s.ttsOnlineProvider, 'doubao');
	assert.equal(s.ttsOnlineVoice, 'zh_male_cixingjieshuonan_uranus_bigtts');
});

test('接口与模型：默认取预设，覆盖按提供商独立保存', () => {
	const s = baseSettings();
	assert.deepEqual(providerConfig(s, 'openai'), {
		baseUrl: 'https://api.openai.com/v1',
		model: 'tts-1',
	});
	assert.deepEqual(providerConfig(s, 'doubao'), {
		baseUrl: TTS_PROVIDERS.doubao.baseUrl,
		model: 'seed-tts-2.0',
		channel: 'standard',
	});

	setProviderConfig(s, 'openai', { model: 'gpt-4o-mini-tts' });
	assert.equal(providerConfig(s, 'openai').model, 'gpt-4o-mini-tts');
	assert.equal(providerConfig(s, 'openai').baseUrl, 'https://api.openai.com/v1');
	// 改一家不影响另一家
	assert.equal(providerConfig(s, 'doubao').model, 'seed-tts-2.0');

	setProviderConfig(s, 'openai', { baseUrl: 'https://proxy.example.com/v1' });
	assert.equal(providerConfig(s, 'openai').baseUrl, 'https://proxy.example.com/v1');

	// 清空即回到预设默认值，不会留下空地址
	setProviderConfig(s, 'openai', { baseUrl: '', model: '' });
	assert.deepEqual(providerConfig(s, 'openai'), {
		baseUrl: 'https://api.openai.com/v1',
		model: 'tts-1',
	});
});

test('自定义服务：没有独立配置时沿用旧版全局接口/模型', () => {
	const s = baseSettings();
	s.ttsOnlineBaseUrl = 'https://proxy.example.com/v1';
	s.ttsOnlineModel = 'my-tts';
	assert.deepEqual(providerConfig(s, 'custom'), {
		baseUrl: 'https://proxy.example.com/v1',
		model: 'my-tts',
	});

	setProviderConfig(s, 'custom', { baseUrl: 'https://other.example.com/v1' });
	assert.equal(providerConfig(s, 'custom').baseUrl, 'https://other.example.com/v1');
	assert.equal(providerConfig(s, 'custom').model, 'my-tts');
});

test('豆包请求：使用 v3 单向流式接口与 seed-tts-2.0 资源头', () => {
	const req = buildDoubaoRequest({
		apiKey: 'doubao-key',
		text: '你好，世界。',
		voice: 'zh_female_vv_uranus_bigtts',
		requestId: 'req-1',
	});
	assert.equal(req.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
	assert.equal(req.headers['X-Api-Key'], 'doubao-key');
	assert.equal(req.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
	assert.equal(req.headers['X-Api-Request-Id'], 'req-1');
	const body = JSON.parse(req.body);
	assert.equal(body.req_params.text, '你好，世界。');
	assert.equal(body.req_params.speaker, 'zh_female_vv_uranus_bigtts');
	assert.equal(body.req_params.audio_params.format, 'mp3');
});

test('豆包请求：接口地址与资源 ID 可覆盖，默认仍走官方端点', () => {
	const custom = buildDoubaoRequest({
		apiKey: 'k',
		text: '你好',
		voice: 'v',
		baseUrl: 'https://proxy.example.com',
		model: 'seed-tts-1.0',
	});
	assert.equal(custom.url, 'https://proxy.example.com/api/v3/tts/unidirectional');
	assert.equal(custom.headers['X-Api-Resource-Id'], 'seed-tts-1.0');

	// 已经带完整路径时不重复拼接
	const full = buildDoubaoRequest({
		apiKey: 'k',
		text: '你好',
		voice: 'v',
		baseUrl: 'https://proxy.example.com/api/v3/tts/unidirectional',
	});
	assert.equal(full.url, 'https://proxy.example.com/api/v3/tts/unidirectional');
});

test('千问请求：接口地址可覆盖，默认仍走官方端点', () => {
	const custom = buildQwenRequest({
		apiKey: 'k',
		text: '你好',
		voice: 'Cherry',
		baseUrl: 'https://proxy.example.com',
	});
	assert.equal(
		custom.url,
		'https://proxy.example.com/api/v1/services/aigc/multimodal-generation/generation',
	);
	const plain = buildQwenRequest({ apiKey: 'k', text: '你好', voice: 'Cherry' });
	assert.equal(
		plain.url,
		'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
	);
});

test('豆包 401：提示密钥来源，而不只是回显 JSON', () => {
	const body = JSON.stringify({
		header: { reqid: 'r', code: 45000010, message: 'Invalid X-Api-Key' },
	});
	const msg = describeDoubaoSynthesisFailure(401, body);
	assert.match(msg, /HTTP 401/);
	assert.match(msg, /语音技术/);
	assert.match(msg, /API Key/);
	assert.match(msg, /方舟/);
	assert.match(msg, /Access Token/);
});

test('豆包其它错误：保留状态码与响应片段', () => {
	const msg = describeDoubaoSynthesisFailure(500, 'boom');
	assert.match(msg, /HTTP 500/);
	assert.match(msg, /boom/);
});

test('错误提示：AgentPlan 403 抵扣未开启时指向套餐设置，而非误判为 Key 无效', () => {
	const body =
		'acquire failed err:call ark get status code:403 code:Forbidden.AgentPlanDeductNotEnabled ' +
		'message:Agent Plan deduction is not enabled for this account or seat.';
	const msg = describeDoubaoSynthesisFailure(403, body, 'agentplan');
	assert.match(msg, /45000030/);
	assert.match(msg, /抵扣/);
	assert.match(msg, /开通管理/);
	assert.doesNotMatch(msg, /未被接受|密钥无效/);
});

test('豆包响应：拼接多行 base64，结束后返回完整音频', () => {
	const text = [
		JSON.stringify({ code: 20000000, message: 'OK', data: 'AQID' }),
		JSON.stringify({ code: 20000000, message: 'OK', data: 'BAU=' }),
		JSON.stringify({ code: 20000000, message: 'OK', data: null }),
	].join('\n');
	assert.deepEqual([...parseDoubaoResponse(text)], [1, 2, 3, 4, 5]);
});

test('豆包响应：兼容 AgentPlan 的 code 0 数据片与 20000000 结束行', () => {
	const text = [
		JSON.stringify({ code: 0, message: '', data: 'AQID' }),
		JSON.stringify({ code: 0, message: '', data: 'BAU=' }),
		JSON.stringify({ code: 20000000, message: 'OK', data: null }),
	].join('\n');
	assert.deepEqual([...parseDoubaoResponse(text)], [1, 2, 3, 4, 5]);
});

test('豆包响应：错误行抛出可读错误', () => {
	const text = JSON.stringify({ code: 45000030, message: 'quota exceeded', data: null });
	assert.throws(() => parseDoubaoResponse(text), /45000030.*quota exceeded/);
});

test('千问请求：使用 qwen3-tts-flash 多模态生成接口并带语言提示', () => {
	const req = buildQwenRequest({
		apiKey: 'qwen-key',
		text: 'Hello world.',
		voice: 'Cherry',
		lang: 'en-US',
	});
	assert.equal(
		req.url,
		'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
	);
	assert.equal(req.headers.Authorization, 'Bearer qwen-key');
	const body = JSON.parse(req.body);
	assert.equal(body.model, 'qwen3-tts-flash');
	assert.equal(body.input.text, 'Hello world.');
	assert.equal(body.input.voice, 'Cherry');
	assert.equal(body.input.language_type, 'English');
});

test('千问响应：优先读 base64，其次读 OSS 地址', () => {
	const inline = parseQwenResponse({
		status_code: 200,
		code: '',
		output: { audio: { data: 'AQID', url: '' } },
	});
	assert.deepEqual([...(inline.data ?? [])], [1, 2, 3]);
	assert.equal(inline.url, undefined);

	const remote = parseQwenResponse({
		status_code: 200,
		code: '',
		output: { audio: { data: '', url: 'https://example.com/a.wav?Expires=1' } },
	});
	assert.equal(remote.data, undefined);
	assert.equal(remote.url, 'https://example.com/a.wav?Expires=1');
	assert.equal(remote.mime, 'audio/wav');
});

test('千问响应：业务错误码抛出可读错误', () => {
	assert.throws(
		() => parseQwenResponse({ status_code: 400, code: 'InvalidParameter', message: 'voice invalid' }),
		/InvalidParameter.*voice invalid/,
	);
});

test('base64 解码：忽略空白，返回原始字节', () => {
	assert.deepEqual([...decodeBase64(' AQ ID\n')], [1, 2, 3]);
});

test('豆包通道：AgentPlan 走 /api/v3/plan 路径，鉴权与请求体保持 v3 格式', () => {
	const req = buildDoubaoRequest({
		apiKey: 'agentplan-key',
		text: '你好，AgentPlan。',
		voice: 'zh_female_vv_uranus_bigtts',
		requestId: 'req-plan-1',
		channel: 'agentplan',
	});
	assert.equal(
		req.url,
		'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional',
	);
	assert.equal(req.headers['X-Api-Key'], 'agentplan-key');
	assert.equal(req.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
	assert.equal(req.headers['X-Api-Request-Id'], 'req-plan-1');
	const body = JSON.parse(req.body);
	assert.equal(body.req_params.text, '你好，AgentPlan。');
	assert.equal(body.req_params.speaker, 'zh_female_vv_uranus_bigtts');
	assert.equal(body.req_params.audio_params.format, 'mp3');
});

test('豆包通道：默认仍是标准语音端点，显式切回标准不残留 plan 路径', () => {
	const standard = buildDoubaoRequest({
		apiKey: 'k',
		text: 'hi',
		voice: 'zh_female_vv_uranus_bigtts',
	});
	assert.equal(standard.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');

	const back = buildDoubaoRequest({
		apiKey: 'k',
		text: 'hi',
		voice: 'zh_female_vv_uranus_bigtts',
		channel: 'standard',
	});
	assert.equal(back.url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
});

test('提供商配置：豆包通道按提供商保存，默认标准且不污染别家', () => {
	const s = baseSettings();
	assert.equal(providerConfig(s, 'doubao').channel, 'standard');
	setProviderConfig(s, 'doubao', { channel: 'agentplan' });
	assert.equal(providerConfig(s, 'doubao').channel, 'agentplan');
	assert.equal(providerConfig(s, 'qwen').channel, undefined);
	assert.equal(providerConfig(s, 'custom').channel, undefined);
});

test('错误提示：AgentPlan 通道指向 AgentPlan 专属 Key，不再劝用语音技术控制台', () => {
	const hint = describeDoubaoSynthesisFailure(
		401,
		JSON.stringify({ code: 45000010, message: 'Invalid X-Api-Key' }),
		'agentplan',
	);
	assert.match(hint, /AgentPlan/);
	assert.match(hint, /专属 API Key/);
	assert.doesNotMatch(hint, /语音技术 → API Key 管理/);
});

test('错误提示：标准通道提示可改用 AgentPlan 接入方式', () => {
	const hint = describeDoubaoSynthesisFailure(401, 'Invalid X-Api-Key', 'standard');
	assert.match(hint, /语音技术/);
	assert.match(hint, /接入方式.*AgentPlan|AgentPlan.*接入方式/);
});

test('豆包音色：知性女声用官方 2.0 id，旧的 nvsheng 写法在选择时归一', () => {
	const voice = TTS_PROVIDERS.doubao.voices.find((v) => v.label === '知性女声');
	assert.equal(voice?.id, 'zh_female_zhixingnv_uranus_bigtts');

	const s = baseSettings();
	applyVoiceSelection(s, 'doubao', 'zh_female_zhixingnvsheng_uranus_bigtts');
	assert.equal(s.ttsOnlineVoice, 'zh_female_zhixingnv_uranus_bigtts');
});

test('豆包通道：接口地址误填完整端点时按当前通道归一，不叠路径', () => {
	const standardFull = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
	const planFull = 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional';

	const toPlan = buildDoubaoRequest({
		apiKey: 'k',
		text: 'hi',
		voice: 'v',
		baseUrl: standardFull,
		channel: 'agentplan',
	});
	assert.equal(toPlan.url, planFull);

	const toStandard = buildDoubaoRequest({
		apiKey: 'k',
		text: 'hi',
		voice: 'v',
		baseUrl: planFull,
		channel: 'standard',
	});
	assert.equal(toStandard.url, standardFull);
});
