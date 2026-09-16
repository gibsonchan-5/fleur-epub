// 听书播放器（微信读书式）：移动端 bottom sheet 与桌面 Modal 共用的 UI 构建器。
// 引擎为 ReaderTTS（系统 TTS），本文件只管界面：当前句 / 进度 / 语速 / 声源 / 播放控制。
// 关闭面板 = 收起播放器，朗读继续（微信读书 collapse 语义）。

import { App, Modal, setIcon } from 'obsidian';
import type { EpubReaderView } from './reader-view';
import { ReaderTTS, TTS_RATES } from './tts';
import type { TTSState } from './tts';
import { onlineVoices, ONLINE_TTS_PRESETS } from './tts-online';

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

	// 引擎切换：系统语音（免费离线）/ 在线语音（安卓 WebView 没有系统语音，只能走在线）
	const engineRow = container.createDiv('fleur-epub-tts-engines');
	const engineBtns = new Map<string, HTMLElement>();
	const systemOk = ReaderTTS.supported();
	const engines: { v: 'system' | 'online'; label: string; hint: string }[] = [
		{ v: 'system', label: '系统语音', hint: systemOk ? '免费离线，随系统音色' : '当前平台不支持系统朗读' },
		{ v: 'online', label: '在线语音', hint: tts.onlineReady() ? '需网络，音色更好' : '未配置：设置 → 听书 填入接口与密钥' },
	];
	for (const e of engines) {
		const b = engineRow.createDiv('fleur-epub-tts-engine');
		b.setText(e.label);
		b.setAttribute('aria-label', e.hint);
		if (e.v === 'system' && !systemOk) b.addClass('is-disabled');
		b.addEventListener('click', () => {
			if (e.v === 'system' && !systemOk) return;
			tts.setEngine(e.v);
			sync(tts.getState());
		});
		engineBtns.set(e.v, b);
	}

	// 引擎说明（触屏上看不到悬浮提示，直接把原因写在界面上：
	// 系统语音为何灰着 / 在线语音为何还不出声）
	const engineHint = container.createDiv('fleur-epub-tts-hint');
	const engineHintOf = (): string => {
		if (!systemOk) return '当前平台（安卓 WebView）不提供系统朗读，请使用在线语音';
		if (tts.engine() === 'online' && !tts.onlineReady()) return '在线语音未配置：设置 → 听书 填入接口地址与密钥';
		return '';
	};
	engineHint.setText(engineHintOf());

	// 声源：系统 = 内置语音 chips；在线 = 当前提供商的音色 chips
	const caption = container.createDiv('fleur-epub-tts-caption');
	const voiceScroll = container.createDiv('fleur-epub-tts-voice-scroll');
	let lastVoiceKey = '';
	const renderVoices = () => {
		voiceScroll.empty();
		const engine = tts.engine();
		caption.setText(engine === 'online' ? '声源 · 在线语音' : '声源 · 系统语音');
		const mk = (label: string, id: string, title: string, active: boolean, onPick: () => void) => {
			const chip = voiceScroll.createDiv('fleur-epub-tts-voice');
			chip.setText(label);
			chip.setAttribute('aria-label', title);
			chip.toggleClass('is-active', active);
			chip.addEventListener('click', onPick);
		};
		if (engine === 'online') {
			const provider = view.plugin.settings.ttsOnlineProvider;
			const current = tts.getOnlineVoice();
			const list = onlineVoices(provider);
			if (!list.length) {
				// 自定义提供商：没有预置音色，只展示当前值（在设置里改）
				mk(current || '未设置音色', current, '当前音色（在设置中修改）', true, () => {});
				return;
			}
			for (const v of list) {
				mk(v.label, v.id, v.id, v.id === current, () => tts.setOnlineVoice(v.id));
			}
			if (current && !list.some((v) => v.id === current)) {
				mk(current, current, current, true, () => {});
			}
			return;
		}
		const current = tts.getVoiceURI();
		mk('自动', '', '跟随章节语言由系统选择', current === '', () => tts.setVoice(''));
		const voices = tts.listVoices(view.getTTSChapterLang());
		for (const v of voices) {
			mk(v.name, v.voiceURI, `${v.name} (${v.lang})`, v.voiceURI === current, () => tts.setVoice(v.voiceURI));
		}
		// 当前选中项若被精选列表排除，补进列表（保证可见、可切回「自动」）
		if (current && !voices.some((v) => v.voiceURI === current)) {
			const v = tts.findVoice(current);
			if (v) mk(v.name, current, `${v.name} (${v.lang})`, true, () => {});
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
		for (const [v, b] of engineBtns) b.toggleClass('is-active', v === s.engine);
		engineHint.setText(engineHintOf());
		// 声源列表异步到达（voiceschanged）/ 引擎或音色变化后补渲染；句推进时不重绘
		const engine = s.engine;
		const key = engine === 'online'
			? `online:${view.plugin.settings.ttsOnlineProvider}:${tts.getOnlineVoice()}`
			: `system:${tts.getVoiceURI()}:${tts.listVoices().length}`;
		if (key !== lastVoiceKey) {
			lastVoiceKey = key;
			renderVoices();
		}
	};
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
		// 复位 transform：setCssProps 底层就是 style.setProperty，传空串即移除该属性，
		// 与直接写 this.modalEl.style.transform = '' 完全等价。
		this.modalEl.setCssProps({ transform: '' });
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
