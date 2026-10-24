// 终止听书的回归测试：会话结束后，留在途中的 utterance 回调必须彻底失效——
// 不能再点亮跟读高亮、不能推进句序，否则「终止后原文仍跟随定位」会以异步形式复发。
// 运行：npx tsx --tsconfig tsconfig.test.json --test test/tts-stop.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { ReaderTTS } from '../src/tts.ts';

class FakeUtterance {
	text: string;
	lang = '';
	rate = 1;
	voice: unknown = null;
	onstart: (() => void) | null = null;
	onend: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(text: string) {
		this.text = text;
	}
}

/** 最小朗读环境：系统引擎 + 记录发言与高亮调用。 */
function setup() {
	const spoken: FakeUtterance[] = [];
	const highlights: string[] = [];
	let clears = 0;
	(globalThis as { window?: unknown }).window = {
		speechSynthesis: {
			speak: (u: FakeUtterance) => spoken.push(u),
			cancel: () => undefined,
			getVoices: () => [],
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		},
	};
	(globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance = FakeUtterance;

	const view = {
		plugin: {
			settings: { ttsRate: 1, ttsEngine: 'system', ttsVoiceURI: '' },
			saveSettings: async () => undefined,
		},
		getTTSChapter: () => ({
			items: [
				{ el: { id: 'p1' }, text: '第一句。' },
				{ el: { id: 'p2' }, text: '第二句。' },
			],
			lang: 'zh-CN',
		}),
		highlightTTSSentence: (_el: unknown, text: string) => highlights.push(text),
		clearTTSHighlight: () => {
			clears++;
			highlights.length = 0;
		},
	};
	const tts = new ReaderTTS(view as never);
	return {
		tts,
		spoken,
		highlights,
		clears: () => clears,
		cleanup: () => {
			delete (globalThis as { window?: unknown }).window;
			delete (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
		},
	};
}

test('终止后：清空高亮与进度，旧 utterance 回调不再生效', () => {
	const env = setup();
	try {
		const states: Array<{ active: boolean; index: number; sentence: string }> = [];
		env.tts.onStateChange((s) =>
			states.push({ active: s.active, index: s.index, sentence: s.sentence }),
		);

		env.tts.start();
		assert.equal(env.tts.isActive(), true);
		const u1 = env.spoken.at(-1);
		assert.ok(u1);
		assert.equal(u1.text, '第一句。');

		// 开读：高亮当前句
		u1.onstart?.();
		assert.deepEqual(env.highlights, ['第一句。']);
		assert.equal(env.tts.getState().speaking, true);

		// 终止
		env.tts.stop();
		assert.equal(env.tts.isActive(), false);
		assert.equal(env.tts.getState().sentence, '');
		assert.equal(env.clears(), 1);
		assert.deepEqual(env.highlights, []);
		assert.equal(states.at(-1)?.active, false);

		// 旧回调迟到：不得重新点亮高亮、不得推进句序、不得再发声
		const stateCount = states.length;
		const spokenCount = env.spoken.length;
		u1.onstart?.();
		u1.onend?.();
		u1.onerror?.();
		assert.deepEqual(env.highlights, []);
		assert.equal(env.clears(), 1);
		assert.equal(env.spoken.length, spokenCount);
		assert.equal(states.length, stateCount);
		assert.equal(env.tts.isActive(), false);
		assert.equal(env.tts.getState().index, 0);
	} finally {
		env.cleanup();
	}
});

test('暂停不是终止：保留会话与当前句，仅停止出声', () => {
	const env = setup();
	try {
		env.tts.start();
		const u1 = env.spoken.at(-1);
		assert.ok(u1);
		u1.onstart?.();
		env.tts.pause();
		assert.equal(env.tts.isActive(), true);
		assert.equal(env.tts.getState().paused, true);
		assert.equal(env.tts.getState().sentence, '第一句。');
		// 暂停保留高亮，续播从本句头重读
		assert.deepEqual(env.highlights, ['第一句。']);
		env.tts.resume();
		assert.equal(env.tts.getState().paused, false);
		assert.equal(env.spoken.at(-1)?.text, '第一句。');
	} finally {
		env.cleanup();
	}
});
