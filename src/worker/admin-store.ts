export type CustomerPhoneMode = "hidden" | "optional";

export type BusinessDayHours = {
	isOpen: boolean;
	openAt: string;
	closeAt: string;
};

export type WeeklyBusinessHours = Record<string, BusinessDayHours>;

export type AdminStoreConfiguration = {
	weeklyBusinessHours: WeeklyBusinessHours | null;
	lastOrderTime: string | null;
	customerPhoneMode: CustomerPhoneMode;
	showProductImages: boolean;
	newOrderSoundEnabled: boolean;
};

const TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const DAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;
const ALLOWED_FIELDS = new Set([
	"weeklyBusinessHours",
	"lastOrderTime",
	"customerPhoneMode",
	"showProductImages",
	"newOrderSoundEnabled",
]);

export class AdminStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AdminStoreError";
	}
}

function invalid(message: string): never {
	throw new AdminStoreError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireTime(value: unknown, field: string) {
	if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
		invalid(`${field} must use HH:mm`);
	}
	return value;
}

export function parseWeeklyBusinessHours(value: unknown): WeeklyBusinessHours | null {
	if (value === null) return null;
	if (!isRecord(value) || Object.keys(value).length !== DAY_KEYS.length) {
		invalid("weeklyBusinessHours must include all seven days");
	}
	const result: WeeklyBusinessHours = {};
	for (const day of DAY_KEYS) {
		const candidate = value[day];
		if (!isRecord(candidate) || Object.keys(candidate).some((key) => !["isOpen", "openAt", "closeAt"].includes(key))) {
			invalid(`weeklyBusinessHours.${day} is invalid`);
		}
		if (typeof candidate.isOpen !== "boolean") invalid(`weeklyBusinessHours.${day}.isOpen must be boolean`);
		const openAt = requireTime(candidate.openAt, `weeklyBusinessHours.${day}.openAt`);
		const closeAt = requireTime(candidate.closeAt, `weeklyBusinessHours.${day}.closeAt`);
		if (candidate.isOpen && openAt === closeAt) invalid(`weeklyBusinessHours.${day} opening and closing times must differ`);
		result[day] = { isOpen: candidate.isOpen, openAt, closeAt };
	}
	return result;
}

export function parseAdminStoreConfiguration(value: unknown): AdminStoreConfiguration {
	if (!isRecord(value)) invalid("Admin store configuration must be an object");
	const unknown = Object.keys(value).find((key) => !ALLOWED_FIELDS.has(key));
	if (unknown) invalid(`Unknown Admin store field: ${unknown}`);
	for (const field of ALLOWED_FIELDS) {
		if (!(field in value)) invalid(`Admin store configuration must include ${field}`);
	}
	if (value.customerPhoneMode !== "hidden" && value.customerPhoneMode !== "optional") {
		invalid("customerPhoneMode must be hidden or optional");
	}
	if (typeof value.showProductImages !== "boolean") invalid("showProductImages must be boolean");
	if (typeof value.newOrderSoundEnabled !== "boolean") invalid("newOrderSoundEnabled must be boolean");
	return {
		weeklyBusinessHours: parseWeeklyBusinessHours(value.weeklyBusinessHours),
		lastOrderTime: value.lastOrderTime === null ? null : requireTime(value.lastOrderTime, "lastOrderTime"),
		customerPhoneMode: value.customerPhoneMode,
		showProductImages: value.showProductImages,
		newOrderSoundEnabled: value.newOrderSoundEnabled,
	};
}

export function decodeWeeklyBusinessHours(value: string | null) {
	if (value === null) return null;
	try {
		return parseWeeklyBusinessHours(JSON.parse(value));
	} catch {
		throw new AdminStoreError("Stored weekly business hours are invalid");
	}
}

export async function getAdminStoreConfiguration(db: D1Database): Promise<AdminStoreConfiguration> {
	const row = await db.prepare(
		`SELECT weekly_business_hours AS weeklyBusinessHours,
			last_order_time AS lastOrderTime,
			customer_phone_mode AS customerPhoneMode,
			show_product_images AS showProductImages
			,new_order_sound_enabled AS newOrderSoundEnabled
		FROM store_settings WHERE id = 1`,
	).first<{
		weeklyBusinessHours: string | null;
		lastOrderTime: string | null;
		customerPhoneMode: CustomerPhoneMode;
		showProductImages: number;
		newOrderSoundEnabled: number;
	}>();
	if (!row) throw new AdminStoreError("Store settings not found");
	return {
		weeklyBusinessHours: decodeWeeklyBusinessHours(row.weeklyBusinessHours),
		lastOrderTime: row.lastOrderTime,
		customerPhoneMode: row.customerPhoneMode,
		showProductImages: Boolean(row.showProductImages),
		newOrderSoundEnabled: Boolean(row.newOrderSoundEnabled),
	};
}

export async function updateAdminStoreConfiguration(db: D1Database, value: AdminStoreConfiguration) {
	const result = await db.prepare(
		`UPDATE store_settings SET weekly_business_hours = ?, last_order_time = ?,
			customer_phone_mode = ?, show_product_images = ?, new_order_sound_enabled = ? WHERE id = 1`,
	).bind(
		value.weeklyBusinessHours === null ? null : JSON.stringify(value.weeklyBusinessHours),
		value.lastOrderTime,
		value.customerPhoneMode,
		value.showProductImages ? 1 : 0,
		value.newOrderSoundEnabled ? 1 : 0,
	).run();
	if (result.meta.changes !== 1) throw new AdminStoreError("Store settings not found");
	return getAdminStoreConfiguration(db);
}

export function getTodayBusinessHours(
	weeklyBusinessHours: WeeklyBusinessHours | null,
	now = new Date(),
) {
	if (weeklyBusinessHours === null) return null;
	const taipeiCalendar = new Date(now.getTime() + 8 * 60 * 60 * 1000);
	return weeklyBusinessHours[String(taipeiCalendar.getUTCDay())] ?? null;
}
