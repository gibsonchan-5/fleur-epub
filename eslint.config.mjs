// eslint.config.mjs
// Obsidian 官方审核规则（eslint-plugin-obsidianmd）。
// vendor/foliate-js 是上游 foliate-js 的 vendored 副本（非插件代码），
// 按官方配置指南对非插件代码整体忽略，不做规则改造；main.js 为构建产物。
import obsidianmd from 'eslint-plugin-obsidianmd';

export default [
	{
		ignores: ['vendor/**', 'main.js', 'node_modules/**'],
	},
	...obsidianmd.configs.recommended,
];
