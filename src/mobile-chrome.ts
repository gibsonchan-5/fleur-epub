// 移动端 chrome：底部工具栏 + 目录/进度/批注 bottom sheet + 显隐状态机。
// 仅在 isMobileUI() 为真时由 EpubReaderView 创建；桌面端不实例化、不受影响。
// 显隐实现：在阅读根元素（.fleur-epub-root）上切换 is-chrome-hidden 类，
// 顶栏与底部工具栏的位移动画全部由 CSS（body.fleur-epub-mobile 作用域）驱动。

import { Notice, setIcon } from 'obsidian';
// 与 reader-view 存在类型层面的相互引用（此处仅类型 + 延迟使用的常量），
// ESM live binding 下运行时安全：HIGHLIGHT_COLORS / READER_THEMES 只在事件回调中读取。
import { HIGHLIGHT_COLORS, READER_THEMES } from './reader-view';
import type { EpubReaderView } from './reader-view';
import type { ReaderTheme } from './settings';
import { buildTTSPlayer } from './tts-player';

/** 底部工具栏条目（微信读书式五键：目录 · 批注 · 进度 · 背景 · 排版） */
const TOOLBAR_ITEMS: Array<{ id: 'toc' | 'progress' | 'anns' | 'theme' | 'type'; icon: string; label: string }> = [
	{ id: 'toc', icon: 'list', label: '目录' },
	{ id: 'anns', icon: 'highlighter', label: '批注' },
	{ id: 'progress', icon: 'gauge', label: '进度' },
	{ id: 'theme', icon: 'palette', label: '背景' },
	{ id: 'type', icon: 'type', label: '排版' },
];

/** sheet 收起动画时长（与 CSS transition 保持一致） */
const SHEET_ANIM_MS = 200;

export class MobileChrome {
	/** 底部工具栏元素（由 reader-view 挂到 contentEl） */
	readonly toolbarEl: HTMLElement;
	private visible = false;
	private sheetBackdrop: HTMLElement | null = null;
	private sheetOpen = false;
	/** sheet 关闭时的清理钩子（目录 sheet 用来清除检索高亮） */
	private sheetCleanup: (() => void) | null = null;
	private itemBtns = new Map<string, HTMLElement>();

	constructor(private view: EpubReaderView) {
		this.toolbarEl = createDiv('fleur-epub-mtoolbar');
		for (const item of TOOLBAR_ITEMS) {
			const btn = this.toolbarEl.createDiv('fleur-epub-mtoolbar-btn');
			const icon = btn.createSpan('fleur-epub-mtoolbar-icon');
			setIcon(icon, item.icon);
			// 纯图标工具栏：名称放 aria-label，不渲染文字
			btn.setAttribute('aria-label', item.label);
			this.itemBtns.set(item.id, btn);
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.handleItem(item.id);
			});
		}
	}

	// ── 显隐状态机 ──

	/** 最近一次显式呼出时间：宽限期内忽略 relocate/scroll 的自动收起
	 *  （开书时恢复进度、字体加载 expand 等迟到的 relocate 会把刚弹出的工具栏闪掉） */
	private shownAt = 0;
	private static readonly SHOW_GRACE_MS = 800;

	toggle(): void {
		if (this.visible) this.hide();
		else this.show();
	}

	show(): void {
		this.visible = true;
		this.shownAt = Date.now();
		this.view.contentEl.removeClass('is-chrome-hidden');
	}

	hide(): void {
		this.visible = false;
		this.closeSheet();
		this.view.contentEl.addClass('is-chrome-hidden');
	}

	/** 无 sheet 打开时才算「空闲」——空闲状态下翻页/滚动才自动收起 chrome */
	isIdle(): boolean {
		return !this.sheetOpen;
	}

	/** 翻页 / 跳转 relocate 时调用：空闲则收起（微信读书行为）；宽限期内不收 */
	onRelocate(): void {
		if (this.visible && this.isIdle() && Date.now() - this.shownAt > MobileChrome.SHOW_GRACE_MS) this.hide();
	}

	/** 滚动模式内容滚动时调用：空闲则收起；宽限期内不收 */
	onContentScroll(): void {
		if (this.visible && this.isIdle() && Date.now() - this.shownAt > MobileChrome.SHOW_GRACE_MS) this.hide();
	}

	destroy(): void {
		this.closeSheet();
	}

	// ── 工具栏按钮分发 ──

	private handleItem(id: string): void {
		switch (id) {
			case 'toc':
				this.openTocSheet();
				break;
			case 'progress':
				this.openProgressSheet();
				break;
			case 'anns':
				this.openAnnotationsSheet();
				break;
			case 'theme':
				this.openThemeSheet();
				break;
			case 'type': {
				// 排版 = 原「设置」入口的 Aa 外观面板（字号/行距/段距/页边距/字体/背景）
				const anchor = this.itemBtns.get('type');
				if (anchor) this.view.openAppearancePanelFrom(anchor);
				break;
			}
		}
	}

	/**
	 * 听书播放器（微信读书式）：UI 构建器在 tts-player.ts（与桌面 Modal 共用）。
	 * 顶栏「听」呼出：空闲顺带开播；关闭 sheet 仅收起面板，朗读继续。
	 */
	openTTSPlayer(): void {
		const tts = this.view.getTTS();
		if (!tts) return;
		if (!tts.isActive()) tts.start();
		this.openSheet('听书', (body) => {
			this.sheetCleanup = buildTTSPlayer(body, this.view);
		});
	}

	// ── bottom sheet ──

	private openSheet(title: string, build: (body: HTMLElement) => void): void {
		this.closeSheet();
		const backdrop = document.body.createDiv('fleur-epub-sheet-backdrop');
		const sheet = backdrop.createDiv('fleur-epub-sheet');
		const header = sheet.createDiv('fleur-epub-sheet-header');
		header.createSpan('fleur-epub-sheet-title').setText(title);
		const close = header.createSpan('fleur-epub-sheet-close');
		setIcon(close, 'x');
		close.setAttribute('aria-label', '关闭');
		close.addEventListener('click', () => this.closeSheet());
		const body = sheet.createDiv('fleur-epub-sheet-body');
		build(body);
		backdrop.addEventListener('click', (e) => {
			if (e.target === backdrop) this.closeSheet();
		});
		this.sheetBackdrop = backdrop;
		this.sheetOpen = true;
		// 下一帧再加 is-open，保证 translateY(100%) → 0 的过渡动画生效
		window.requestAnimationFrame(() => backdrop.addClass('is-open'));
	}

	private closeSheet(): void {
		const bd = this.sheetBackdrop;
		this.sheetBackdrop = null;
		this.sheetOpen = false;
		if (this.sheetCleanup) {
			const fn = this.sheetCleanup;
			this.sheetCleanup = null;
			try {
				fn();
			} catch {
				/* 清理失败不影响收起 */
			}
		}
		if (!bd) return;
		bd.removeClass('is-open');
		window.setTimeout(() => bd.remove(), SHEET_ANIM_MS);
	}

	/**
	 * 目录 sheet：顶部检索行 + 章节树列表（depth 缩进），点击跳转。
	 * 检索由原书内面板「检索」tab 移植（回车执行全书检索），书架面板移动端不再承担书内功能。
	 */
	private openTocSheet(): void {
		const toc = this.view.getTOC();
		if (!toc.length) {
			new Notice('本书没有目录', 1800);
			return;
		}
		this.openSheet('目录', (body) => {
			// 检索行（sticky 置顶，章节列表滚动时保持可见）
			const searchWrap = body.createDiv('fleur-epub-sheet-search');
			const input = searchWrap.createEl('input', 'fleur-epub-sheet-search-input');
			input.type = 'search';
			input.placeholder = '在本书中检索…（回车执行）';
			const listWrap = body.createDiv('fleur-epub-sheet-toclist');

			const renderToc = () => {
				listWrap.empty();
				for (const item of toc) {
					const row = listWrap.createDiv('fleur-epub-sheet-row');
					row.setCssStyles({ paddingLeft: `${12 + Math.min(item.depth, 5) * 16}px` });
					row.setText(item.label || '（无标题）');
					row.addEventListener('click', () => {
						void this.view.goToTarget(item.href);
						this.hide();
					});
				}
			};
			renderToc();

			input.addEventListener('keydown', (e) => {
				if (e.key !== 'Enter') return;
				e.preventDefault();
				void this.runSheetSearch(input.value, listWrap, renderToc);
			});

			// sheet 关闭 → 清除正文检索高亮
			this.sheetCleanup = () => this.view.clearBookSearch();
		});
	}

	/** 目录 sheet 内的全书检索：结果替换章节列表，点击定位（与桌面检索 tab 同一 reader API） */
	private async runSheetSearch(
		rawQuery: string,
		listWrap: HTMLElement,
		renderToc: () => void,
	): Promise<void> {
		const query = rawQuery.trim();
		this.view.clearBookSearch();
		listWrap.empty();
		if (!query) {
			renderToc();
			return;
		}
		const status = listWrap.createDiv('fleur-epub-sheet-empty');
		status.setText('检索中…');
		let count = 0;
		try {
			await this.view.runSearch(
				query,
				(label, excerpt, cfi) => {
					count++;
					if (count === 1) status.setText('点击结果定位到正文');
					const row = listWrap.createDiv('fleur-epub-sheet-hit');
					if (label) row.createDiv('fleur-epub-sheet-hit-label').setText(label);
					row.createDiv('fleur-epub-sheet-hit-text').setText(excerpt);
					row.addEventListener('click', () => {
						void this.view.goToTarget(cfi);
						this.hide();
					});
				},
				(p) => {
					if (count === 0) status.setText(`检索中… ${Math.round(p * 100)}%`);
				},
			);
		} catch (err) {
			console.warn('[FleurEPUB] 检索失败', err);
		}
		if (status.isConnected) status.setText(count ? `共 ${count} 条结果` : '没有找到结果');
	}

	/** 背景 sheet：四主题圆点（微信读书式），点击即换；Aa 面板内仍有完整背景行 */
	private openThemeSheet(): void {
		const current = this.view.getReaderTheme();
		this.openSheet('背景', (body) => {
			const row = body.createDiv('fleur-epub-sheet-themes');
			for (const [key, t] of Object.entries(READER_THEMES)) {
				const item = row.createDiv('fleur-epub-sheet-theme');
				const dot = item.createDiv('fleur-epub-sheet-theme-dot');
				dot.setCssStyles({ background: t.bg });
				item.createDiv('fleur-epub-sheet-theme-label').setText(t.label);
				if (key === current) item.addClass('is-active');
				item.addEventListener('click', () => {
					row.findAll('.fleur-epub-sheet-theme').forEach((d) => d.removeClass('is-active'));
					item.addClass('is-active');
					void this.view.setReaderTheme(key as ReaderTheme);
				});
			}
		});
	}

	/** 进度 sheet：大号百分比 + 拖动跳转（松手生效，避免拖动中连续重排） */
	private openProgressSheet(): void {
		const percent = this.view.getCurrentPercent() ?? 0;
		this.openSheet('进度', (body) => {
			const num = body.createDiv('fleur-epub-sheet-progress-num');
			num.setText(`${percent}%`);
			const slider = body.createEl('input', 'fleur-epub-sheet-range');
			slider.setAttr('type', 'range');
			slider.setAttr('min', '0');
			slider.setAttr('max', '100');
			slider.setAttr('step', '1');
			slider.setAttr('value', String(percent));
			slider.addEventListener('input', () => num.setText(`${slider.value}%`));
			slider.addEventListener('change', () => {
				void this.view.goToFraction(Number(slider.value) / 100);
				this.hide();
			});
		});
	}

	/** 批注 sheet：全部标注（最新在前），点击定位 */
	private openAnnotationsSheet(): void {
		const anns = [...this.view.getAnnotations()].reverse();
		this.openSheet(`批注 · ${anns.length}`, (body) => {
			if (!anns.length) {
				body.createDiv('fleur-epub-sheet-empty').setText('还没有批注。选中文字即可高亮或写想法。');
				return;
			}
			for (const ann of anns) {
				const row = body.createDiv('fleur-epub-sheet-ann');
				const dot = row.createSpan('fleur-epub-sheet-ann-dot');
				dot.setCssStyles({ background: HIGHLIGHT_COLORS[ann.color] ?? HIGHLIGHT_COLORS.yellow });
				const main = row.createDiv('fleur-epub-sheet-ann-main');
				main.createDiv('fleur-epub-sheet-ann-label').setText(ann.chapterLabel || '批注');
				const preview = ann.comment || ann.text || '';
				if (preview) main.createDiv('fleur-epub-sheet-ann-text').setText(preview.slice(0, 60));
				row.addEventListener('click', () => {
					void this.view.locateAnnotation(ann.cfi);
					this.hide();
				});
			}
			// 导出笔记：与桌面书架批注 tab 共用实现（annotation-export.ts）
			const exportBtn = body.createEl('button', 'fleur-epub-sheet-export');
			exportBtn.setText('导出笔记');
			exportBtn.setAttribute('aria-label', '导出所有批注为 Markdown 笔记');
			exportBtn.addEventListener('click', () => {
				this.closeSheet();
				this.view.exportAnnotations();
			});
		});
	}
}

