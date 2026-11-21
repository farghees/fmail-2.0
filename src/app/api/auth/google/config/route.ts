import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getGoogleOAuthConfig, getSignupDomain, GOOGLE_PENDING_COOKIE, verifyPendingSignupCookie } from "@/lib/auth/google";
import { hasAdminAccount } from "@/lib/auth/setup";

function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get("Cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

export async function GET(request: Request) {
	const env = getEnv();
	const config = getGoogleOAuthConfig(env);
	const signupDomain = getSignupDomain(env);
	let signupAvailable = false;
	if (config && signupDomain && (await hasAdminAccount(env))) {
		const db = getDb(env);
		const [domain] = await db.select({ status: domains.status }).from(domains).where(eq(domains.hostname, signupDomain)).limit(1);
		signupAvailable = domain?.status === "active";
	}
	const pending = config ? await verifyPendingSignupCookie(config.clientSecret, readCookie(request, GOOGLE_PENDING_COOKIE)) : null;
	const response = Response.json({
		enabled: !!config,
		signupAvailable,
		domain: signupAvailable ? signupDomain : null,
		pending: pending ? { email: pending.email, name: pending.name } : null,
	});
	response.headers.set("Cache-Control", "no-store");
	return response;
}
