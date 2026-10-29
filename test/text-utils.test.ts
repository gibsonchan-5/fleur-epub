// 批注文本清洗 / Markdown 识别测试。
// 背景：AI 写入的批注是完整 Markdown，展示层按 hasMarkdownSyntax 分流——
// 有结构就富文本渲染，纯文本原样显示。这里钉住两侧边界：
//   · AI 批注必须被识别出来（否则又退化成源码外泄）；
//   · 普通手写批注不能被误判（否则换行被 Markdown 合并、星号被吃掉）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanAnnotationText, hasMarkdownSyntax, stripMarkdown } from '../src/text-utils.ts';

/** 虚构样本（不取自任何真实笔记）：标题 + 加粗 + 引用 + 列表 + 表格 + 分割线 */
const AI_COMMENT = [
	'## 示例概念：日常收纳的分层方法',
	'',
	'### 一、概念内涵',
	'',
	'**分层收纳** 指的是按使用频率安排存放位置。',
	'',
	'> 把常用的东西放在抬手就能拿到的地方。',
	'',
	'- 常用物品放外层',
	'- 换季物品放高处',
	'',
	'| 维度 | 说明 |',
	'|------|------|',
	'| 频率 | 高者易取 |',
	'',
	'---',
].join('\n');

test('AI 批注（标题/引用/列表/表格）被识别为 Markdown', () => {
	assert.equal(hasMarkdownSyntax(AI_COMMENT), true);
});

test('单行加粗也会被识别', () => {
	assert.equal(hasMarkdownSyntax('结论：**分层收纳**适合小房间。'), true);
});

test('手写纯文本批注不误判（含换行、冒号、书名号）', () => {
	const handwritten = [
		'周末整理行李，按清单逐项勾选。',
		'这里的说法很直白：先重后轻。',
		'（1）先看天气预报，2 再看路线。',
	].join('\n');
	assert.equal(hasMarkdownSyntax(handwritten), false);
});

test('空批注不算 Markdown', () => {
	assert.equal(hasMarkdownSyntax(''), false);
	assert.equal(hasMarkdownSyntax('   \n  '), false);
});

test('stripMarkdown 把块级标记全部压平，不残留源码符号', () => {
	const flat = stripMarkdown(AI_COMMENT);
	assert.ok(!/^[ \t]{0,3}>/m.test(flat), '不应残留引用符 >');
	assert.ok(!/^[ \t]{0,3}#{1,6}[ \t]/m.test(flat), '不应残留标题符 #');
	assert.ok(!/^[ \t]{0,3}[-*+][ \t]/m.test(flat), '不应残留列表符 -');
	assert.ok(!/\|/.test(flat), '不应残留表格竖线');
	assert.ok(!/\*\*/.test(flat), '不应残留加粗符 **');
	assert.ok(!/^[ \t]{0,3}-{3,}[ \t]*$/m.test(flat), '不应残留分割线');
	// 内容本身要留下
	assert.ok(flat.includes('分层收纳'));
	assert.ok(flat.includes('常用物品放外层'));
});

test('cleanAnnotationText 仍会去掉「批注：×××」标题行', () => {
	assert.equal(cleanAnnotationText('**批注：示例释义**\n正文内容'), '正文内容');
});
