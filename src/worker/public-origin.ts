/** Browser same-origin boundary, not authentication or an anti-spam control.
 * Missing Origin or Fetch Metadata fails closed; no UA/Referer fallback.
 */
export function isPublicMutationRequestAllowed(input: {
	requestUrl: string;
	origin?: string;
	secFetchSite?: string;
}) {
	if (!input.origin || input.secFetchSite !== "same-origin") return false;
	try {
		const request = new URL(input.requestUrl);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(request.hostname);
		if (request.username || request.password) return false;
		if (loopback) {
			if (!["https:", "http:"].includes(request.protocol)) return false;
		} else if (request.protocol !== "https:" || request.port) {
			return false;
		}
		// Compare the original header, never a URL-parser-normalized Origin.
		return input.origin === request.origin;
	} catch {
		return false;
	}
}
