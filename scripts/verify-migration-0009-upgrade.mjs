import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const safeTempRoot = realpathSync(tmpdir());
const scenarioRoot = mkdtempSync(join(safeTempRoot, "chi-zha-de-0009-upgrade-"));
const migrationsDirectory = join(scenarioRoot, "migrations");
const persistenceDirectory = join(scenarioRoot, "d1");
const configPath = join(scenarioRoot, "wrangler-upgrade-test.json");
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const database = "DB";
const localDatabaseId = "00000000-0000-4000-8000-000000000009";
const migrationsThrough0008 = [
	"0001_create_store_settings.sql",
	"0002_create_menu.sql",
	"0003_create_modifiers.sql",
	"0004_create_orders.sql",
	"0005_add_order_public_lookup_token.sql",
	"0006_create_notification_deliveries.sql",
	"0007_add_notification_last_attempt_at.sql",
	"0008_create_line_merchant_pairing.sql",
];
const migration0009 = "0009_create_merchant_push_subscriptions.sql";
const migration0009Path = join(root, "migrations", migration0009);
const forbiddenMigrationPattern = /^\s*(?:DROP\s+(?:TABLE|COLUMN)|DELETE\s+FROM|ALTER\s+TABLE\s+\S+\s+RENAME|UPDATE\s+\S+|INSERT\s+INTO)\b/im;

function spawnWrangler(arguments_) {
	return spawnSync(
		process.execPath,
		[
			wranglerBin,
			...arguments_,
			"--local",
			"--persist-to",
			persistenceDirectory,
			"--config",
			configPath,
		],
		{
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, CI: "true", NO_COLOR: "1" },
		},
	);
}

function runWrangler(arguments_, expectJson = false) {
	const result = spawnWrangler(arguments_);
	if (result.status !== 0) {
		throw new Error(
			`Wrangler command failed: ${result.error ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
		);
	}
	return expectJson ? JSON.parse(result.stdout) : result.stdout;
}

function expectWranglerFailure(arguments_, expectedMessage) {
	const result = spawnWrangler(arguments_);
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (result.status === 0 || !output.includes(expectedMessage)) {
		throw new Error(`Expected Wrangler failure containing ${expectedMessage}:\n${output}`);
	}
}

function firstResult(output) {
	const row = output?.[0]?.results?.[0];
	if (!row) throw new Error(`Upgrade verification returned no row: ${JSON.stringify(output)}`);
	return row;
}

function queryRows(command) {
	return (
		runWrangler(["d1", "execute", database, "--json", "--command", command], true)?.[0]
			?.results ?? []
	);
}

function assertExact(actual, expected, label) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${label} changed during migration 0009: ${JSON.stringify(actual)}`);
	}
}

mkdirSync(migrationsDirectory);
writeFileSync(
	configPath,
	JSON.stringify(
		{
			name: "chi-zha-de-migration-upgrade-test",
			main: join(root, "src", "worker", "index.ts"),
			compatibility_date: "2026-08-18",
			d1_databases: [
				{
					binding: database,
					database_name: "chi-zha-de-upgrade-test",
					database_id: localDatabaseId,
					migrations_dir: "migrations",
				},
			],
		},
		null,
		2,
	),
);

try {
	const migrationSql = readFileSync(migration0009Path, "utf8");
	if (forbiddenMigrationPattern.test(migrationSql)) {
		throw new Error("Migration 0009 contains a forbidden destructive or data-mutating statement");
	}

	for (const migration of migrationsThrough0008) {
		copyFileSync(join(root, "migrations", migration), join(migrationsDirectory, migration));
	}
	runWrangler(["d1", "migrations", "apply", database]);

	const historyBefore = queryRows("SELECT id, name FROM d1_migrations ORDER BY id");
	if (
		historyBefore.length !== 8 ||
		historyBefore.at(-1)?.name !== "0008_create_line_merchant_pairing.sql"
	) {
		throw new Error(`Migration history did not stop at 0008: ${JSON.stringify(historyBefore)}`);
	}

	runWrangler([
		"d1",
		"execute",
		database,
		"--command",
		`INSERT INTO orders (
			id, order_number, status, total_amount, estimated_ready_at, created_at,
			customer_name, customer_phone, special_order, idempotency_key,
			request_fingerprint, public_lookup_token
		) VALUES (
			'historical-order', 'CZ-HISTORICAL', 'completed', 70,
			'2026-09-01T12:15:00.000Z', '2026-09-01T12:00:00.000Z',
			'Historical Customer', '0900000000', 0, 'historical-idempotency-key',
			'${"a".repeat(64)}', '${"b".repeat(64)}'
		);
		INSERT INTO notification_deliveries (
			id, order_id, channel, event_type, status, attempt_count,
			last_error, created_at, sent_at, last_attempt_at
		) VALUES (
			'historical-line-delivery', 'historical-order', 'line', 'new_order',
			'sent', 1, NULL, '2026-09-01T12:00:00.000Z',
			'2026-09-01T12:00:01.000Z', '2026-09-01T12:00:01.000Z'
		);
		INSERT INTO line_merchant_binding (
			id, recipient_user_id, paired_at, updated_at
		) VALUES (
			1, 'U${"c".repeat(32)}', '2026-09-01T11:00:00.000Z',
			'2026-09-01T11:00:00.000Z'
		);
		INSERT INTO line_merchant_pairing_challenge (
			id, code_hash, expires_at, consumed_at, created_at
		) VALUES (
			1, '${"d".repeat(64)}', '2026-09-01T11:10:00.000Z',
			'2026-09-01T11:01:00.000Z', '2026-09-01T11:00:00.000Z'
		);`,
	]);

	const historicalTablesBefore = firstResult(
		runWrangler(
			[
				"d1",
				"execute",
				database,
				"--json",
				"--command",
				`SELECT
					(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'line_merchant_binding') AS bindingTableCount,
					(SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'line_merchant_pairing_challenge') AS challengeTableCount,
					(SELECT COUNT(*) FROM line_merchant_binding) AS bindingRowCount,
					(SELECT COUNT(*) FROM line_merchant_pairing_challenge) AS challengeRowCount,
					(SELECT COUNT(*) FROM notification_deliveries WHERE channel = 'line') AS lineDeliveryCount`,
			],
			true,
		),
	);
	const bindingBefore = queryRows(
		"SELECT id, recipient_user_id, paired_at, updated_at FROM line_merchant_binding ORDER BY id",
	);
	const challengeBefore = queryRows(
		"SELECT id, code_hash, expires_at, consumed_at, created_at FROM line_merchant_pairing_challenge ORDER BY id",
	);
	const deliveryBefore = queryRows(
		`SELECT id, order_id, channel, event_type, status, attempt_count,
			last_error, created_at, sent_at, last_attempt_at
		FROM notification_deliveries ORDER BY id`,
	);
	const legacyDeliverySchemaBefore = queryRows(
		"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_deliveries'",
	);

	assertExact(
		historicalTablesBefore,
		{
			bindingTableCount: 1,
			challengeTableCount: 1,
			bindingRowCount: 1,
			challengeRowCount: 1,
			lineDeliveryCount: 1,
		},
		"Pre-upgrade historical table state",
	);

	copyFileSync(migration0009Path, join(migrationsDirectory, migration0009));
	runWrangler(["d1", "migrations", "apply", database]);

	const historyAfter = queryRows("SELECT id, name FROM d1_migrations ORDER BY id");
	if (historyAfter.length !== 9 || historyAfter.at(-1)?.name !== migration0009) {
		throw new Error(`Migration 0009 was not recorded: ${JSON.stringify(historyAfter)}`);
	}

	const pushSubscriptionTableSql = firstResult(
		runWrangler(
			[
				"d1",
				"execute",
				database,
				"--json",
				"--command",
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'merchant_push_subscriptions'",
			],
			true,
		),
	)?.sql;
	const pushSubscriptionColumns = queryRows("PRAGMA table_info(merchant_push_subscriptions)").map(
		(column) => column.name,
	);
	const expectedPushSubscriptionColumns = [
		"id",
		"endpoint",
		"p256dh",
		"auth",
		"created_at",
		"updated_at",
		"last_success_at",
		"last_failure_at",
	];
	const pushSubscriptionIndexCount = firstResult(
		runWrangler(
			[
				"d1",
				"execute",
				database,
				"--json",
				"--command",
				`SELECT COUNT(*) AS count FROM sqlite_master
				WHERE type = 'index' AND name = 'merchant_push_subscriptions_updated_idx'`,
			],
			true,
		),
	)?.count;
	const pushDeliveryTableSql = firstResult(
		runWrangler(
			[
				"d1",
				"execute",
				database,
				"--json",
				"--command",
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'web_push_notification_deliveries'",
			],
			true,
		),
	)?.sql;
	const pushDeliveryColumns = queryRows("PRAGMA table_info(web_push_notification_deliveries)").map(
		(column) => column.name,
	);
	const expectedPushDeliveryColumns = [
		"id",
		"order_id",
		"event_type",
		"status",
		"attempt_count",
		"last_error",
		"created_at",
		"sent_at",
		"last_attempt_at",
	];
	const pushDeliveryIndexCount = firstResult(
		runWrangler(
			[
				"d1",
				"execute",
				database,
				"--json",
				"--command",
				`SELECT COUNT(*) AS count FROM sqlite_master
				WHERE type = 'index' AND name = 'web_push_notification_deliveries_status_idx'`,
			],
			true,
		),
	)?.count;

	if (
		!String(pushSubscriptionTableSql).includes("endpoint TEXT NOT NULL UNIQUE") ||
		JSON.stringify(pushSubscriptionColumns) !==
			JSON.stringify(expectedPushSubscriptionColumns) ||
		pushSubscriptionIndexCount !== 1 ||
		!String(pushDeliveryTableSql).includes("UNIQUE (order_id, event_type)") ||
		JSON.stringify(pushDeliveryColumns) !== JSON.stringify(expectedPushDeliveryColumns) ||
		pushDeliveryIndexCount !== 1
	) {
		throw new Error(
			`Migration 0009 additive Push schema is incomplete: ${JSON.stringify({ pushSubscriptionTableSql, pushSubscriptionColumns, pushSubscriptionIndexCount, pushDeliveryTableSql, pushDeliveryColumns, pushDeliveryIndexCount })}`,
		);
	}

	const initialPushCounts = firstResult(
		runWrangler(
			[
				"d1",
				"execute",
				database,
				"--json",
				"--command",
				`SELECT
					(SELECT COUNT(*) FROM web_push_notification_deliveries) AS deliveryCount,
					(SELECT COUNT(*) FROM merchant_push_subscriptions) AS subscriptionCount`,
			],
			true,
		),
	);
	assertExact(initialPushCounts, { deliveryCount: 0, subscriptionCount: 0 }, "Initial Push state");

	runWrangler([
		"d1",
		"execute",
		database,
		"--command",
		`INSERT INTO merchant_push_subscriptions (
			id, endpoint, p256dh, auth, created_at, updated_at
		) VALUES (
			'push-one', 'https://push.example.test/unique', 'p256dh-one', 'auth-one',
			'2026-09-01T13:00:00.000Z', '2026-09-01T13:00:00.000Z'
		)`,
	]);
	expectWranglerFailure(
		[
			"d1",
			"execute",
			database,
			"--command",
			`INSERT INTO merchant_push_subscriptions (
				id, endpoint, p256dh, auth, created_at, updated_at
			) VALUES (
				'push-two', 'https://push.example.test/unique', 'p256dh-two', 'auth-two',
				'2026-09-01T13:01:00.000Z', '2026-09-01T13:01:00.000Z'
			)`,
		],
		"UNIQUE constraint failed: merchant_push_subscriptions.endpoint",
	);
	runWrangler([
		"d1",
		"execute",
		database,
		"--command",
		`INSERT INTO web_push_notification_deliveries (
			id, order_id, event_type, status, attempt_count, created_at
		) VALUES (
			'push-delivery-one', 'historical-order', 'new_order', 'pending', 0,
			'2026-09-01T13:00:00.000Z'
		)`,
	]);
	expectWranglerFailure(
		[
			"d1",
			"execute",
			database,
			"--command",
			`INSERT INTO web_push_notification_deliveries (
				id, order_id, event_type, status, attempt_count, created_at
			) VALUES (
				'push-delivery-two', 'historical-order', 'new_order', 'pending', 0,
				'2026-09-01T13:01:00.000Z'
			)`,
		],
		"UNIQUE constraint failed: web_push_notification_deliveries.order_id, web_push_notification_deliveries.event_type",
	);

	assertExact(
		queryRows("SELECT id, recipient_user_id, paired_at, updated_at FROM line_merchant_binding ORDER BY id"),
		bindingBefore,
		"LINE Merchant binding",
	);
	assertExact(
		queryRows(
			"SELECT id, code_hash, expires_at, consumed_at, created_at FROM line_merchant_pairing_challenge ORDER BY id",
		),
		challengeBefore,
		"LINE pairing challenge",
	);
	assertExact(
		queryRows(
			`SELECT id, order_id, channel, event_type, status, attempt_count,
				last_error, created_at, sent_at, last_attempt_at
			FROM notification_deliveries WHERE id = 'historical-line-delivery'`,
		),
		deliveryBefore,
		"Historical LINE notification delivery",
	);
	assertExact(
		queryRows(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_deliveries'",
		),
		legacyDeliverySchemaBefore,
		"Historical notification_deliveries schema",
	);

	runWrangler(["d1", "migrations", "apply", database]);
	assertExact(
		queryRows("SELECT id, name FROM d1_migrations ORDER BY id"),
		historyAfter,
		"Second migration apply history",
	);

	const quickCheck = firstResult(
		runWrangler(
			["d1", "execute", database, "--json", "--command", "PRAGMA quick_check"],
			true,
		),
	);
	if (quickCheck.quick_check !== "ok") {
		throw new Error(`Upgrade D1 quick_check failed: ${JSON.stringify(quickCheck)}`);
	}

	console.log(
		"Migration 0009 upgrade PASS: real migrations stopped at 0008, the historical LINE delivery schema/rows remained exact, additive Push intent/subscription tables and DB uniqueness exist without fixtures, and a second apply left migration history unchanged at 0009.",
	);
} finally {
	const resolvedScenario = resolve(scenarioRoot);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedScenario.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove an upgrade test directory outside the system temp root");
	}
	rmSync(resolvedScenario, { recursive: true, force: true });
}

if (existsSync(scenarioRoot)) {
	throw new Error("Temporary migration upgrade directory was not removed");
}
console.log("Temporary migration upgrade database removed.");
