// 移动端顶栏「听」：Web Speech API（speechSynthesis）句级朗读 + 微信读书式播放器。
// 选型：零依赖、免费、离线，iOS/Android WebView 与桌面 Electron 均内置。
// 暂停语义：句级暂停（cancel + 续播时从当前句头重读）——speechSynthesis.pause
// 在移动端 WebView 兼容性差，句级重读是跨端最稳的等价体验。
// 跟读高亮：每句 onstart 在原文加灰底高亮；停止/翻页/翻章自动清除。

import { Notice } from 'obsidian';
import type { EpubReaderView } from './reader-view';

export type TTSItem = { el: HTMLElement; text: string };

export type TTSState = {
	/** 已加载章节并处于播放/暂停会话中 */
	active: boolean;
	/** 正在出声（active 且未暂停） */
	speaking: boolean;
	/** 暂停中（active 但未出声，进度与高亮保留） */
	paused: boolean;
	index: number;
	total: number;
	rate: number;
	/** 当前句文本（播放器展示用） */
	sentence: string;
};

/** 预设语速（微信读书式 0.75x–2.0x） */
export const TTS_RATES = [0.75, 1, 1.25, 1.5, 2];

export class ReaderTTS {
	private view: EpubReaderView;
	private items: TTSItem[] = [];
	private index = 0;
	private lang = '';
	private rate: number;
	private active = false;
	private speaking = false;
	private paused = false;
	/** 会话代数：pause/stop/seek 后使旧 utterance 的回调失效 */
	private gen = 0;
	private listeners = new Set<(s: TTSState) => void>();
	/** 系统声源列表（voiceschanged 异步到达，到达后广播） */
	private voices: SpeechSynthesisVoice[] = [];
	private onVoicesChangedHandler: (() => void) | null = null;

	constructor(view: EpubReaderView) {
		this.view = view;
		this.rate = view.plugin.settings.ttsRate ?? 1;
		this.refreshVoices();
		// 声源列表异步加载（Chrome/WebView 首次 getVoices 常返回空），到达后补一次广播
		try {
			this.onVoicesChangedHandler = () => {
				this.voices = window.speechSynthesis?.getVoices?.() ?? [];
				this.emit();
			};
			window.speechSynthesis?.addEventListener?.('voiceschanged', this.onVoicesChangedHandler);
		} catch {
			/* 老引擎无 addEventListener 时静默降级 */
		}
	}

	/** 当前环境是否支持 Web Speech API */
	static supported(): boolean {
		return typeof window !== 'undefined' && 'speechSynthesis' in window;
	}

	// ── 声源（合规来源：仅系统内置 TTS 语音，免费离线） ──

	private refreshVoices(): void {
		try {
			this.voices = window.speechSynthesis?.getVoices?.() ?? [];
		} catch {
			this.voices = [];
		}
	}

	/** 排除 macOS 经典 novelty/机械音（语言过滤已挡掉绝大多数长尾，这里兜住 en/zh 杂音） */
	private static readonly VOICE_EXCLUDE =
		/(bad news|good news|bahh|bells|boing|bubbles|cellos|deranged|hysterical|jester|organ|pipe|princess|superstar|trinoids|whisper|wobble|zarvox|albert|fred|kathy|junior|ralph|eddy|flo|jack|reed|rocko|sandy|shelley|grandma|grandpa|nicky)/i;

	/**
	 * 声源列表（精选）：仅中英文主流语音，章节语言匹配优先。
	 * 过滤规则：语言限定 zh、en → 排除 novelty、长尾语音 → 同名去重（Enhanced、Premium 等变体只留一个）→ 总量限 8。
	 */
	listVoices(chapterLang = ''): SpeechSynthesisVoice[] {
		const raw = [...this.voices];
		const base = (chapterLang || '').toLowerCase().replace('_', '-').split('-')[0];
		const isZhEn = (v: SpeechSynthesisVoice) => /^(zh|en)/i.test(v.lang.replace('_', '-'));
		const normName = (n: string) => n.replace(/\s*\([^)]*\)\s*/g, '').trim();
		const score = (v: SpeechSynthesisVoice): number => {
			const l = v.lang.toLowerCase().replace('_', '-');
			if (base && l === (chapterLang || '').toLowerCase().replace('_', '-')) return 0;
			if (base && l.startsWith(base)) return 1;
			if (l.startsWith('zh')) return 2;
			return 3;
		};
		const filtered = raw.filter(
			(v) => isZhEn(v) && !ReaderTTS.VOICE_EXCLUDE.test(v.name),
		);
		// 同名去重：变体（Enhanced/Premium/Compact）只保留系统排位最前的一个
		const seen = new Set<string>();
		const deduped = filtered.filter((v) => {
			const key = normName(v.name).toLowerCase();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		const picked = deduped.sort((a, b) => score(a) - score(b)).slice(0, 8);
		// 兜底：极简系统上过滤后为空则不筛选，保证功能可用
		return picked.length ? picked : raw;
	}

	/** 当前选中的声源（'' = 跟随系统默认） */
	getVoiceURI(): string {
		return this.view.plugin.settings.ttsVoiceURI;
	}

	/** 选择声源并持久化；朗读中即时生效（当前句头以新声源重读） */
	setVoice(uri: string): void {
		if (uri === this.view.plugin.settings.ttsVoiceURI) return;
		this.view.plugin.settings.ttsVoiceURI = uri;
		void this.view.plugin.saveSettings();
		if (this.active && !this.paused) this.speakCurrent();
		else this.emit();
	}

	/** 解析朗读用声源：用户选择优先（已卸载则回退系统默认） */
	private resolveVoice(): SpeechSynthesisVoice | null {
		const uri = this.view.plugin.settings.ttsVoiceURI;
		if (uri) return this.voices.find((v) => v.voiceURI === uri) ?? null;
		return null;
	}

	/** 按 URI 查声源（播放器兜底展示用，精选列表外也可找到） */
	findVoice(uri: string): SpeechSynthesisVoice | null {
		return this.voices.find((v) => v.voiceURI === uri) ?? null;
	}

	// ── 状态广播（播放器 UI 订阅） ──

	onStateChange(fn: (s: TTSState) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	getState(): TTSState {
		return {
			active: this.active,
			speaking: this.speaking,
			paused: this.paused,
			index: this.index,
			total: this.items.length,
			rate: this.rate,
			sentence: this.items[this.index]?.text ?? '',
		};
	}

	private emit(): void {
		const s = this.getState();
		for (const fn of this.listeners) {
			try {
				fn(s);
			} catch {
				/* 单个订阅者异常不影响其他 */
			}
		}
	}

	// ── 查询 ──

	isActive(): boolean {
		return this.active;
	}

	/** 是否正在出声（暂停中为 false） */
	isSpeaking(): boolean {
		return this.active && !this.paused;
	}

	// ── 播放控制 ──

	/** 空闲→开播；暂停→续播；播放中→暂停（播放器大按钮语义） */
	toggle(): void {
		if (!this.active) this.start();
		else if (this.paused) this.resume();
		else this.pause();
	}

	/** 从当前句开始朗读本章（章节句级切分由 reader-view 提供） */
	start(): void {
		if (this.active) return;
		if (!ReaderTTS.supported()) {
			new Notice('当前环境不支持语音朗读', 2200);
			return;
		}
		const chapter = this.view.getTTSChapter();
		if (!chapter || !chapter.items.length) {
			new Notice('本章节没有可朗读的内容', 1800);
			return;
		}
		this.lang = chapter.lang;
		this.items = chapter.items;
		this.index = 0;
		this.active = true;
		this.paused = false;
		this.emit();
		this.speakCurrent();
	}

	/** 句级暂停：停止出声但保留进度与高亮（微信读书「点句子暂停」语义） */
	pause(): void {
		if (!this.active || this.paused) return;
		this.paused = true;
		this.gen++;
		try {
			window.speechSynthesis?.cancel();
		} catch {
			/* 忽略 */
		}
		this.speaking = false;
		this.emit();
	}

	/** 续播：从当前句头重读（跨端最稳的暂停等价实现） */
	resume(): void {
		if (!this.active || !this.paused) return;
		this.paused = false;
		this.speakCurrent();
	}

	/** 停止并丢弃会话（翻页/翻章/关闭用） */
	stop(notice = false): void {
		const was = this.active;
		this.gen++;
		this.active = false;
		this.speaking = false;
		this.paused = false;
		this.items = [];
		this.index = 0;
		try {
			window.speechSynthesis?.cancel();
		} catch {
			/* 忽略 */
		}
		this.view.clearTTSHighlight();
		if (was && notice) new Notice('已停止朗读', 1200);
		this.emit();
	}

	/** 跳到第 i 句（拖进度条 / 上一句 / 下一句共用） */
	seek(i: number): void {
		if (!this.items.length) return;
		const next = Math.max(0, Math.min(this.items.length - 1, Math.round(i)));
		const changed = next !== this.index;
		this.index = next;
		if (!this.active) {
			this.active = true;
			this.paused = false;
			this.emit();
			this.speakCurrent();
			return;
		}
		if (changed || this.paused) {
			// 换句或暂停中跳转：取消当前、立即读目标句
			this.paused = false;
			this.speakCurrent();
		} else {
			this.emit();
		}
	}

	next(): void {
		if (!this.active) return;
		if (this.index >= this.items.length - 1) {
			this.stop();
			new Notice('本章节朗读完毕', 1800);
			return;
		}
		this.seek(this.index + 1);
	}

	prev(): void {
		if (!this.active) return;
		this.seek(Math.max(0, this.index - 1));
	}

	/** 设置语速：持久化；朗读中即时生效（从当前句头以新语速重读） */
	setRate(rate: number): void {
		if (!TTS_RATES.includes(rate) || rate === this.rate) return;
		this.rate = rate;
		this.view.plugin.settings.ttsRate = rate;
		void this.view.plugin.saveSettings();
		if (this.active && !this.paused) this.speakCurrent();
		else this.emit();
	}

	// ── 内部 ──

	private speakCurrent(): void {
		this.gen++;
		const myGen = this.gen;
		if (!this.active) return;
		if (this.index >= this.items.length) {
			// 本章读完
			this.stop();
			new Notice('本章节朗读完毕', 1800);
			return;
		}
		const item = this.items[this.index];
		this.cancelSpeech();
		const u = new SpeechSynthesisUtterance(item.text);
		if (this.lang) u.lang = this.lang;
		const voice = this.resolveVoice();
		if (voice) u.voice = voice;
		u.rate = this.rate;
		// 句子开读：原文同步高亮 + 通知播放器刷新
		u.onstart = () => {
			if (myGen !== this.gen) return;
			this.speaking = true;
			this.view.highlightTTSSentence(item.el, item.text);
			this.emit();
		};
		u.onend = () => {
			if (myGen !== this.gen) return;
			this.index++;
			this.speakCurrent();
		};
		u.onerror = () => {
			if (myGen !== this.gen) return;
			this.stop();
		};
		try {
			window.speechSynthesis.speak(u);
		} catch {
			this.stop();
			new Notice('朗读启动失败', 1800);
		}
	}

	private cancelSpeech(): void {
		try {
			window.speechSynthesis?.cancel();
		} catch {
			/* 忽略 */
		}
	}

	destroy(): void {
		this.stop();
		try {
			if (this.onVoicesChangedHandler) {
				window.speechSynthesis?.removeEventListener?.('voiceschanged', this.onVoicesChangedHandler);
				this.onVoicesChangedHandler = null;
			}
		} catch {
			/* 忽略 */
		}
	}
}
