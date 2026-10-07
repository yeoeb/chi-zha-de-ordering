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
	runWrangler(["d1", "execute", database, "--file", join(root, "seeds", "ensure-spice-modifiers.sql")]);

	const summary = firstResult(
		runWrangler([
			"d1",
			"execute",
			database,
			"--json",
			"--command",
			`SELECT
				(SELECT COUNT(*) FROM d1_migrations) AS migrationCount,
				(SELECT COUNT(*) FROM store_settings WHERE id = 1 AND display_name = '吃炸的' AND state_version = 0
					AND busy_mode = 0 AND missed_order_count = 0 AND auto_pause_reason IS NULL
					AND weekly_business_hours IS NOT NULL AND last_order_time = '23:15'
					AND customer_phone_mode = 'optional' AND show_product_images = 1
					AND new_order_sound_enabled = 1) AS storeCount,
				(SELECT COUNT(*) FROM menu_items) AS menuItemCount,
				(SELECT COUNT(*) FROM modifier_groups WHERE id IN (5, 6) AND menu_item_id IN (9, 10) AND name = '調味' AND is_required = 1 AND is_active = 1) AS seasoningGroupCount,
				(SELECT COUNT(*) FROM modifier_options WHERE id BETWEEN 15 AND 20 AND name IN ('梅粉', '胡椒') AND is_active = 1) AS seasoningOptionCount,
				(SELECT COUNT(*) FROM modifier_options WHERE id IN (17, 20) AND name = '不加調味' AND is_active = 0) AS retiredSeasoningOptionCount,
				(SELECT COUNT(*) FROM modifier_options WHERE id BETWEEN 21 AND 26 AND name IN ('微辣', '辣粉另包') AND is_active = 1) AS addedSpiceOptionCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'orders_public_lookup_token_unique') AS publicTokenIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'notification_deliveries_status_idx') AS notificationStatusIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'web_push_notification_deliveries') AS pushDeliveryTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'web_push_notification_deliveries_status_idx') AS pushDeliveryIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'merchant_push_subscriptions') AS pushSubscriptionTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'merchant_push_subscriptions_updated_idx') AS pushSubscriptionIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_state_events') AS storeEventTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'store_state_events_created_idx') AS storeEventIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'line_merchant_binding') AS lineBindingTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'line_merchant_pairing_challenge') AS lineChallengeTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'menu_items_customer_visibility_sort_idx') AS adminMenuIndexCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_busy_mode_events') AS busyEventTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'order_auto_rejection_events') AS autoRejectEventTableCount,
				(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_pending_auto_reject') AS autoRejectIndexCount`,
		], true),
	);

	if (
		summary.migrationCount !== 20 ||
		summary.storeCount !== 1 ||
		summary.menuItemCount !== 46 ||
		summary.seasoningGroupCount !== 2 ||
		summary.seasoningOptionCount !== 4 ||
		summary.retiredSeasoningOptionCount !== 2 ||
		summary.addedSpiceOptionCount !== 6 ||
		summary.publicTokenIndexCount !== 1 ||
		summary.notificationStatusIndexCount !== 1 ||
		summary.pushDeliveryTableCount !== 1 ||
		summary.pushDeliveryIndexCount !== 1 ||
		summary.pushSubscriptionTableCount !== 1 ||
		summary.pushSubscriptionIndexCount !== 1 ||
		summary.storeEventTableCount !== 1 ||
		summary.storeEventIndexCount !== 1 ||
		summary.lineBindingTableCount !== 1 ||
		summary.lineChallengeTableCount !== 1 ||
		summary.adminMenuIndexCount !== 1 ||
		summary.busyEventTableCount !== 1 ||
		summary.autoRejectEventTableCount !== 1 ||
		summary.autoRejectIndexCount !== 1
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
	const orderColumns = runWrangler([
		"d1",
		"execute",
		database,
		"--json",
		"--command",
		"PRAGMA table_info(orders)",
	], true)?.[0]?.results;
	if (!orderColumns?.some((column) => column.name === "customer_note")) {
		throw new Error("Fresh D1 is missing orders.customer_note");
	}
	if (!orderColumns?.some((column) => column.name === "packaging_preference")) {
		throw new Error("Fresh D1 is missing orders.packaging_preference");
	}
	if (!orderColumns?.some((column) => column.name === "order_source")) {
		throw new Error("Fresh D1 is missing orders.order_source");
	}
	for (const name of ["shortage_policy", "original_total_amount", "shortage_revision", "cancelled_at", "cancellation_reason"]) {
		if (!orderColumns?.some((column) => column.name === name)) {
			throw new Error(`Fresh D1 is missing orders.${name}`);
		}
	}
	if (!orderColumns?.some((column) => column.name === "rejection_reason")) {
		throw new Error("Fresh D1 is missing orders.rejection_reason");
	}
	const shortageRequestColumns = runWrangler([
		"d1",
		"execute",
		database,
		"--json",
		"--command",
		"PRAGMA table_info(order_shortage_requests)",
	], true)?.[0]?.results;
	if (!shortageRequestColumns?.some((column) => column.name === "request_fingerprint" && column.notnull === 1)) {
		throw new Error("Fresh D1 is missing the required shortage request fingerprint");
	}
	const menuItemColumns = runWrangler([
		"d1",
		"execute",
		database,
		"--json",
		"--command",
		"PRAGMA table_info(menu_items)",
	], true)?.[0]?.results;
	for (const name of ["image_url", "is_popular", "is_quick_sold_out", "is_archived"]) {
		if (!menuItemColumns?.some((column) => column.name === name)) {
			throw new Error(`Fresh D1 is missing menu_items.${name}`);
		}
	}
	const soldOutColumn = menuItemColumns?.find((column) => column.name === "sold_out_business_date");
	if (!soldOutColumn || soldOutColumn.type !== "TEXT" || soldOutColumn.notnull !== 0 || soldOutColumn.dflt_value !== "NULL") {
		throw new Error("Fresh D1 daily sold-out marker must be nullable TEXT DEFAULT NULL");
	}
	const soldOutMigration = readFileSync(join(root, "migrations", "0020_add_sold_out_business_date.sql"), "utf8");
	if (!/^\s*ALTER TABLE menu_items ADD COLUMN sold_out_business_date TEXT DEFAULT NULL;\s*$/.test(soldOutMigration)) {
		throw new Error("Migration 0020 must only add the nullable daily sold-out marker");
	}
	if (firstResult(runWrangler(["d1", "execute", database, "--json", "--command",
		"SELECT COUNT(*) AS markedCount FROM menu_items WHERE sold_out_business_date IS NOT NULL"], true)).markedCount !== 0) {
		throw new Error("Fresh daily sold-out marker must not backfill unavailable fixtures");
	}
	const storeColumns = runWrangler([
		"d1",
		"execute",
		database,
		"--json",
		"--command",
		"PRAGMA table_info(store_settings)",
	], true)?.[0]?.results;
	for (const name of ["origin_disclosure", "busy_mode", "missed_order_count", "auto_pause_reason", "weekly_business_hours", "last_order_time", "customer_phone_mode", "show_product_images", "new_order_sound_enabled"]) {
		if (!storeColumns?.some((column) => column.name === name)) {
			throw new Error(`Fresh D1 is missing store_settings.${name}`);
		}
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
	const customerNoteMigration = readFileSync(
		join(root, "migrations", "0011_add_customer_note.sql"),
		"utf8",
	);
	if (
		!customerNoteMigration.includes("ADD COLUMN customer_note") ||
		!customerNoteMigration.includes("length(customer_note) BETWEEN 1 AND 120") ||
		destructiveMigrationPattern.test(customerNoteMigration)
	) {
		throw new Error("Migration 0011 is missing the additive customer_note schema or contains a forbidden write");
	}
	const adminMenuMigration = readFileSync(
		join(root, "migrations", "0012_add_admin_menu_metadata.sql"),
		"utf8",
	);
	if (
		!adminMenuMigration.includes("ADD COLUMN image_url") ||
		!adminMenuMigration.includes("ADD COLUMN is_popular") ||
		!adminMenuMigration.includes("ADD COLUMN is_quick_sold_out") ||
		!adminMenuMigration.includes("ADD COLUMN is_archived") ||
		!adminMenuMigration.includes("ADD COLUMN origin_disclosure") ||
		destructiveMigrationPattern.test(adminMenuMigration)
	) {
		throw new Error("Migration 0012 is missing additive Admin menu schema or contains a forbidden write");
	}
	const packagingMigration = readFileSync(
		join(root, "migrations", "0013_add_order_packaging_preference.sql"),
		"utf8",
	);
	if (
		!packagingMigration.includes("ADD COLUMN packaging_preference") ||
		!packagingMigration.includes("'together', 'separate_spicy'") ||
		destructiveMigrationPattern.test(packagingMigration)
	) {
		throw new Error("Migration 0013 is missing the additive packaging preference schema or contains a forbidden write");
	}
	const orderSourceMigration = readFileSync(
		join(root, "migrations", "0014_add_order_source.sql"),
		"utf8",
	);
	if (
		!orderSourceMigration.includes("ADD COLUMN order_source") ||
		!orderSourceMigration.includes("'online', 'onsite'") ||
		destructiveMigrationPattern.test(orderSourceMigration)
	) {
		throw new Error("Migration 0014 is missing the additive order source schema or contains a forbidden write");
	}
	const shortageMigration = readFileSync(
		join(root, "migrations", "0015_add_order_shortage_and_cancellation.sql"),
		"utf8",
	);
	if (
		!shortageMigration.includes("ADD COLUMN shortage_policy") ||
		!shortageMigration.includes("CREATE TABLE order_item_shortages") ||
		!shortageMigration.includes("CREATE TABLE order_shortage_requests") ||
		destructiveMigrationPattern.test(shortageMigration)
	) {
		throw new Error("Migration 0015 is missing additive shortage/cancellation schema or contains a forbidden write");
	}
	const shortageFingerprintMigration = readFileSync(
		join(root, "migrations", "0016_add_shortage_request_fingerprint.sql"),
		"utf8",
	);
	if (
		!shortageFingerprintMigration.includes("ADD COLUMN request_fingerprint TEXT NOT NULL") ||
		destructiveMigrationPattern.test(shortageFingerprintMigration)
	) {
		throw new Error("Migration 0016 is missing the additive shortage request fingerprint or contains a forbidden write");
	}
	const automationMigration = readFileSync(
		join(root, "migrations", "0017_add_operational_automation.sql"),
		"utf8",
	);
	if (
		!automationMigration.includes("ADD COLUMN busy_mode") ||
		!automationMigration.includes("ADD COLUMN missed_order_count") ||
		!automationMigration.includes("ADD COLUMN rejection_reason") ||
		!automationMigration.includes("CREATE TABLE store_busy_mode_events") ||
		!automationMigration.includes("CREATE TABLE order_auto_rejection_events") ||
		/^\s*(?:DROP\s+(?:TABLE|COLUMN)|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+RENAME|INSERT\s+INTO)\b/im.test(automationMigration)
	) {
		throw new Error("Migration 0017 is missing operational automation schema or contains a forbidden destructive write");
	}
	const customerStoreConfigurationMigration = readFileSync(
		join(root, "migrations", "0018_add_customer_store_configuration.sql"),
		"utf8",
	);
	if (
		!customerStoreConfigurationMigration.includes("ADD COLUMN weekly_business_hours") ||
		!customerStoreConfigurationMigration.includes("ADD COLUMN last_order_time") ||
		!customerStoreConfigurationMigration.includes("ADD COLUMN customer_phone_mode") ||
		!customerStoreConfigurationMigration.includes("ADD COLUMN show_product_images") ||
		destructiveMigrationPattern.test(customerStoreConfigurationMigration)
	) {
		throw new Error("Migration 0018 is missing additive Customer Store configuration or contains a forbidden write");
	}
	const newOrderSoundMigration = readFileSync(
		join(root, "migrations", "0019_add_new_order_sound_setting.sql"),
		"utf8",
	);
	if (
		!newOrderSoundMigration.includes("ADD COLUMN new_order_sound_enabled") ||
		!newOrderSoundMigration.includes("DEFAULT 1") ||
		destructiveMigrationPattern.test(newOrderSoundMigration)
	) {
		throw new Error("Migration 0019 is missing the additive new Order sound setting or contains a forbidden write");
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
	if (firstResult(secondHistory).migrationCount !== 20) {
		throw new Error("Second fresh D1 migration apply changed migration history");
	}
	if (firstResult(runWrangler(["d1", "execute", database, "--json", "--command", "PRAGMA quick_check"], true)).quick_check !== "ok") {
		throw new Error("Fresh D1 quick_check failed");
	}

	console.log(
		"Fresh D1 PASS: 20 sequential migrations, nullable daily sold-out marker without backfill, Customer Store configuration and new Order sound setting, operational busy/auto-reject schema, additive order source, packaging preference, shortage/cancellation ledgers and request fingerprints, Admin menu metadata and customer_note schema, complete local-only 46-product development menu, API-backed fries seasoning and spice fixtures, Store state version/audit constraints, idempotent second apply, required store row, untouched historical LINE tables, additive Web Push tables, no Store/Push fixtures, and quick_check verified.",
	);
} finally {
	const resolvedPersistence = resolve(persistenceDirectory);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedPersistence.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove a directory outside the system temporary directory");
	}
	rmSync(resolvedPersistence, { recursive: true, force: true });
}
