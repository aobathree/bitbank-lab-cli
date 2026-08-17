import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// vitest の対象は cli/ のテストのみ。scripts/ 配下には node:test で動く原型
		// （scripts/dev/tax/tests/）があり、既定パターンだと拾って "No test suite found" で落ちる。
		include: ["cli/**/*.test.ts"],
		setupFiles: ["cli/__tests__/setup.ts"],
		testTimeout: 15000,
		coverage: {
			provider: "v8",
			include: ["cli/**/*.ts"],
			exclude: [
				"cli/__tests__/**",
				"cli/index.ts", // subprocess 経由でのみ実行されるエントリ
				"cli/types.ts", // 型定義のみ
			],
			thresholds: {
				statements: 80,
				branches: 70,
				functions: 80,
				lines: 80,
			},
		},
	},
});
