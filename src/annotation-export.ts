// 批注笔记导出（共享模块）
// 桌面：书架侧栏批注 tab「导出笔记」按钮；移动端：批注 bottom sheet「导出笔记」按钮。
// 逻辑原样提取自 shelf-view.exportNotes（Markdown、按章节分组、同名覆盖，与 fleur-pdf 一致）。

import { Notice } from 'obsidian';
import type FleurEpubPlugin from './main';
import type { EpubReaderView } from './reader-view';
import { resolveAnnotationColor } from './reader-view';
import { cleanAnnotationText } from './text-utils';

/** 按背景亮度选可读前景色（导出 Markdown 高亮底色用） */
function pickReadableFg(bg: string): string {
	const hex = bg.replace('#', '');
	if (hex.length !== 3 && hex.length !== 6) return '#000';
	const r = parseInt(hex.length === 3 ? hex[0] + hex[0] : hex.slice(0, 2), 16);
	const g = parseInt(hex.length === 3 ? hex[1] + hex[1] : hex.slice(2, 4), 16);
	const b = parseInt(hex.length === 3 ? hex[2] + hex[2] : hex.slice(4, 6), 16);
	const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luma > 0.6 ? '#000' : '#fff';
}

/** 空白收敛为单行（EPUB 选段常带换行） */
function normalizeWhitespace(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** 导出当前阅读书的全部批注为 Markdown 笔记 */
export async function exportAnnotationsToNote(plugin: FleurEpubPlugin, reader: EpubReaderView): Promise<void> {
	const list = reader.getAnnotations();
	if (list.length === 0) {
		new Notice('当前书没有批注可导出');
		return;
	}

	const noteName = `${reader.getDisplayText()} - 批注笔记`;
	// 导出文件夹（设置项，默认 FleurEpub；'' = vault 根目录）— fleur-pdf 同款逻辑
	const folder = plugin.settings.noteFolder?.trim() || '';
	const notePath = folder ? `${folder}/${noteName}.md` : `${noteName}.md`;

	try {
		// 确保导出文件夹存在（默认 FleurEpub，首次导出自动创建）
		if (folder) {
			const folderExists = await plugin.app.vault.adapter.exists(folder);
			if (!folderExists) await plugin.app.vault.createFolder(folder);
		}

		const exists = await plugin.app.vault.adapter.exists(notePath);
		if (exists) {
			const existing = plugin.app.vault.getAbstractFileByPath(notePath);
			if (existing) await plugin.app.vault.trash(existing, false);
		}

		let md = `> 导出时间：${new Date().toLocaleString('zh-CN')}\n\n`;
		const grouped = new Map<string, typeof list>();
		for (const ann of list) {
			const key = ann.chapterLabel?.trim() || '未命名章节';
			if (!grouped.has(key)) grouped.set(key, []);
			grouped.get(key)!.push(ann);
		}
		for (const [chapter, items] of grouped) {
			md += `## ${chapter}\n\n`;
			for (const ann of items) {
				const t = normalizeWhitespace(ann.text);
				const color = resolveAnnotationColor(ann.color);
				if (ann.kind === 'highlight') {
					const fg = pickReadableFg(color);
					md += `<span style="background-color:${color};color:${fg};padding:0 2px;border-radius:2px">${t}</span>\n\n`;
				} else {
					const style = ann.kind === 'wavy' ? 'wavy' : 'solid';
					md += `<span style="text-decoration:underline;text-decoration-color:${color};text-decoration-style:${style}">${t}</span>\n\n`;
				}
				if (ann.comment) md += `> ${cleanAnnotationText(normalizeWhitespace(ann.comment))}\n\n`;
				md += `---\n\n`;
			}
		}

		await plugin.app.vault.create(notePath, md);
		new Notice('笔记已导出', 2000);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		new Notice(`导出失败：${msg}`);
	}
}
