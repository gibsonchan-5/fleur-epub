/**
 * 阅读器桌面全屏（专注态）：
 * - 纯状态决策 `toggleFocusState` 便于单测；
 * - 运行时按 Document 维护进入前快照，负责 body 类与左右侧栏开合。
 *
 * CSS 依赖的隐藏类定义在 styles.css（body.fleur-epub-focus ...），
 * 隐藏的是 Obsidian 宿主 chrome：根分栏标签栏、缎带、状态栏；
 * macOS 隐藏式标题栏另留 32px 拖动带（见 styles.css）。
 */
import type { Workspace } from 'obsidian';

export const FOCUS_CLASS = 'fleur-epub-focus';

/** 全屏下顶栏自动隐藏：窗口顶部这条透明带负责唤醒（px） */
export const BAR_REVEAL_ZONE = 10;
/** 指针离开顶栏后延迟收起，避免经过边缘时闪烁（ms） */
export const BAR_HIDE_DELAY = 350;

/**
 * 指针离开顶栏时是否应当收起它。
 * 仍停留在顶部唤醒带内时保持显示，否则收起后会立刻被同一指针再次唤醒。
 */
export function shouldHideBarAfterLeave(pointerY: number): boolean {
	return pointerY > BAR_REVEAL_ZONE;
}

export interface FocusSnapshot {
	/** 进入前左栏是否已收起 */
	left: boolean;
	/** 进入前右栏是否已收起 */
	right: boolean;
}

export interface FocusTransition {
	active: boolean;
	/** null 表示退出；非 null 表示进入后的快照 */
	snapshot: FocusSnapshot | null;
	collapseLeft: boolean;
	collapseRight: boolean;
	expandLeft: boolean;
	expandRight: boolean;
}

/**
 * 全屏状态迁移：进入时记录左右栏真实开合，收起尚未收起的；
 * 退出时只展开进入前原本展开的一侧，保留用户原先收起的那一侧。
 */
export function toggleFocusState(
	current: FocusSnapshot | null,
	leftCollapsed: boolean,
	rightCollapsed: boolean,
): FocusTransition {
	if (current === null) {
		return {
			active: true,
			snapshot: { left: leftCollapsed, right: rightCollapsed },
			collapseLeft: !leftCollapsed,
			collapseRight: !rightCollapsed,
			expandLeft: false,
			expandRight: false,
		};
	}
	return {
		active: false,
		snapshot: null,
		collapseLeft: false,
		collapseRight: false,
		expandLeft: !current.left,
		expandRight: !current.right,
	};
}

interface ActiveFocus {
	snapshot: FocusSnapshot;
	workspace: Workspace;
}

const states = new Map<Document, ActiveFocus>();

/** 当前窗口是否处于阅读全屏 */
export function isReaderFocusActive(doc: Document): boolean {
	return states.has(doc);
}

/** 切换指定窗口的阅读全屏，返回切换后的状态 */
export function toggleReaderFocus(doc: Document, ws: Workspace): boolean {
	const transition = toggleFocusState(
		states.get(doc)?.snapshot ?? null,
		ws.leftSplit.collapsed,
		ws.rightSplit.collapsed,
	);
	if (transition.snapshot === null) {
		states.delete(doc);
		doc.body.classList.remove(FOCUS_CLASS);
	} else {
		states.set(doc, { snapshot: transition.snapshot, workspace: ws });
		doc.body.classList.add(FOCUS_CLASS);
	}
	if (transition.collapseLeft) ws.leftSplit.collapse();
	if (transition.collapseRight) ws.rightSplit.collapse();
	if (transition.expandLeft) ws.leftSplit.expand();
	if (transition.expandRight) ws.rightSplit.expand();
	return states.has(doc);
}

/**
 * 清理全部阅读全屏（关闭阅读页 / 插件卸载）：
 * 去掉隐藏类并按快照恢复侧栏，避免把宿主 chrome 留在隐藏状态。
 */
export function clearReaderFocus(): void {
	if (states.size === 0) return;
	for (const [doc, state] of states) {
		doc.body.classList.remove(FOCUS_CLASS);
		if (!state.snapshot.left) state.workspace.leftSplit.expand();
		if (!state.snapshot.right) state.workspace.rightSplit.expand();
	}
	states.clear();
}
