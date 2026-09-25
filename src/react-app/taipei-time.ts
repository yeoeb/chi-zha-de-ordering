const STORE_TIME_ZONE = "Asia/Taipei";

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
