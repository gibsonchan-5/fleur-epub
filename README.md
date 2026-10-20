# FleurEPUB

An EPUB reader plugin for Obsidian, built on [foliate-js](https://github.com/johnfactotum/foliate-js) — the FleurPDF experience for e-books.

Obsidian 的 EPUB 阅读插件，基于 foliate-js 渲染，延续 FleurPDF 的阅读与批注体验。

## Highlights

### 1. Fully adjustable reading experience · 阅读体验全面可调

- **Layout** — scrolled or paginated flow, single/double column, tap zones and wheel paging
- **Typography** — font size / family (presets + local fonts), line & paragraph spacing, page margin
- **Themes** — Light / Dark / Sepia / Green paper, applied to both the book and the interface
- **Reader essentials kept** — bookshelf with reading progress, table of contents, full-text search

排版可选滚动 / 翻页、单双栏；字号、字体（含本机字体）、行距段距、页边距均可调；浅色 / 深色 / 暖黄 / 豆绿四种背景主题；同时保留书架、目录、全文检索等阅读器基础能力。

### 2. Annotations that can ask AI · 批注可直接问 AI

- Highlights in **6 colors**, plus straight and squiggly underlines, with inline comment cards
- Select any passage and ask the AI to **explain, translate, or comment** on it
- Every annotation is CFI-anchored — precisely located across sessions, listed in the sidebar, and searchable

六种高亮颜色 + 直线 / 波浪划线 + 行内评论卡；选中文字即可让 AI 解释、翻译或点评；所有批注基于 CFI 精准定位，重开书不漂移，侧边栏统一管理与检索。

### 3. Built-in paragraph translation · 内置段落对照翻译

- Toggle once, and translations are embedded right under the original paragraphs — WeChat-Reading style
- **Foreign languages → modern Chinese** (auto-detected: English, Japanese, Korean, French, German...)
- **Classical Chinese → vernacular Chinese** (文言文自动译为白话文)
- Viewport-first scheduling: the page you are reading is translated first, the rest of the chapter follows in the background
- Cached per book, so re-reading costs nothing

一键开启对照翻译，译文直接嵌入原文段落下方（微信读书式）；自动识别语言——外语译为中文、文言文译为白话文；优先翻译当前阅读页，其余后台推进；译文按书缓存，重复阅读零消耗。

### 4. Dictionary lookup & vocabulary · 词典查词与生词本

- Select a word to look it up in a popup dictionary — Youdao (English–Chinese) or Free Dictionary API
- **WordWise** — Kindle-style inline hints drawn above vocabulary words while you read (toggle in the reader toolbar)
- Vocabulary notebook with built-in management (search / edit / delete / CSV export)
- Optional sync with [FleurDict](https://github.com/gibsonchan-5/fleurdict); without it, a standalone notebook is used and everything still works
- **Standalone notebook cross-device sync** — optionally stored inside the vault (`FleurEpub/data/wordbook.json`), merged across devices with tombstone-based deletion; data stays in your vault and only travels with your own sync service

选中单词即弹出查词卡（有道英汉词典或 Free Dictionary）；开启 WordWise 后，正文中的生词上方会直接绘制简要注释（Kindle 式，顶栏「注」开关）；生词本支持搜索、编辑、删除与 CSV 导出，也可选择与 FleurDict 同步——未安装 FleurDict 时使用独立生词本，功能不缺席。独立生词本还可选择跨设备同步：词条合并存入 Vault 内文件（删除走墓碑不会复活），数据只随你自己的同步服务流转。

### 5. Read aloud, on desktop and mobile · 桌面与移动端听书

- Sentence-by-sentence playback with the current sentence highlighted, progress scrubbing and a 0.5x–2.5x speed slider
- **System and cloud voices in one picker** — free offline system voices, or cloud voices from OpenAI, SiliconFlow, Doubao (Volcengine standard / AgentPlan) and Qwen
- Desktop opens a centered player; mobile opens a touch-sized bottom sheet. Closing the player keeps reading aloud
- Android WebView has no system speech engine, so the plugin automatically falls back to a configured cloud voice

逐句朗读并高亮当前句，可拖动进度、0.5x–2.5x 调速；系统声音免费离线，云端声音支持 OpenAI、硅基流动、豆包（火山引擎标准 / AgentPlan）与千问；桌面端为居中播放器，移动端为底部面板，关闭后朗读继续；安卓 WebView 无系统语音时自动回落到在线声音。

> **Privacy note · 隐私说明** — FleurEPUB has no telemetry and no analytics. Network access happens only when you use a feature that needs it:
>
> - Dictionary lookup sends only the selected word to Youdao or dictionaryapi.dev.
> - Paragraph translation sends the paragraph text to Microsoft's public translation endpoint.
> - AI annotations and chat send the selected text and your prompt to the AI endpoint you configure.
> - Cloud read-aloud sends the sentence being read to the TTS provider you select. System voices are handled by your operating system, not by the configured TTS provider.
> - Font downloads fetch the chosen font file from that font's listed source.
>
> API keys are stored in the system keychain by default (Obsidian 1.11.4+). If you choose the `data.json` option, keys are stored in clear text and travel with your vault. Books, annotations and reading data stay in your vault. 无遥测上报；只有你主动使用对应功能时才会发起上述请求。密钥默认存入系统钥匙串；选择 `data.json` 时则为明文并随 vault 同步。

## Other features · 其他能力

- AI assistant via OpenAI-compatible providers (DeepSeek, GLM, Kimi, Qwen, Doubao, MiniMax...)
- Export annotations to Markdown notes
- Progress memory — reopen a book exactly where you left off
- **Fullscreen** — on desktop the toolbar hides host chrome and reveals itself when the pointer reaches the top edge; on mobile it switches to an immersive layout. The same button exits
- **Desktop footnote popup** — optional (off by default): tapping a footnote marker opens a WeChat-Reading-style card with the note text instead of jumping to the note's location; mobile always uses the popup. When enabled, the card appears only for links recognized as footnotes — every other in-book link keeps navigating as before
- **Classic-book compatibility** — some Chinese classics (duokan-style EPUBs) render footnote markers, rare characters and inline formulas as small images sized by the book's own CSS (e.g. `height: 1em`). Since Obsidian's CSP blocks the book's blob-URL stylesheets, FleurEPUB recovers only those image-sizing rules (selectors that exclusively match `img`/`svg`/`video`/`embed`/`object` and declare width/height/vertical-align) and re-injects them inline, so icons render at their intended one-em size. Your typography settings (font, size, line-height) always take precedence; no text styles from the book are restored, and every step fails silently back to the previous behavior.

支持 OpenAI 兼容接口（DeepSeek、智谱、Kimi、通义、豆包、MiniMax 等）；批注可导出为 Markdown 笔记；阅读进度记忆，重开即续读；全屏按钮在桌面端隐藏宿主界面、移动端进入沉浸阅读，再点一次退出。

**古籍兼容性**：部分中文古籍（duokan 工艺 EPUB）的注码、生僻字、行内公式是靠书内 CSS 钉尺寸的行内小图（如 `height: 1em`）。由于 Obsidian 的 CSP 会拦截书内的 blob 样式表，FleurEPUB 只恢复其中「图片尺寸类」规则（选择器仅命中 img/svg/video/embed/object 且声明了宽高或垂直对齐），将其内联注入，使图标回到一个字的大小。你的排版设置（字体、字号、行距）始终优先，书内文字样式一概不恢复，任何一步失败都会静默退回原有表现。

**桌面端脚注弹卡**：可选开关（默认关闭）。开启后点击书内注码 /「注」图标会弹出微信读书式的注解内容卡，而非跳转到注解所在位置；移动端始终弹卡。开启后也只对识别为脚注的链接弹卡，其余书内链接保持原跳转行为。

## Install

Download `main.js`, `manifest.json`, `styles.css` from the latest release into `<vault>/.obsidian/plugins/fleur-epub/`, then enable it in Obsidian.

从最新 Release 下载 `main.js`、`manifest.json`、`styles.css` 放入 `<vault>/.obsidian/plugins/fleur-epub/`，在 Obsidian 中启用即可。

## License

MIT
