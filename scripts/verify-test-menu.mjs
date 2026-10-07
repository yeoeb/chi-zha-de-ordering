import { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const safeTempRoot = realpathSync(tmpdir());
const persistenceDirectory = mkdtempSync(join(safeTempRoot, "chi-zha-de-test-menu-"));
const wranglerBin = join(root, "node_modules", "wrangler", "bin", "wrangler.js");

const expectedItems = [
	[1, "傳統雞排", 90, "雞排類", 0], [2, "雞蛋豆腐", 60, "招牌炸物", 1],
	[3, "香酥魷魚", 60, "招牌炸物", 1], [4, "鹽酥雞", 60, "招牌炸物", 1],
	[5, "招牌炸蛋", 60, "招牌炸物", 1], [6, "甜不辣", 40, "招牌炸物", 0],
	[7, "傳統豆腐", 40, "招牌炸物", 0], [8, "雞皮", 40, "招牌炸物", 0],
	[9, "薯條", 40, "招牌炸物", 0], [10, "甘梅地瓜", 50, "招牌炸物", 0],
	[11, "百頁豆腐", 35, "招牌炸物", 0], [12, "蘿蔔糕", 35, "招牌炸物", 0],
	[13, "轟炸大魷魚", 100, "串類小品", 0], [14, "米血", 30, "招牌炸物", 0],
	[15, "銀絲卷", 30, "招牌炸物", 0], [16, "米腸", 35, "招牌炸物", 0],
	[17, "甜芋粿", 30, "招牌炸物", 0], [18, "鹹芋粿", 30, "招牌炸物", 0],
	[20, "豆皮", 30, "招牌炸物", 0], [21, "鑫鑫腸", 30, "串類小品", 0],
	[22, "雞脖子", 35, "串類小品", 0], [23, "豆干", 25, "串類小品", 0],
	[24, "豬大腸", 60, "招牌炸物", 0], [26, "牛肉串", 45, "串類小品", 0],
	[27, "豬肉串", 40, "串類小品", 0], [28, "雞屁股", 35, "串類小品", 0],
	[29, "雞心", 35, "串類小品", 0], [30, "雞胗", 35, "串類小品", 0],
	[31, "貢丸", 30, "串類小品", 0], [33, "花枝丸", 30, "串類小品", 0],
	[35, "金針菇及高麗菜", 60, "蔬菜", 0], [36, "杏鮑菇", 50, "蔬菜", 0],
	[37, "高麗菜", 50, "蔬菜", 0], [39, "青花菜", 50, "蔬菜", 0],
	[40, "四季豆", 50, "蔬菜", 0], [42, "小黃瓜", 40, "蔬菜", 0],
	[43, "大青椒", 40, "蔬菜", 0], [44, "魚板", 30, "招牌炸物", 0],
	[45, "柳葉魚", 50, "招牌炸物", 0], [46, "章魚串", 40, "串類小品", 0],
	[47, "小香腸", 30, "串類小品", 0], [48, "起司雞排", 100, "雞排類", 0],
	[49, "香蔥雞排", 100, "雞排類", 0], [50, "泡菜起司雞排", 110, "雞排類", 0],
	[51, "蟹肉起司雞排", 110, "雞排類", 0], [52, "蟹肉蔥雞排", 110, "雞排類", 1],
];

function runWrangler(arguments_, expectJson = false) {
	const result = spawnSync(process.execPath, [
		wranglerBin,
		...arguments_,
		"--local",
		"--persist-to", persistenceDirectory,
		"--config", join(root, "wrangler.json"),
	], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, CI: "true", NO_COLOR: "1" },
	});
	if (result.status !== 0) {
		throw new Error(`Wrangler command failed: ${result.error ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	}
	return expectJson ? JSON.parse(result.stdout) : undefined;
}

function query(sql) {
	return runWrangler(["d1", "execute", "DB", "--json", "--command", sql], true)?.[0]?.results ?? [];
}

try {
	runWrangler(["d1", "migrations", "apply", "DB"]);
	runWrangler(["d1", "execute", "DB", "--file", join(root, "seeds", "development.sql")]);
	runWrangler(["d1", "execute", "DB", "--file", join(root, "seeds", "ensure-spice-modifiers.sql")]);
	const spiceBefore = query("SELECT COUNT(*) AS groupsCount FROM modifier_groups WHERE name = '辣度'")[0];
	if (spiceBefore?.groupsCount !== 45 || query("SELECT COUNT(*) AS count FROM modifier_groups WHERE menu_item_id = 5 AND name = '辣度'")[0]?.count !== 0) {
		throw new Error("Every development product except stable item 5 must have one spice group");
	}
	if (query(`SELECT COUNT(*) AS count FROM menu_items AS items WHERE items.id <> 5 AND NOT EXISTS (
		SELECT 1 FROM modifier_groups AS groups JOIN modifier_options AS options ON options.modifier_group_id = groups.id
		WHERE groups.menu_item_id = items.id AND groups.name = '辣度' AND groups.is_required = 1 AND groups.is_active = 1
		AND options.name = '不辣' AND options.is_active = 1)`)[0]?.count !== 0) {
		throw new Error("Missing required real non-spicy defaults");
	}
	const optionCount = query("SELECT COUNT(*) AS count FROM modifier_options")[0]?.count;
	runWrangler(["d1", "execute", "DB", "--file", join(root, "seeds", "ensure-spice-modifiers.sql")]);
	if (query("SELECT COUNT(*) AS count FROM modifier_options")[0]?.count !== optionCount ||
		query("SELECT COUNT(*) AS count FROM modifier_groups WHERE name = '辣度'")[0]?.count !== 45) {
		throw new Error("Spice delta is not repeat-safe");
	}

	const rows = query(`SELECT menu_items.id, menu_items.name, menu_items.price,
		menu_categories.name AS category, menu_items.is_popular AS isPopular,
		menu_items.is_archived AS isArchived
		FROM menu_items JOIN menu_categories ON menu_categories.id = menu_items.category_id
		ORDER BY menu_items.id`);
	if (rows.length !== expectedItems.length) {
		throw new Error(`Expected ${expectedItems.length} local menu items, received ${rows.length}`);
	}
	for (const [id, name, price, category, isPopular] of expectedItems) {
		const row = rows.find((candidate) => candidate.id === id);
		if (!row || row.name !== name || row.price !== price || row.category !== category || row.isPopular !== isPopular || row.isArchived !== 0) {
			throw new Error(`Unexpected local item ${id}: ${JSON.stringify(row)}`);
		}
	}

	const modifierSummary = query(`SELECT
		(SELECT COUNT(*) FROM modifier_groups WHERE id = 5 AND menu_item_id = 9 AND name = '調味') AS friesGroup,
		(SELECT COUNT(*) FROM modifier_options WHERE id = 16 AND modifier_group_id = 5 AND name = '胡椒') AS friesDefault,
		(SELECT COUNT(*) FROM modifier_groups WHERE id = 6 AND menu_item_id = 10 AND name = '調味') AS sweetPotatoGroup,
		(SELECT COUNT(*) FROM modifier_options WHERE id = 18 AND modifier_group_id = 6 AND name = '梅粉') AS sweetPotatoDefault,
		(SELECT COUNT(*) FROM modifier_groups WHERE name = '切法' AND menu_item_id = 1 AND id = 2) AS traditionalCut,
		(SELECT COUNT(*) FROM modifier_groups WHERE name = '切法' AND menu_item_id IN (48, 49, 50, 51, 52)) AS otherChickenCut,
		(SELECT COUNT(*) FROM menu_items WHERE id BETWEEN 44 AND 52) AS testOnlyCount,
		(SELECT COUNT(*) FROM menu_items WHERE is_popular = 1) AS popularCount`)[0];
	if (
		modifierSummary?.friesGroup !== 1 || modifierSummary?.friesDefault !== 1 ||
		modifierSummary?.sweetPotatoGroup !== 1 || modifierSummary?.sweetPotatoDefault !== 1 ||
		modifierSummary?.traditionalCut !== 1 || modifierSummary?.otherChickenCut !== 0 ||
		modifierSummary?.testOnlyCount !== 9 || modifierSummary?.popularCount !== 5
	) {
		throw new Error(`Unexpected local modifier/menu summary: ${JSON.stringify(modifierSummary)}`);
	}

	const productionDirectory = join(root, "production-data");
	const testOnlyNames = expectedItems.filter(([id]) => id >= 44).map(([, name]) => name);
	for (const fileName of readdirSync(productionDirectory).filter((name) => name.endsWith(".sql"))) {
		const sql = readFileSync(join(productionDirectory, fileName), "utf8");
		for (const name of testOnlyNames) {
			if (sql.includes(name)) {
				throw new Error(`${fileName} contains local-only placeholder product ${name}`);
			}
		}
		if (/LOCAL \/ TEST PLACEHOLDER|本機視覺驗收用商品|本機獨立測試商品/i.test(sql)) {
			throw new Error(`${fileName} contains a local-only placeholder marker`);
		}
	}

	if (query("PRAGMA quick_check")[0]?.quick_check !== "ok") {
		throw new Error("Local test-menu D1 quick_check failed");
	}
	console.log("Local test menu PASS: 46 visible products, 45 required API-backed spice groups with real non-spicy defaults, 招牌炸蛋 has no spice, repeat-safe spice delta, 9 test-only placeholder identities, 5 popular products, stable seasoning IDs/defaults, cut only on 傳統雞排, production SQL isolation, and quick_check verified.");
} finally {
	const resolvedPersistence = resolve(persistenceDirectory);
	const resolvedTempRoot = resolve(safeTempRoot);
	if (!resolvedPersistence.startsWith(`${resolvedTempRoot}${sep}`)) {
		throw new Error("Refusing to remove a directory outside the system temporary directory");
	}
	rmSync(resolvedPersistence, { recursive: true, force: true });
}
