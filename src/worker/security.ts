import { createRemoteJWKSet, jwtVerify } from "jose";

export type SecurityBindings = {
	CF_ACCESS_AUD?: string;
	CF_ACCESS_TEAM_DOMAIN?: string;
	MERCHANT_DEV_BYPASS?: string;
	MERCHANT_HOSTNAME?: string;
	ORDER_RATE_LIMITER?: RateLimit;
	PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS?: string;
};

type AccessTokenVerifier = (token: string, teamDomain: string, audience: string) => Promise<boolean>;

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
	const normalizedTeamDomain = normalizeTeamDomain(teamDomain);

	if (!normalizedTeamDomain) {
		return false;
	}

	let jwks = accessJwkSets.get(normalizedTeamDomain);

	if (!jwks) {
		jwks = createRemoteJWKSet(
			new URL(`${normalizedTeamDomain}/cdn-cgi/access/certs`),
		);
		accessJwkSets.set(normalizedTeamDomain, jwks);
	}

	await jwtVerify(token, jwks, {
		issuer: normalizedTeamDomain,
		audience,
	});
	return true;
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

	const expectedHostname = input.expectedHostname?.trim().toLowerCase();

	if (!expectedHostname || new URL(input.requestUrl).hostname.toLowerCase() !== expectedHostname) {
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
