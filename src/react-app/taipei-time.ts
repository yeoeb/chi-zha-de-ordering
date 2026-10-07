const STORE_TIME_ZONE = "Asia/Taipei";
export {
	getStoreBusinessDate,
	listStoreBusinessDates,
} from "../shared/business-date";

function getParts(timestamp: string) {
	const date = new Date(timestamp);
	if (!Number.isFinite(date.getTime())) return null;
	const parts = new Intl.DateTimeFormat("zh-TW-u-nu-latn", {
		timeZone: STORE_TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function formatTaipeiDeadlineTime(timestamp: string) {
	const parts = getParts(timestamp);
	return parts ? `${parts.hour}:${parts.minute}` : null;
}

export function formatTaipeiDeadlineDateTime(timestamp: string) {
	const parts = getParts(timestamp);
	return parts
		? `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`
		: null;
}

export function formatTaipeiOrderDate(timestamp: string) {
	const parts = getParts(timestamp);
	return parts ? `${Number(parts.month)} 月 ${Number(parts.day)} 日` : null;
}

export function formatBusinessDateLabel(value: string, today: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return value;
	const label = `${Number(match[2])}/${Number(match[3])}`;
	return value === today ? `今天 ${label}` : label;
}

export function formatBusinessDateFull(value: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	return match ? `${match[1]}/${match[2]}/${match[3]}` : value;
}
