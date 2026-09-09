/**
 * 批注文本展示清洗工具
 *
 * 对齐 FleurAnnotation 约束：批注内容一律以纯文本展示，不暴露 Markdown 源码；
 * 同时批注中不出现原文——AI 模型习惯在开头写「**批注：×××（原文关键词）**」当标题，
 * 存储与展示前统一去掉该头部行（用户手写批注不受影响，除非真写了「批注：」开头的标题行）。
 */

/** 轻量去 Markdown 标记（批注显示用纯文本，不暴露源码） */
export function stripMarkdown(s: string): string {
	return s
		.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?|```/g, ''))
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/(\*\*|__)(.*?)\1/g, '$2')
		.replace(/(\*|_)(.*?)\1/g, '$2')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/==/g, '')
		.trim();
}

/** 去掉开头的「批注：×××」标题行（含 **加粗** 变体）；整条都是标题时保持原样不动 */
export function stripAnnotationHeader(s: string): string {
	const t = s
		.replace(/^\s*\*{0,2}\s*批注\s*[：:][^\n]*?\*{0,2}\s*(?:\n+)?/, '')
		.trim();
	return t || s.trim();
}

/** 展示 / 存储前的综合清洗：先去 Markdown 标记，再去 AI 标题行 */
export function cleanAnnotationText(s: string): string {
	return stripAnnotationHeader(stripMarkdown(s));
}
