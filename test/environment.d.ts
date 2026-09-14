declare namespace Cloudflare {
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
		AUDIT_ACTOR_HASH_KEY: string;
		MERCHANT_DEV_ACTOR_SUBJECT: string;
	}

	interface GlobalProps {
		mainModule: typeof import("../src/worker/index");
	}
}
