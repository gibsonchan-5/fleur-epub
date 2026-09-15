// 数据持久层：按「书指纹」锚定，文件移动/改名不丢数据。
// v1（M1）只落进度与元信息；批注数组结构先行占位，M2 填充。

import { App, Plugin } from 'obsidian';

export interface BookMeta {
	title?: string;
	creator?: string;
	language?: string;
	identifier?: string;
}

export interface BookProgress {
	cfi?: string;
	percent?: number;
	updatedAt?: number;
}

/** 标注种类：高亮 / 直线 / 波浪线（对齐 fleur-pdf 三种样式） */
export type AnnotationKind = 'highlight' | 'underline' | 'wavy';

/** 单条标注：以 EPUB CFI 锚定，text 为选段快照（CFI 失效时的兜底与 AI 上下文） */
export interface EpubAnnotation {
	id: string;
	cfi: string;
	text: string;
	kind: AnnotationKind;
	/** 颜色键（HIGHLIGHT_COLORS 的 key） */
	color: string;
	/** 批注文字（附属字段，任何 kind 都可带，同 fleur-pdf 约定） */
	comment?: string;
	/** 所在章节标题（创建时由 foliate 返回） */
	chapterLabel?: string;
	createdAt: number;
}

export interface BookData {
	fingerprint: string;
	book: BookMeta;
	progress: BookProgress;
	annotations: EpubAnnotation[];
	/** 段落对照翻译缓存：key = 段落文本 FNV 哈希（translator.ts） */
	translations?: Record<string, string>;
}

/** FNV-1a 32bit 哈希（纯前端可用，无 Node 依赖） */
export function hashString(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** 书指纹：identifier + 书名 联合哈希；缺 identifier 时用 title+creator+language 组合。
 *
 * ⚠️ 不能只用 identifier：部分打包工具（如 z-library）会给不同书籍打入完全相同的
 * UUID（实际案例：5 本书共用 urn:uuid:273fd756-…），identifier 单独做指纹会跨书串
 * 批注/进度。混入书名后即天然去重（同名同 identifier 视为同一本书的重复文件）。
 */
export function computeFingerprint(meta: BookMeta): string {
	const ident = meta.identifier?.trim();
	if (ident) {
		return hashString(ident + '|' + (meta.title ?? '').trim().toLowerCase());
	}
	const fallback = [meta.title, meta.creator, meta.language]
		.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : ''))
		.join('|');
	return hashString(fallback || 'unknown');
}

export class BookStore {
	constructor(private app: App, private plugin: Plugin) {}

	private dir(): string {
		return `${this.app.vault.configDir}/plugins/fleur-epub/data`;
	}

	private path(fingerprint: string): string {
		return `${this.dir()}/${fingerprint}.json`;
	}

	async load(fingerprint: string): Promise<BookData | null> {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.path(fingerprint)))) return null;
			const raw = await adapter.read(this.path(fingerprint));
			return JSON.parse(raw) as BookData;
		} catch (e) {
			console.warn('[FleurEPUB] 读取书籍数据失败', fingerprint, e);
			return null;
		}
	}

	async save(data: BookData): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.dir()))) {
				await adapter.mkdir(this.dir());
			}
			await adapter.write(this.path(data.fingerprint), JSON.stringify(data, null, 2));
		} catch (e) {
			console.warn('[FleurEPUB] 保存书籍数据失败', data.fingerprint, e);
		}
	}
}
