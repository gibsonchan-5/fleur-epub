// Node 测试用的 obsidian 运行时替身：仓库里没有可执行的 obsidian 包（main 为空），
// 纯逻辑模块一旦在运行时用到 Notice / Platform / requestUrl，就需要这个替身。
// 用法：npx tsx --test --alias:obsidian=./test/mocks/obsidian.ts test/*.test.ts
export class Notice {
	constructor(public message: string, public timeout?: number) {}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
	hide(): void {
		/* 测试里不显示任何东西 */
	}
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isMobileApp: false,
	isSafari: false,
};

export async function requestUrl(): Promise<never> {
	throw new Error('测试环境不应发起网络请求');
}
