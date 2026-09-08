const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_CHARACTER_COUNT = 8;
const PAIRING_TTL_MS = 10 * 60 * 1_000;
export const MAX_LINE_WEBHOOK_BODY_BYTES = 64 * 1_024;
const LINE_USER_ID_PATTERN = /^U[0-9A-Fa-f]{32}$/;
const PAIRING_MESSAGE_PATTERN = /^綁定\s+([A-Za-z0-9]{4}-[A-Za-z0-9]{4})\s*$/u;

export type LinePairingBindings = {
	LINE_CHANNEL_SECRET?: string;
};

export type LinePairingStatus = {
	paired: boolean;
	pairedAt?: string;
};

export class LineWebhookError extends Error {
	constructor(
		readonly status: 400 | 401 | 413 | 503,
		readonly code:
			| "LINE_WEBHOOK_NOT_CONFIGURED"
			| "LINE_WEBHOOK_SIGNATURE_REQUIRED"
			| "INVALID_LINE_WEBHOOK_SIGNATURE"
			| "INVALID_LINE_WEBHOOK_BODY"
			| "LINE_WEBHOOK_BODY_TOO_LARGE",
		message: string,
	) {
		super(message);
		this.name = "LineWebhookError";
	}
}

type RandomBytes = (target: Uint8Array) => Uint8Array;

function defaultRandomBytes(target: Uint8Array) {
	crypto.getRandomValues(target);
	return target;
}

function toHex(bytes: Uint8Array) {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashPairingCode(code: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
	return toHex(new Uint8Array(digest));
}

function normalizePairingCode(value: string) {
	const normalized = value.toUpperCase();
	const compact = normalized.replace("-", "");

	if (
		compact.length !== PAIRING_CODE_CHARACTER_COUNT ||
		[...compact].some((character) => !PAIRING_CODE_ALPHABET.includes(character))
	) {
		return null;
	}

	return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export async function createLinePairingChallenge(
	db: D1Database,
	now: Date = new Date(),
	randomBytes: RandomBytes = defaultRandomBytes,
) {
	const bytes = randomBytes(new Uint8Array(PAIRING_CODE_CHARACTER_COUNT));

	if (bytes.length !== PAIRING_CODE_CHARACTER_COUNT) {
		throw new Error("Pairing code generator returned an unexpected byte count");
	}

	const compactCode = [...bytes]
		.map((value) => PAIRING_CODE_ALPHABET[value & 31])
		.join("");
	const code = `${compactCode.slice(0, 4)}-${compactCode.slice(4)}`;
	const codeHash = await hashPairingCode(code);
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();

	await db
		.prepare(
			`INSERT INTO line_merchant_pairing_challenge (
				id, code_hash, expires_at, consumed_at, created_at
			) VALUES (1, ?, ?, NULL, ?)
			ON CONFLICT(id) DO UPDATE SET
				code_hash = excluded.code_hash,
				expires_at = excluded.expires_at,
				consumed_at = NULL,
				created_at = excluded.created_at`,
		)
		.bind(codeHash, expiresAt, createdAt)
		.run();

	return { code, expiresAt };
}

export async function getLinePairingStatus(db: D1Database): Promise<LinePairingStatus> {
	const binding = await db
		.prepare("SELECT paired_at AS pairedAt FROM line_merchant_binding WHERE id = 1")
		.first<{ pairedAt: string }>();

	return binding ? { paired: true, pairedAt: binding.pairedAt } : { paired: false };
}

export async function getLineMerchantRecipientId(db: D1Database) {
	const binding = await db
		.prepare("SELECT recipient_user_id AS recipientUserId FROM line_merchant_binding WHERE id = 1")
		.first<{ recipientUserId: string }>();

	return binding?.recipientUserId ?? null;
}

function decodeBase64(value: string) {
	try {
		const decoded = atob(value);
		return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

export async function verifyLineWebhookSignature(
	rawBody: Uint8Array,
	signature: string,
	channelSecret: string,
) {
	const signatureBytes = decodeBase64(signature);

	if (!signatureBytes) {
		return false;
	}

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(channelSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);

	return crypto.subtle.verify("HMAC", key, signatureBytes, rawBody);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function consumePairingChallenge(
	db: D1Database,
	code: string,
	recipientUserId: string,
	now: Date,
) {
	const codeHash = await hashPairingCode(code);
	const timestamp = now.toISOString();
	const [bindingResult, challengeResult] = await db.batch([
		db
			.prepare(
				`INSERT INTO line_merchant_binding (id, recipient_user_id, paired_at, updated_at)
				SELECT 1, ?, ?, ?
				FROM line_merchant_pairing_challenge
				WHERE id = 1
					AND code_hash = ?
					AND consumed_at IS NULL
					AND expires_at > ?
				ON CONFLICT(id) DO UPDATE SET
					recipient_user_id = excluded.recipient_user_id,
					paired_at = excluded.paired_at,
					updated_at = excluded.updated_at`,
			)
			.bind(recipientUserId, timestamp, timestamp, codeHash, timestamp),
		db
			.prepare(
				`UPDATE line_merchant_pairing_challenge
				SET consumed_at = ?
				WHERE id = 1
					AND code_hash = ?
					AND consumed_at IS NULL
					AND expires_at > ?`,
			)
			.bind(timestamp, codeHash, timestamp),
	]);

	return bindingResult.meta.changes === 1 && challengeResult.meta.changes === 1;
}

export async function processLineWebhook(
	db: D1Database,
	rawBody: Uint8Array,
	signature: string | undefined,
	channelSecret: string | undefined,
	now: Date = new Date(),
) {
	const secret = channelSecret?.trim();

	if (!secret || secret.length > 256) {
		throw new LineWebhookError(
			503,
			"LINE_WEBHOOK_NOT_CONFIGURED",
			"LINE webhook is not configured",
		);
	}

	if (!signature?.trim()) {
		throw new LineWebhookError(
			401,
			"LINE_WEBHOOK_SIGNATURE_REQUIRED",
			"LINE webhook signature is required",
		);
	}

	if (rawBody.byteLength > MAX_LINE_WEBHOOK_BODY_BYTES) {
		throw new LineWebhookError(
			413,
			"LINE_WEBHOOK_BODY_TOO_LARGE",
			`LINE webhook body must not exceed ${MAX_LINE_WEBHOOK_BODY_BYTES} bytes`,
		);
	}

	if (!(await verifyLineWebhookSignature(rawBody, signature, secret))) {
		throw new LineWebhookError(
			401,
			"INVALID_LINE_WEBHOOK_SIGNATURE",
			"LINE webhook signature is invalid",
		);
	}

	let payload: unknown;

	try {
		payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
	} catch {
		throw new LineWebhookError(
			400,
			"INVALID_LINE_WEBHOOK_BODY",
			"LINE webhook body must be valid JSON",
		);
	}

	if (!isRecord(payload) || !Array.isArray(payload.events)) {
		throw new LineWebhookError(
			400,
			"INVALID_LINE_WEBHOOK_BODY",
			"LINE webhook body must contain an events array",
		);
	}

	let paired = false;

	for (const event of payload.events) {
		if (!isRecord(event) || !isRecord(event.source) || !isRecord(event.message)) {
			continue;
		}

		if (
			event.source.type !== "user" ||
			typeof event.source.userId !== "string" ||
			!LINE_USER_ID_PATTERN.test(event.source.userId) ||
			event.message.type !== "text" ||
			typeof event.message.text !== "string"
		) {
			continue;
		}

		const match = PAIRING_MESSAGE_PATTERN.exec(event.message.text);
		const pairingCode = match ? normalizePairingCode(match[1]) : null;

		if (!pairingCode) {
			continue;
		}

		paired =
			(await consumePairingChallenge(db, pairingCode, event.source.userId, now)) || paired;
	}

	return { paired };
}
