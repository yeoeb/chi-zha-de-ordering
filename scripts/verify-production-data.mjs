import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const safeTempRoot = realpathSync(tmpdir());
const persistenceDirectory = mkdtempSync(join(safeTempRoot, "chi-zha-de-production-data-"));
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const configPath = join(persistenceDirectory, "wrangler.json");
const migrationDirectory = join(persistenceDirectory, "migrations");
mkdirSync(migrationDirectory);
for (const name of readdirSync(join(root, "migrations")).filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 19)) {
	copyFileSync(join(root, "migrations", name), join(migrationDirectory, name));
}
writeFileSync(configPath, JSON.stringify({
	name: "chi-zha-de-production-data-local-verifier",
	main: join(root, "src", "worker", "index.ts"),
	compatibility_date: "2026-08-18",
	d1_databases: [{ binding: "DB", database_name: "production-data-local-verifier", database_id: "local-verifier", migrations_dir: "migrations" }],
}));

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
	if (!expectJson) return undefined;
	return JSON.parse(result.stdout);
}

function firstResult(output) {
	const row = output?.[0]?.results?.[0];
	if (!row) throw new Error(`Production-data verification query returned no rows: ${JSON.stringify(output)}`);
	return row;
}

const productionFiles = [
	"production-data/initial-store-menu.sql",
	"production-data/add-fries-seasoning.sql",
	"production-data/add-spice-options.sql",
	"production-data/add-admin-presentation-metadata.sql",
	"production-data/add-portion-options.sql",
	"production-data/apply-official-menu-v0.1.1.sql",
];

try {
	for (const file of productionFiles) {
		const sql = readFileSync(join(root, file), "utf8");
		if (/^\s*(?:DELETE|DROP|ALTER)\b/im.test(sql)) {
			throw new Error(`${file} contains a forbidden destructive statement`);
		}
	}

	runWrangler(["d1", "migrations", "apply", "DB"]);
	runWrangler(["d1", "execute", "DB", "--file", join(root, "production-data", "initial-store-menu.sql")]);
	runWrangler([
		"d1",
		"execute",
		"DB",
		"--command",
		`UPDATE store_settings SET is_accepting_orders = 1, state_version = 3 WHERE id = 1;
		 UPDATE menu_items SET is_archived = 1 WHERE id = 2 AND name = '雞蛋豆腐';
		 INSERT INTO orders (
		  id, order_number, status, total_amount, estimated_ready_at, created_at,
		  customer_name, customer_phone, special_order, idempotency_key,
		  request_fingerprint, public_lookup_token, customer_note
		 ) VALUES (
		  'production-data-history', 'PD-001', 'completed', 35,
		  '2026-09-17T12:15:00.000Z', '2026-09-17T12:00:00.000Z',
		  '歷史顧客', '0912345678', 0, 'production-data-history-key',
		  '${"a".repeat(64)}', '${"b".repeat(64)}', '保留備註'
		 );
		 INSERT INTO order_items (
		  id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, sort_order
		 ) VALUES ('production-data-line', 'production-data-history', 9, '薯條', 35, 1, 35, 0);
		 INSERT INTO orders (
		  id, order_number, status, total_amount, estimated_ready_at, created_at,
		  customer_name, customer_phone, special_order, idempotency_key,
		  request_fingerprint, public_lookup_token, customer_note
		 ) VALUES (
		  'production-data-rename-history', 'PD-002', 'completed', 60,
		  '2026-09-17T12:20:00.000Z', '2026-09-17T12:01:00.000Z',
		  '歷史顧客', '0912345678', 0, 'production-data-rename-history-key',
		  '${"c".repeat(64)}', '${"d".repeat(64)}', NULL
		 );
		 INSERT INTO order_items (
		  id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, sort_order
		 ) VALUES ('production-data-rename-line', 'production-data-rename-history', 4, '鹹酥雞', 60, 1, 60, 0);`,
	]);

	for (let pass = 0; pass < 2; pass += 1) {
		for (const file of productionFiles) {
			runWrangler(["d1", "execute", "DB", "--file", join(root, file)]);
		}
	}
	const baselineSql = `SELECT
		(SELECT COUNT(*) FROM menu_categories) AS categories,
		(SELECT COUNT(*) FROM menu_items) AS items,
		(SELECT group_concat(id || ':' || name || ':' || category_id || ':' || price || ':' || is_available || ':' || is_archived) FROM (SELECT * FROM menu_items ORDER BY id)) AS menu,
		(SELECT COUNT(*) FROM orders) AS orders,
		(SELECT COUNT(*) FROM order_items) AS lines,
		(SELECT group_concat(item_name || ':' || unit_price || ':' || quantity || ':' || line_total) FROM order_items) AS history,
		(SELECT is_accepting_orders || ':' || state_version FROM store_settings WHERE id=1) AS store,
		(SELECT COUNT(*) FROM sqlite_master WHERE type='table') AS tables`;
	const beforeDaily = firstResult(runWrangler(["d1", "execute", "DB", "--json", "--command", baselineSql], true));
	copyFileSync(join(root, "migrations", "0020_add_sold_out_business_date.sql"), join(migrationDirectory, "0020_add_sold_out_business_date.sql"));
	runWrangler(["d1", "migrations", "apply", "DB"]);
	const afterDaily = firstResult(runWrangler(["d1", "execute", "DB", "--json", "--command", baselineSql], true));
	if (JSON.stringify(beforeDaily) !== JSON.stringify(afterDaily)) throw new Error("0020 altered existing production-like menu/availability/history/Store/table invariants");
	if (firstResult(runWrangler(["d1", "execute", "DB", "--json", "--command",
		"SELECT COUNT(*) AS marked FROM menu_items WHERE sold_out_business_date IS NOT NULL"], true)).marked !== 0) {
		throw new Error("0020 must not infer daily sold-out from existing production-like unavailable rows");
	}
	runWrangler(["d1", "migrations", "apply", "DB"]);

	const summary = firstResult(runWrangler([
		"d1",
		"execute",
		"DB",
		"--json",
		"--command",
		`SELECT
			(SELECT COUNT(*) FROM menu_categories) AS categoryCount,
			(SELECT COUNT(*) FROM menu_items) AS itemCount,
			(SELECT COUNT(*) FROM modifier_groups) AS groupCount,
			(SELECT COUNT(*) FROM modifier_options) AS optionCount,
			(SELECT COUNT(*) FROM menu_items WHERE is_popular = 1) AS popularCount,
			(SELECT COUNT(*) FROM menu_items WHERE is_archived = 1) AS archivedCount,
			(SELECT COUNT(*) FROM menu_categories WHERE id = 4 AND name = '雞排類'
				AND sort_order = 40 AND is_active = 1) AS chickenCategoryCount,
			(SELECT COUNT(*) FROM menu_items WHERE
				(id = 1 AND name = '傳統雞排' AND category_id = 4 AND price = 70) OR
				(id = 3 AND name = '香酥魷魚' AND price = 60) OR
				(id = 4 AND name = '鹽酥雞' AND price = 60) OR
				(id = 5 AND name = '招牌炸蛋' AND description = '兩顆皮蛋' AND price = 45) OR
				(id = 24 AND name = '豬大腸' AND category_id = 1 AND price = 45) OR
				(id = 35 AND name = '金針菇及高麗菜' AND category_id = 3 AND price = 55)) AS officialMappingCount,
			(SELECT COUNT(*) FROM modifier_groups WHERE id = 2 AND menu_item_id = 1
				AND name = '切法' AND is_active = 1) AS preservedCutGroupCount,
			(SELECT COUNT(*) FROM modifier_groups AS groups JOIN menu_items AS items ON items.id = groups.menu_item_id
				WHERE groups.id = 5 AND groups.name = '調味' AND items.id = 9 AND items.name = '薯條') AS friesGroupCount,
			(SELECT COUNT(*) FROM modifier_options WHERE id = 16 AND modifier_group_id = 5 AND name = '胡椒') AS friesDefaultCount,
			(SELECT COUNT(*) FROM modifier_groups AS groups JOIN menu_items AS items ON items.id = groups.menu_item_id
				WHERE groups.id = 6 AND groups.name = '調味' AND items.id = 10 AND items.name = '甘梅地瓜') AS sweetPotatoGroupCount,
			(SELECT COUNT(*) FROM modifier_options WHERE id = 18 AND modifier_group_id = 6 AND name = '梅粉') AS sweetPotatoDefaultCount,
			(SELECT COUNT(*) FROM modifier_options WHERE
				(id = 17 AND modifier_group_id = 5 AND name = '不加調味' AND is_active = 0) OR
				(id = 20 AND modifier_group_id = 6 AND name = '不加調味' AND is_active = 0)) AS retiredSeasoningOptionCount,
			(SELECT COUNT(*) FROM modifier_options WHERE
				(id = 21 AND modifier_group_id = 1 AND name = '微辣') OR
				(id = 22 AND modifier_group_id = 1 AND name = '辣粉另包') OR
				(id = 23 AND modifier_group_id = 3 AND name = '微辣') OR
				(id = 24 AND modifier_group_id = 3 AND name = '辣粉另包') OR
				(id = 25 AND modifier_group_id = 4 AND name = '微辣') OR
				(id = 26 AND modifier_group_id = 4 AND name = '辣粉另包')) AS addedSpiceOptionCount,
			(SELECT COUNT(*) FROM modifier_groups WHERE
				(id = 7 AND menu_item_id = 4 AND name = '份量') OR
				(id = 8 AND menu_item_id = 3 AND name = '份量')) AS portionGroupCount,
			(SELECT COUNT(*) FROM modifier_options WHERE
				(id = 27 AND modifier_group_id = 7 AND name = '小份' AND price_delta = 0) OR
				(id = 28 AND modifier_group_id = 7 AND name = '大份' AND price_delta = 40) OR
				(id = 29 AND modifier_group_id = 8 AND name = '小份' AND price_delta = 0) OR
				(id = 30 AND modifier_group_id = 8 AND name = '大份' AND price_delta = 40)) AS portionOptionCount,
			(SELECT COUNT(*) FROM store_settings WHERE id = 1 AND is_accepting_orders = 1 AND state_version = 3) AS preservedStoreStateCount,
			(SELECT COUNT(*) FROM orders WHERE id = 'production-data-history' AND total_amount = 35 AND customer_note = '保留備註') AS preservedOrderCount,
			(SELECT COUNT(*) FROM order_items WHERE id = 'production-data-line' AND item_name = '薯條' AND unit_price = 35 AND line_total = 35) AS preservedSnapshotCount,
			(SELECT COUNT(*) FROM order_items WHERE id = 'production-data-rename-line'
				AND item_name = '鹹酥雞' AND unit_price = 60 AND line_total = 60) AS preservedRenameSnapshotCount`,
	], true));

	const expected = {
		categoryCount: 4,
		itemCount: 43,
		groupCount: 8,
		optionCount: 30,
		popularCount: 4,
		archivedCount: 6,
		chickenCategoryCount: 1,
		officialMappingCount: 6,
		preservedCutGroupCount: 1,
		friesGroupCount: 1,
		friesDefaultCount: 1,
		sweetPotatoGroupCount: 1,
		sweetPotatoDefaultCount: 1,
		retiredSeasoningOptionCount: 2,
		addedSpiceOptionCount: 6,
		portionGroupCount: 2,
		portionOptionCount: 4,
		preservedStoreStateCount: 1,
		preservedOrderCount: 1,
		preservedSnapshotCount: 1,
		preservedRenameSnapshotCount: 1,
	};
	for (const [key, value] of Object.entries(expected)) {
		if (summary[key] !== value) {
			throw new Error(`Production-data verification failed for ${key}: ${JSON.stringify(summary)}`);
		}
	}
	const quickCheck = firstResult(runWrangler([
		"d1", "execute", "DB", "--json", "--command", "PRAGMA quick_check",
	], true));
	if (quickCheck.quick_check !== "ok") throw new Error("Production-data quick_check failed");

	console.log("Production data PASS: repeatable official-menu mapping, stable prices/modifiers, 0019 -> 0020 unchanged counts/prices/availability/archive/Store/history with NULL markers, second migration apply and quick_check verified.");
} finally {
	const resolvedPersistence = resolve(persistenceDirectory);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedPersistence.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove a directory outside the system temporary directory");
	}
	rmSync(resolvedPersistence, { recursive: true, force: true });
}
