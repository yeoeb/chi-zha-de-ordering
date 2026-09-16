import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const safeTempRoot = realpathSync(tmpdir());
const verifierRoot = mkdtempSync(join(safeTempRoot, "chi-zha-de-0012-upgrade-"));
const migrationDirectory = join(verifierRoot, "migrations");
const persistenceDirectory = join(verifierRoot, "state");
const configPath = join(verifierRoot, "wrangler.json");
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

mkdirSync(migrationDirectory);
writeFileSync(configPath, JSON.stringify({
	name: "chi-zha-de-0012-upgrade-verifier",
	main: join(root, "src", "worker", "index.ts"),
	compatibility_date: "2026-08-18",
	d1_databases: [{
		binding: "DB",
		database_name: "chi-zha-de-0012-upgrade-verifier",
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
			(SELECT COUNT(*) FROM orders WHERE id = 'upgrade-order' AND customer_note IS NULL) AS preservedOrderCount,
			(SELECT COUNT(*) FROM store_settings WHERE id = 1 AND origin_disclosure IS NULL) AS preservedStoreCount,
			(SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'menu_items_customer_visibility_sort_idx') AS visibilityIndexCount`,
	], true));

	for (const [key, expected] of Object.entries({
		migrationCount: 12,
		preservedItemCount: 1,
		preservedSnapshotCount: 1,
		preservedOrderCount: 1,
		preservedStoreCount: 1,
		visibilityIndexCount: 1,
	})) {
		if (upgraded[key] !== expected) {
			throw new Error(`Migration 0012 upgrade verification failed for ${key}: ${JSON.stringify(upgraded)}`);
		}
	}

	runWrangler(["d1", "migrations", "apply", "DB"]);
	const secondHistory = firstResult(runWrangler([
		"d1", "execute", "DB", "--json", "--command", "SELECT COUNT(*) AS migrationCount FROM d1_migrations",
	], true));
	if (secondHistory.migrationCount !== 12) throw new Error("Second upgrade apply changed migration history");
	const quickCheck = firstResult(runWrangler([
		"d1", "execute", "DB", "--json", "--command", "PRAGMA quick_check",
	], true));
	if (quickCheck.quick_check !== "ok") throw new Error("Upgrade D1 quick_check failed");

	console.log("Migrations 0011+0012 upgrade PASS: pre-0011 menu/order data preserved, customer_note and Admin metadata defaults verified, second apply idempotent, and quick_check passed.");
} finally {
	const resolvedVerifierRoot = resolve(verifierRoot);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedVerifierRoot.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove a directory outside the system temporary directory");
	}
	rmSync(resolvedVerifierRoot, { recursive: true, force: true });
}
