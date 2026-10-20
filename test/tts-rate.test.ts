// 语速归一与显示测试：语速原来是固定档位，现在由滑杆给出连续值，
// 边界、精度和显示格式都在这里钉死。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	TTS_RATE_MAX,
	TTS_RATE_MIN,
	formatTtsRate,
	normalizeTtsRate,
} from '../src/tts-rate.ts';

test('语速归一：越界收敛到上下限', () => {
	assert.equal(normalizeTtsRate(0.1), TTS_RATE_MIN);
	assert.equal(normalizeTtsRate(9), TTS_RATE_MAX);
});

test('语速归一：保留两位小数', () => {
	assert.equal(normalizeTtsRate(1.234), 1.23);
	assert.equal(normalizeTtsRate(1), 1);
});

test('语速归一：非法值回退到当前语速', () => {
	assert.equal(normalizeTtsRate(Number.NaN, 1.2), 1.2);
	assert.equal(normalizeTtsRate(Number.POSITIVE_INFINITY, 0.9), 0.9);
});

test('语速显示：去掉无意义的零', () => {
	assert.equal(formatTtsRate(1), '1x');
	assert.equal(formatTtsRate(1.25), '1.25x');
	assert.equal(formatTtsRate(1.05), '1.05x');
});
