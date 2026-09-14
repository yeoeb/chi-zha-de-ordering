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

function expectWranglerFailure(arguments_, expectedMessage) {
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
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (result.status === 0 || !output.includes(expectedMessage)) {
		throw new Error(`Expected Wrangler failure containing ${expectedMessage}:\n${output}`);
	}
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
				(SELECT COUNT(*) FROM store_settings WHERE id = 1 AND display_name = '吃炸的' AND state_version = 0) AS storeCount,
				(SELECT COUNT(*) FROM menu_items) AS menuItemCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'orders_public_lookup_token_unique') AS publicTokenIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'notification_deliveries_status_idx') AS notificationStatusIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'web_push_notification_deliveries') AS pushDeliveryTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'web_push_notification_deliveries_status_idx') AS pushDeliveryIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'merchant_push_subscriptions') AS pushSubscriptionTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'merchant_push_subscriptions_updated_idx') AS pushSubscriptionIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_state_events') AS storeEventTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'store_state_events_created_idx') AS storeEventIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'line_merchant_binding') AS lineBindingTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'line_merchant_pairing_challenge') AS lineChallengeTableCount`,
		], true),
	);

	if (
		summary.migrationCount !== 10 ||
		summary.storeCount !== 1 ||
		summary.menuItemCount !== 5 ||
		summary.publicTokenIndexCount !== 1 ||
		summary.notificationStatusIndexCount !== 1 ||
		summary.pushDeliveryTableCount !== 1 ||
		summary.pushDeliveryIndexCount !== 1 ||
		summary.pushSubscriptionTableCount !== 1 ||
		summary.pushSubscriptionIndexCount !== 1 ||
		summary.storeEventTableCount !== 1 ||
		summary.storeEventIndexCount !== 1 ||
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
		"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('orders', 'notification_deliveries', 'store_state_events', 'web_push_notification_deliveries') ORDER BY name",
	], true)?.[0]?.results;
	const ordersSql = schemaRows?.find((row) => row.name === "orders")?.sql ?? "";
	const notificationsSql =
		schemaRows?.find((row) => row.name === "notification_deliveries")?.sql ?? "";
	const pushNotificationsSql =
		schemaRows?.find((row) => row.name === "web_push_notification_deliveries")?.sql ?? "";
	const storeEventsSql = schemaRows?.find((row) => row.name === "store_state_events")?.sql ?? "";

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
	if (!storeEventsSql.includes("operation_id TEXT NOT NULL UNIQUE")) {
		throw new Error("Fresh D1 is missing Store operation idempotency uniqueness");
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
	const storeAuditMigration = readFileSync(
		join(root, "migrations", "0010_add_store_state_audit.sql"),
		"utf8",
	);
	if (
		!storeAuditMigration.includes("ADD COLUMN state_version") ||
		!storeAuditMigration.includes("CREATE TABLE store_state_events") ||
		destructiveMigrationPattern.test(storeAuditMigration)
	) {
		throw new Error("Migration 0010 is missing additive Store audit schema or contains a forbidden write");
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
				(SELECT COUNT(*) FROM merchant_push_subscriptions) AS subscriptionCount,
				(SELECT COUNT(*) FROM store_state_events) AS storeEventCount`,
		], true),
	);
	if (
		pushFixtureCounts.deliveryCount !== 0 ||
		pushFixtureCounts.subscriptionCount !== 0 ||
		pushFixtureCounts.storeEventCount !== 0
	) {
		throw new Error(`Fresh D1 contains unexpected Web Push fixtures: ${JSON.stringify(pushFixtureCounts)}`);
	}

	for (const invalidVersion of ["0.5", "'not-a-version'", "-1", "9007199254740992"]) {
		expectWranglerFailure(
			[
				"d1",
				"execute",
				database,
				"--command",
				`UPDATE store_settings SET state_version = ${invalidVersion} WHERE id = 1`,
			],
			"CHECK constraint failed",
		);
	}
	runWrangler([
		"d1",
		"execute",
		database,
		"--command",
		"UPDATE store_settings SET state_version = 9007199254740991 WHERE id = 1",
	]);
	const maximumVersion = firstResult(
		runWrangler(
			[
				"d1",
				"execute",
				database,
				"--json",
				"--command",
				"SELECT typeof(state_version) AS storageType, state_version AS stateVersion FROM store_settings WHERE id = 1",
			],
			true,
		),
	);
	if (maximumVersion.storageType !== "integer" || maximumVersion.stateVersion !== Number.MAX_SAFE_INTEGER) {
		throw new Error(`Maximum safe Store revision was not preserved: ${JSON.stringify(maximumVersion)}`);
	}
	runWrangler([
		"d1",
		"execute",
		database,
		"--command",
		"UPDATE store_settings SET state_version = 0 WHERE id = 1",
	]);

	const auditBase = {
		expected: "0",
		from: "0",
		to: "0",
	};
	for (const [column, value] of [
		["expected_state_version", "0.5"],
		["from_state_version", "'not-a-version'"],
		["to_state_version", "9007199254740992"],
	]) {
		const versions = { ...auditBase };
		versions[column === "expected_state_version" ? "expected" : column === "from_state_version" ? "from" : "to"] = value;
		expectWranglerFailure(
			[
				"d1",
				"execute",
				database,
				"--command",
				`INSERT INTO store_state_events (
					id, operation_id, request_fingerprint, action,
					expected_accepting, expected_state_version,
					from_accepting, to_accepting, from_state_version, to_state_version,
					outcome, actor_subject_hash, created_at
				) VALUES (
					'probe-${column}', '00000000-0000-4000-8000-000000000001',
					'${"a".repeat(64)}', 'resume', 0, ${versions.expected},
					0, 0, ${versions.from}, ${versions.to}, 'stale', '${"b".repeat(64)}',
					'2026-09-15T00:00:00.000Z'
				)`,
			],
			"CHECK constraint failed",
		);
	}

	runWrangler(["d1", "migrations", "apply", database]);
	const secondHistory = runWrangler([
		"d1",
		"execute",
		database,
		"--json",
		"--command",
		"SELECT COUNT(*) AS migrationCount FROM d1_migrations",
	], true);
	if (firstResult(secondHistory).migrationCount !== 10) {
		throw new Error("Second fresh D1 migration apply changed migration history");
	}
	if (firstResult(runWrangler(["d1", "execute", database, "--json", "--command", "PRAGMA quick_check"], true)).quick_check !== "ok") {
		throw new Error("Fresh D1 quick_check failed");
	}

	console.log(
		"Fresh D1 PASS: 10 sequential migrations, Store state version/audit constraints, idempotent second apply, required store row, replaceable development seed, untouched historical LINE tables, additive Web Push tables, no Store/Push fixtures, and quick_check verified.",
	);
} finally {
	const resolvedPersistence = resolve(persistenceDirectory);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedPersistence.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove a directory outside the system temporary directory");
	}
	rmSync(resolvedPersistence, { recursive: true, force: true });
}
