// 在线字体库：从官方公开渠道（GitHub Releases / npmmirror / jsDelivr）下载
// SIL OFL 1.1 开源字体到 vault 隐藏目录，本地缓存、离线可用。
//
// 背景：iOS 预装的简体中文字体只有苹方，宋体/楷体等在 Apple 官方清单中标为
// 「可下载」——但按需下载只对原生 App 开放，WKWebView 无法触发，网页环境等于
// 不存在，导致书内字体选择全部静默回退苹方。本模块提供开源替代字体的
// 「用户自行下载」通道：不内置任何字体文件（不打包、不修改、不再分发），
// 只从字体官方发布渠道按需拉取，全部 SIL OFL 1.1 许可。
//
// 注入方式：书籍 iframe 由 foliate 以 srcdoc 创建（opaque origin），app:// 资源
// URL 加载不可靠，故沿用 collectFontFaceCss 已实证的 base64 data URI 管线，
// 以 @font-face 注入章节文档，并按字体 id 做内存缓存。

import { App, Modal, Notice, requestUrl, normalizePath } from 'obsidian';
import type FleurEpubPlugin from './main';

/** 字体存放目录（vault 根下的隐藏目录，不进 Obsidian 索引、不占同步空间） */
export const FONT_DIR = '.fleur-epub-fonts';

export interface CatalogFont {
	/** 稳定 id（文件名 / 缓存键） */
	id: string;
	/** 展示名 */
	label: string;
	/** @font-face 使用的 CSS 家族名（带 FleurFont 前缀，避免与本机字体撞名） */
	family: string;
	/** 选中后的完整 font-family 栈（首选下载字体，回退到常见系统字体） */
	stack: string;
	/** 字体格式（@font-face src format） */
	format: 'truetype' | 'woff2';
	/** 落盘文件名 */
	fileName: string;
	/** 精确字节数（用于下载完整性校验） */
	sizeBytes: number;
	/** sha256（官方资产固定 tag / 锁定版本，内容不可变） */
	sha256: string;
	/** 许可证名 */
	license: string;
	/** 来源（按优先级排列，逐个回退） */
	sources: string[];
	/** 项目主页 */
	homepage: string;
	/** 覆盖范围说明 */
	note: string;
}

/**
 * 内置字体目录（首批，全部 SIL OFL 1.1，官方渠道单文件）。
 * - 霞鹜文楷 Lite：官方 GitHub Release（锁定 v1.522，资产 digest 来自 GitHub API）。
 * - 思源宋体/黑体 SC：fontsource 官方打包的简体常用字集 woff2（锁定 5.2.8，
 *   npmmirror 为主源国内直连最快，jsDelivr 回退），只覆盖常用字，生僻字回退栈内
 *   系统字体，UI 已注明。
 */
export const FONT_CATALOG: CatalogFont[] = [
	{
		id: 'lxgw-wenkai-lite',
		label: '霞鹜文楷 Lite',
		family: 'FleurFont LXGW WenKai Lite',
		stack: '"FleurFont LXGW WenKai Lite", "Kaiti SC", "STKaiti", "KaiTi", serif',
		format: 'truetype',
		fileName: 'lxgw-wenkai-lite-regular.ttf',
		sizeBytes: 13872424,
		sha256: '140c99ba4e28e817cec49bf82a0c5fcdc4fe633fb9dfda16d0ee8d59a8545f15',
		license: 'SIL OFL 1.1',
		sources: [
			'https://github.com/lxgw/LxgwWenKai-Lite/releases/download/v1.522/LXGWWenKaiLite-Regular.ttf',
		],
		homepage: 'https://github.com/lxgw/LxgwWenKai-Lite',
		note: '开源楷体（Regular 字面），覆盖 GB 常用简繁字，适合正文长阅读。iOS 上楷体类系统字体不可用，此为官方发布的替代方案。',
	},
	{
		id: 'noto-serif-sc',
		label: '思源宋体 SC（常用字集）',
		family: 'FleurFont Noto Serif SC',
		stack: '"FleurFont Noto Serif SC", "Songti SC", "STSong", "SimSun", serif',
		format: 'woff2',
		fileName: 'noto-serif-sc-common.woff2',
		sizeBytes: 1508300,
		sha256: '8253fcd74e0ca536148c1ebb6719f62d1a62a5c69951e92cc9e20e7c73b578a9',
		license: 'SIL OFL 1.1',
		sources: [
			'https://registry.npmmirror.com/@fontsource/noto-serif-sc/5.2.8/files/files/noto-serif-sc-chinese-simplified-400-normal.woff2',
			'https://cdn.jsdelivr.net/npm/@fontsource/noto-serif-sc@5.2.8/files/noto-serif-sc-chinese-simplified-400-normal.woff2',
		],
		homepage: 'https://fonts.google.com/noto/specimen/Noto+Serif+SC',
		note: '开源宋体（Regular 字面，fontsource 简体常用字集，约 1.5MB）。生僻字自动回退系统字体。',
	},
	{
		id: 'noto-sans-sc',
		label: '思源黑体 SC（常用字集）',
		family: 'FleurFont Noto Sans SC',
		stack: '"FleurFont Noto Sans SC", "PingFang SC", "Heiti SC", "SimHei", sans-serif',
		format: 'woff2',
		fileName: 'noto-sans-sc-common.woff2',
		sizeBytes: 1141536,
		sha256: 'eb385eca10dd39caff881c38338aefccecfaec6b42cc016fbe81434e388d6c3a',
		license: 'SIL OFL 1.1',
		sources: [
			'https://registry.npmmirror.com/@fontsource/noto-sans-sc/5.2.8/files/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
			'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5.2.8/files/noto-sans-sc-chinese-simplified-400-normal.woff2',
		],
		homepage: 'https://fonts.google.com/noto/specimen/Noto+Sans+SC',
		note: '开源黑体（Regular 字面，fontsource 简体常用字集，约 1.1MB）。生僻字自动回退系统字体。',
	},
];

/** 从已保存的 font-family 栈中匹配内置字体目录项（含 `"FleurFont …"` 即命中） */
export function matchCatalogFont(stack: string): CatalogFont | null {
	if (!stack || !stack.includes('FleurFont ')) return null;
	return FONT_CATALOG.find((c) => stack.includes(`"${c.family}"`)) ?? null;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/** ArrayBuffer → base64（分块拼接，避免大数组撑爆 apply 栈） */
function bufToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	const chunks: string[] = [];
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
	}
	return btoa(chunks.join(''));
}

export class FontLibrary {
	/** 已下载的目录项缓存（面板打开 / 下载 / 删除后刷新） */
	downloaded: CatalogFont[] = [];
	/** 正在下载的 id 集合（防重复触发、供 UI 置灰） */
	downloading = new Set<string>();
	/** base64 @font-face CSS 缓存（id → css），删除 / 重下后失效 */
	private faceCache = new Map<string, string>();

	constructor(private plugin: FleurEpubPlugin) {}

	private get app(): App {
		return this.plugin.app;
	}

	dir(): string {
		return normalizePath(FONT_DIR);
	}

	pathOf(font: CatalogFont): string {
		return normalizePath(`${FONT_DIR}/${font.fileName}`);
	}

	async refreshDownloaded(): Promise<CatalogFont[]> {
		const out: CatalogFont[] = [];
		for (const font of FONT_CATALOG) {
			if (await this.app.vault.adapter.exists(this.pathOf(font))) out.push(font);
		}
		this.downloaded = out;
		return out;
	}

	isDownloaded(font: CatalogFont): boolean {
		return this.downloaded.some((d) => d.id === font.id);
	}

	/**
	 * 从目录项来源逐个尝试下载（size + sha256 双重校验），成功后落盘并失效缓存。
	 * requestUrl 无进度事件：用 Notice 阶段提示，iOS 上 13MB 约需 1 分钟。
	 */
	async download(font: CatalogFont): Promise<boolean> {
		if (this.downloading.has(font.id)) return false;
		this.downloading.add(font.id);
		const notice = new Notice(`正在下载「${font.label}」（约 ${Math.round(font.sizeBytes / 1048576)}MB），请保持网络畅通…`, 0);
		try {
			await this.ensureDir();
			for (const url of font.sources) {
				try {
					const res = await requestUrl({ url, method: 'GET', throw: false });
					if (res.status !== 200) continue;
					const buf = res.arrayBuffer;
					if (buf.byteLength !== font.sizeBytes) continue;
					if (font.sha256 && (await sha256Hex(buf)) !== font.sha256) continue;
					await this.app.vault.adapter.writeBinary(this.pathOf(font), buf);
					this.faceCache.delete(font.id);
					await this.refreshDownloaded();
					new Notice(`「${font.label}」下载完成，可在字体列表中选择`, 2500);
					return true;
				} catch {
					// 换下一个源
				}
			}
			new Notice(`「${font.label}」下载失败：所有来源均不可达，请检查网络后重试`, 4000);
			return false;
		} finally {
			this.downloading.delete(font.id);
			notice.hide();
		}
	}

	async remove(font: CatalogFont): Promise<void> {
		try {
			await this.app.vault.adapter.remove(this.pathOf(font));
		} catch {
			// 文件可能已不存在，忽略
		}
		this.faceCache.delete(font.id);
		await this.refreshDownloaded();
		new Notice(`已删除「${font.label}」`, 2000);
	}

	/**
	 * 取该字体的 @font-face CSS（base64 data URI，iframe 注入用）。
	 * 同步读缓存；未缓存时后台加载并在就绪后由调用方重排。
	 */
	getCachedFaceCss(font: CatalogFont): string | null {
		return this.faceCache.get(font.id) ?? null;
	}

	/** 后台读取字体文件并生成 base64 @font-face CSS（失败返回 null） */
	async loadFaceCss(font: CatalogFont): Promise<string | null> {
		const cached = this.faceCache.get(font.id);
		if (cached) return cached;
		try {
			const path = this.pathOf(font);
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const buf = await this.app.vault.adapter.readBinary(path);
			const css =
				`@font-face { font-family: "${font.family}"; ` +
				`src: url(data:font/${font.format === 'woff2' ? 'woff2' : 'ttf'};base64,${bufToBase64(buf)}) format('${font.format}'); ` +
				'font-display: swap; }';
			this.faceCache.set(font.id, css);
			return css;
		} catch {
			return null;
		}
	}

	private async ensureDir(): Promise<void> {
		const dir = this.dir();
		if (!(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.adapter.mkdir(dir);
		}
	}
}

/** 在线字体库弹窗：列出目录项、下载 / 删除、展示许可证与来源 */
export class FontLibraryModal extends Modal {
	/** 操作完成后的回调（刷新面板字体列表 / 重排） */
	private onChange: () => void;

	constructor(
		private plugin: FleurEpubPlugin,
		onChange: () => void,
	) {
		super(plugin.app);
		this.onChange = onChange;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('fleur-epub-fontlib-modal');
		this.titleEl.setText('在线字体库');
		const lib = this.plugin.fontLibrary;
		await lib.refreshDownloaded();
		this.contentEl.empty();

		this.contentEl.createEl('p', { cls: 'fleur-epub-fontlib-hint' }).setText(
			'以下均为 SIL OFL 1.1 开源字体，从官方发布渠道下载后保存到本库（.fleur-epub-fonts/），离线可用；不会上传任何数据。',
		);

		for (const font of FONT_CATALOG) {
			const row = this.contentEl.createDiv('fleur-epub-fontlib-item');
			const info = row.createDiv('fleur-epub-fontlib-info');
			const title = info.createDiv('fleur-epub-fontlib-title');
			title.setText(font.label);
			if (lib.isDownloaded(font)) title.createSpan('fleur-epub-fontlib-badge').setText('已下载');
			info.createDiv('fleur-epub-fontlib-meta').setText(
				`${Math.round(font.sizeBytes / 1048576 * 10) / 10}MB · ${font.license} · ${font.note}`,
			);
			info.createEl('a', { cls: 'fleur-epub-fontlib-link', href: font.homepage }).setText('来源与许可证');
			const actions = row.createDiv('fleur-epub-fontlib-actions');
			if (lib.downloading.has(font.id)) {
				const busy = actions.createEl('button');
				busy.setText('下载中…');
				busy.disabled = true;
				continue;
			}
			if (lib.isDownloaded(font)) {
				const del = actions.createEl('button', 'mod-warning');
				del.setText('删除');
				del.addEventListener('click', async () => {
					await lib.remove(font);
					this.onOpen(); // 就地刷新
					this.onChange();
				});
			} else {
				const dl = actions.createEl('button', 'mod-cta');
				dl.setText('下载');
				dl.addEventListener('click', async () => {
					dl.disabled = true;
					dl.setText('下载中…');
					await lib.download(font);
					this.onOpen(); // 就地刷新
					this.onChange();
				});
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
