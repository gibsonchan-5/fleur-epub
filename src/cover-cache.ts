// 书籍封面缓存：从 EPUB 内解析封面图，生成缩略图并缓存（内存 + 磁盘）。
// 书架上几十本书逐一解析 zip 较慢，故：① 先渲染占位再异步补封面；② 缩略图落盘，
// 二次打开书架直接读缓存，不再解析 EPUB。

import { App, Events, Plugin, TFile, arrayBufferToBase64 } from 'obsidian';
import { makeBook } from '../vendor/foliate-js/view.js';
import { computeFingerprint, hashString } from './store';

export interface BookCoverInfo {
	/** 封面缩略图的 data URL（自包含，无 blob 生命周期问题）；无封面时为 null */
	url: string | null;
	/** OPF 中的书名（缺失时回落文件名） */
	title: string;
	/** OPF 中的作者 */
	author: string;
	/** 书指纹（identifier + 书名联合哈希）：书架网格用它查阅读进度；旧缓存可能缺省 */
	fingerprint?: string;
}

/** 缩略图最大宽度（px），够书架卡片 2x 显示即可 */
const THUMB_MAX = 320;

function firstStr(v: unknown): string {
	if (Array.isArray(v)) return firstStr(v[0]);
	if (typeof v === 'string') return v.trim();
	return '';
}

export class CoverCache {
	/** 内存缓存：key = 文件路径 */
	private mem = new Map<string, BookCoverInfo>();
	/** 进行中的任务（避免同一本书重复解析） */
	private inflight = new Map<string, Promise<BookCoverInfo>>();

	constructor(private app: App, private plugin: Plugin & { events?: Events }) {}

	private dir(): string {
		return `${this.app.vault.configDir}/plugins/fleur-epub/covers`;
	}
	private imgPath(key: string): string {
		return `${this.dir()}/${key}.webp`;
	}
	private metaPath(key: string): string {
		return `${this.dir()}/${key}.json`;
	}
	private keyOf(file: TFile): string {
		return hashString(file.path);
	}

	/** 同步取已缓存项（渲染时先拿旧值，拿不到再异步加载） */
	peek(file: TFile): BookCoverInfo | null {
		return this.mem.get(file.path) ?? null;
	}

	async get(file: TFile): Promise<BookCoverInfo> {
		const cached = this.mem.get(file.path);
		if (cached) return cached;
		const running = this.inflight.get(file.path);
		if (running) return running;
		const task = this.slot()
			.then(() => this.load(file))
			.finally(() => {
				this.inflight.delete(file.path);
				this.release();
			});
		this.inflight.set(file.path, task);
		return task;
	}

	// ── 并发闸门：书架可能有几十本书，限制同时解析的 EPUB 数量，避免卡 UI ──
	private static readonly MAX_CONCURRENT = 3;
	private active = 0;
	private waiting: Array<() => void> = [];

	private slot(): Promise<void> {
		if (this.active < CoverCache.MAX_CONCURRENT) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => this.waiting.push(resolve)).then(() => {
			this.active++;
		});
	}

	private release(): void {
		this.active--;
		const next = this.waiting.shift();
		if (next) next();
	}

	private async load(file: TFile): Promise<BookCoverInfo> {
		const key = this.keyOf(file);
		const adapter = this.app.vault.adapter;

	// ① 磁盘缓存命中：直接读缩略图，无需解析 EPUB
	try {
		if (await adapter.exists(this.metaPath(key))) {
			const meta = JSON.parse(await adapter.read(this.metaPath(key))) as BookCoverInfo;
			let url: string | null = null;
			if (await adapter.exists(this.imgPath(key))) {
				const buf = await adapter.readBinary(this.imgPath(key));
				url = `data:image/webp;base64,${arrayBufferToBase64(buf)}`;
			}
			// 旧缓存缺指纹（本版之前生成）：必须先补齐再返回——书架排序与进度条都依赖
			// 指纹，返回不完整会让首屏先按书名排、指纹稍后到达又重排一次（闪一下）。
			// 补齐结果随手落盘 ⇒ 每本书只多解析一次，此后永远走缓存。
			let fingerprint = meta.fingerprint;
			if (!fingerprint) {
				const md = await this.readMetadata(file).catch(() => null);
				if (md) {
					fingerprint = this.fpOf(md.identifier, md.title, md.author);
					void this.persist(key, { url, title: meta.title, author: meta.author, fingerprint }, null);
				}
			}
			const info: BookCoverInfo = { url, title: meta.title, author: meta.author, fingerprint };
			this.mem.set(file.path, info);
			return info;
		}
	} catch (e) {
		console.warn('[FleurEPUB] 读取封面缓存失败', file.path, e);
	}

	// ② 解析 EPUB：仅取 metadata 与封面图
	let title = file.basename;
	let author = '';
	let fingerprint: string | undefined;
	let url: string | null = null;
	try {
		const md = await this.readMetadata(file, true);
		title = md.title;
		author = md.author;
		fingerprint = this.fpOf(md.identifier, title, author);
		const cover: Blob | null = md.cover;
		if (cover) {
			const thumb = await this.makeThumb(cover);
			if (thumb) {
				url = await this.toDataUrl(thumb);
				void this.persist(key, { url, title, author, fingerprint }, thumb);
			}
		}
	} catch (e) {
		console.warn('[FleurEPUB] 解析封面失败', file.path, e);
	}

	const info: BookCoverInfo = { url, title, author, fingerprint };
	this.mem.set(file.path, info);
	if (!url) void this.persist(key, info, null);
	return info;
}

	/**
	 * 解析 EPUB 元数据（可选连封面一起取）。
	 * withCover=false 时不调用 getCover()（解封面图不便宜），只补齐指纹时走这条。
	 */
	private async readMetadata(
		file: TFile,
		withCover = false,
	): Promise<{ title: string; author: string; identifier: string; cover: Blob | null }> {
		const bytes = await this.app.vault.readBinary(file);
		const fileObj = new File([bytes], file.name, { type: 'application/epub+zip' });
		const book: any = await makeBook(fileObj);
		const md = book?.metadata ?? {};
		return {
			title: firstStr(md.title) || file.basename,
			author: firstStr(md.creator) || '',
			identifier: firstStr(md.identifier),
			cover: withCover ? ((await book?.getCover?.()) ?? null) : null,
		};
	}

	/** 由 metadata 组装书指纹（与 reader-view 打开书时的 computeFingerprint 同一算法） */
	private fpOf(identifier: string, title: string, author: string): string {
		return computeFingerprint({ identifier: identifier || undefined, title, creator: author });
	}

	/** Blob → data URL（自包含，不依赖 objectURL 生命周期） */
	private async toDataUrl(blob: Blob): Promise<string> {
		return `data:${blob.type || 'image/webp'};base64,${arrayBufferToBase64(await blob.arrayBuffer())}`;
	}

	/** 生成缩略图：等比缩到 320px 宽以内，转 WebP（体积约为原图 1/5） */
	private async makeThumb(src: Blob): Promise<Blob | null> {
		try {
			const bmp = await createImageBitmap(src);
			const scale = Math.min(1, THUMB_MAX / Math.max(1, bmp.width));
			const w = Math.max(1, Math.round(bmp.width * scale));
			const h = Math.max(1, Math.round(bmp.height * scale));
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d');
			if (!ctx) return null;
			ctx.drawImage(bmp, 0, 0, w, h);
			bmp.close?.();
			return await new Promise<Blob | null>((resolve) => {
				canvas.toBlob((b) => resolve(b), 'image/webp', 0.86);
			});
		} catch (e) {
			console.warn('[FleurEPUB] 生成封面缩略图失败', e);
			return null;
		}
	}

	/** 落盘：缩略图 + 书名/作者/指纹元信息（异步，不阻塞渲染） */
	private async persist(key: string, info: BookCoverInfo, thumb: Blob | null): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.dir()))) await adapter.mkdir(this.dir());
			// 指纹必须落盘：否则下次会话读缓存又缺指纹 → 又要解析一次 EPUB 才拿得到，
			// 书架排序会被拖到「解析完才准」。
			await adapter.write(
				this.metaPath(key),
				JSON.stringify({ title: info.title, author: info.author, fingerprint: info.fingerprint }),
			);
			if (thumb) await adapter.writeBinary(this.imgPath(key), await thumb.arrayBuffer());
		} catch (e) {
			console.warn('[FleurEPUB] 写入封面缓存失败', e);
		}
	}

	/** 插件卸载时清空内存缓存（data URL 无需 revoke） */
	dispose(): void {
		this.mem.clear();
	}
}
