// 听书播放器（微信读书式）：移动端 bottom sheet 与桌面 Modal 共用的 UI 构建器。
// 引擎为 ReaderTTS，本文件只管界面：当前句 / 进度 / 语速 / 声音选择 / 播放控制。
//
// 声音选择：系统声音与云端声音合并在同一张卡里，点一下展开下拉；
// 云端按提供商分组折叠，未配置的服务直接标出来，不在界面里藏入口。
// 关闭面板 = 收起播放器，朗读继续（微信读书 collapse 语义）。

import { App, Modal, Notice, setIcon } from 'obsidian';
import type { EpubReaderView } from './reader-view';
import { ReaderTTS } from './tts';
import type { TTSState } from './tts';
import {
	TTS_RATE_MAX,
	TTS_RATE_MIN,
	TTS_RATE_STEP,
	formatTtsRate,
} from './tts-rate';
import {
	TTS_PROVIDERS,
	currentSelectionKey,
	isCloudProvider,
	providerPreset,
	providerReady,
} from './tts-providers';
import type { TtsProviderId } from './tts-providers';

interface VoiceInfo {
	title: string;
	sub: string;
	icon: string;
	ready: boolean;
}

/**
 * 在容器内构建播放器 UI（容器需自行布局：sheet body 或 modal content）。
 * 返回清理函数（解绑 TTS 状态订阅）。
 */
export function buildTTSPlayer(container: HTMLElement, view: EpubReaderView): () => void {
	const tts = view.getTTS();
	if (!tts) return () => {};
	container.addClass('fleur-epub-tts-player');
	const settings = view.plugin.settings;

	// ── 章节与当前句 ──
	const head = container.createDiv('fleur-epub-tts-head');
	const chapter = head.createDiv('fleur-epub-tts-chapter');
	chapter.setText(view.getDisplayText());
	const sentence = container.createDiv('fleur-epub-tts-sentence');
	const count = container.createDiv('fleur-epub-tts-count');

	// ── 进度 ──
	const slider = container.createEl('input', 'fleur-epub-tts-range');
	slider.setAttr('type', 'range');
	slider.setAttr('min', '0');
	slider.setAttr('step', '1');
	slider.setAttr('aria-label', '朗读进度');
	// 拖动松手才跳句（change），拖动中只更新数字避免连续重读
	slider.addEventListener('change', () => tts.seek(Number(slider.value)));

	// ── 播放控制 ──
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

	// ── 语速：一条滑杆 + 实时数值，松手才应用 ──
	const rateRow = container.createDiv('fleur-epub-tts-rate-row');
	rateRow.createSpan('fleur-epub-tts-rate-label').setText('语速');
	const rateSlider = rateRow.createEl('input', { cls: 'fleur-epub-tts-rate-range' });
	rateSlider.type = 'range';
	rateSlider.min = String(TTS_RATE_MIN);
	rateSlider.max = String(TTS_RATE_MAX);
	rateSlider.step = String(TTS_RATE_STEP);
	rateSlider.setAttr('aria-label', '朗读语速');
	const rateValue = rateRow.createSpan('fleur-epub-tts-rate-value');
	// 拖动中只用数值预览，避免每移动一格就重读当前句
	let rateDragging = false;
	rateSlider.addEventListener('input', () => {
		rateDragging = true;
		rateValue.setText(formatTtsRate(Number(rateSlider.value)));
	});
	rateSlider.addEventListener('change', () => {
		rateDragging = false;
		tts.setRate(Number(rateSlider.value));
	});

	// ── 声音：一张卡 + 下拉 ──
	// 移动端 sheet 默认只有 62vh；展开声音面板时临时加高，避免列表被硬切
	const sheetEl = container.closest('.fleur-epub-sheet');
	const voiceBlock = container.createDiv('fleur-epub-tts-voice-block');
	const trigger = voiceBlock.createEl('button', { cls: 'fleur-epub-tts-voice-trigger' });
	trigger.setAttr('type', 'button');
	trigger.setAttr('aria-expanded', 'false');
	trigger.setAttr('aria-label', '选择朗读声音');
	const avatar = trigger.createSpan('fleur-epub-tts-voice-avatar');
	const meta = trigger.createSpan('fleur-epub-tts-voice-meta');
	const voiceName = meta.createSpan('fleur-epub-tts-voice-name');
	const voiceSub = meta.createSpan('fleur-epub-tts-voice-sub');
	const chevron = trigger.createSpan('fleur-epub-tts-voice-chevron');
	setIcon(chevron, 'chevron-down');

	const panel = voiceBlock.createDiv('fleur-epub-tts-voice-panel');
	panel.hidden = true;
	const panelBody = panel.createDiv('fleur-epub-tts-voice-panel-body');
	const foot = panel.createDiv('fleur-epub-tts-voice-foot');
	foot.createSpan('fleur-epub-tts-voice-foot-text').setText('密钥可在设置 → 听书 中管理');
	const settingsBtn = foot.createEl('button', { cls: 'fleur-epub-tts-voice-settings' });
	settingsBtn.setAttr('type', 'button');
	settingsBtn.setText('打开设置');
	settingsBtn.addEventListener('click', () => {
		const target = (view.app as unknown as {
			setting?: { open?: () => void; openTabById?: (id: string) => void };
		}).setting;
		try {
			target?.open?.();
			target?.openTabById?.(view.plugin.manifest.id);
		} catch {
			new Notice('请从 设置 → FleurEPUB → 听书 打开', 2400);
		}
	});

	let panelOpen = false;
	let expandedProvider: string | null = null;
	let lastVoiceKey = '';

	const systemSupported = ReaderTTS.supported();

	const selectionInfo = (): VoiceInfo => {
		if (settings.ttsEngine === 'system') {
			const voice = tts.findVoice(settings.ttsVoiceURI);
			return {
				title: voice ? `系统 · ${voice.name}` : '系统 · 自动',
				sub: voice ? `免费 · 离线 · ${voice.lang}` : '免费 · 离线 · 跟随章节语言',
				icon: 'mic',
				ready: systemSupported,
			};
		}
		const preset = providerPreset(settings.ttsOnlineProvider);
		const voice = preset?.voices.find((v) => v.id === settings.ttsOnlineVoice);
		const ready = tts.onlineReady();
		if (!preset) {
			return { title: '云端声音', sub: '选择声音后开始朗读', icon: 'cloud', ready };
		}
		const note = voice?.note ? ` · ${voice.note}` : '';
		return {
			title: `${preset.shortLabel} · ${voice?.label ?? (settings.ttsOnlineVoice || '未选音色')}`,
			sub: `云端${note}${ready ? '' : ' · 未配置密钥'}`,
			icon: 'cloud',
			ready,
		};
	};

	const renderTrigger = () => {
		const info = selectionInfo();
		avatar.empty();
		setIcon(avatar, info.icon);
		voiceName.setText(info.title);
		voiceSub.setText(info.sub);
		trigger.toggleClass('is-cloud', settings.ttsEngine === 'online');
		trigger.toggleClass('is-unready', !info.ready);
	};

	const makeVoiceRow = (
		parent: HTMLElement,
		opts: {
			title: string;
			sub: string;
			active: boolean;
			disabled?: boolean;
			onClick: () => void;
		},
	): void => {
		const row = parent.createEl('button', { cls: 'fleur-epub-tts-voice-row' });
		row.setAttr('type', 'button');
		row.toggleClass('is-active', opts.active);
		if (opts.disabled) row.disabled = true;
		const text = row.createSpan('fleur-epub-tts-voice-row-text');
		text.createSpan('fleur-epub-tts-voice-row-title').setText(opts.title);
		text.createSpan('fleur-epub-tts-voice-row-sub').setText(opts.sub);
		if (opts.active) setIcon(row.createSpan('fleur-epub-tts-voice-row-check'), 'check');
		row.addEventListener('click', opts.onClick);
	};

	const pick = (provider: TtsProviderId, voiceId: string) => {
		const wasReady = provider === 'system' ? systemSupported : providerReady(settings, provider);
		tts.selectVoice(provider, voiceId);
		panelOpen = false;
		trigger.setAttr('aria-expanded', 'false');
		trigger.removeClass('is-open');
		sheetEl?.removeClass('is-tts-expanded');
		renderTrigger();
		renderPanel();
		if (!wasReady) {
			const label = provider === 'system' ? '系统声音' : providerPreset(provider)?.label ?? '云端声音';
			new Notice(`${label}暂不可用：请在设置 → 听书 完成配置`, 3600);
		}
	};

	const renderPanel = () => {
		panel.hidden = !panelOpen;
		panel.toggleClass('is-open', panelOpen);
		if (!panelOpen) return;
		panelBody.empty();

		// 系统声音
		const systemGroup = panelBody.createDiv('fleur-epub-tts-voice-group');
		const systemHead = systemGroup.createDiv('fleur-epub-tts-voice-group-head');
		systemHead.createSpan('fleur-epub-tts-voice-group-title').setText('系统声音');
		systemHead
			.createSpan('fleur-epub-tts-voice-group-badge')
			.setText(systemSupported ? '免费 · 离线' : '当前平台不可用');
		const systemList = systemGroup.createDiv('fleur-epub-tts-voice-list');
		if (!systemSupported) {
			systemList
				.createDiv('fleur-epub-tts-voice-empty')
				.setText('安卓 WebView 不提供系统朗读，请选择下方的云端声音');
		} else {
			makeVoiceRow(systemList, {
				title: '自动',
				sub: '跟随章节语言选择系统默认音色',
				active: settings.ttsEngine === 'system' && !settings.ttsVoiceURI,
				onClick: () => pick('system', ''),
			});
			const voices = tts.listVoices(view.getTTSChapterLang());
			if (!voices.length) {
				systemList
					.createDiv('fleur-epub-tts-voice-empty')
					.setText('系统声源加载中…稍后再打开本面板');
			}
			for (const voice of voices) {
				makeVoiceRow(systemList, {
					title: voice.name,
					sub: voice.lang,
					active:
						settings.ttsEngine === 'system' && settings.ttsVoiceURI === voice.voiceURI,
					onClick: () => pick('system', voice.voiceURI),
				});
			}
		}

		// 云端声音：按提供商折叠
		const cloudGroup = panelBody.createDiv('fleur-epub-tts-voice-group');
		const cloudHead = cloudGroup.createDiv('fleur-epub-tts-voice-group-head');
		cloudHead.createSpan('fleur-epub-tts-voice-group-title').setText('云端声音');
		cloudHead.createSpan('fleur-epub-tts-voice-group-badge').setText('更自然');
		const cloudList = cloudGroup.createDiv('fleur-epub-tts-voice-providers');

		for (const preset of Object.values(TTS_PROVIDERS)) {
			const ready = providerReady(settings, preset.id);
			const expanded = expandedProvider === preset.id;
			const providerEl = cloudList.createDiv('fleur-epub-tts-provider');
			providerEl.toggleClass('is-active', settings.ttsOnlineProvider === preset.id);
			const providerHead = providerEl.createEl('button', {
				cls: 'fleur-epub-tts-provider-head',
			});
			providerHead.setAttr('type', 'button');
			providerHead.setAttr('aria-expanded', String(expanded));
			providerHead.createSpan('fleur-epub-tts-provider-dot').toggleClass('is-ready', ready);
			const providerText = providerHead.createSpan('fleur-epub-tts-provider-text');
			providerText
				.createSpan('fleur-epub-tts-provider-name')
				.setText(preset.shortLabel);
			providerText
				.createSpan('fleur-epub-tts-provider-sub')
				.setText(ready ? '已配置' : '未配置密钥');
			setIcon(providerHead.createSpan('fleur-epub-tts-provider-chevron'), 'chevron-down');
			providerHead.addEventListener('click', () => {
				expandedProvider = expanded ? null : preset.id;
				renderPanel();
			});

			const providerVoices = providerEl.createDiv('fleur-epub-tts-provider-voices');
			providerVoices.hidden = !expanded;
			if (!preset.voices.length) {
				providerVoices
					.createDiv('fleur-epub-tts-voice-empty')
					.setText('在设置 → 听书 填写接口地址、模型与音色 id');
				const customVoice = settings.ttsOnlineVoice || 'alloy';
				makeVoiceRow(providerVoices, {
					title: '使用自定义接口',
					sub: customVoice,
					active:
						settings.ttsEngine === 'online' &&
						settings.ttsOnlineProvider === 'custom',
					onClick: () => pick('custom', customVoice),
				});
				continue;
			}
			for (const voice of preset.voices) {
				makeVoiceRow(providerVoices, {
					title: voice.label,
					sub: voice.note ?? voice.id,
					active:
						settings.ttsEngine === 'online' &&
						settings.ttsOnlineProvider === preset.id &&
						settings.ttsOnlineVoice === voice.id,
					onClick: () => pick(preset.id, voice.id),
				});
			}
			// 当前音色不在预置列表（旧配置 / 自定义 id）：补一行，保证可见
			if (
				settings.ttsOnlineProvider === preset.id &&
				settings.ttsOnlineVoice &&
				!preset.voices.some((v) => v.id === settings.ttsOnlineVoice)
			) {
				makeVoiceRow(providerVoices, {
					title: settings.ttsOnlineVoice,
					sub: '当前音色',
					active: settings.ttsEngine === 'online',
					onClick: () => pick(preset.id, settings.ttsOnlineVoice),
				});
			}
		}
	};

	const setPanel = (open: boolean) => {
		panelOpen = open;
		trigger.setAttr('aria-expanded', String(open));
		trigger.toggleClass('is-open', open);
		sheetEl?.toggleClass('is-tts-expanded', open);
		if (open && !expandedProvider) {
			if (settings.ttsEngine === 'online' && isCloudProvider(settings.ttsOnlineProvider)) {
				expandedProvider = settings.ttsOnlineProvider;
			}
		}
		renderPanel();
	};
	trigger.addEventListener('click', () => setPanel(!panelOpen));

	// ── 状态同步 ──
	const sync = (s: TTSState) => {
		const idle = !s.active;
		sentence.setText(s.sentence || (idle ? '点下方播放键，从本章开始朗读' : '…'));
		sentence.toggleClass('is-idle', idle || !s.sentence);
		count.setText(s.total ? `${s.index + 1} / ${s.total} 句` : '—');
		slider.setAttr('max', String(Math.max(0, s.total - 1)));
		slider.setAttr('value', String(s.index));
		slider.disabled = s.total <= 1;
		playIcon.empty();
		setIcon(playIcon, s.active && !s.paused ? 'pause' : 'play');
		playBtn.toggleClass('is-playing', s.active && !s.paused);
		playBtn.toggleClass('is-loading', s.active && !s.paused && !s.speaking);
		if (!rateDragging) {
			rateSlider.value = String(s.rate);
			rateValue.setText(formatTtsRate(s.rate));
		}

		renderTrigger();
		const key = `${s.engine}:${currentSelectionKey(settings)}:${tts.listVoices().length}:${
			tts.onlineReady() ? 1 : 0
		}`;
		if (key !== lastVoiceKey) {
			lastVoiceKey = key;
			renderPanel();
		}
	};
	const unsub = tts.onStateChange(sync);
	renderTrigger();
	sync(tts.getState());
	return unsub;
}

/** 桌面端听书播放器：居中 Modal，关闭仅收起面板、朗读继续 */
export class TTSPlayerModal extends Modal {
	private cleanup: (() => void) | null = null;

	constructor(app: App, private view: EpubReaderView) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('听书');
		this.modalEl.addClass('fleur-epub-tts-modal');
		this.cleanup = buildTTSPlayer(this.contentEl, this.view);
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
		this.cleanup?.();
		this.cleanup = null;
		this.contentEl.empty();
	}
}
