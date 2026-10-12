# Public Order mutation browser boundary

Scope: POST `/api/orders`, POST `/api/onsite/orders`, and POST `/api/orders/by-token/:token/cancel`.
Checkout quote POST computes a read-only quote and is unchanged. QR/page GETs are unchanged.

Require the original Origin header to equal the request URL's canonical Origin byte-for-byte. Production requests must use HTTPS with the default port. HTTP/HTTPS loopback development may use its exact port. Do not parse/normalize the Origin header, trust Referer/forwarded-host headers, or use suffix matching.

Require `Sec-Fetch-Site: same-origin`. Missing Origin, missing Fetch Metadata, `null`, `none`, `same-site`, `cross-site`, and unknown metadata values fail closed with 403. No User-Agent exemption, legacy-client fallback, or production bypass is introduced. Both production hosts work separately; cross-host Origin mixing is denied.

The create-order guard runs before the rate limiter, body parsing, pricing/database reads, Order creation and notification intent. Cancellation keeps the opaque token format check and enforces the same guard before body validation and the existing cancellation domain function. Existing schema, pricing, idempotency, rate limiting for legitimate requests, tokens, deadlines and cancellation rules remain unchanged.

This is a browser same-origin/CSRF boundary, not authentication or anti-spam. Non-browser clients can forge these headers; existing rate limiting, validation, authoritative pricing and opaque cancellation tokens remain necessary.

## Browser compatibility evidence and release condition

The current UI uses relative same-origin JSON fetch POSTs without setting Origin/Fetch Metadata itself. Browser-generated headers must be observed at the network/server boundary, not by inspecting a JavaScript Request object.

- [Fetch Origin algorithm](https://fetch.spec.whatwg.org/#append-a-request-origin-header): POST fetch uses a serialized Origin.
- [Fetch Metadata specification](https://www.w3.org/TR/fetch-metadata/#sec-fetch-site-header): same-origin subresource requests use same-origin metadata independently of the initial QR/navigation GET.
- [Safari 16.4 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-16_4-release-notes): Apple added Fetch Metadata support.

The Owner's actual iPhone Safari and standalone PWA headers have not yet been captured. Strict missing-header rejection is the proposed policy, not a claimed real-device PASS. Keep the compatibility release gate NO-GO until actual supported-device POST headers are confirmed. Safari versions without Fetch Metadata are incompatible with this policy; do not silently relax it. If a legitimate supported iPhone flow lacks either required header, stop and report for an explicit policy decision.

Do not create Production test Orders to obtain evidence. A valid checkout quote is read-only with respect to D1, but should only be observed through a separately coordinated normal preview or local test environment. Observe only Origin, Sec-Fetch-Site, method, path, timestamp and browser/standalone mode; never persist cookies, JWTs, customer data or lookup tokens.
