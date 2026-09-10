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

## Other features · 其他能力

- AI assistant via OpenAI-compatible providers (DeepSeek, GLM, Kimi, Qwen, Doubao, MiniMax...)
- Export annotations to Markdown notes
- Progress memory — reopen a book exactly where you left off

支持 OpenAI 兼容接口（DeepSeek、智谱、Kimi、通义、豆包、MiniMax 等）；批注可导出为 Markdown 笔记；阅读进度记忆，重开即续读。

## Install

Download `main.js`, `manifest.json`, `styles.css` from the latest release into `<vault>/.obsidian/plugins/fleur-epub/`, then enable it in Obsidian.

从最新 Release 下载 `main.js`、`manifest.json`、`styles.css` 放入 `<vault>/.obsidian/plugins/fleur-epub/`，在 Obsidian 中启用即可。

## License

MIT
