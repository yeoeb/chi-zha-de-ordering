import { createRemoteJWKSet, jwtVerify } from "jose";

export type SecurityBindings = {
	ADMIN_ACCESS_AUD?: string;
	ADMIN_ACCESS_TEAM_DOMAIN?: string;
	ADMIN_DEV_BYPASS?: string;
	ADMIN_DEV_ACTOR_SUBJECT?: string;
	ADMIN_HOSTNAME?: string;
	CF_ACCESS_AUD?: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	MERCHANT_DEV_BYPASS?: string;
	MERCHANT_DEV_ACTOR_SUBJECT?: string;
	MERCHANT_HOSTNAME?: string;
	ORDER_RATE_LIMITER?: RateLimit;
	PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS?: string;
};

type AccessTokenVerifier = (token: string, teamDomain: string, audience: string) => Promise<boolean>;
type AccessIdentityVerifier = (
	token: string,
	teamDomain: string,
	audience: string,
) => Promise<{ subject: string } | null>;

export type MerchantIdentity = { subject: string };
export type AdminIdentity = { subject: string };

const accessJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeTeamDomain(value: string) {
	try {
		const url = new URL(value);

		if (
			url.protocol !== "https:" ||
			!url.hostname.endsWith(".cloudflareaccess.com") ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		) {
			return null;
		}

		return url.origin;
	} catch {
		return null;
	}
}

async function verifyCloudflareAccessToken(token: string, teamDomain: string, audience: string) {
	return (await verifyCloudflareAccessIdentity(token, teamDomain, audience)) !== null;
}

async function verifyCloudflareAccessIdentity(token: string, teamDomain: string, audience: string) {
	const normalizedTeamDomain = normalizeTeamDomain(teamDomain);

	if (!normalizedTeamDomain) {
		return null;
	}

	let jwks = accessJwkSets.get(normalizedTeamDomain);

	if (!jwks) {
		jwks = createRemoteJWKSet(
			new URL(`${normalizedTeamDomain}/cdn-cgi/access/certs`),
		);
		accessJwkSets.set(normalizedTeamDomain, jwks);
	}

	const { payload } = await jwtVerify(token, jwks, {
		issuer: normalizedTeamDomain,
		audience,
	});
	return typeof payload.sub === "string" && payload.sub.trim()
		? { subject: payload.sub.trim() }
		: null;
}

function hasExpectedHostname(requestUrl: string, expectedHostname: string | undefined) {
	const normalized = expectedHostname?.trim().toLowerCase();
	if (!normalized) return false;
	try {
		return new URL(requestUrl).hostname.toLowerCase() === normalized;
	} catch {
		return false;
	}
}

export async function authenticateMerchantRequest(input: {
	devBypass?: string;
	devActorSubject?: string;
	expectedHostname?: string;
	requestUrl: string;
	accessAudience?: string;
	accessTeamDomain?: string;
	accessToken?: string;
	verifyAccessIdentity?: AccessIdentityVerifier;
}): Promise<MerchantIdentity | null> {
	if (input.devBypass === "true") {
		const subject = input.devActorSubject?.trim();
		return subject ? { subject } : null;
	}

	if (!hasExpectedHostname(input.requestUrl, input.expectedHostname)) return null;
	const accessAudience = input.accessAudience?.trim();
	const accessTeamDomain = input.accessTeamDomain?.trim();
	const accessToken = input.accessToken?.trim();
	if (!accessAudience || !accessTeamDomain || !accessToken) return null;

	try {
		return await (input.verifyAccessIdentity ?? verifyCloudflareAccessIdentity)(
			accessToken,
			accessTeamDomain,
			accessAudience,
		);
	} catch {
		return null;
	}
}

export async function authenticateAdminRequest(input: {
	devBypass?: string;
	devActorSubject?: string;
	expectedHostname?: string;
	requestUrl: string;
	accessAudience?: string;
	accessTeamDomain?: string;
	accessToken?: string;
	verifyAccessIdentity?: AccessIdentityVerifier;
}): Promise<AdminIdentity | null> {
	return authenticateMerchantRequest(input);
}

export function isMerchantMutationRequestAllowed(input: {
	method: string;
	devBypass?: string;
	expectedHostname?: string;
	requestUrl?: string;
	origin?: string;
	secFetchSite?: string;
}) {
	if (["GET", "HEAD", "OPTIONS"].includes(input.method.toUpperCase())) return true;
	if (input.secFetchSite !== "same-origin" || !input.origin) return false;

	if (input.devBypass === "true") {
		try {
			const requestUrl = new URL(input.requestUrl ?? "");
			const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(requestUrl.hostname);
			if (isLoopback) {
				const origin = new URL(input.origin);
				return (
					input.origin === origin.origin &&
					origin.origin === requestUrl.origin &&
					origin.username === "" &&
					origin.password === "" &&
					origin.pathname === "/" &&
					origin.search === "" &&
					origin.hash === ""
				);
			}
		} catch {
			return false;
		}
	}

	const expectedHostname = input.expectedHostname?.trim().toLowerCase();
	if (!expectedHostname) return false;

	const expectedOrigin = `https://${expectedHostname}`;
	try {
		const origin = new URL(input.origin);
		return (
			origin.origin === expectedOrigin &&
			input.origin === expectedOrigin &&
			origin.username === "" &&
			origin.password === "" &&
			origin.pathname === "/" &&
			origin.search === "" &&
			origin.hash === ""
		);
	} catch {
		return false;
	}
}

export async function isMerchantRequestAllowed(input: {
	devBypass?: string;
	expectedHostname?: string;
	requestUrl: string;
	accessAudience?: string;
	accessTeamDomain?: string;
	accessToken?: string;
	verifyAccessToken?: AccessTokenVerifier;
}) {
	if (input.devBypass === "true") {
		return true;
	}

	if (!hasExpectedHostname(input.requestUrl, input.expectedHostname)) {
		return false;
	}

	const accessAudience = input.accessAudience?.trim();
	const accessTeamDomain = input.accessTeamDomain?.trim();
	const accessToken = input.accessToken?.trim();

	if (!accessAudience || !accessTeamDomain || !accessToken) {
		return false;
	}

	try {
		return await (input.verifyAccessToken ?? verifyCloudflareAccessToken)(
			accessToken,
			accessTeamDomain,
			accessAudience,
		);
	} catch {
		return false;
	}
}

export async function isRateLimitAllowed(limiter: RateLimit, key: string) {
	return (await limiter.limit({ key })).success;
}
