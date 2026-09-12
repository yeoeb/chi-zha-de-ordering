import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const safeTempRoot = realpathSync(tmpdir());
const persistenceDirectory = mkdtempSync(join(safeTempRoot, "chi-zha-de-fresh-d1-"));
const database = "DB";
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

function runWrangler(arguments_, expectJson = false) {
	const result = spawnSync(
		process.execPath,
		[
			wranglerBin,
			...arguments_,
			"--local",
			"--persist-to",
			persistenceDirectory,
			"--config",
			join(root, "wrangler.json"),
		],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, CI: "true", NO_COLOR: "1" },
		},
	);

	if (result.status !== 0) {
		throw new Error(`Wrangler command failed: ${result.error ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	}

	if (!expectJson) {
		process.stdout.write(result.stdout);
		return undefined;
	}

	return JSON.parse(result.stdout);
}

function firstResult(output) {
	const row = output?.[0]?.results?.[0];
	if (!row) {
		throw new Error(`Fresh D1 verification query returned no rows: ${JSON.stringify(output)}`);
	}
	return row;
}

try {
	runWrangler(["d1", "migrations", "apply", database]);
	runWrangler(["d1", "execute", database, "--file", join(root, "seeds", "development.sql")]);

	const summary = firstResult(
		runWrangler([
			"d1",
			"execute",
			database,
			"--json",
			"--command",
			`SELECT
				(SELECT COUNT(*) FROM d1_migrations) AS migrationCount,
				(SELECT COUNT(*) FROM store_settings WHERE id = 1 AND display_name = '吃炸的') AS storeCount,
				(SELECT COUNT(*) FROM menu_items) AS menuItemCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'orders_public_lookup_token_unique') AS publicTokenIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'notification_deliveries_status_idx') AS notificationStatusIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'web_push_notification_deliveries') AS pushDeliveryTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'web_push_notification_deliveries_status_idx') AS pushDeliveryIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'merchant_push_subscriptions') AS pushSubscriptionTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'merchant_push_subscriptions_updated_idx') AS pushSubscriptionIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'line_merchant_binding') AS lineBindingTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'line_merchant_pairing_challenge') AS lineChallengeTableCount`,
		], true),
	);

	if (
		summary.migrationCount !== 9 ||
		summary.storeCount !== 1 ||
		summary.menuItemCount !== 5 ||
		summary.publicTokenIndexCount !== 1 ||
		summary.notificationStatusIndexCount !== 1 ||
		summary.pushDeliveryTableCount !== 1 ||
		summary.pushDeliveryIndexCount !== 1 ||
		summary.pushSubscriptionTableCount !== 1 ||
		summary.pushSubscriptionIndexCount !== 1 ||
		summary.lineBindingTableCount !== 1 ||
		summary.lineChallengeTableCount !== 1
	) {
		throw new Error(`Unexpected fresh D1 summary: ${JSON.stringify(summary)}`);
	}

	const schemaRows = runWrangler([
		"d1",
		"execute",
		database,
		"--json",
		"--command",
		"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('orders', 'notification_deliveries', 'web_push_notification_deliveries') ORDER BY name",
	], true)?.[0]?.results;
	const ordersSql = schemaRows?.find((row) => row.name === "orders")?.sql ?? "";
	const notificationsSql =
		schemaRows?.find((row) => row.name === "notification_deliveries")?.sql ?? "";
	const pushNotificationsSql =
		schemaRows?.find((row) => row.name === "web_push_notification_deliveries")?.sql ?? "";

	if (!ordersSql.includes("idempotency_key TEXT NOT NULL UNIQUE")) {
		throw new Error("Fresh D1 is missing the Order idempotency uniqueness constraint");
	}
	if (!notificationsSql.includes("UNIQUE (order_id, channel, event_type)")) {
		throw new Error("Fresh D1 is missing historical LINE notification intent uniqueness");
	}
	if (!notificationsSql.includes("channel = 'line'")) {
		throw new Error("Fresh D1 changed the historical LINE delivery channel constraint");
	}
	if (!pushNotificationsSql.includes("UNIQUE (order_id, event_type)")) {
		throw new Error("Fresh D1 is missing Web Push notification intent uniqueness");
	}

	const columns = runWrangler([
		"d1",
		"execute",
		database,
		"--json",
		"--command",
		"PRAGMA table_info(notification_deliveries)",
	], true)?.[0]?.results;
	if (!columns?.some((column) => column.name === "last_attempt_at")) {
		throw new Error("Fresh D1 is missing notification_deliveries.last_attempt_at");
	}
	const pushDeliveryColumns = runWrangler([
		"d1",
		"execute",
		database,
		"--json",
		"--command",
		"PRAGMA table_info(web_push_notification_deliveries)",
	], true)?.[0]?.results;
	if (!pushDeliveryColumns?.some((column) => column.name === "last_attempt_at")) {
		throw new Error("Fresh D1 is missing web_push_notification_deliveries.last_attempt_at");
	}

	const notificationMigration = readFileSync(join(root, "migrations", "0007_add_notification_last_attempt_at.sql"), "utf8");
	if (!notificationMigration.includes("last_attempt_at")) {
		throw new Error("Migration 0007 content could not be verified");
	}
	const pairingMigration = readFileSync(join(root, "migrations", "0008_create_line_merchant_pairing.sql"), "utf8");
	if (
		!pairingMigration.includes("line_merchant_binding") ||
		!pairingMigration.includes("line_merchant_pairing_challenge")
	) {
		throw new Error("Migration 0008 content could not be verified");
	}
	const pushMigration = readFileSync(join(root, "migrations", "0009_create_merchant_push_subscriptions.sql"), "utf8");
	const destructiveMigrationPattern = /^\s*(?:DROP\s+(?:TABLE|COLUMN)|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+RENAME|UPDATE\s+\S+|INSERT\s+INTO)\b/im;
	if (
		!pushMigration.includes("merchant_push_subscriptions") ||
		!pushMigration.includes("web_push_notification_deliveries") ||
		destructiveMigrationPattern.test(pushMigration)
	) {
		throw new Error("Migration 0009 is missing additive Web Push schema or contains a forbidden write");
	}
	const pushFixtureCounts = firstResult(
		runWrangler([
			"d1",
			"execute",
			database,
			"--json",
			"--command",
			`SELECT
				(SELECT COUNT(*) FROM web_push_notification_deliveries) AS deliveryCount,
				(SELECT COUNT(*) FROM merchant_push_subscriptions) AS subscriptionCount`,
		], true),
	);
	if (pushFixtureCounts.deliveryCount !== 0 || pushFixtureCounts.subscriptionCount !== 0) {
		throw new Error(`Fresh D1 contains unexpected Web Push fixtures: ${JSON.stringify(pushFixtureCounts)}`);
	}

	console.log(
		"Fresh D1 PASS: 9 sequential migrations, required store row, replaceable 5-item development seed, untouched historical LINE delivery/pairing tables, additive Web Push intent/subscription tables, and no Push fixtures verified.",
	);
} finally {
	const resolvedPersistence = resolve(persistenceDirectory);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedPersistence.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove a directory outside the system temporary directory");
	}
	rmSync(resolvedPersistence, { recursive: true, force: true });
}
