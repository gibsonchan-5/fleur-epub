/**
 * 旧 WebView 兼容层（Android 常见：MIUI 平板 WebView 长期不更新）。
 * vendored foliate-js 的 epub.js / epubcfi.js 使用了：
 * - Array.prototype.at()        → Chrome 92+
 * - String.prototype.replaceAll → Chrome 85+
 * esbuild target 只转译语法、不补 API，因此这两个缺失会直接让 EPUB
 * 解析抛 TypeError，表现为「打开书空白」。书架路径不涉及，故书架正常。
 * 在插件 onload 最前调用，先于任何 book 解析执行。
 */
export function installCompatPolyfills(): void {
	// Array.prototype.at（含 TypedArray 不需要，仅普通数组够用）
	const arrProto = Array.prototype as unknown as Record<string, unknown>;
	if (typeof arrProto.at !== 'function') {
		arrProto.at = function (this: unknown[], n: number): unknown {
			const len = this.length;
			const i = Math.trunc(n) || 0;
			if (i < 0) return this[len + i];
			if (i >= len) return undefined;
			return this[i];
		};
	}
	// String.prototype.replaceAll（与原生语义一致：RegExp 必须带 g 标志）
	const strProto = String.prototype as unknown as Record<string, unknown>;
	if (typeof strProto.replaceAll !== 'function') {
		strProto.replaceAll = function (
			this: unknown,
			search: string | RegExp,
			replacement: string | ((m: string) => string),
		): string {
			const self = this as string;
			if (search instanceof RegExp) {
				if (!search.global) throw new TypeError('String.prototype.replaceAll requires a global regex');
				return self.replace(search, replacement as (substring: string, ...args: unknown[]) => string);
			}
			return self.split(search).join(replacement as string);
		};
	}
}
