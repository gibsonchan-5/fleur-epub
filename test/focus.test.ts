// 桌面全屏状态机的纯决策测试：进入时快照侧栏开合，退出时只恢复原本展开的一侧。
// 运行：node --test test/focus.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { toggleFocusState } from '../src/focus.ts';
import type { FocusSnapshot } from '../src/focus.ts';
import {
	BAR_REVEAL_ZONE,
	FOCUS_CLASS,
	clearReaderFocus,
	isReaderFocusActive,
	shouldHideBarAfterLeave,
	toggleReaderFocus,
} from '../src/focus.ts';

function fakeDoc(): Document {
	const classes = new Set<string>();
	return {
		body: {
			classList: {
				add: (c: string) => classes.add(c),
				remove: (c: string) => classes.delete(c),
				contains: (c: string) => classes.has(c),
			},
		},
	} as unknown as Document;
}

function fakeWorkspace(left: boolean, right: boolean) {
	const calls: string[] = [];
	const ws = {
		leftSplit: {
			collapsed: left,
			collapse: () => { calls.push('collapse-left'); ws.leftSplit.collapsed = true; },
			expand: () => { calls.push('expand-left'); ws.leftSplit.collapsed = false; },
		},
		rightSplit: {
			collapsed: right,
			collapse: () => { calls.push('collapse-right'); ws.rightSplit.collapsed = true; },
			expand: () => { calls.push('expand-right'); ws.rightSplit.collapsed = false; },
		},
	};
	return { ws: ws as never, calls };
}

test('进入全屏：两侧都展开时记录快照并收起两侧', () => {
	const t = toggleFocusState(null, false, false);
	assert.equal(t.active, true);
	assert.deepEqual(t.snapshot, { left: false, right: false });
	assert.equal(t.collapseLeft, true);
	assert.equal(t.collapseRight, true);
	assert.equal(t.expandLeft, false);
	assert.equal(t.expandRight, false);
});

test('进入全屏：已收起的一侧不再重复收起，快照保留真实状态', () => {
	const t = toggleFocusState(null, true, false);
	assert.deepEqual(t.snapshot, { left: true, right: false });
	assert.equal(t.collapseLeft, false);
	assert.equal(t.collapseRight, true);
});

test('退出全屏：只展开进入前原本展开的侧栏', () => {
	const snapshot: FocusSnapshot = { left: false, right: true };
	const t = toggleFocusState(snapshot, true, true);
	assert.equal(t.active, false);
	assert.equal(t.snapshot, null);
	assert.equal(t.expandLeft, true);
	assert.equal(t.expandRight, false);
	assert.equal(t.collapseLeft, false);
	assert.equal(t.collapseRight, false);
});

test('退出后再次进入：按当前侧栏状态重新取快照，不沿用旧值', () => {
	const exited = toggleFocusState({ left: false, right: false }, true, true);
	assert.equal(exited.snapshot, null);
	const reentered = toggleFocusState(exited.snapshot, true, false);
	assert.deepEqual(reentered.snapshot, { left: true, right: false });
	assert.equal(reentered.collapseRight, true);
	assert.equal(reentered.collapseLeft, false);
});

test('运行时：进入加 body 类并收起侧栏，退出撤类并只展开原本展开的一侧', () => {
	const doc = fakeDoc();
	const { ws, calls } = fakeWorkspace(false, true);

	assert.equal(toggleReaderFocus(doc, ws), true);
	assert.equal(isReaderFocusActive(doc), true);
	assert.equal(doc.body.classList.contains(FOCUS_CLASS), true);
	assert.deepEqual(calls, ['collapse-left']);

	assert.equal(toggleReaderFocus(doc, ws), false);
	assert.equal(isReaderFocusActive(doc), false);
	assert.equal(doc.body.classList.contains(FOCUS_CLASS), false);
	assert.deepEqual(calls, ['collapse-left', 'expand-left']);
});

test('运行时：clearReaderFocus 恢复侧栏并清空所有窗口状态', () => {
	const doc = fakeDoc();
	const { ws, calls } = fakeWorkspace(false, false);

	toggleReaderFocus(doc, ws);
	clearReaderFocus();

	assert.equal(isReaderFocusActive(doc), false);
	assert.equal(doc.body.classList.contains(FOCUS_CLASS), false);
	assert.deepEqual(calls, ['collapse-left', 'collapse-right', 'expand-left', 'expand-right']);
});

test('顶栏自动隐藏：指针仍在顶部唤醒带内时不收起', () => {
	assert.equal(shouldHideBarAfterLeave(0), false);
	assert.equal(shouldHideBarAfterLeave(BAR_REVEAL_ZONE), false);
});

test('顶栏自动隐藏：指针离开顶部唤醒带后收起', () => {
	assert.equal(shouldHideBarAfterLeave(BAR_REVEAL_ZONE + 1), true);
	assert.equal(shouldHideBarAfterLeave(200), true);
});
