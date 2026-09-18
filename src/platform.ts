// 平台分支基建：桌面端零影响的核心守卫。
// 所有移动端专属逻辑必须经由 isMobileUI() 判断；所有移动端样式必须限定在
// MOBILE_BODY_CLASS（body.fleur-epub-mobile）作用域下——桌面端该类永不挂载。

import { Platform } from 'obsidian';
import type FleurEpubPlugin from './main';

/** body 上的移动端标记类名：真机移动端与桌面调试开关共用同一 CSS 作用域 */
export const MOBILE_BODY_CLASS = 'fleur-epub-mobile';

/**
 * 是否启用移动端 UI：仅真机移动端（Platform.isMobile）。
 * 原「桌面端移动端调试」开关已移除（移动端适配已成熟，不再需要桌面预览入口）。
 */
export function isMobileUI(_plugin: FleurEpubPlugin): boolean {
	return Platform.isMobile;
}

/** 把移动端标记类同步到 body（onload 时调用） */
export function applyMobileBodyClass(_plugin: FleurEpubPlugin): void {
	document.body.classList.toggle(MOBILE_BODY_CLASS, isMobileUI(_plugin));
}
