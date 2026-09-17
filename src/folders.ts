/**
 * 「导出文件夹」下拉的候选收集。
 *
 * ## 为什么会有这个模块（旧实现的两个漏点）
 *
 * 旧实现是**从每个条目的路径反推祖先目录**：
 *
 * ```ts
 * this.app.vault.getAllLoadedFiles().forEach((file) => {
 *   if (file.path.includes('/')) {                       // ← 漏点 1
 *     const parts = file.path.split('/');
 *     let current = '';
 *     for (let i = 0; i < parts.length - 1; i++) {       // ← 漏点 2
 *       current = current ? `${current}/${parts[i]}` : parts[i];
 *       folderSet.add(current);
 *     }
 *   }
 * });
 * ```
 *
 * 它只能「由后代反推出祖先」，所以**凡是没有可见后代的文件夹都拿不到**：
 *
 * - **漏点 1**：位于 vault 根的叶子目录（里面没有文件）`path` 不含 `/`，
 *   第一个判断就跳过 → 永远不会进入集合。
 * - **漏点 2**：循环只累加到「最后一段之前」（`i < parts.length - 1`），
 *   也就是目录**自己**不会被加入；空目录没有任何后代能把它反推出来。
 *
 * 实测（用户真实 vault，258 个非隐藏文件夹）：旧算法只列出 233 个，**漏掉 25 个** ——
 * 24 个空文件夹，外加 1 个只含 `.DS_Store` 的目录（`技能学习/视听语言/后期`，
 * 在 Obsidian 里同样没有可见子项）。用户反馈的「点击后看不到空文件夹」正是此因。
 *
 * ## 正确做法
 *
 * **直接枚举文件夹本身**（`vault.getAllFolders()`，@since 1.6.6，本插件 minAppVersion 1.7.2），
 * 而不是从文件路径反推。与 fleur-pdf 的实现保持一致。
 *
 * 本模块只承载纯逻辑（去重 / 排除根 / 排除隐藏目录 / 排序），不 import obsidian，
 * 以便在 Node 验收台里直接单测。
 */

/** 路径中任一段以 `.` 开头（`.obsidian` / `.trash` / `.git` …）视为隐藏目录，不参与选择 */
function isHiddenPath(p: string): boolean {
	return p.split('/').some((seg) => seg.startsWith('.'));
}

/**
 * 收集下拉候选文件夹路径。
 *
 * @param folderPaths vault 里的全部文件夹路径（`this.app.vault.getAllFolders().map(f => f.path)`）
 * @returns 去重、去根、去隐藏后的路径，按字典序排列。
 *          路径分隔符 `/`（U+002F）的码位低于数字、字母与常用汉字，
 *          因此字典序天然是「父在前、其子紧随」，无需另做层级排序。
 */
export function collectFolderPaths(folderPaths: Iterable<string>): string[] {
	const set = new Set<string>();
	for (const p of folderPaths) {
		if (!p || p === '/' || p === '.') continue;
		if (isHiddenPath(p)) continue;
		set.add(p);
	}
	return Array.from(set).sort();
}
