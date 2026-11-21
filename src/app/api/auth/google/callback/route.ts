import { recordAuthActivity } from "@/lib/auth/activity";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import {
	createPendingSignupCookie,
	exchangeAuthorizationCode,
	fetchGoogleProfile,
	getGoogleOAuthConfig,
 googleAppOrigin,
	GOOGLE_PENDING_COOKIE,
	GOOGLE_PENDING_MAX_AGE_SECONDS,
	GOOGLE_STATE_COOKIE,
	verifyOAuthState,
} from "@/lib/auth/google";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";

function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get("Cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

function redirectWithCookies(origin: string, path: string): Response {
	return new Response(null, {
		status: 302,
		headers: { Location: new URL(path, origin).toString(), "Cache-Control": "no-store" },
	});
}

function setSessionCookie(response: Response, token: string) {
	response.headers.append(
		"Set-Cookie",
		`${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
	);
}

function clearCookie(response: Response, name: string) {
	response.headers.append("Set-Cookie", `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

export async function GET(request: Request) {
	const env = getEnv();
	const url = new URL(request.url);
	const origin = googleAppOrigin(env, request);
	const config = getGoogleOAuthConfig(env);
	if (!config) return new Response("Google sign-in is not configured", { status: 404 });

	const fail = (response: Response) => {
		clearCookie(response, GOOGLE_STATE_COOKIE);
		return response;
	};

	if (url.searchParams.get("error")) {
		return fail(redirectWithCookies(origin, "/login?error=google"));
	}
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const stateOk = await verifyOAuthState(config.clientSecret, readCookie(request, GOOGLE_STATE_COOKIE), state);
	if (!code || code.length > 4096 || !stateOk) {
		return fail(redirectWithCookies(origin, "/login?error=google"));
	}

	const accessToken = await exchangeAuthorizationCode(config, `${origin}/api/auth/google/callback`, code, stateOk.verifier);
	const profile = accessToken ? await fetchGoogleProfile(accessToken) : null;
	if (!profile) {
		return fail(redirectWithCookies(origin, "/login?error=google"));
	}

	const db = getDb(env);
	const [linked] = await db.select().from(users).where(eq(users.googleSub, profile.sub)).limit(1);
	if (linked) {
		if (linked.disabled || linked.deletedAt || linked.requireSecondFactor) {
			return fail(redirectWithCookies(origin, "/login?error=disabled"));
		}
		const token = await createSession(env, linked.id);
		await recordAuthActivity(env, { action: "auth.login", userId: linked.id, request });
		const response = redirectWithCookies(origin, "/inbox");
		setSessionCookie(response, token);
		clearCookie(response, GOOGLE_STATE_COOKIE);
		clearCookie(response, GOOGLE_PENDING_COOKIE);
		return response;
	}

	// New account: hold the verified profile in a signed cookie while the user picks a UserID.
	const pending = await createPendingSignupCookie(config.clientSecret, profile);
	const response = redirectWithCookies(origin, "/signup?step=username");
	response.headers.append(
		"Set-Cookie",
		`${GOOGLE_PENDING_COOKIE}=${pending}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${GOOGLE_PENDING_MAX_AGE_SECONDS}`,
	);
	clearCookie(response, GOOGLE_STATE_COOKIE);
	return response;
}
