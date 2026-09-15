import { App, PluginSettingTab, Setting, DropdownComponent, Notice, requestUrl } from 'obsidian';
import type FleurEpubPlugin from './main';
import { PROMPT_PRESETS, getPromptPreset, getPresetPreview, isCustomPresetKey, ANNOTATION_DEFAULT_BASE_LIMIT, type PromptPresetKey } from './ai-prompts';
import { applyMobileBodyClass } from './platform';

/** 阅读背景主题：浅色 / 深色 / 暖黄 / 豆绿（微信读书式四色） */
export type ReaderTheme = 'light' | 'dark' | 'sepia' | 'green';

/** 对照翻译引擎：AI（大模型，支持文言→白话）/ 微软机翻（免密钥、快、零 token） */
export type TranslationEngineKind = 'ai' | 'microsoft';

/** 侧边栏批注排序：document = 行文顺序（按 CFI 在正文中的位置）/ time = 批注创建时间 */
export type AnnotationSortKind = 'document' | 'time';

export interface FleurEpubSettings {
	fontSize: number;
	flow: 'scrolled' | 'paginated';
	/** 翻页模式分栏数：1 = 单栏（默认），2 = 双栏 */
	columns: 1 | 2;
	// ── 阅读外观（顶栏 Aa 面板，微信读书式） ──
	/** 背景主题 */
	theme: ReaderTheme;
	/** 页边距（px，foliate renderer margin 属性，滚动/翻页通用） */
	pageMargin: number;
	/** 左边距（px，在对称页边距基础上的额外偏移；与右边距独立） */
	marginLeft: number;
	/** 右边距（px，在对称页边距基础上的额外偏移；与左边距独立） */
	marginRight: number;
	/** 行距（行高倍数） */
	lineHeight: number;
	/** 段间距（em） */
	paraSpacing: number;
	/** 首行排版：true = 首行缩进两字（默认）/ false = 首行顶格（不缩进） */
	paraIndent: boolean;
	/** 正文字体（CSS font-family 栈；'' = 跟随 Obsidian 全局文本字体） */
	fontFamily: string;
	/** 正文字重：300 细 / 400 常规（默认）/ 500 中等 / 700 粗 */
	fontWeight: number;
	// ── AI（对齐 fleur-pdf 字段命名，便于同源配置） ──
	/** 对照翻译引擎（ai = 走下方 AI 配置；microsoft = 微软机翻，免密钥） */
	translationEngine: TranslationEngineKind;
	/** AI 提供商（deepseek / zhipu / moonshot / qwen / doubao / minimax / openai / custom） */
	aiProvider: string;
	apiKey: string;
	/** 密钥保存位置：system=系统钥匙串（默认），vault=data.json 明文随 vault 同步。 */
	secretStorageMode: 'system' | 'vault';
	baseUrl: string;
	model: string;
	temperature: number;
	promptPreset: PromptPresetKey;
	/** 三个自定义提示词槽（对应 promptPreset 的 custom-1/2/3） */
	customPrompts: string[];
	/** 侧边栏批注场景的基准字数上限 */
	annotationLimit: number;
	/** 侧边栏批注组内排序：document = 行文顺序 / time = 批注时间（默认） */
	annotationSort: AnnotationSortKind;
	/** AI 浮窗位置记忆 */
	aiPanelPos?: { left: number; top: number };
	/** 批注编辑弹窗宽度记忆（h 已废弃：高度改为随内容自适应，按钮行永远可见） */
	annPopSize?: { w: number; h: number };
	/** 批注笔记导出文件夹（vault 内相对路径；'' = 根目录，默认 FleurEpub） */
	noteFolder: string;
	/** 移动端调试：桌面端强制启用移动端布局（预览/开发用途，默认关） */
	mobileDebug: boolean;
	/** 听书声源：系统 TTS voiceURI（'' = 跟随章节语言自动选系统默认） */
	ttsVoiceURI: string;
	/** 听书语速（播放器可调，持久化） */
	ttsRate: number;
}

export const DEFAULT_SETTINGS: FleurEpubSettings = {
	fontSize: 16,
	flow: 'scrolled',
	columns: 1,
	theme: 'light',
	pageMargin: 36,
	marginLeft: 0,
	marginRight: 0,
	lineHeight: 1.9,
	paraSpacing: 0.85,
	paraIndent: true,
	fontFamily: '',
	fontWeight: 400,
	translationEngine: 'microsoft',
	aiProvider: 'deepseek',
	apiKey: '',
	secretStorageMode: 'system',
	baseUrl: 'https://api.deepseek.com/v1',
	model: 'deepseek-chat',
	temperature: 0.7,
	promptPreset: 'default',
	customPrompts: ['', '', ''],
	annotationLimit: 250,
	annotationSort: 'time',
	noteFolder: 'FleurEpub',
	mobileDebug: false,
	ttsVoiceURI: '',
	ttsRate: 1,
};

export class FleurEpubSettingTab extends PluginSettingTab {
	plugin: FleurEpubPlugin;

	constructor(app: App, plugin: FleurEpubPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('正文字号（px）')
			.setDesc('重新打开书籍后生效')
			.addText((text) =>
				text
					.setPlaceholder('16')
					.setValue(String(this.plugin.settings.fontSize))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!Number.isNaN(n) && n >= 10 && n <= 40) {
							this.plugin.settings.fontSize = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName('默认阅读模式')
			.setDesc('滚动 = 连续流式；翻页 = 电子书分页（阅读页顶栏可随时切换）')
			.addDropdown((drop) =>
				drop
					.addOption('scrolled', '滚动')
					.addOption('paginated', '翻页')
					.setValue(this.plugin.settings.flow)
					.onChange(async (v) => {
						this.plugin.settings.flow = v === 'paginated' ? 'paginated' : 'scrolled';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('翻页分栏')
			.setDesc('翻页模式下每页显示单栏或双栏（对已打开的书即时生效；滚动模式不适用）')
			.addDropdown((drop) =>
				drop
					.addOption('1', '单栏')
					.addOption('2', '双栏')
					.setValue(String(this.plugin.settings.columns))
					.onChange(async (v) => {
						this.plugin.settings.columns = v === '2' ? 2 : 1;
						await this.plugin.saveSettings();
						this.plugin.getActiveReader()?.applyColumnLayout();
					}),
			);

		new Setting(containerEl)
			.setName('背景主题')
			.setDesc('阅读背景与配套文字配色（阅读页顶栏「Aa」面板可随时调整字号/行距/段距/页边距/字体）')
			.addDropdown((drop) =>
				drop
					.addOption('light', '浅色')
					.addOption('dark', '深色')
					.addOption('sepia', '暖黄')
					.addOption('green', '豆绿')
					.setValue(this.plugin.settings.theme)
					.onChange(async (v) => {
						this.plugin.settings.theme = v as typeof this.plugin.settings.theme;
						await this.plugin.saveSettings();
						this.plugin.getActiveReader()?.applyReaderStyles();
					}),
			);

		// ── 批注（侧边栏排序等） ──
		new Setting(containerEl).setName('批注').setHeading();

		new Setting(containerEl)
			.setName('侧边栏批注排序')
			.setDesc('同一章节内批注的排列方式：行文顺序 = 按标注在正文中的先后位置排列，适合通读回顾；批注时间 = 按创建先后排列（默认）')
			.addDropdown((drop) =>
				drop
					.addOption('time', '按批注时间（创建先后）')
					.addOption('document', '按行文顺序（上下文先后）')
					.setValue(this.plugin.settings.annotationSort ?? 'time')
					.onChange(async (v) => {
						this.plugin.settings.annotationSort = v === 'document' ? 'document' : 'time';
						await this.plugin.saveSettings();
						// 立即刷新已打开的侧边栏批注 tab
						this.plugin.refreshShelf();
					}),
			);

		// ── 笔记导出（对齐 fleur-pdf：扫描 vault 文件夹下拉选择，导出时自动建目录） ──
		new Setting(containerEl).setName('笔记导出').setHeading();

		// 扫描 vault 中的所有文件夹供选择（fleur-pdf 同款实现）
		const folderSet = new Set<string>();
		folderSet.add(''); // 根目录选项
		this.app.vault.getAllLoadedFiles().forEach((file) => {
			if (file.path.includes('/')) {
				const parts = file.path.split('/');
				let current = '';
				for (let i = 0; i < parts.length - 1; i++) {
					current = current ? `${current}/${parts[i]}` : parts[i];
					folderSet.add(current);
				}
			}
		});

		new Setting(containerEl)
			.setName('导出文件夹')
			.setDesc('批注笔记的存放位置（默认 FleurEpub，导出时自动创建）')
			.addDropdown((drop) => {
				drop.addOption('', 'Vault 根目录');
				// 当前设置值（如默认 FleurEpub）尚未创建时也要出现在选项里，避免回显错位
				const current = this.plugin.settings.noteFolder ?? '';
				if (current && !folderSet.has(current)) folderSet.add(current);
				for (const folder of Array.from(folderSet).sort()) {
					if (folder) drop.addOption(folder, folder);
				}
				drop.setValue(current).onChange(async (value) => {
					this.plugin.settings.noteFolder = value;
					await this.plugin.saveSettings();
				});
			});

		// ── 对照翻译（引擎选择；微软机翻免密钥，AI 走下方 AI 配置） ──
		new Setting(containerEl).setName('对照翻译').setHeading();

		new Setting(containerEl)
			.setName('翻译引擎')
			.setDesc('微软机翻：免密钥、速度快、不消耗 AI 额度，但不支持文言文→白话（文言段落会保持原样）；AI 翻译：质量更高且支持文言文，需在下方配置 API Key')
			.addDropdown((drop) =>
				drop
					.addOption('ai', 'AI 翻译（支持文言文）')
					.addOption('microsoft', '微软机翻（免费快速）')
					.setValue(this.plugin.settings.translationEngine ?? 'ai')
					.onChange(async (v) => {
						this.plugin.settings.translationEngine = v === 'microsoft' ? 'microsoft' : 'ai';
						await this.plugin.saveSettings();
					}),
			);

		// ── AI 配置（与 fleur-pdf 对齐：多提供商 + 提示词详情预览 + 测试连接） ──
		new Setting(containerEl).setName('AI 配置').setHeading();

		// 预置提供商：默认 DeepSeek，覆盖国内主流大模型 + OpenAI 通用兜底
		const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
			deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
			zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
			moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
			qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
			doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
			minimax: { baseUrl: 'https://api.minimax.chat/v1', model: 'abab6.5s-chat' },
			openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
		};

		new Setting(containerEl)
			.setName('AI 提供商')
			.setDesc('选择 AI 服务提供商（均为 OpenAI 兼容接口；切换后自动填入该家的 Base URL 与默认模型）')
			.addDropdown((drop) =>
				drop
					.addOption('deepseek', 'DeepSeek（默认）')
					.addOption('zhipu', '智谱 AI · GLM')
					.addOption('moonshot', '月之暗面 · Kimi')
					.addOption('qwen', '阿里 · 通义千问')
					.addOption('doubao', '字节 · 豆包（火山方舟）')
					.addOption('minimax', 'MiniMax')
					.addOption('openai', 'OpenAI / 其他兼容接口')
					.setValue(this.plugin.settings.aiProvider)
					.onChange(async (value) => {
						this.plugin.settings.aiProvider = value;
						const defaults = PROVIDER_DEFAULTS[value];
						if (defaults) {
							this.plugin.settings.baseUrl = defaults.baseUrl;
							this.plugin.settings.model = defaults.model;
						}
						await this.plugin.saveSettings();
						this.display(); // 重渲染以同步 Base URL 与模型显示
					}),
			);

		// 密钥存储位置
		const secretSection = containerEl.createDiv('fleurepub-settings-section');
		new Setting(secretSection).setHeading().setName('密钥存储');

		secretSection.createEl('p', {
			text: '决定 API Key 保存在哪里。切换后密钥会自动搬到新位置，不会丢失，也不需要重新填写。',
			cls: 'setting-item-description',
		});

		new Setting(secretSection)
			.setName('密钥保存位置')
			.setDesc(
				this.plugin.secretStorageAvailable
					? '系统钥匙串更安全，但密钥不进 vault，因此每台设备都要各自填写一次；data.json 可随 vault 同步给多台设备共用，代价是密钥以明文保存在仓库中。'
					: '当前 Obsidian 版本不支持系统钥匙串，密钥只能明文保存在 data.json。',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('system', '系统钥匙串（推荐）');
				dropdown.addOption('vault', 'data.json（随 vault 同步）');
				dropdown.setValue(this.plugin.secretBackend);
				if (!this.plugin.secretStorageAvailable) {
					dropdown.setDisabled(true);
				}
				dropdown.onChange(async (value) => {
					const mode = value === 'vault' ? 'vault' : 'system';
					const result = await this.plugin.setSecretStorageMode(mode);
					if (!result.ok) {
						new Notice('FleurEPUB：密钥移入系统钥匙串失败，已保持原设置');
					} else if (mode === 'vault') {
						new Notice('FleurEPUB：密钥将以明文保存在 data.json，并随 vault 同步');
					} else {
						new Notice('FleurEPUB：密钥已移入系统钥匙串，data.json 中不再保存明文');
					}
					// 重新渲染，让密钥说明与警告同步更新
					this.display();
				});
			});

		if (this.plugin.secretStorageAvailable && this.plugin.secretBackend === 'vault') {
			secretSection.createEl('p', {
				text: '注意：当前为明文存储。密钥会随 Obsidian Sync / iCloud / OneDrive 上传到云端，请确认你接受这一点。',
				cls: 'setting-item-description mod-warning',
			});
		}

		new Setting(containerEl)
			.setName('API Key')
			.setDesc(this.secretDesc())
			.addText((text) => {
				text
					.setPlaceholder('sk-…')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (v) => {
						this.plugin.settings.apiKey = v.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
			});

		new Setting(containerEl)
			.setName('Base URL')
			.setDesc('OpenAI 兼容接口地址（豆包填推理接入点对应的地址）')
			.addText((text) =>
				text
					.setPlaceholder('https://api.deepseek.com/v1')
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (v) => {
						this.plugin.settings.baseUrl = v.trim().replace(/\/+$/, '');
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('模型')
			.setDesc('使用的 AI 模型（豆包填推理接入点 ID）')
			.addText((text) =>
				text
					.setPlaceholder('deepseek-chat')
					.setValue(this.plugin.settings.model)
					.onChange(async (v) => {
						this.plugin.settings.model = v.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('AI 温度')
			.setDesc('控制输出的随机性。值越高（如 1.0）越多样，值越低（如 0.1）越保守')
			.addSlider((slider) =>
				slider
					.setLimits(0, 1, 0.1)
					.setValue(this.plugin.settings.temperature)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.temperature = v;
						await this.plugin.saveSettings();
					}),
			);

		// 提示词模式（预设选项卡 + 详情区展示完整提示词）
		// 切换模式时只重绘下方详情区，不重建整个面板（避免设置窗口自行滚动）
		let dropdownComp: DropdownComponent | null = null;

		new Setting(containerEl)
			.setName('提示词模式')
			.setDesc('选择 AI 生成批注时的角色定位，下方展示完整提示词，可随时切换')
			.addDropdown((drop) => {
				dropdownComp = drop;
				for (const p of PROMPT_PRESETS) drop.addOption(p.key, p.label);
				drop
					.setValue(this.plugin.settings.promptPreset)
					.onChange(async (value) => {
						this.plugin.settings.promptPreset = value as PromptPresetKey;
						await this.plugin.saveSettings();
						renderPromptDetail();
					});
			});

		const promptDetailEl = containerEl.createDiv('fleur-epub-setting-prompt-detail');

		const renderPromptDetail = () => {
			promptDetailEl.empty();
			const preset = getPromptPreset(this.plugin.settings.promptPreset) ?? PROMPT_PRESETS[0];
			const baseLimit = this.plugin.settings.annotationLimit || ANNOTATION_DEFAULT_BASE_LIMIT;

			if (isCustomPresetKey(this.plugin.settings.promptPreset)) {
				// 三个自定义槽位（对齐 FleurAnnotation）：当前选中的槽位加高亮提示
				const activeSlot = this.plugin.settings.promptPreset === 'custom-1' ? 1
					: this.plugin.settings.promptPreset === 'custom-2' ? 2 : 3;
				for (let i = 1; i <= 3; i++) {
					new Setting(promptDetailEl)
						.setName(`自定义提示词 ${i}${i === activeSlot ? '（当前使用）' : ''}`)
						.setDesc(i === 1 ? '留空则回落到「默认」模式' : '')
						.setClass('fleur-epub-setting-block')
						.addTextArea((ta) => {
							ta.setPlaceholder('在此写下你自己的系统提示词。例如：你是一位……请根据用户选中的文本……')
								.setValue(this.plugin.settings.customPrompts[i - 1] ?? '')
								.onChange(async (value) => {
									this.plugin.settings.customPrompts[i - 1] = value;
									await this.plugin.saveSettings();
								});
							ta.inputEl.setCssStyles({ width: '100%', minHeight: i === activeSlot ? '170px' : '90px' });
						});
				}
			} else {
				const previewSetting = new Setting(promptDetailEl)
					.setName('当前提示词（完整内容）')
					.setDesc(`仅侧边栏批注受 ${baseLimit} 字限制（原文过长自动放宽），正文「询问 AI」不限。`);

				const previewWrap = previewSetting.controlEl.createDiv('fleur-epub-setting-prompt-block');
				const preview = previewWrap.createDiv('fleur-epub-setting-prompt-preview');
				preview.textContent = getPresetPreview(preset, baseLimit);

				previewSetting.addExtraButton((btn) =>
					btn
						.setIcon('pencil')
						.setTooltip('以此为基础改为自定义 1')
						.onClick(async () => {
							this.plugin.settings.promptPreset = 'custom-1';
							this.plugin.settings.customPrompts[0] = preset.body;
							await this.plugin.saveSettings();
							dropdownComp?.setValue('custom-1');
							renderPromptDetail();
						}),
				);
			}
		};

		renderPromptDetail();

		// 侧边栏 AI 批注字数上限（正文「询问 AI」不受此限制）
		new Setting(containerEl)
			.setName('批注字数上限')
			.setDesc('侧边栏「AI 生成批注」的输出基准字数。选中原文较长时上限会自动放宽；正文「询问 AI」不设字数限制')
			.addSlider((slider) =>
				slider
					.setLimits(100, 600, 10)
					.setValue(this.plugin.settings.annotationLimit || ANNOTATION_DEFAULT_BASE_LIMIT)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.settings.annotationLimit = v;
						await this.plugin.saveSettings();
						renderPromptDetail();
					}),
			);

		// 测试连接
		const testSetting = new Setting(containerEl);
		testSetting.setName('测试连接');
		testSetting.setDesc('验证 API 配置是否正确');
		testSetting.addButton((btn) => {
			btn.setButtonText('测试').onClick(async () => {
				btn.setButtonText('测试中...');
				btn.setDisabled(true);
				try {
					const { baseUrl, apiKey, model } = this.plugin.settings;
					const response = await requestUrl({
						url: `${baseUrl}/chat/completions`,
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${apiKey}`,
						},
						body: JSON.stringify({
							model,
							messages: [{ role: 'user', content: 'hi' }],
							max_tokens: 5,
						}),
					});
					if (response.status >= 200 && response.status < 300) {
						btn.setButtonText('✓ 连接成功');
						btn.buttonEl.addClass('fleur-epub-setting-test-success');
					} else {
						btn.setButtonText(`✗ 失败 (${response.status})`);
						btn.buttonEl.addClass('fleur-epub-setting-test-error');
					}
				} catch (_e) {
					btn.setButtonText('✗ 网络错误');
					btn.buttonEl.addClass('fleur-epub-setting-test-error');
				}
				window.setTimeout(() => {
					btn.setButtonText('测试');
					btn.setDisabled(false);
					btn.buttonEl.removeClass('fleur-epub-setting-test-success', 'fleur-epub-setting-test-error');
				}, 3000);
			});
		});
		// ── 高级（移动端调试等开发向开关） ──
		new Setting(containerEl).setName('高级').setHeading();

		new Setting(containerEl)
			.setName('移动端调试模式')
			.setDesc('在桌面端强制启用移动端布局（顶栏紧凑化、底部安全区等），用于预览与开发。关闭后桌面端完全恢复原状，不影响任何桌面功能。')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.mobileDebug).onChange(async (v) => {
					this.plugin.settings.mobileDebug = v;
					await this.plugin.saveSettings();
					applyMobileBodyClass(this.plugin);
				}),
			);
	}

	/**
	 * 描述密钥当前保存在哪里，措辞与「密钥保存位置」设置保持一致。
	 */
	private secretDesc(): string {
		if (!this.plugin.secretStorageAvailable) {
			return 'API Key。当前 Obsidian 版本不支持系统钥匙串，将以明文保存在 data.json。';
		}
		return this.plugin.secretBackend === 'system'
			? 'API Key。已保存在系统钥匙串，不会写入 data.json，也不会随 vault 同步。'
			: 'API Key。当前以明文保存在 data.json，会随 vault 同步到其他设备。';
	}
}
