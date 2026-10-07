import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const safeTempRoot = realpathSync(tmpdir());
const verifierRoot = mkdtempSync(join(safeTempRoot, "chi-zha-de-0013-upgrade-"));
const migrationDirectory = join(verifierRoot, "migrations");
const persistenceDirectory = join(verifierRoot, "state");
const configPath = join(verifierRoot, "wrangler.json");
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

mkdirSync(migrationDirectory);
writeFileSync(configPath, JSON.stringify({
	name: "chi-zha-de-0013-upgrade-verifier",
	main: join(root, "src", "worker", "index.ts"),
	compatibility_date: "2026-08-18",
	d1_databases: [{
		binding: "DB",
		database_name: "chi-zha-de-0013-upgrade-verifier",
		database_id: "local-upgrade-verifier",
		migrations_dir: "migrations",
	}],
}, null, 2));

function runWrangler(arguments_, expectJson = false) {
	const result = spawnSync(process.execPath, [
		wranglerBin,
		...arguments_,
		"--local",
		"--persist-to",
		persistenceDirectory,
		"--config",
		configPath,
	], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, CI: "true", NO_COLOR: "1" },
	});
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
	if (!row) throw new Error(`Upgrade verification query returned no rows: ${JSON.stringify(output)}`);
	return row;
}

function installMigration(number) {
	const names = {
		1: "0001_create_store_settings.sql",
		2: "0002_create_menu.sql",
		3: "0003_create_modifiers.sql",
		4: "0004_create_orders.sql",
		5: "0005_add_order_public_lookup_token.sql",
		6: "0006_create_notification_deliveries.sql",
		7: "0007_add_notification_last_attempt_at.sql",
		8: "0008_create_line_merchant_pairing.sql",
		9: "0009_create_merchant_push_subscriptions.sql",
		10: "0010_add_store_state_audit.sql",
		11: "0011_add_customer_note.sql",
		12: "0012_add_admin_menu_metadata.sql",
		13: "0013_add_order_packaging_preference.sql",
		14: "0014_add_order_source.sql",
		15: "0015_add_order_shortage_and_cancellation.sql",
		16: "0016_add_shortage_request_fingerprint.sql",
		17: "0017_add_operational_automation.sql",
		18: "0018_add_customer_store_configuration.sql",
		19: "0019_add_new_order_sound_setting.sql",
		20: "0020_add_sold_out_business_date.sql",
	};
	const name = names[number];
	copyFileSync(join(root, "migrations", name), join(migrationDirectory, name));
}

try {
	for (let migration = 1; migration <= 10; migration += 1) installMigration(migration);
	runWrangler(["d1", "migrations", "apply", "DB"]);
	runWrangler([
		"d1",
		"execute",
		"DB",
		"--command",
		`INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (901, '升級分類', 1, 1);
		 INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available)
		 VALUES (901, 901, '升級雞排', '保留原資料', 80, 1, 1);
		 INSERT INTO orders (
		  id, order_number, status, total_amount, estimated_ready_at, created_at,
		  customer_name, customer_phone, special_order, idempotency_key,
		  request_fingerprint, public_lookup_token
		 ) VALUES (
		  'upgrade-order', 'UPGRADE-001', 'completed', 80,
		  '2026-09-16T12:15:00.000Z', '2026-09-16T12:00:00.000Z',
		  '升級顧客', '0912345678', 0, 'upgrade-idempotency',
		  '${"a".repeat(64)}', '${"b".repeat(64)}'
		 );
		 INSERT INTO order_items (
		  id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, sort_order
		 ) VALUES ('upgrade-line', 'upgrade-order', 901, '升級雞排', 80, 1, 80, 0);`,
	]);

	installMigration(11);
	installMigration(12);
	installMigration(13);
	installMigration(14);
	installMigration(15);
	installMigration(16);
	installMigration(17);
	installMigration(18);
	installMigration(19);
	runWrangler(["d1", "migrations", "apply", "DB"]);

	const upgraded = firstResult(runWrangler([
		"d1",
		"execute",
		"DB",
		"--json",
		"--command",
		`SELECT
			(SELECT COUNT(*) FROM d1_migrations) AS migrationCount,
			(SELECT COUNT(*) FROM menu_items WHERE id = 901 AND name = '升級雞排' AND price = 80
				AND image_url IS NULL AND is_popular = 0 AND is_quick_sold_out = 0 AND is_archived = 0) AS preservedItemCount,
			(SELECT COUNT(*) FROM order_items WHERE id = 'upgrade-line' AND item_name = '升級雞排'
				AND unit_price = 80 AND line_total = 80) AS preservedSnapshotCount,
			(SELECT COUNT(*) FROM orders WHERE id = 'upgrade-order' AND customer_note IS NULL
				AND packaging_preference = 'together' AND order_source = 'online'
				AND shortage_policy = 'continue_available' AND shortage_revision = 0
				AND cancelled_at IS NULL AND cancellation_reason IS NULL AND rejection_reason IS NULL) AS preservedOrderCount,
			(SELECT COUNT(*) FROM store_settings WHERE id = 1 AND origin_disclosure IS NULL
				AND busy_mode = 0 AND missed_order_count = 0 AND auto_pause_reason IS NULL
				AND weekly_business_hours IS NULL AND last_order_time IS NULL
				AND customer_phone_mode = 'optional' AND show_product_images = 1
				AND new_order_sound_enabled = 1) AS preservedStoreCount,
			(SELECT COUNT(*) FROM pragma_table_info('order_shortage_requests')
				WHERE name = 'request_fingerprint' AND "notnull" = 1) AS shortageRequestFingerprintCount,
			(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'menu_items_customer_visibility_sort_idx') AS visibilityIndexCount,
			(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_busy_mode_events') AS busyEventTableCount,
			(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'order_auto_rejection_events') AS autoRejectEventTableCount`,
	], true));

	for (const [key, expected] of Object.entries({
		migrationCount: 19,
		preservedItemCount: 1,
		preservedSnapshotCount: 1,
		preservedOrderCount: 1,
		preservedStoreCount: 1,
		shortageRequestFingerprintCount: 1,
		visibilityIndexCount: 1,
		busyEventTableCount: 1,
		autoRejectEventTableCount: 1,
	})) {
		if (upgraded[key] !== expected) {
			throw new Error(`Migration 0013 upgrade verification failed for ${key}: ${JSON.stringify(upgraded)}`);
		}
	}

	// Exercise the immediate 0019 -> 0020 upgrade with unavailable legacy and
	// archived rows, rather than just applying all migrations to an empty DB.
	runWrangler(["d1", "execute", "DB", "--command",
		`INSERT INTO menu_items (id,category_id,name,description,price,sort_order,is_available,is_archived)
		VALUES (902,901,'舊停售','',30,2,0,0),(903,901,'舊封存','',40,3,0,1)`]);
	const baselineSql = `SELECT
		(SELECT group_concat(id || ':' || name || ':' || price || ':' || is_available || ':' || is_archived) FROM (SELECT * FROM menu_items ORDER BY id)) AS menu,
		(SELECT COUNT(*) FROM orders) AS orders,
		(SELECT COUNT(*) FROM order_items) AS lines,
		(SELECT group_concat(item_name || ':' || unit_price || ':' || quantity || ':' || line_total) FROM order_items) AS snapshots,
		(SELECT COUNT(*) FROM sqlite_master WHERE type='table') AS tables`;
	const beforeDaily = firstResult(runWrangler(["d1", "execute", "DB", "--json", "--command", baselineSql], true));
	installMigration(20);
	runWrangler(["d1", "migrations", "apply", "DB"]);
	const afterDaily = firstResult(runWrangler(["d1", "execute", "DB", "--json", "--command", baselineSql], true));
	if (JSON.stringify(beforeDaily) !== JSON.stringify(afterDaily)) throw new Error("0020 changed existing menu/history/table invariants");
	const marker = firstResult(runWrangler(["d1", "execute", "DB", "--json", "--command",
		`SELECT (SELECT COUNT(*) FROM menu_items WHERE sold_out_business_date IS NOT NULL) AS marked,
		(SELECT COUNT(*) FROM menu_items WHERE id IN (902,903) AND is_available=0 AND sold_out_business_date IS NULL) AS preservedUnavailable,
		(SELECT COUNT(*) FROM pragma_table_info('menu_items') WHERE name='sold_out_business_date' AND type='TEXT' AND "notnull"=0 AND dflt_value='NULL') AS validColumn`], true));
	if (marker.marked !== 0 || marker.preservedUnavailable !== 2 || marker.validColumn !== 1) throw new Error("0020 legacy sold-out semantics are unsafe");
	runWrangler(["d1", "migrations", "apply", "DB"]);
	const secondHistory = firstResult(runWrangler([
		"d1", "execute", "DB", "--json", "--command", "SELECT COUNT(*) AS migrationCount FROM d1_migrations",
	], true));
	if (secondHistory.migrationCount !== 20) throw new Error("Second upgrade apply changed migration history");
	const quickCheck = firstResult(runWrangler([
		"d1", "execute", "DB", "--json", "--command", "PRAGMA quick_check",
	], true));
	if (quickCheck.quick_check !== "ok") throw new Error("Upgrade D1 quick_check failed");

	console.log("Migrations 0011-0020 upgrade PASS: pre-0011 data preserved; immediate 0019 -> 0020 preserves menu prices/availability/archive/history/table counts with nullable marker and no backfill; second apply idempotent and quick_check passed.");
} finally {
	const resolvedVerifierRoot = resolve(verifierRoot);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedVerifierRoot.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove a directory outside the system temporary directory");
	}
	rmSync(resolvedVerifierRoot, { recursive: true, force: true });
}
