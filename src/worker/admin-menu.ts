export type AdminMenuUpdateRequest = {
	name?: string;
	price?: number;
	description?: string;
	categoryId?: number;
	sortOrder?: number;
	imageUrl?: string | null;
	isPopular?: boolean;
	isQuickSoldOut?: boolean;
	isArchived?: boolean;
};

export type AdminMenuCreateRequest = {
	name: string;
	price: number;
	categoryId: number;
	description: string;
	sortOrder?: number;
	imageUrl: string | null;
	isPopular: boolean;
	isQuickSoldOut: boolean;
};

export type AdminCategoryCreateRequest = {
	name: string;
	sortOrder?: number;
	isActive: boolean;
};

export type AdminCategoryUpdateRequest = {
	name?: string;
	sortOrder?: number;
	isActive?: boolean;
};

const allowedUpdateFields = new Set([
	"name",
	"price",
	"description",
	"categoryId",
	"sortOrder",
	"imageUrl",
	"isPopular",
	"isQuickSoldOut",
	"isArchived",
]);

const allowedCreateFields = new Set([
	"name",
	"price",
	"description",
	"categoryId",
	"sortOrder",
	"imageUrl",
	"isPopular",
	"isQuickSoldOut",
]);

const allowedCategoryFields = new Set(["name", "sortOrder", "isActive"]);

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export class AdminMenuError extends Error {
	constructor(
		readonly status: 400 | 404 | 409,
		readonly code:
			| "INVALID_ADMIN_UPDATE"
			| "MENU_ITEM_NOT_FOUND"
			| "CATEGORY_NOT_FOUND"
			| "CATEGORY_IN_USE",
		message: string,
	) {
		super(message);
		this.name = "AdminMenuError";
	}
}

function categoryNotFound(): never {
	throw new AdminMenuError(400, "CATEGORY_NOT_FOUND", "Category must reference an active category");
}

function invalid(message: string): never {
	throw new AdminMenuError(400, "INVALID_ADMIN_UPDATE", message);
}

function hasDisallowedControlCharacters(value: string, allowNewline = false) {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		if (allowNewline && codePoint === 10) return false;
		return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
	});
}

function requireTrimmedText(value: unknown, field: string, maximumLength: number, allowEmpty = false) {
	if (typeof value !== "string") invalid(`${field} must be a string`);
	const normalized = value.trim();
	if ((!allowEmpty && normalized.length === 0) || [...normalized].length > maximumLength) {
		invalid(`${field} has an invalid length`);
	}
	if (hasDisallowedControlCharacters(normalized)) invalid(`${field} contains control characters`);
	return normalized;
}

function requireInteger(value: unknown, field: string, maximum: number) {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
		invalid(`${field} must be a non-negative integer`);
	}
	return value as number;
}

function requireBoolean(value: unknown, field: string) {
	if (typeof value !== "boolean") invalid(`${field} must be a boolean`);
	return value;
}

function normalizeImageUrl(value: unknown) {
	if (value === null) return null;
	if (typeof value !== "string") invalid("imageUrl must be a string or null");
	const normalized = value.trim();
	if (!normalized) return null;
	if ([...normalized].length > 2048 || hasDisallowedControlCharacters(normalized)) {
		invalid("imageUrl is invalid");
	}
	try {
		const url = new URL(normalized);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
			invalid("imageUrl must be an HTTP or HTTPS URL without credentials");
		}
	} catch {
		invalid("imageUrl must be a valid URL");
	}
	return normalized;
}

function requireCategoryId(value: unknown) {
	const categoryId = requireInteger(value, "categoryId", Number.MAX_SAFE_INTEGER);
	if (categoryId === 0) invalid("categoryId must be positive");
	return categoryId;
}

function normalizeDescription(value: unknown) {
	if (value === null || value === undefined) return "";
	return requireTrimmedText(value, "description", 240, true);
}

export function parseAdminMenuUpdate(value: unknown): AdminMenuUpdateRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid("Admin menu update must be an object");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 0) invalid("Admin menu update must include at least one field");
	const unknown = keys.find((key) => !allowedUpdateFields.has(key));
	if (unknown) invalid(`Unknown Admin menu field: ${unknown}`);

	const result: AdminMenuUpdateRequest = {};
	if (hasOwn(record, "name")) result.name = requireTrimmedText(record.name, "name", 80);
	if (hasOwn(record, "price")) result.price = requireInteger(record.price, "price", 100_000);
	if (hasOwn(record, "description")) {
		result.description = requireTrimmedText(record.description, "description", 240, true);
	}
	if (hasOwn(record, "categoryId")) {
		result.categoryId = requireCategoryId(record.categoryId);
	}
	if (hasOwn(record, "sortOrder")) result.sortOrder = requireInteger(record.sortOrder, "sortOrder", 1_000_000);
	if (hasOwn(record, "imageUrl")) result.imageUrl = normalizeImageUrl(record.imageUrl);
	if (hasOwn(record, "isPopular")) result.isPopular = requireBoolean(record.isPopular, "isPopular");
	if (hasOwn(record, "isQuickSoldOut")) {
		result.isQuickSoldOut = requireBoolean(record.isQuickSoldOut, "isQuickSoldOut");
	}
	if (hasOwn(record, "isArchived")) result.isArchived = requireBoolean(record.isArchived, "isArchived");
	return result;
}

export function parseAdminMenuCreate(value: unknown): AdminMenuCreateRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid("Admin menu creation must be an object");
	}
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).find((key) => !allowedCreateFields.has(key));
	if (unknown) invalid(`Unknown Admin menu field: ${unknown}`);
	if (!hasOwn(record, "name") || !hasOwn(record, "price") || !hasOwn(record, "categoryId")) {
		invalid("name, price, and categoryId are required");
	}

	return {
		name: requireTrimmedText(record.name, "name", 80),
		price: requireInteger(record.price, "price", 100_000),
		categoryId: requireCategoryId(record.categoryId),
		description: normalizeDescription(record.description),
		sortOrder: hasOwn(record, "sortOrder")
			? requireInteger(record.sortOrder, "sortOrder", 1_000_000)
			: undefined,
		imageUrl: hasOwn(record, "imageUrl") ? normalizeImageUrl(record.imageUrl) : null,
		isPopular: hasOwn(record, "isPopular") ? requireBoolean(record.isPopular, "isPopular") : false,
		isQuickSoldOut: hasOwn(record, "isQuickSoldOut")
			? requireBoolean(record.isQuickSoldOut, "isQuickSoldOut")
			: false,
	};
}

function parseCategoryObject(value: unknown, create: boolean) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid("Admin category request must be an object");
	}
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length === 0) invalid("Admin category request must include at least one field");
	const unknown = keys.find((key) => !allowedCategoryFields.has(key));
	if (unknown) invalid(`Unknown Admin category field: ${unknown}`);
	if (create && !hasOwn(record, "name")) invalid("Category name is required");
	return record;
}

export function parseAdminCategoryCreate(value: unknown): AdminCategoryCreateRequest {
	const record = parseCategoryObject(value, true);
	return {
		name: requireTrimmedText(record.name, "name", 80),
		sortOrder: hasOwn(record, "sortOrder")
			? requireInteger(record.sortOrder, "sortOrder", 1_000_000)
			: undefined,
		isActive: hasOwn(record, "isActive") ? requireBoolean(record.isActive, "isActive") : true,
	};
}

export function parseAdminCategoryUpdate(value: unknown): AdminCategoryUpdateRequest {
	const record = parseCategoryObject(value, false);
	const result: AdminCategoryUpdateRequest = {};
	if (hasOwn(record, "name")) result.name = requireTrimmedText(record.name, "name", 80);
	if (hasOwn(record, "sortOrder")) {
		result.sortOrder = requireInteger(record.sortOrder, "sortOrder", 1_000_000);
	}
	if (hasOwn(record, "isActive")) result.isActive = requireBoolean(record.isActive, "isActive");
	return result;
}

type AdminItemRow = {
	id: number;
	categoryId: number;
	name: string;
	description: string;
	price: number;
	sortOrder: number;
	isAvailable: number;
	imageUrl: string | null;
	isPopular: number;
	isQuickSoldOut: number;
	isArchived: number;
};

function toAdminItem(row: AdminItemRow) {
	return {
		id: row.id,
		categoryId: row.categoryId,
		name: row.name,
		description: row.description,
		price: row.price,
		sortOrder: row.sortOrder,
		isAvailable: Boolean(row.isAvailable),
		imageUrl: row.imageUrl,
		isPopular: Boolean(row.isPopular),
		isQuickSoldOut: Boolean(row.isQuickSoldOut),
		isArchived: Boolean(row.isArchived),
	};
}

const adminItemSelect = `SELECT
	id,
	category_id AS categoryId,
	name,
	description,
	price,
	sort_order AS sortOrder,
	is_available AS isAvailable,
	image_url AS imageUrl,
	is_popular AS isPopular,
	is_quick_sold_out AS isQuickSoldOut,
	is_archived AS isArchived
FROM menu_items`;

async function ensureActiveCategory(db: D1Database, categoryId: number) {
	const category = await db
		.prepare("SELECT id FROM menu_categories WHERE id = ? AND is_active = 1")
		.bind(categoryId)
		.first();
	if (!category) categoryNotFound();
}

async function readAdminItem(db: D1Database, menuItemId: number) {
	const item = await db
		.prepare(`${adminItemSelect} WHERE id = ?`)
		.bind(menuItemId)
		.first<AdminItemRow>();
	if (!item) throw new AdminMenuError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found");
	return toAdminItem(item);
}

export async function createAdminMenuItem(db: D1Database, request: AdminMenuCreateRequest) {
	await ensureActiveCategory(db, request.categoryId);
	const insertPrefix = `INSERT INTO menu_items (
		category_id, name, description, price, sort_order, is_available,
		image_url, is_popular, is_quick_sold_out, is_archived
	)`;
	const result = request.sortOrder === undefined
		? await db
			.prepare(`${insertPrefix}
				SELECT ?, ?, ?, ?, COALESCE(MAX(sort_order), -10) + 10, 1, ?, ?, ?, 0
				FROM menu_items WHERE category_id = ?`)
			.bind(
				request.categoryId,
				request.name,
				request.description,
				request.price,
				request.imageUrl,
				request.isPopular ? 1 : 0,
				request.isQuickSoldOut ? 1 : 0,
				request.categoryId,
			)
			.run()
		: await db
			.prepare(`${insertPrefix} VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0)`)
			.bind(
				request.categoryId,
				request.name,
				request.description,
				request.price,
				request.sortOrder,
				request.imageUrl,
				request.isPopular ? 1 : 0,
				request.isQuickSoldOut ? 1 : 0,
			)
			.run();
	const menuItemId = Number(result.meta.last_row_id);
	if (!Number.isSafeInteger(menuItemId) || menuItemId <= 0) {
		throw new Error("Created Admin menu item ID was unavailable");
	}
	return readAdminItem(db, menuItemId);
}

export async function updateAdminMenuItem(
	db: D1Database,
	menuItemId: number,
	request: AdminMenuUpdateRequest,
) {
	if (!Number.isSafeInteger(menuItemId) || menuItemId <= 0) {
		throw new AdminMenuError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found");
	}

	if (request.categoryId !== undefined) {
		await ensureActiveCategory(db, request.categoryId);
	}

	const assignments: string[] = [];
	const values: unknown[] = [];
	const add = (column: string, value: unknown) => {
		assignments.push(`${column} = ?`);
		values.push(value);
	};

	if (request.name !== undefined) add("name", request.name);
	if (request.price !== undefined) add("price", request.price);
	if (request.description !== undefined) add("description", request.description);
	if (request.categoryId !== undefined) add("category_id", request.categoryId);
	if (request.sortOrder !== undefined) add("sort_order", request.sortOrder);
	if (request.imageUrl !== undefined) add("image_url", request.imageUrl);
	if (request.isPopular !== undefined) add("is_popular", request.isPopular ? 1 : 0);
	if (request.isQuickSoldOut !== undefined) add("is_quick_sold_out", request.isQuickSoldOut ? 1 : 0);
	if (request.isArchived !== undefined) add("is_archived", request.isArchived ? 1 : 0);
	if (assignments.length === 0) invalid("Admin menu update must include at least one field");

	const result = await db
		.prepare(`UPDATE menu_items SET ${assignments.join(", ")} WHERE id = ?`)
		.bind(...values, menuItemId)
		.run();
	if (result.meta.changes === 0) {
		throw new AdminMenuError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found");
	}

	return readAdminItem(db, menuItemId);
}

type AdminCategoryRow = {
	id: number;
	name: string;
	sortOrder: number;
	isActive: number;
};

function toAdminCategory(row: AdminCategoryRow) {
	return {
		id: row.id,
		name: row.name,
		sortOrder: row.sortOrder,
		isActive: Boolean(row.isActive),
	};
}

const adminCategorySelect = `SELECT
	id,
	name,
	sort_order AS sortOrder,
	is_active AS isActive
FROM menu_categories`;

export async function listAdminCategories(db: D1Database) {
	const { results } = await db
		.prepare(`${adminCategorySelect} ORDER BY sort_order, id`)
		.all<AdminCategoryRow>();
	return results.map(toAdminCategory);
}

async function readAdminCategory(db: D1Database, categoryId: number) {
	const row = await db
		.prepare(`${adminCategorySelect} WHERE id = ?`)
		.bind(categoryId)
		.first<AdminCategoryRow>();
	if (!row) throw new AdminMenuError(404, "CATEGORY_NOT_FOUND", "Category not found");
	return toAdminCategory(row);
}

export async function createAdminCategory(db: D1Database, request: AdminCategoryCreateRequest) {
	const result = request.sortOrder === undefined
		? await db
			.prepare(`INSERT INTO menu_categories (name, sort_order, is_active)
				SELECT ?, COALESCE(MAX(sort_order), -10) + 10, ? FROM menu_categories`)
			.bind(request.name, request.isActive ? 1 : 0)
			.run()
		: await db
			.prepare("INSERT INTO menu_categories (name, sort_order, is_active) VALUES (?, ?, ?)")
			.bind(request.name, request.sortOrder, request.isActive ? 1 : 0)
			.run();
	const categoryId = Number(result.meta.last_row_id);
	if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
		throw new Error("Created Admin category ID was unavailable");
	}
	return readAdminCategory(db, categoryId);
}

export async function updateAdminCategory(
	db: D1Database,
	categoryId: number,
	request: AdminCategoryUpdateRequest,
) {
	if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
		throw new AdminMenuError(404, "CATEGORY_NOT_FOUND", "Category not found");
	}
	const current = await readAdminCategory(db, categoryId);
	if (current.isActive && request.isActive === false) {
		const activeProduct = await db
			.prepare("SELECT id FROM menu_items WHERE category_id = ? AND is_archived = 0 LIMIT 1")
			.bind(categoryId)
			.first();
		if (activeProduct) {
			throw new AdminMenuError(
				409,
				"CATEGORY_IN_USE",
				"Archive or reassign all products before deactivating this category",
			);
		}
	}

	const assignments: string[] = [];
	const values: unknown[] = [];
	const add = (column: string, value: unknown) => {
		assignments.push(`${column} = ?`);
		values.push(value);
	};
	if (request.name !== undefined) add("name", request.name);
	if (request.sortOrder !== undefined) add("sort_order", request.sortOrder);
	if (request.isActive !== undefined) add("is_active", request.isActive ? 1 : 0);

	const result = await db
		.prepare(`UPDATE menu_categories SET ${assignments.join(", ")} WHERE id = ?`)
		.bind(...values, categoryId)
		.run();
	if (result.meta.changes === 0) {
		throw new AdminMenuError(404, "CATEGORY_NOT_FOUND", "Category not found");
	}
	return readAdminCategory(db, categoryId);
}

type AdminMenuRow = AdminItemRow & {
	categoryName: string;
	modifierGroupId: number | null;
	modifierGroupName: string | null;
	modifierGroupIsRequired: number | null;
	modifierOptionId: number | null;
	modifierOptionName: string | null;
	modifierOptionPriceDelta: number | null;
};

export async function listAdminMenu(db: D1Database) {
	const categoryList = await listAdminCategories(db);
	const { results } = await db.prepare(
		`SELECT
			items.id,
			items.category_id AS categoryId,
			items.name,
			items.description,
			items.price,
			items.sort_order AS sortOrder,
			items.is_available AS isAvailable,
			items.image_url AS imageUrl,
			items.is_popular AS isPopular,
			items.is_quick_sold_out AS isQuickSoldOut,
			items.is_archived AS isArchived,
			categories.name AS categoryName,
			modifier_groups.id AS modifierGroupId,
			modifier_groups.name AS modifierGroupName,
			modifier_groups.is_required AS modifierGroupIsRequired,
			modifier_options.id AS modifierOptionId,
			modifier_options.name AS modifierOptionName,
			modifier_options.price_delta AS modifierOptionPriceDelta
		FROM menu_items AS items
		JOIN menu_categories AS categories ON categories.id = items.category_id
		LEFT JOIN modifier_groups ON modifier_groups.menu_item_id = items.id AND modifier_groups.is_active = 1
		LEFT JOIN modifier_options ON modifier_options.modifier_group_id = modifier_groups.id AND modifier_options.is_active = 1
		ORDER BY categories.sort_order, categories.id, items.sort_order, items.id,
			modifier_groups.sort_order, modifier_groups.id, modifier_options.sort_order, modifier_options.id`,
	).all<AdminMenuRow>();

	const items = new Map<number, ReturnType<typeof toAdminItem> & {
		categoryName: string;
		modifierGroups: Array<{
			id: number;
			name: string;
			isRequired: boolean;
			options: Array<{ id: number; name: string; priceDelta: number }>;
		}>;
	}>();

	for (const row of results) {
		let item = items.get(row.id);
		if (!item) {
			item = { ...toAdminItem(row), categoryName: row.categoryName, modifierGroups: [] };
			items.set(row.id, item);
		}
		if (row.modifierGroupId !== null && row.modifierGroupName !== null && row.modifierGroupIsRequired !== null) {
			let group = item.modifierGroups.at(-1);
			if (!group || group.id !== row.modifierGroupId) {
				group = {
					id: row.modifierGroupId,
					name: row.modifierGroupName,
					isRequired: Boolean(row.modifierGroupIsRequired),
					options: [],
				};
				item.modifierGroups.push(group);
			}
			if (row.modifierOptionId !== null && row.modifierOptionName !== null && row.modifierOptionPriceDelta !== null) {
				group.options.push({
					id: row.modifierOptionId,
					name: row.modifierOptionName,
					priceDelta: row.modifierOptionPriceDelta,
				});
			}
		}
	}

	return { categories: categoryList, items: [...items.values()] };
}

export function parseOriginDisclosure(value: unknown) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid("Origin disclosure update must be an object");
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => key !== "originDisclosure") || !hasOwn(record, "originDisclosure")) {
		invalid("Origin disclosure update contains unsupported fields");
	}
	if (record.originDisclosure === null) return null;
	if (typeof record.originDisclosure !== "string") invalid("originDisclosure must be a string or null");
	const normalized = record.originDisclosure.replace(/\r\n/g, "\n").trim();
	if (!normalized) return null;
	if ([...normalized].length > 500 || hasDisallowedControlCharacters(normalized, true)) {
		invalid("originDisclosure is invalid");
	}
	return normalized;
}

export async function updateOriginDisclosure(db: D1Database, originDisclosure: string | null) {
	await db
		.prepare("UPDATE store_settings SET origin_disclosure = ? WHERE id = 1")
		.bind(originDisclosure)
		.run();
	return { originDisclosure };
}

export async function getOriginDisclosure(db: D1Database) {
	const row = await db
		.prepare("SELECT origin_disclosure AS originDisclosure FROM store_settings WHERE id = 1")
		.first<{ originDisclosure: string | null }>();
	return { originDisclosure: row?.originDisclosure ?? null };
}
