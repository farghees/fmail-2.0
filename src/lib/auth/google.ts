const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export const GOOGLE_STATE_COOKIE = "ep_google_state";
export const GOOGLE_PENDING_COOKIE = "ep_google_pending";
export const GOOGLE_STATE_MAX_AGE_SECONDS = 10 * 60;
export const GOOGLE_PENDING_MAX_AGE_SECONDS = 15 * 60;

export type GoogleOAuthConfig = {
	clientId: string;
	clientSecret: string;
};

export type GoogleProfile = {
	sub: string;
	email: string;
	name: string | null;
	picture: string | null;
};

export function getGoogleOAuthConfig(env: Pick<CloudflareEnv, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">): GoogleOAuthConfig | null {
	const clientId = env.GOOGLE_CLIENT_ID?.trim();
	const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) return null;
	return { clientId, clientSecret };
}

/** Hostname of the domain public sign-ups create mailboxes on; unset disables sign-up. */
export function getSignupDomain(env: Pick<CloudflareEnv, "SIGNUP_DOMAIN">): string | null {
	const domain = env.SIGNUP_DOMAIN?.trim().toLowerCase();
	return domain || null;
}

function base64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlText(value: string): string {
	return base64url(new TextEncoder().encode(value).buffer as ArrayBuffer);
}

function unbase64urlText(value: string): string | null {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		const binary = atob(normalized);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

async function hmac(secret: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	return base64url(signature);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
	return diff === 0;
}

async function signPayload(secret: string, payload: string): Promise<string> {
	return `${payload}.${await hmac(secret, payload)}`;
}

async function verifyPayload(secret: string, signed: string | undefined | null): Promise<string | null> {
	if (!signed || signed.length > 4096) return null;
	const separator = signed.lastIndexOf(".");
	if (separator <= 0) return null;
	const payload = signed.slice(0, separator);
	const signature = signed.slice(separator + 1);
	const expected = await hmac(secret, payload);
	if (!timingSafeEqual(signature, expected)) return null;
	return payload;
}

export async function createOAuthState(secret: string): Promise<{ nonce: string; cookieValue: string; challenge: string }> {
	const nonce = crypto.randomUUID();
	const verifier = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
	const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	const payload = base64urlText(JSON.stringify({ nonce, verifier, expiresAt: Date.now() + GOOGLE_STATE_MAX_AGE_SECONDS * 1000 }));
	return { nonce, cookieValue: await signPayload(secret, payload), challenge };
}

export async function verifyOAuthState(secret: string, cookieValue: string | undefined, nonce: string | null): Promise<{ verifier: string } | null> {
	if (!nonce) return null;
	const payload = await verifyPayload(secret, cookieValue);
	const text = payload ? unbase64urlText(payload) : null;
	if (!text) return null;
	try {
		const state = JSON.parse(text) as { nonce?: string; verifier?: string; expiresAt?: number };
		if (typeof state.nonce !== "string" || !timingSafeEqual(state.nonce, nonce)) return null;
		if (typeof state.verifier !== "string" || state.verifier.length !== 64) return null;
		if (typeof state.expiresAt !== "number" || state.expiresAt <= Date.now()) return null;
		return { verifier: state.verifier };
	} catch { return null; }
}

export async function createPendingSignupCookie(secret: string, profile: GoogleProfile): Promise<string> {
	const payload = base64urlText(JSON.stringify({ ...profile, expiresAt: Date.now() + GOOGLE_PENDING_MAX_AGE_SECONDS * 1000 }));
	return signPayload(secret, payload);
}

export async function verifyPendingSignupCookie(secret: string, cookieValue: string | undefined): Promise<GoogleProfile | null> {
	const payload = await verifyPayload(secret, cookieValue);
	if (!payload) return null;
	const text = unbase64urlText(payload);
	if (!text) return null;
	try {
		const pending = JSON.parse(text) as GoogleProfile & { expiresAt?: number };
		if (!validGoogleIdentity(pending)) return null;
		if (typeof pending.expiresAt !== "number" || pending.expiresAt <= Date.now()) return null;
		return { sub: pending.sub, email: pending.email, name: pending.name ?? null, picture: pending.picture ?? null };
	} catch {
		return null;
	}
}

export function buildAuthorizationUrl(config: GoogleOAuthConfig, redirectUri: string, nonce: string, challenge: string): string {
	const url = new URL(GOOGLE_AUTH_URL);
	url.searchParams.set("client_id", config.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "openid email profile");
	url.searchParams.set("state", nonce);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	// Always show the account picker so a signed-in user can choose which Gmail backs the mailbox.
	url.searchParams.set("prompt", "select_account");
	return url.toString();
}

export async function exchangeAuthorizationCode(config: GoogleOAuthConfig, redirectUri: string, code: string, verifier: string): Promise<string | null> {
	try {
		const response = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			signal: AbortSignal.timeout(10_000),
			body: new URLSearchParams({
				client_id: config.clientId,
				client_secret: config.clientSecret,
				redirect_uri: redirectUri,
				grant_type: "authorization_code",
				code_verifier: verifier,
				code,
			}),
		});
		if (!response.ok) return null;
		const token = (await response.json()) as { access_token?: string };
		return token.access_token ?? null;
	} catch {
		return null;
	}
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile | null> {
	try {
		const response = await fetch(GOOGLE_USERINFO_URL, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) return null;
		const info = (await response.json()) as {
			sub?: string;
			email?: string;
			email_verified?: boolean;
			name?: string;
			picture?: string;
		};
		if (!validGoogleIdentity(info)) return null;
		// Only a Google-verified address may back an account: it doubles as the password-reset target.
		if (info.email_verified !== true) return null;
		return { sub: info.sub, email: info.email.toLowerCase(), name: info.name ?? null, picture: info.picture ?? null };
	} catch {
		return null;
	}
}

function validGoogleIdentity(value: { sub?: unknown; email?: unknown; name?: unknown; picture?: unknown }): value is GoogleProfile {
 return typeof value.sub === "string" && value.sub.length > 0 && value.sub.length <= 255 &&
  typeof value.email === "string" && value.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) &&
  (value.name == null || (typeof value.name === "string" && value.name.length <= 200)) &&
  (value.picture == null || (typeof value.picture === "string" && value.picture.length <= 1000));
}

export function googleAppOrigin(env: Pick<CloudflareEnv, "APP_URL">, request: Request): string {
 return env.APP_URL?.trim() ? new URL(env.APP_URL.trim()).origin : new URL(request.url).origin;
}
