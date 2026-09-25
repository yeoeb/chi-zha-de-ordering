export const CUSTOMER_PHONE_MAX_LENGTH = 10;
export const CUSTOMER_PHONE_ERROR_MESSAGE = "請輸入 09 開頭的 10 位手機號碼";

const CUSTOMER_PHONE_PATTERN = /^09[0-9]{8}$/;

export function isValidCustomerPhone(value: unknown): value is string {
	return typeof value === "string" && CUSTOMER_PHONE_PATTERN.test(value);
}
