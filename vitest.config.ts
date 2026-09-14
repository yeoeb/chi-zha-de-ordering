import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

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
						MERCHANT_DEV_ACTOR_SUBJECT: "local-test-merchant-subject",
						MERCHANT_HOSTNAME: "example.com",
						AUDIT_ACTOR_HASH_KEY: "local-test-audit-key-32-bytes-minimum",
						PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS: "true",
					},
				},
			}),
		],
		test: {
			setupFiles: ["./test/apply-migrations.ts"],
			exclude: [...configDefaults.exclude, "test/**/*.dom.test.tsx"],
		},
	};
});
