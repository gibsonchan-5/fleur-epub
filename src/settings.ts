import { App, PluginSettingTab, Setting, DropdownComponent, requestUrl } from 'obsidian';
import type FleurEpubPlugin from './main';
import { PROMPT_PRESETS, getPromptPreset, getPresetPreview, isCustomPresetKey, ANNOTATION_DEFAULT_BASE_LIMIT, type PromptPresetKey } from './ai-prompts';

/** 阅读背景主题：浅色 / 深色 / 暖黄 / 豆绿（微信读书式四色） */
export type ReaderTheme = 'light' | 'dark' | 'sepia' | 'green';

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
	/** 正文字体（CSS font-family 栈；'' = 默认宋体栈） */
	fontFamily: string;
	/** 正文字重：300 细 / 400 常规（默认）/ 500 中等 / 700 粗 */
	fontWeight: number;
	// ── AI（对齐 fleur-pdf 字段命名，便于同源配置） ──
	/** AI 提供商（deepseek / zhipu / moonshot / qwen / doubao / minimax / openai / custom） */
	aiProvider: string;
	apiKey: string;
	baseUrl: string;
	model: string;
	temperature: number;
	promptPreset: PromptPresetKey;
	/** 三个自定义提示词槽（对应 promptPreset 的 custom-1/2/3） */
	customPrompts: string[];
	/** 侧边栏批注场景的基准字数上限 */
	annotationLimit: number;
	/** AI 浮窗位置记忆 */
	aiPanelPos?: { left: number; top: number };
	/** 批注卡片位置记忆（用户拖拽后固定；undefined = 默认出现在标注文本旁） */
	annPopPos?: { left: number; top: number };
	/** 批注卡片尺寸记忆（用户缩放后固定） */
	annPopSize?: { w: number; h: number };
	/** 批注笔记导出文件夹（vault 内相对路径；'' = 根目录，默认 FleurEpub） */
	noteFolder: string;
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
	fontFamily: '',
	fontWeight: 400,
	aiProvider: 'deepseek',
	apiKey: '',
	baseUrl: 'https://api.deepseek.com/v1',
	model: 'deepseek-chat',
	temperature: 0.7,
	promptPreset: 'default',
	customPrompts: ['', '', ''],
	annotationLimit: 250,
	noteFolder: 'FleurEpub',
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

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('仅保存在本地，不会上传')
			.addText((text) =>
				text
					.setPlaceholder('sk-…')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (v) => {
						this.plugin.settings.apiKey = v.trim();
						await this.plugin.saveSettings();
					}),
			);

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
	}
}
