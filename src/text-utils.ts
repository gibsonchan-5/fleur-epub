/**
 * 批注文本展示清洗工具
 *
 * 批注的存储形态是「作者写下的原文」：AI 写入的批注带完整 Markdown（标题 / 列表 / 引用 / 表格），
 * 手写批注通常是纯文本。展示层据此分流（见 annotation-render.ts）：
 *   · 含 Markdown 结构 → 富文本渲染，不暴露源码；
 *   · 纯文本 → 保持原样（保留换行），不做任何 Markdown 解释。
 *
 * 本模块只保留「就地压平成一行纯文本」的能力，给预览类场景用
 * （移动端批注列表的 60 字摘要、导出笔记里的纯文本兜底）。
 * 同时批注中不出现原文——AI 模型习惯在开头写「**批注：×××（原文关键词）**」当标题，
 * 存储与展示前统一去掉该头部行（用户手写批注不受影响，除非真写了「批注：」开头的标题行）。
 */

/**
 * 批注正文是否夹带 Markdown 结构。
 *
 * 判据只看「有明确标记意义的写法」，避免把普通中文句子误判：
 * 标题 / 引用 / 列表 / 表格 / 代码块 / 分割线 / 加粗。
 * 单独出现的 * 或 _ 不算——手写批注里的星号多为修饰，按 Markdown 渲染反而丢字。
 */
export function hasMarkdownSyntax(s: string): boolean {
	if (!s) return false;
	return (
		/^[ \t]{0,3}#{1,6}[ \t]/m.test(s) || // 标题
		/^[ \t]{0,3}>/m.test(s) || // 引用
		/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]/m.test(s) || // 列表
		/^[ \t]*\|.*\|[ \t]*$/m.test(s) || // 表格行
		/^[ \t]{0,3}(?:```|~~~)/m.test(s) || // 代码块
		/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/m.test(s) || // 分割线
		/\*\*[^*\n]+\*\*/.test(s) // 加粗
	);
}

/** 轻量去 Markdown 标记（压平成纯文本：用于预览摘要与纯文本兜底，不用于富文本展示） */
export function stripMarkdown(s: string): string {
	return s
		.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?|```/g, ''))
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/(\*\*|__)(.*?)\1/g, '$2')
		.replace(/(\*|_)(.*?)\1/g, '$2')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, '') // 表格分隔行
		.replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, inner: string) =>
			inner.split('|').map((c) => c.trim()).filter(Boolean).join(' ')) // 表格单元格
		.replace(/^[ \t]{0,3}>[ \t]?/gm, '') // 引用
		.replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, '') // 列表符号
		.replace(/^[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '') // 分割线
		.replace(/==/g, '')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** 去掉开头的「批注：×××」标题行（含 **加粗** 变体）；整条都是标题时保持原样不动 */
export function stripAnnotationHeader(s: string): string {
	// 整行吃掉：旧写法在惰性匹配下只吃掉「批注：」四个字，标题文字会残留进正文
	const t = s
		.replace(/^[ \t]*(?:\*\*|__)?[ \t]*批注[ \t]*[：:][^\n]*(?:\n+|$)/, '')
		.trim();
	return t || s.trim();
}

/** 展示 / 存储前的综合清洗：先去 Markdown 标记，再去 AI 标题行 */
export function cleanAnnotationText(s: string): string {
	return stripAnnotationHeader(stripMarkdown(s));
}
