export const MAX_PUBLIC_REQUEST_BODY_BYTES = 32 * 1024;

export class RequestBodyError extends Error {
	constructor(
		readonly status: 400 | 413,
		readonly code: "INVALID_JSON_BODY" | "REQUEST_BODY_TOO_LARGE",
		message: string,
	) {
		super(message);
		this.name = "RequestBodyError";
	}
}

export async function readBoundedJson(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();

	if (contentType !== "application/json") {
		throw new RequestBodyError(
			400,
			"INVALID_JSON_BODY",
			"Content-Type must be application/json",
		);
	}

	const declaredLength = Number(request.headers.get("content-length"));

	if (Number.isFinite(declaredLength) && declaredLength > MAX_PUBLIC_REQUEST_BODY_BYTES) {
		throw new RequestBodyError(
			413,
			"REQUEST_BODY_TOO_LARGE",
			`Request body must not exceed ${MAX_PUBLIC_REQUEST_BODY_BYTES} bytes`,
		);
	}

	const reader = request.body?.getReader();
	const decoder = new TextDecoder();
	let body = "";
	let receivedBytes = 0;

	if (reader) {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			receivedBytes += value.byteLength;
			if (receivedBytes > MAX_PUBLIC_REQUEST_BODY_BYTES) {
				await reader.cancel();
				throw new RequestBodyError(
					413,
					"REQUEST_BODY_TOO_LARGE",
					`Request body must not exceed ${MAX_PUBLIC_REQUEST_BODY_BYTES} bytes`,
				);
			}
			body += decoder.decode(value, { stream: true });
		}
		body += decoder.decode();
	}

	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new RequestBodyError(400, "INVALID_JSON_BODY", "Request body must be valid JSON");
	}
}
