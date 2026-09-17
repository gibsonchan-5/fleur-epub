// 数据持久层：按「书指纹」锚定，文件移动/改名不丢数据。
//
// ── 分域存储（第一期）────────────────────────────────────────────────────
// 一本书的数据落成三个文件，各按自己的写入节奏独立落盘：
//   <指纹>.json            主文件：book 元信息 + annotations（另含 progress 兼容镜像）
//   <指纹>.progress.json   阅读进度：翻页 800ms 防抖写
//   <指纹>.trans.json      段落对照译文缓存：4000ms 节流写
//
// 为什么要拆：拆分前每次保存都写「整份 BookData」，而译文缓存是体积大头（上限 6000 条）。
// 于是翻一页、翻一段译文，都要把批注数组连同这份缓存整份重写一遍——写放大之外还有个
// 更隐蔽的代价：文件一旦超过同步插件的大文件阈值，译文会把批注一起拖累成「不同步」。
// 拆开后翻页只写几十字节的 progress.json、译文只写 trans.json，主文件不再含缓存、
// 体积回落到 KB 级。
//
// ── 合并写与墓碑（第二期）───────────────────────────────────────────────
// 第一期只解决了「不同类数据互相拖累」，**同一个文件内部仍是整份覆盖**。于是有了这条
// 丢数据路径（不需要两端同时编辑）：手机加了一条批注 → 同步器把新文件拉到桌面 → 桌面
// 还开着这本书，内存里是开书那一刻读的旧数组 → 翻一页就把刚同步进来的批注整份覆盖掉
// → 下次同步把「没有这条」的版本推回手机 → 两端一起丢。
//
// 第二期做三件事堵住它：
//   1. 合并写。落盘前先读回磁盘原文，与自己「上次写下去的字节串」比对（见 lastWritten）：
//      一致 → 说明没人动过，直接写（本机自己的写入永远走这条，不引入任何行为变化）；
//      不一致 → 说明被外部（同步器）改过 → 解析磁盘版、按 id/updatedAt 取并集后再写回。
//      ⚠️ 这里刻意用「读回原文比字节」而不是「stat 比 mtime+size」：移动端 mtime 常只有
//      秒级精度，同一秒内写入会被误判成「没人动过」——那恰好是要防的丢数据方向。代价是
//      每次保存多一次读盘，但主文件已只有 KB 级、progress 不到 100 字节（第一期的收益），
//      实测一次保存的读盘增量可忽略，换来判断绝对确定。
//   2. 墓碑。删除不再 splice 掉数组元素，而是打 deletedAt。否则另一端那条仍是存活的，
//      合并取并集时会把删掉的内容「救回来」（复活 bug）。墓碑按 TOMBSTONE_TTL_MS 回收。
//   3. 损坏不覆盖。磁盘上的 JSON 解析失败时，先另存 <指纹>.corrupt-<时间戳>.json，
//      **本次不覆盖**（磁盘原文件原样保留）。同一份损坏内容只会备份一次，第二次起允许
//      覆盖，避免一次损坏把这本书永久变成只读。
//
// 进度合并规则：**percent 取大者**。目的是「在桌面随手一开」不会把另一端读到的位置拉回去。
// 本机自己的写入走 lastWritten 短路、根本不进合并分支，所以单设备用户「往回翻」不受影响。
// 已知取舍：两端都读过时，位置较前的那端不会把另一端拉回来（要真正的「往回同步」，需要
// 一个显式的「重置进度」入口）。
//
// 升级期兼容（另一端还是旧版时）：
//   · 旧版单文件（含 progress + translations）照常读，字段齐全直接用；
//   · 主文件保留 progress 镜像，但**只在写主文件时刷新**——加/删批注、切书、关书会刷，
//     翻页不刷（翻页只写 .progress.json）。所以另一端还是旧版时，它看到的进度会停在
//     「上次写主文件」那一刻，关书即自愈。同一版本内没有这个延迟：新版先读 .progress.json。
//   · load() 合并时 progress 取 updatedAt 较新者，旧版写回主文件的进度不会被打回；
//   · translations 无时间戳，按 key 取并集（缓存只增不减，并集恒安全）；译文域**不做**
//     合并写——它是可重算的缓存，两端并发写最多让某些段落重译一次，不值得为它付出读盘代价。
//   · 读盘代价不倒退：旧版 loadProgress 是 exists + read 两跳，新版在「尚未迁移的书」上
//     是「试探读 .progress.json（未命中，零字节）+ 回落读主文件」同为两跳、同样字节数；
//     迁移之后每本书只剩一跳小文件（实测 27 本：435.1K → 2.8K）。

import { App, Plugin } from 'obsidian';

export interface BookMeta {
	title?: string;
	creator?: string;
	language?: string;
	identifier?: string;
}

export interface BookProgress {
	cfi?: string;
	percent?: number;
	updatedAt?: number;
}

/** 标注种类：高亮 / 直线 / 波浪线（对齐 fleur-pdf 三种样式） */
export type AnnotationKind = 'highlight' | 'underline' | 'wavy';

/** 单条标注：以 EPUB CFI 锚定，text 为选段快照（CFI 失效时的兜底与 AI 上下文） */
export interface EpubAnnotation {
	id: string;
	cfi: string;
	text: string;
	kind: AnnotationKind;
	/** 颜色键（HIGHLIGHT_COLORS 的 key） */
	color: string;
	/** 批注文字（附属字段，任何 kind 都可带，同 fleur-pdf 约定） */
	comment?: string;
	/** 所在章节标题（创建时由 foliate 返回） */
	chapterLabel?: string;
	createdAt: number;
	/** 最后修改时间（第二期新增）。合并时按此取新；老数据缺省 → 回落 createdAt。
	 *  修改批注文字、改色、删除都要刷新它，否则合并会误判为「两边一样」。 */
	updatedAt?: number;
	/** 墓碑（第二期新增）：非空表示这条已被删除。删除不再移出数组——移出后另一端那条
	 *  仍是存活的，合并取并集会把它救回来（复活的删除）。渲染与计数一律过滤墓碑。 */
	deletedAt?: number;
}

export interface BookData {
	fingerprint: string;
	book: BookMeta;
	progress: BookProgress;
	annotations: EpubAnnotation[];
	/** 段落对照翻译缓存：key = 段落文本 FNV 哈希（translator.ts） */
	translations?: Record<string, string>;
}

/** 写入域：本次落盘碰哪几个文件。拆域后绝大多数保存只写其中一个小文件。 */
export type SaveScope = 'all' | 'progress' | 'annotations' | 'translations';

/** 墓碑保留时长：超过即回收。取 30 天是因为它必须长于「另一端可能离线的最久时间」——
 *  墓碑提前消失，另一端那条存活的批注会在下次合并时复活。 */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 落盘结果：调用方据此决定要不要增量挂载新批注、要不要提示用户。 */
export interface SaveOutcome {
	/** 本次是否检测到外部写入并吸收了它 */
	merged: boolean;
	/** 合并后新增的批注（本地内存原先没有的），供调用方增量挂载 */
	absorbed: EpubAnnotation[];
	/** 遇到损坏文件时的备份路径（磁盘原文件未被覆盖） */
	corruptBackup?: string;
	/** 本次因损坏保护而放弃写主文件 */
	skipped?: boolean;
}

/** FNV-1a 32bit 哈希（纯前端可用，无 Node 依赖） */
export function hashString(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/** 书指纹：identifier + 书名 联合哈希；缺 identifier 时用 title+creator+language 组合。
 *
 * ⚠️ 不能只用 identifier：部分打包工具（如 z-library）会给不同书籍打入完全相同的
 * UUID（实际案例：5 本书共用 urn:uuid:273fd756-…），identifier 单独做指纹会跨书串
 * 批注/进度。混入书名后即天然去重（同名同 identifier 视为同一本书的重复文件）。
 */
export function computeFingerprint(meta: BookMeta): string {
	const ident = meta.identifier?.trim();
	if (ident) {
		return hashString(ident + '|' + (meta.title ?? '').trim().toLowerCase());
	}
	const fallback = [meta.title, meta.creator, meta.language]
		.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : ''))
		.join('|');
	return hashString(fallback || 'unknown');
}

/** 损坏备份文件名里的时间戳段：`<指纹>.corrupt-1758000000000.json` */
const CORRUPT_BACKUP_RE = /\.corrupt-\d+\.json$/;

/** 文件名是否是书数据主文件（`<指纹>.json`）。
 *
 *  data 目录里同时住着分域文件与损坏备份，它们与主文件同后缀，**任何扫描该目录的代码
 *  都必须先按名字排除**——否则会被当成书数据解析、在里面找 `book` 字段而抛错
 *  （main.ts 的指纹迁移就是这么被绊到的）。过滤规则集中在此，将来再加文件时只改这一处。
 */
export function isMainDataFileName(name: string): boolean {
	if (!name.endsWith('.json')) return false;
	if (name.endsWith('.progress.json') || name.endsWith('.trans.json')) return false;
	if (CORRUPT_BACKUP_RE.test(name)) return false;
	return true;
}

/** 文件不存在 vs 真出错：Obsidian 各平台底层（Node fs / Capacitor / 移动端桥）措辞不同，
 *  只能宽匹配。方向是「宁可多打日志也不静默吞错」——漏判最坏是多条日志，误判则会把
 *  「文件损坏」当「还没写过」悄悄咽下去。
 */
function isMissingFileError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /ENOENT|no such file|not exist|404/i.test(msg);
}

/** 确定性序列化：对象键排序后输出。用于两处**必须逐字节可比**的判断——
 *  ① 冲突时比较两端条目内容，② 判断合并是否真的改动了数据。
 *  直接 JSON.stringify 会受键插入顺序影响，出现「内容相同却判为不同」的假差异。 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
	const o = value as Record<string, unknown>;
	return (
		'{' +
		Object.keys(o)
			.sort()
			.map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
			.join(',') +
		'}'
	);
}

/** 条目标识：id 是主键；极老的数据理论上可能缺 id，用 cfi 兜底避免两条被并成一条。 */
export function annotationKey(a: EpubAnnotation): string {
	return a.id || a.cfi;
}

/** 合并用的时间线：优先 updatedAt，老数据回落 createdAt */
function annotationTime(a: EpubAnnotation): number {
	const t = a.updatedAt ?? a.createdAt;
	return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

export function isAnnotationDeleted(a: EpubAnnotation): boolean {
	return typeof a.deletedAt === 'number' && a.deletedAt > 0;
}

/** 过滤墓碑：渲染、计数、导出、查找一律走这里，别直接遍历 bookData.annotations */
export function liveAnnotations(list: readonly EpubAnnotation[] | undefined): EpubAnnotation[] {
	return (list ?? []).filter((a) => !isAnnotationDeleted(a));
}

/** 回收过期墓碑。**只在合并路径调用**（见 mergeAnnotations）：那时我们本来就要重写文件，
 *  顺手清理零成本；在 load() 里清理会在「另一端还没同步到删除」时提前抹掉墓碑、导致复活。 */
export function pruneTombstones(
	list: readonly EpubAnnotation[],
	now: number = Date.now(),
): EpubAnnotation[] {
	return list.filter((a) => !isAnnotationDeleted(a) || now - (a.deletedAt as number) <= TOMBSTONE_TTL_MS);
}

/**
 * 合并批注（第二期核心纯函数）。
 *
 * 规则：
 *   · 以 id 对齐取并集 —— 两端各自新增的都保留，这是「无损」的定义；
 *   · 同 id 冲突按 updatedAt 取新；
 *   · 同毫秒冲突：**删除优先**（宁可少一条也不能让删掉的批注复活）；
 *   · 同毫秒且删除态相同时，按条目内容的确定性序列化比较取大者 ——
 *     保证两端各自算出**完全相同**的结果与顺序，否则每次同步都会互相判为「被改过」而反复写盘；
 *   · 输出按 (createdAt, id) 排序而不是保留原顺序，同样是为了两端收敛。
 */
export function mergeAnnotations(
	local: readonly EpubAnnotation[] | null | undefined,
	remote: readonly EpubAnnotation[] | null | undefined,
	now: number = Date.now(),
): EpubAnnotation[] {
	const byId = new Map<string, EpubAnnotation>();
	const put = (a: EpubAnnotation) => {
		const k = annotationKey(a);
		const prev = byId.get(k);
		if (!prev) {
			byId.set(k, { ...a });
			return;
		}
		const ta = annotationTime(a);
		const tp = annotationTime(prev);
		if (ta > tp) {
			byId.set(k, { ...a });
			return;
		}
		if (ta < tp) return;
		const da = isAnnotationDeleted(a);
		const dp = isAnnotationDeleted(prev);
		if (da !== dp) {
			byId.set(k, da ? { ...a } : { ...prev });
			return;
		}
		if (canonicalJson(a) > canonicalJson(prev)) byId.set(k, { ...a });
	};
	// 顺序无关：所有分支都由时间戳/内容决定，不依赖谁先放进 Map
	for (const a of remote ?? []) put(a);
	for (const a of local ?? []) put(a);

	const out = pruneTombstones([...byId.values()], now);
	out.sort((a, b) => {
		const d = (a.createdAt ?? 0) - (b.createdAt ?? 0);
		if (d) return d;
		const ka = annotationKey(a);
		const kb = annotationKey(b);
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	return out;
}

/**
 * 合并阅读进度：**percent 取大者**（用户拍板的策略）。
 *
 * 为什么不能直接用 updatedAt 比新（LWW）：「在桌面随手翻开一本书」会在开书后一秒内
 * 把封面页（0%）写进磁盘，而它的时间戳比手机读到的 42% 更新 —— LWW 会让手机被拉回开头。
 * 取大者解决的正是这个。
 *
 * 单设备用户不受影响：本机自己的写入走 lastWritten 短路、根本不进合并分支，
 * 所以「读到一半又翻回第二章」仍会正常记为第二章。
 * 代价：两端都读过时，位置靠前的那端不会把另一端拉回来。要真正的「往回同步」得给个
 * 显式的「重置进度」入口（未做）。
 */
export function mergeProgress(
	local: BookProgress | null | undefined,
	remote: BookProgress | null | undefined,
): BookProgress {
	const l = local ?? {};
	const r = remote ?? {};
	const lp = typeof l.percent === 'number' ? l.percent : undefined;
	const rp = typeof r.percent === 'number' ? r.percent : undefined;

	let win: BookProgress;
	if (lp === undefined && rp === undefined) {
		win = (r.updatedAt ?? 0) > (l.updatedAt ?? 0) ? r : l;
	} else if (lp === undefined) {
		win = r;
	} else if (rp === undefined) {
		win = l;
	} else if (lp > rp) {
		win = l;
	} else if (rp > lp) {
		win = r;
	} else {
		win = (r.updatedAt ?? 0) > (l.updatedAt ?? 0) ? r : l;
	}

	const out: BookProgress = { ...win };
	// updatedAt 取大者：书架排序靠它，不能让合并把排序时间往回拨
	const t = Math.max(l.updatedAt ?? 0, r.updatedAt ?? 0);
	out.updatedAt = t > 0 ? t : undefined;
	if (!out.cfi) out.cfi = l.cfi ?? r.cfi;
	return out;
}

/** 主文件里的 progress 是兼容镜像，.progress.json 才是新版权威所在；两者都可能更新
 *  （升级期旧版会把进度写回主文件）→ 按 updatedAt 取新者，相等或都缺时优先分域文件。
 *  注意这里**不是** mergeProgress：这两个文件都出自本机，谁新听谁的即可，
 *  跨设备的「取大者」策略不适用（否则旧镜像会把刚读到的位置顶回去）。 */
export function pickNewerProgress(
	mirror?: BookProgress | null,
	scoped?: BookProgress | null,
): BookProgress {
	const tm = mirror?.updatedAt ?? 0;
	const ts = scoped?.updatedAt ?? 0;
	if (tm > ts) return { ...mirror };
	if (ts > tm) return { ...scoped };
	return { ...(scoped && Object.keys(scoped).length ? scoped : mirror) };
}

export class BookStore {
	/**
	 * 进度索引：指纹 → progress 快照（很小）。
	 * 书架排序要每本书的 updatedAt、每张卡片要 percent；若直接 load() 就是 N 次读盘 +
	 * N 次整本 JSON 反序列化（翻译缓存可能很大）。只缓存这几个字段，写入时同步更新
	 * ⇒ 同一会话内书架排序与进度条零读盘。
	 */
	private progressIndex = new Map<string, BookProgress>();

	/**
	 * 每文件写队列：同一文件的写串行执行。翻页防抖（800ms）与译文节流（4000ms）可能
	 * 同时到点，交错写会让后一次基于旧内容覆盖。「读回磁盘 → 合并 → 写回」整段都在这
	 * 个队列槽内执行，所以合并读到的必然是上一次写完的内容，不会被自己人插队。
	 * 队列里存的是「守门 promise」（已 catch），所以一次写失败不会卡死后续。
	 */
	private queues = new Map<string, Promise<void>>();

	/** 数据目录只创建一次（并发首写会同时 exists → mkdir）；失败不缓存，下次再试 */
	private dirReady: Promise<void> | null = null;

	/** 已确认译文域落盘的指纹。见 save() 里 transPersisted 的说明。 */
	private transPersisted = new Set<string>();

	/**
	 * 我们自己最后一次写下去（或在 load 时读到的）字节串，按路径记。
	 *
	 * 这是「本次保存是否需要合并」的唯一判据，也是它比 stat 可靠的地方：
	 * 字节串比对没有时间精度问题。load() 时把读到的原文记进来同样重要——它让
	 * 「本机自己的历史写入」也能命中短路分支，于是单设备用户的保存路径**一行都没变**。
	 */
	private lastWritten = new Map<string, string>();

	/** 已备份过的损坏内容（按路径）。同一份内容只备份一次，之后允许覆盖以自愈。 */
	private corruptSeen = new Map<string, string>();

	constructor(private app: App, private plugin: Plugin) {}

	private dir(): string {
		return `${this.app.vault.configDir}/plugins/fleur-epub/data`;
	}

	private mainPath(fingerprint: string): string {
		return `${this.dir()}/${fingerprint}.json`;
	}

	private progressPath(fingerprint: string): string {
		return `${this.dir()}/${fingerprint}.progress.json`;
	}

	private transPath(fingerprint: string): string {
		return `${this.dir()}/${fingerprint}.trans.json`;
	}

	/** 读原文。区分「不存在」（常态，不留痕）与「真出错」（要留痕）——合并写与 load
	 *  都需要原始字节串，所以这里返回 raw 而不是解析结果。 */
	private async readRawText(
		path: string,
	): Promise<{ ok: true; raw: string } | { ok: false; reason: 'missing' | 'error'; error?: unknown }> {
		try {
			const raw = await this.app.vault.adapter.read(path);
			return { ok: true, raw: raw ?? '' };
		} catch (e) {
			if (!isMissingFileError(e)) console.warn('[FleurEPUB] 读取数据文件失败', path, e);
			return { ok: false, reason: isMissingFileError(e) ? 'missing' : 'error', error: e };
		}
	}

	/** 解析成对象；空串 / 非法 JSON / 非对象一律 null */
	private parseOrNull<T>(raw: string): T | null {
		if (!raw) return null;
		try {
			const v = JSON.parse(raw) as unknown;
			return v && typeof v === 'object' ? (v as T) : null;
		} catch {
			return null;
		}
	}

	async load(fingerprint: string): Promise<BookData | null> {
		const mainPath = this.mainPath(fingerprint);
		const progressPath = this.progressPath(fingerprint);
		// 三个域并发读；单个域坏掉只是该域回落，其余照常
		const [mainRes, scopedRes, transRes] = await Promise.all([
			this.readRawText(mainPath),
			this.readRawText(progressPath),
			this.readRawText(this.transPath(fingerprint)),
		]);
		const mainText = mainRes.ok ? mainRes.raw : '';
		const scopedText = scopedRes.ok ? scopedRes.raw : '';
		const transText = transRes.ok ? transRes.raw : '';

		// 记下磁盘现状：之后若我们写出的字节串与之一致，说明中间没人动过 → 保存无需读回合并
		if (mainText) this.lastWritten.set(mainPath, mainText);
		if (scopedText) this.lastWritten.set(progressPath, scopedText);

		const main = this.parseOrNull<BookData>(mainText);
		const scoped = this.parseOrNull<BookProgress>(scopedText);
		const trans = this.parseOrNull<Record<string, string>>(transText);

		// 三域皆无 → 新书（或数据被清），交由调用方建默认值
		if (!main && !scoped && !trans) return null;
		// 译文域已在磁盘上 → 后续批注保存不必再顺手补写它
		if (trans) this.transPersisted.add(fingerprint);

		const base: Partial<BookData> = main ?? {};
		const data: BookData = {
			...base,
			fingerprint,
			book: base.book ?? {},
			// 注意：保留墓碑，不在 load 时回收 —— 提前抹掉会让另一端的存活副本复活
			annotations: Array.isArray(base.annotations) ? base.annotations : [],
			progress: pickNewerProgress(base.progress, scoped),
		};
		// 旧版把译文写在主文件里、新版写在 .trans.json，升级期两份可能并存 → 取并集
		const mergedTrans: Record<string, string> = { ...(base.translations ?? {}), ...(trans ?? {}) };
		data.translations = Object.keys(mergedTrans).length ? mergedTrans : undefined;
		return data;
	}

	/** 只取进度（书架排序 / 卡片进度条用）：命中索引直接返回，否则读一次盘并记住。
	 *  优先读体积最小的分域文件；它不存在说明这本书还没被新版写过 → 回落读主文件
	 *  （兼容旧数据）。返回的是副本——调用方改动返回值不会污染索引。 */
	async loadProgress(fingerprint: string): Promise<BookProgress> {
		const hit = this.progressIndex.get(fingerprint);
		if (hit) return { ...hit };
		const scoped = this.parseOrNull<BookProgress>(
			this.okRaw(await this.readRawText(this.progressPath(fingerprint))),
		);
		let progress: BookProgress = scoped ?? {};
		if (!Object.keys(progress).length) {
			const main = this.parseOrNull<BookData>(
				this.okRaw(await this.readRawText(this.mainPath(fingerprint))),
			);
			progress = { ...(main?.progress ?? {}) };
		}
		this.progressIndex.set(fingerprint, progress);
		return { ...progress };
	}

	private okRaw(res: { ok: true; raw: string } | { ok: false }): string {
		return res.ok ? res.raw : '';
	}

	/** 落盘。scope 决定碰哪几个文件（默认 all：切书/关书的全量 flush）。
	 *  ⚠️ 主文件只写 book + annotations + progress 镜像，**不含译文缓存**（见文件头注释）。
	 *  ⚠️ 本方法会**就地改写 data**：吸收到的外部批注/进度会写回调用方的对象，
	 *     这样内存（侧边栏、书架计数）与磁盘不会各说各话。返回值告诉你吸收了什么。 */
	async save(data: BookData, scope: SaveScope = 'all'): Promise<SaveOutcome> {
		const fp = data.fingerprint;
		const outcome: SaveOutcome = { merged: false, absorbed: [] };
		// 先更新索引再落盘：即便写失败，本次会话内的排序/进度条也按最新值走
		this.progressIndex.set(fp, { ...(data.progress ?? {}) });

		// 译文域：常规由 scope 决定；此外「旧格式书读进来后的第一次批注保存」也要补写一次，
		// 否则主文件重写会把缓存抹掉（详见 transPersisted 的说明）。
		const writeTrans =
			scope === 'all' ||
			scope === 'translations' ||
			(scope === 'annotations' && !!data.translations && !this.transPersisted.has(fp));
		if (writeTrans) this.transPersisted.add(fp);

		const jobs: Array<Promise<void>> = [];

		if (scope === 'all' || scope === 'progress') {
			const path = this.progressPath(fp);
			jobs.push(
				this.queued(path, async () => {
					const disk = await this.readDiskForMerge(path, fp);
					if (disk.kind === 'corrupt') {
						outcome.corruptBackup = disk.backup;
						outcome.skipped = true;
						return;
					}
					if (disk.kind === 'content') {
						const before = data.progress ?? {};
						const merged = mergeProgress(before, this.parseOrNull<BookProgress>(disk.raw));
						if (canonicalJson(merged) !== canonicalJson(before)) {
							outcome.merged = true;
							data.progress = merged;
							// 合并结果也要回填索引：否则书架排序/进度条仍显示被合并掉的那个旧值
							this.progressIndex.set(fp, { ...merged });
						}
					}
					await this.writeNow(path, JSON.stringify(data.progress ?? {}, null, 2));
				}),
			);
		}

		if (writeTrans) {
			// 译文域刻意**不做**合并写：它是可重算的缓存，为它读回整个大文件不划算
			// （两端并发写最多让若干段落重译一次）。
			const path = this.transPath(fp);
			jobs.push(
				this.queued(path, async () => {
					await this.writeNow(path, JSON.stringify(data.translations ?? {}, null, 2));
				}),
			);
		}

		if (scope === 'all' || scope === 'annotations') {
			const path = this.mainPath(fp);
			jobs.push(
				this.queued(path, async () => {
					const disk = await this.readDiskForMerge(path, fp);
					if (disk.kind === 'corrupt') {
						// 损坏保护：磁盘原文件一个字节都不动，等用户/我们处置
						outcome.corruptBackup = disk.backup;
						outcome.skipped = true;
						return;
					}
					if (disk.kind === 'content') {
						const diskData = this.parseOrNull<BookData>(disk.raw);
						if (diskData) {
							const local = data.annotations ?? [];
							const known = new Set(local.map(annotationKey));
							const merged = mergeAnnotations(local, diskData.annotations);
							for (const a of merged) {
								if (!known.has(annotationKey(a)) && !isAnnotationDeleted(a)) outcome.absorbed.push(a);
							}
							data.annotations = merged;
							// 元信息：只补本地缺的字段，不覆盖本地已有值
							const diskBook = diskData.book ?? {};
							for (const k of Object.keys(diskBook) as Array<keyof BookMeta>) {
								if (!data.book[k] && diskBook[k]) data.book[k] = diskBook[k];
							}
							outcome.merged = true;
						}
					}
					// translations: undefined 会被 JSON.stringify 整个跳过，将来 BookData 加字段不必改这里
					await this.writeNow(
						path,
						JSON.stringify({ ...data, translations: undefined }, null, 2),
					);
				}),
			);
		}

		await Promise.all(jobs);
		return outcome;
	}

	/** 判断磁盘上的现状，决定本次保存要不要合并。三种结果：
	 *   none    —— 没文件 / 内容为空 / 就是我们自己上次写的 → 无需合并，直接写；
	 *   content —— 被外部改过且能解析 → 调用方合并后再写；
	 *   corrupt —— 被外部改坏，已另存备份，**本次不覆盖**。
	 *  同一份损坏内容第二次遇到时按 none 处理（已备份过，允许覆盖）——否则一次损坏
	 *  会让这本书永久写不进去。 */
	private async readDiskForMerge(
		path: string,
		fingerprint: string,
	): Promise<{ kind: 'none' } | { kind: 'content'; raw: string } | { kind: 'corrupt'; backup: string }> {
		const res = await this.readRawText(path);
		if (!res.ok) return { kind: 'none' };
		const raw = res.raw;
		if (!raw.trim()) return { kind: 'none' };
		if (this.lastWritten.get(path) === raw) return { kind: 'none' };
		if (this.parseOrNull(raw)) return { kind: 'content', raw };
		if (this.corruptSeen.get(path) === raw) return { kind: 'none' };

		const backup = `${this.dir()}/${fingerprint}.corrupt-${Date.now()}.json`;
		try {
			await this.ensureDir();
			await this.app.vault.adapter.write(backup, raw);
			this.corruptSeen.set(path, raw);
		} catch (e) {
			// 备份都失败就绝不能覆盖：否则损坏内容彻底没了
			console.warn('[FleurEPUB] 备份损坏数据文件失败，本次放弃写入', backup, e);
		}
		console.warn('[FleurEPUB] 数据文件损坏，本次未覆盖，已另存备份', path, '→', backup);
		return { kind: 'corrupt', backup };
	}

	/** 同路径写串行化。存进队列的是「已 catch 的守门 promise」，一次失败不卡死后续。 */
	private queued<T>(path: string, task: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(path) ?? Promise.resolve();
		const next = prev.then(task);
		this.queues.set(
			path,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	private async writeNow(path: string, payload: string): Promise<boolean> {
		try {
			await this.ensureDir();
			await this.app.vault.adapter.write(path, payload);
			// 写下什么就记什么：下次保存靠它判断「中间有没有人动过」
			this.lastWritten.set(path, payload);
			return true;
		} catch (e) {
			console.warn('[FleurEPUB] 保存书籍数据失败', path, e);
			return false;
		}
	}

	private ensureDir(): Promise<void> {
		if (!this.dirReady) {
			const adapter = this.app.vault.adapter;
			this.dirReady = (async () => {
				if (!(await adapter.exists(this.dir()))) await adapter.mkdir(this.dir());
			})().catch((e) => {
				// 不缓存失败：否则一次 mkdir 抖动会让整个会话都写不进去
				this.dirReady = null;
				console.warn('[FleurEPUB] 创建数据目录失败', e);
			});
		}
		return this.dirReady;
	}
}
