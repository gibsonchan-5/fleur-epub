// 按设备分片（第三期）的持久层测试：模拟两台设备共用一份「同步过的磁盘」，
// 验证任何一台设备的写入都不会整份盖掉另一台设备的批注。
// 运行：npx tsx --test test/store-shards.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { BookStore, isAnnotationDeleted, liveAnnotations } from '../src/store.ts';
import type { AnnotationShard, BookData, EpubAnnotation } from '../src/store.ts';

const CONFIG_DIR = '.obsidian';
const DATA_DIR = 'FleurEpub/data';

/** 内存版 vault.adapter：两台「设备」共用同一份，代表同步之后的磁盘状态。 */
function makeAdapter() {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const parents = (p: string) => {
		const parts = p.split('/').filter(Boolean);
		parts.pop();
		let cur = '';
		for (const part of parts) {
			cur = cur ? `${cur}/${part}` : part;
			dirs.add(cur);
		}
	};
	const adapter = {
		exists: async (path: string) => {
			if (files.has(path) || dirs.has(path)) return true;
			const prefix = path.endsWith('/') ? path : path + '/';
			return [...files.keys()].some((f) => f.startsWith(prefix));
		},
		read: async (path: string) => {
			const raw = files.get(path);
			if (raw === undefined) throw new Error(`ENOENT: no such file, ${path}`);
			return raw;
		},
		write: async (path: string, data: string) => {
			parents(path);
			files.set(path, data);
		},
		mkdir: async (path: string) => {
			parents(path);
			dirs.add(path);
		},
		remove: async (path: string) => {
			files.delete(path);
		},
		list: async (dir: string) => {
			const prefix = dir.endsWith('/') ? dir : dir + '/';
			const out = { files: [] as string[], folders: [] as string[] };
			for (const f of files.keys()) if (f.startsWith(prefix)) out.files.push(f);
			for (const d of dirs) {
				if (!d.startsWith(prefix)) continue;
				if (d.slice(prefix.length).includes('/')) continue;
				out.folders.push(d);
			}
			return out;
		},
	};
	return { adapter, files, dirs };
}

type Adapter = ReturnType<typeof makeAdapter>['adapter'];

function makeApp(adapter: Adapter) {
	return { vault: { configDir: CONFIG_DIR, adapter } } as never;
}

function makePlugin() {
	return { settings: { syncDataToVault: true, dataDir: DATA_DIR } } as never;
}

/** 切换到指定设备：localStorage 每台设备独立（真实世界里也不会被同步带走）。 */
function installDevice(id: string) {
	const store = new Map<string, string>([['fleur-epub-device-id', id]]);
	(globalThis as { localStorage?: Storage }).localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
		clear: () => store.clear(),
		key: () => null,
		length: 0,
	} as Storage;
}

async function newDevice(adapter: Adapter, id: string): Promise<BookStore> {
	installDevice(id);
	const store = new BookStore(makeApp(adapter), makePlugin());
	// 立刻解析并缓存设备标识：之后即使切到别的设备再操作，这个实例仍代表自己
	const resolved = await (
		store as unknown as { getDeviceId(): Promise<string> }
	).getDeviceId();
	assert.equal(resolved, id);
	return store;
}

function ann(id: string, createdAt: number, extra: Partial<EpubAnnotation> = {}): EpubAnnotation {
	return {
		id,
		cfi: `epubcfi(/6/2[ch1]!/4/2/1:0)`,
		text: `文本 ${id}`,
		kind: 'highlight',
		color: 'yellow',
		createdAt,
		updatedAt: createdAt,
		...extra,
	};
}

function book(fp: string, annotations: EpubAnnotation[]): BookData {
	return { fingerprint: fp, book: { title: `书 ${fp}` }, progress: {}, annotations };
}

const shardPath = (fp: string, device: string) => `${DATA_DIR}/ann/${fp}/${device}.json`;
const mainPath = (fp: string) => `${DATA_DIR}/${fp}.json`;

function readShard(files: Map<string, string>, fp: string, device: string): AnnotationShard {
	const raw = files.get(shardPath(fp, device));
	assert.ok(raw, `分片不存在：${shardPath(fp, device)}`);
	return JSON.parse(raw) as AnnotationShard;
}

test('两台设备各写各的分片：互不覆盖，第三台设备读到并集', async () => {
	const { adapter, files } = makeAdapter();
	const fp = 'book1';

	const a = await newDevice(adapter, 'deviceA');
	await a.save(book(fp, [ann('a1', 1000)]));
	const b = await newDevice(adapter, 'deviceB');
	await b.save(book(fp, [ann('b1', 2000)]));

	// A 只写自己的分片，不会碰 B 的；B 保存时把自己看到的一并合并进自己的分片
	// （每份分片是「该设备的知识快照」——重复无害，重点是任何设备都不写别人的文件）
	assert.deepEqual(readShard(files, fp, 'deviceA').annotations.map((x) => x.id), ['a1']);
	assert.deepEqual(readShard(files, fp, 'deviceB').annotations.map((x) => x.id).sort(), ['a1', 'b1']);
	// 主文件是整份快照，供旧版本读取
	assert.equal((JSON.parse(files.get(mainPath(fp)) as string) as BookData).annotations.length, 2);

	const c = await newDevice(adapter, 'deviceC');
	const loaded = await c.load(fp);
	assert.ok(loaded);
	assert.deepEqual(loaded.annotations.map((x) => x.id).sort(), ['a1', 'b1']);
});

test('主文件被旧版本整份覆盖 / 删除后，分片仍能把批注带回来', async () => {
	const { adapter, files } = makeAdapter();
	const fp = 'book2';
	const a = await newDevice(adapter, 'deviceA');
	await a.save(book(fp, [ann('a1', 1000)]));
	const b = await newDevice(adapter, 'deviceB');
	await b.save(book(fp, [ann('b1', 2000)]));

	// 模拟 keep_newer 留下的「空批注」主文件：分片在，批注就不该消失
	files.set(
		mainPath(fp),
		JSON.stringify({ fingerprint: fp, book: { title: '书 book2' }, progress: {}, annotations: [] }),
	);
	const c = await newDevice(adapter, 'deviceC');
	const afterOverwrite = await c.load(fp);
	assert.ok(afterOverwrite);
	assert.deepEqual(afterOverwrite.annotations.map((x) => x.id).sort(), ['a1', 'b1']);

	// 主文件整个没了也必须能从分片恢复
	files.delete(mainPath(fp));
	const d = await newDevice(adapter, 'deviceD');
	const afterDelete = await d.load(fp);
	assert.ok(afterDelete, '只有分片时 load 不能当新书返回 null');
	assert.deepEqual(afterDelete.annotations.map((x) => x.id).sort(), ['a1', 'b1']);
});

test('主文件被覆盖后，某台设备再保存：合并全部分片并写回完整主文件', async () => {
	const { adapter, files } = makeAdapter();
	const fp = 'book3';
	const a = await newDevice(adapter, 'deviceA');
	await a.save(book(fp, [ann('a1', 1000)]));
	const b = await newDevice(adapter, 'deviceB');
	await b.save(book(fp, [ann('b1', 2000)]));

	// 同步器把主文件换成 B 的旧快照（不含 A 的批注）
	files.set(mainPath(fp), JSON.stringify(book(fp, [ann('b1', 2000)])));

	// A 仍开着书，内存里只有自己那条；新增 a2 后保存
	const outcome = await a.save(book(fp, [ann('a1', 1000), ann('a2', 3000)]));
	assert.equal(outcome.merged, true, '应识别出主文件被外部改过并合并');
	assert.ok(outcome.absorbed.some((x) => x.id === 'b1'), '应把 B 的批注吸收回内存');

	const onDisk = JSON.parse(files.get(mainPath(fp)) as string) as BookData;
	assert.deepEqual(onDisk.annotations.map((x) => x.id).sort(), ['a1', 'a2', 'b1']);
	assert.deepEqual(readShard(files, fp, 'deviceA').annotations.map((x) => x.id).sort(), ['a1', 'a2', 'b1']);

	const c = await newDevice(adapter, 'deviceC');
	const loaded = await c.load(fp);
	assert.ok(loaded);
	assert.deepEqual(loaded.annotations.map((x) => x.id).sort(), ['a1', 'a2', 'b1']);
});

test('墓碑跨分片生效：另一端分片里的存活副本不会让删除复活', async () => {
	const { adapter, files } = makeAdapter();
	const fp = 'book4';
	// 时间戳必须贴近当前时间：墓碑超过 TOMBSTONE_TTL_MS 会在合并路径被回收，
	// 那是另一条既定规则，不能让它掩盖本测试要验证的「删除胜出」。
	const t0 = Date.now() - 60_000;
	const a = await newDevice(adapter, 'deviceA');
	await a.save(book(fp, [ann('a1', t0)]));

	// B 同步到这条后删除它：墓碑时间更新
	const b = await newDevice(adapter, 'deviceB');
	const seen = await b.load(fp);
	assert.ok(seen);
	const tombstoned: EpubAnnotation = {
		...seen.annotations[0],
		updatedAt: t0 + 1000,
		deletedAt: t0 + 1000,
	};
	await b.save(book(fp, [tombstoned]));

	// A 的分片里仍是存活的 a1（还没同步到删除），但合并后必须判定为已删除
	const c = await newDevice(adapter, 'deviceC');
	const loaded = await c.load(fp);
	assert.ok(loaded);
	assert.equal(liveAnnotations(loaded.annotations).length, 0);
	assert.ok(loaded.annotations.some((x) => x.id === 'a1' && isAnnotationDeleted(x)));

	// A 再写一次自己那份旧数组（含存活 a1），也不能把墓碑顶掉
	await a.save(book(fp, [ann('a1', t0)]));
	const d = await newDevice(adapter, 'deviceD');
	const again = await d.load(fp);
	assert.ok(again);
	assert.equal(liveAnnotations(again.annotations).length, 0);
});

test('启动迁移：给已有主文件补本机分片，幂等且不覆盖已有分片', async () => {
	const { adapter, files } = makeAdapter();
	const fp = 'book5';
	await adapter.write(mainPath(fp), JSON.stringify(book(fp, [ann('a1', 1000), ann('a2', 2000)])));

	const f = await newDevice(adapter, 'deviceF');
	await f.migrateAnnotationsToShards();
	assert.deepEqual(readShard(files, fp, 'deviceF').annotations.map((x) => x.id), ['a1', 'a2']);

	// 主文件后来被清空：迁移再次运行不能把分片覆盖成空
	await adapter.write(mainPath(fp), JSON.stringify(book(fp, [])));
	await f.migrateAnnotationsToShards();
	assert.deepEqual(readShard(files, fp, 'deviceF').annotations.map((x) => x.id), ['a1', 'a2']);

	// 已有分片（来自其他设备/旧迁移）内容不同 → 迁移跳过，绝不拿主文件快照覆盖
	await adapter.write(shardPath(fp, 'deviceF'), JSON.stringify({ deviceId: 'deviceF', annotations: [ann('keep', 9000)] }));
	await f.migrateAnnotationsToShards();
	assert.deepEqual(readShard(files, fp, 'deviceF').annotations.map((x) => x.id), ['keep']);
});

test('开启同步目录前的旧配置目录批注：只读合并，不丢也不冲掉新数据', async () => {
	const { adapter } = makeAdapter();
	const fp = 'book6';
	const legacy = `${CONFIG_DIR}/plugins/fleur-epub/data/${fp}.json`;
	await adapter.write(legacy, JSON.stringify(book(fp, [ann('old1', 1000)])));
	await adapter.write(mainPath(fp), JSON.stringify(book(fp, [ann('new1', 2000)])));

	const g = await newDevice(adapter, 'deviceG');
	const loaded = await g.load(fp);
	assert.ok(loaded);
	assert.deepEqual(loaded.annotations.map((x) => x.id).sort(), ['new1', 'old1']);
	// 只读：旧文件保持原样
	assert.ok((await adapter.read(legacy)).includes('old1'));
});

test('配置目录里的设备标识被污染（含目录穿越字符）时，分片文件名仍被限制在 ann 目录内', async () => {
	const { adapter, files } = makeAdapter();
	// 模拟「没有 localStorage、只能读配置目录文件」的旧运行时，文件内容被人改坏
	(globalThis as { localStorage?: Storage }).localStorage = {
		getItem: () => {
			throw new Error('localStorage blocked');
		},
		setItem: () => {
			throw new Error('localStorage blocked');
		},
	} as unknown as Storage;
	await adapter.write(`${CONFIG_DIR}/plugins/fleur-epub/device-id`, '  ../../escape/..\\evil  ');

	const store = new BookStore(makeApp(adapter), makePlugin());
	const id = await (store as unknown as { getDeviceId(): Promise<string> }).getDeviceId();
	assert.match(id, /^[A-Za-z0-9_-]{1,64}$/, `设备标识未净化：${id}`);
	assert.ok(!id.includes('..'));

	await store.save(book('book9', [ann('x1', Date.now())]));
	const shards = [...files.keys()].filter((k) => k.includes('/ann/book9/'));
	assert.equal(shards.length, 1);
	assert.ok(shards[0].startsWith(`${DATA_DIR}/ann/book9/`), `分片越界：${shards[0]}`);
	assert.ok(!shards[0].includes('..'));
});

// ── 批注文字（comment）的合并语义：正文编辑器只改 comment 时曾漏刷 updatedAt，
//    分片回读会按「同时间戳 → canonical 字典序」把带 comment 的那份顶掉（表现为
//    写完批注只剩高亮、点开只有「清除高亮」、侧边栏看不到批注内容）。
test('只改 comment、未刷 updatedAt：保存后批注文字不被分片旧副本顶掉', async () => {
	const { adapter } = makeAdapter();
	const fp = 'book7';
	const a = await newDevice(adapter, 'deviceA');
	const item = ann('c1', Date.now());
	await a.save(book(fp, [item]));

	// 模拟正文编辑器的保存：只写 comment（updatedAt 仍是创建时间）
	item.comment = '我的想法';
	await a.save(book(fp, [item]));

	// 另一台设备同步后加载，批注文字必须还在
	const b = await newDevice(adapter, 'deviceB');
	const loaded = await b.load(fp);
	assert.ok(loaded);
	assert.equal(loaded.annotations.find((x) => x.id === 'c1')?.comment, '我的想法');
});

test('同一时间戳下显式清除批注：不会被旧副本里的 comment 复活', async () => {
	const { adapter } = makeAdapter();
	const fp = 'book8';
	const now = Date.now();
	const a = await newDevice(adapter, 'deviceA');
	const item = ann('c2', now, { comment: '旧想法' });
	await a.save(book(fp, [item]));

	item.comment = undefined;
	item.updatedAt = now + 1000; // updateAnnotationComment 会推进时间
	await a.save(book(fp, [item]));

	const b = await newDevice(adapter, 'deviceB');
	const loaded = await b.load(fp);
	assert.ok(loaded);
	assert.equal(loaded.annotations.find((x) => x.id === 'c2')?.comment, undefined);
});
