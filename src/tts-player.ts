// 听书播放器（微信读书式）：移动端 bottom sheet 与桌面 Modal 共用的 UI 构建器。
// 引擎为 ReaderTTS（系统 TTS），本文件只管界面：当前句 / 进度 / 语速 / 声源 / 播放控制。
// 关闭面板 = 收起播放器，朗读继续（微信读书 collapse 语义）。

import { App, Modal, setIcon } from 'obsidian';
import type { EpubReaderView } from './reader-view';
import { TTS_RATES } from './tts';
import type { TTSState } from './tts';

/**
 * 在容器内构建播放器 UI（容器需自行布局：sheet body 或 modal content）。
 * 返回清理函数（解绑 TTS 状态订阅）。
 */
export function buildTTSPlayer(container: HTMLElement, view: EpubReaderView): () => void {
	const tts = view.getTTS();
	if (!tts) return () => {};
	container.addClass('fleur-epub-tts-player');

	const chapter = container.createDiv('fleur-epub-tts-chapter');
	chapter.setText(view.getDisplayText());
	const sentence = container.createDiv('fleur-epub-tts-sentence');
	const count = container.createDiv('fleur-epub-tts-count');
	const slider = container.createEl('input', 'fleur-epub-tts-range fleur-epub-sheet-range');
	slider.setAttr('type', 'range');
	slider.setAttr('min', '0');
	slider.setAttr('step', '1');
	// 拖动松手才跳句（change），拖动中只更新数字避免连续重读
	slider.addEventListener('change', () => tts.seek(Number(slider.value)));

	const rateRow = container.createDiv('fleur-epub-tts-rates');
	const rateBtns = new Map<number, HTMLElement>();
	for (const r of TTS_RATES) {
		const b = rateRow.createDiv('fleur-epub-tts-rate');
		b.setText(`${r}x`);
		b.addEventListener('click', () => tts.setRate(r));
		rateBtns.set(r, b);
	}

	// 声源（系统内置 TTS 语音：免费离线、完全合规）：横滑 chips，点击即换并持久化
	container.createDiv('fleur-epub-tts-caption').setText('声源 · 系统语音');
	const voiceScroll = container.createDiv('fleur-epub-tts-voice-scroll');
	const renderVoices = () => {
		voiceScroll.empty();
		const current = tts.getVoiceURI();
		const mk = (label: string, uri: string, title: string) => {
			const chip = voiceScroll.createDiv('fleur-epub-tts-voice');
			chip.setText(label);
			chip.setAttribute('aria-label', title);
			chip.toggleClass('is-active', uri === current);
			chip.addEventListener('click', () => tts.setVoice(uri));
		};
		mk('自动', '', '跟随章节语言由系统选择');
		const voices = tts.listVoices(view.getTTSChapterLang());
		for (const v of voices) {
			mk(v.name, v.voiceURI, `${v.name} (${v.lang})`);
		}
		// 当前选中项若被精选列表排除，补进列表（保证可见、可切回「自动」）
		if (current && !voices.some((v) => v.voiceURI === current)) {
			const v = tts.findVoice(current);
			if (v) mk(v.name, v.voiceURI, `${v.name} (${v.lang})`);
		}
	};

	const controls = container.createDiv('fleur-epub-tts-controls');
	const prevBtn = controls.createDiv('fleur-epub-tts-side');
	setIcon(prevBtn.createSpan('fleur-epub-tts-side-icon'), 'skip-back');
	prevBtn.setAttribute('aria-label', '上一句');
	prevBtn.addEventListener('click', () => tts.prev());
	const playBtn = controls.createDiv('fleur-epub-tts-play');
	const playIcon = playBtn.createSpan('fleur-epub-tts-play-icon');
	playBtn.setAttribute('aria-label', '播放/暂停');
	playBtn.addEventListener('click', () => tts.toggle());
	const nextBtn = controls.createDiv('fleur-epub-tts-side');
	setIcon(nextBtn.createSpan('fleur-epub-tts-side-icon'), 'skip-forward');
	nextBtn.setAttribute('aria-label', '下一句');
	nextBtn.addEventListener('click', () => tts.next());

	const sync = (s: TTSState) => {
		sentence.setText(s.sentence || (s.active ? '…' : '点下方播放键开始朗读本章'));
		count.setText(s.total ? `${s.index + 1} / ${s.total} 句` : '—');
		slider.setAttr('max', String(Math.max(0, s.total - 1)));
		slider.setAttr('value', String(s.index));
		if (playIcon.firstChild) playIcon.empty();
		setIcon(playIcon, s.active && !s.paused ? 'pause' : 'play');
		playBtn.toggleClass('is-playing', s.active && !s.paused);
		for (const [r, b] of rateBtns) b.toggleClass('is-active', r === s.rate);
		// 声源列表异步到达（voiceschanged）或选择变化后补渲染；句推进时不重绘
		const n = tts.listVoices().length;
		const uri = tts.getVoiceURI();
		if (n !== lastVoiceCount || uri !== lastVoiceURI) {
			lastVoiceCount = n;
			lastVoiceURI = uri;
			renderVoices();
		}
	};
	let lastVoiceCount = -1;
	let lastVoiceURI: string | null = null;
	const unsub = tts.onStateChange(sync);
	sync(tts.getState());
	return unsub;
}

/** 桌面端听书播放器：居中 Modal，关闭仅收起面板、朗读继续 */
export class TTSPlayerModal extends Modal {
	constructor(app: App, private view: EpubReaderView) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('听书');
		this.modalEl.addClass('fleur-epub-tts-modal');
		buildTTSPlayer(this.contentEl, this.view);
		this.setupDrag();
	}

	/** 标题栏拖拽移动窗口（桌面端）：transform 累积偏移，松手落位，重开自动复位 */
	private setupDrag(): void {
		this.modalEl.style.transform = '';
		let ox = 0;
		let oy = 0;
		this.titleEl.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			this.modalEl.addClass('is-dragging');
			const sx = e.clientX - ox;
			const sy = e.clientY - oy;
			const onMove = (ev: PointerEvent) => {
				ox = ev.clientX - sx;
				oy = ev.clientY - sy;
				this.modalEl.style.transform = `translate(${ox}px, ${oy}px)`;
			};
			const onUp = () => {
				this.modalEl.removeClass('is-dragging');
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
			};
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
