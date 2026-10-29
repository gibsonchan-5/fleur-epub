// 批注正文渲染（气泡 / 右侧边栏 / 移动端批注卡共用）
//
// 存储层的 comment 是作者原文：AI 写入的批注是完整 Markdown，手写批注通常是纯文本。
// 这里按内容分流：含 Markdown 结构 → 交给 Obsidian 的 MarkdownRenderer 富文本渲染
// （与 AI 对话面板同一套渲染管线）；否则原样纯文本，保留手写换行。
// 渲染失败一律回退纯文本，绝不把异常抛到批注 UI 上。

import { MarkdownRenderer, type App, type Component } from 'obsidian';
import { hasMarkdownSyntax } from './text-utils';

/** 容器是否需要按 Markdown 渲染（供调用方决定折叠策略） */
export function isMarkdownComment(comment: string): boolean {
	return hasMarkdownSyntax(comment ?? '');
}

/**
 * 把批注正文渲染进容器。
 * component 传承载这块 UI 的视图（阅读器 / 侧边栏）——生命周期随视图，
 * 不拿插件实例当 component（插件活得太久，会被当成泄漏）。
 * @returns 渲染完成后 resolve（纯文本路径立即 resolve）
 */
export function renderAnnotationContent(
	el: HTMLElement,
	comment: string,
	component: Component,
	app: App,
): Promise<void> {
	const md = (comment ?? '').trim();
	if (!isMarkdownComment(md)) {
		el.setText(md);
		return Promise.resolve();
	}
	el.addClass('fleur-epub-md');
	return MarkdownRenderer.render(app, md, el, '', component).catch(() => {
		el.removeClass('fleur-epub-md');
		el.setText(md);
	});
}
