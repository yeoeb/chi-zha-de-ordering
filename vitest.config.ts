import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: "./wrangler.json" },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						MERCHANT_DEV_BYPASS: "true",
						NOTIFICATION_PROVIDER: "fake",
						PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS: "true",
					},
				},
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
		},
	};
});
