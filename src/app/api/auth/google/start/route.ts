import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { getEnv } from "@/lib/cloudflare";
import {
	buildAuthorizationUrl,
	createOAuthState,
	getGoogleOAuthConfig,
 googleAppOrigin,
	GOOGLE_STATE_COOKIE,
	GOOGLE_STATE_MAX_AGE_SECONDS,
} from "@/lib/auth/google";

export async function GET(request: Request) {
	const env = getEnv();
	if (!(await allowLoginAttempt(env, request))) return new Response("Too many attempts. Try again shortly.", { status: 429 });
	const config = getGoogleOAuthConfig(env);
	if (!config) return new Response("Google sign-in is not configured", { status: 404 });

	const origin = googleAppOrigin(env, request);
	const { nonce, cookieValue, challenge } = await createOAuthState(config.clientSecret);
	const response = new Response(null, {
		status: 302,
		headers: {
			Location: buildAuthorizationUrl(config, `${origin}/api/auth/google/callback`, nonce, challenge),
			"Cache-Control": "no-store",
		},
	});
	response.headers.append(
		"Set-Cookie",
		`${GOOGLE_STATE_COOKIE}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${GOOGLE_STATE_MAX_AGE_SECONDS}`,
	);
	return response;
}
