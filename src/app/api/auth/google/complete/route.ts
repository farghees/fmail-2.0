import { requestGoogleForwarding } from "@/lib/auth/google-forwarding";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes, users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { googleAppOrigin, getGoogleOAuthConfig, getSignupDomain, GOOGLE_PENDING_COOKIE, verifyPendingSignupCookie } from "@/lib/auth/google";
import { GOOGLE_ONLY_PASSWORD_HASH } from "@/lib/auth/password";
import { hasAdminAccount } from "@/lib/auth/setup";
import { completeLogin } from "@/lib/auth/login-response";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";
import { verifyTurnstileToken } from "@/lib/auth/turnstile";
import { newId } from "@/lib/ids";
import { readJsonBody } from "@/lib/http/request";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { ensureEmailRoutingRuleToWorker } from "@/lib/cloudflare-api";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { ensureBookingUsername } from "@/lib/booking/username";

// Local parts that must never be handed out through public sign-up.
const RESERVED_USERNAMES = new Set([
	"admin", "administrator", "root", "postmaster", "abuse", "hostmaster", "webmaster",
	"noreply", "no-reply", "support", "help", "security", "mailer-daemon", "fmail", "mailflare",
]);

const completeSchema = z.object({
	username: z.string().trim().toLowerCase().min(1).max(32).regex(/^[a-z0-9][a-z0-9_-]*$/, "Use letters, numbers, _ or -"),
	forwardToGmail: z.boolean().optional().default(false),
});

function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get("Cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return undefined;
}

export async function POST(request: Request) {
	const env = getEnv();
	if (request.headers.get("Origin") !== googleAppOrigin(env, request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const config = getGoogleOAuthConfig(env);
	if (!config) return NextResponse.json({ error: "Google sign-in is not configured" }, { status: 404 });
	if (!(await hasAdminAccount(env))) {
		return NextResponse.json({ error: "Initial setup is not finished" }, { status: 409 });
	}
	if (!(await allowLoginAttempt(env, request))) {
		return NextResponse.json({ error: "Too many attempts. Try again shortly." }, { status: 429, headers: { "Retry-After": "60" } });
	}

	let body: unknown;
	try {
		body = await readJsonBody(request, 16 * 1024);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid sign-up request" }, { status });
	}
	if (!(await verifyTurnstileToken(env, request, (body as Record<string, unknown> | null)?.turnstileToken))) {
		return NextResponse.json({ error: "Verification failed. Please try again." }, { status: 400 });
	}
	const parsed = completeSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ error: "Choose a valid UserID: 1-32 characters, starting with a letter or number. Use letters, numbers, _ or -" }, { status: 400 });
	}

	const profile = await verifyPendingSignupCookie(config.clientSecret, readCookie(request, GOOGLE_PENDING_COOKIE));
	if (!profile) {
		return NextResponse.json({ error: "Your Google sign-in expired. Start again.", code: "google_pending_expired" }, { status: 401 });
	}

	const signupDomain = getSignupDomain(env);
	const db = getDb(env);
	const [domain] = signupDomain
		? await db.select().from(domains).where(eq(domains.hostname, signupDomain)).limit(1)
		: [];
	if (!domain || domain.status !== "active") {
		return NextResponse.json({ error: "Sign-up is not available right now" }, { status: 403 });
	}

	const username = parsed.data.username;
	if (RESERVED_USERNAMES.has(username)) {
		return NextResponse.json({ error: "That UserID is reserved. Pick another one." }, { status: 409 });
	}
	const email = `${username}@${domain.hostname}`;

	const [existingUser, existingMailbox, existingAlias, existingGoogle] = await Promise.all([
		db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1),
		db.select({ id: mailboxes.id, localPart: mailboxes.localPart }).from(mailboxes).where(eq(mailboxes.domainId, domain.id)),
		db.select({ id: mailboxAliases.id, localPart: mailboxAliases.localPart }).from(mailboxAliases).where(eq(mailboxAliases.domainId, domain.id)),
		db.select({ id: users.id }).from(users).where(eq(users.googleSub, profile.sub)).limit(1),
	]);
	if (existingGoogle.length) {
		return NextResponse.json({ error: "This Google account already has a mailbox. Log in instead." }, { status: 409 });
	}
	if (existingUser.length || existingMailbox.some((item) => normalizeRecipientLocalPart(item.localPart) === username) || existingAlias.some((item) => normalizeRecipientLocalPart(item.localPart) === username)) {
		return NextResponse.json({ error: "That UserID is taken. Pick another one." }, { status: 409 });
	}

	const userId = newId("usr");
	const name = profile.name?.trim() || username;
	try {
 await db.insert(users).values({
		id: userId,
		email,
		resetEmail: profile.email,
		forwardingEmail: null,
		passwordHash: GOOGLE_ONLY_PASSWORD_HASH,
		name,
		role: "user",
		remoteContentMode: "ask",
		googleSub: profile.sub,
		googleEmail: profile.email,
	});

 } catch {
  return NextResponse.json({ error: "That UserID or Google account was just registered. Log in or choose another UserID." }, { status: 409 });
 }

	const address = `${username}@${domain.hostname}`;
	try {
		await ensureBookingUsername(env, userId, address);
		await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address);
		const mailboxId = newId("mbx");
		await db.insert(mailboxes).values({
			id: mailboxId,
			userId,
			domainId: domain.id,
			localPart: username,
			displayName: name,
			useAllDomains: false,
		});
	} catch (error) {
		console.error("Google sign-up provisioning failed", error);
		await db.delete(users).where(eq(users.id, userId)).catch(() => undefined);
		return NextResponse.json({ error: "Could not finish mailbox setup. Try again." }, { status: 502 });
	}

	let forwardingStatus = "off";
	if (parsed.data.forwardToGmail) {
	 try {
	  forwardingStatus = await requestGoogleForwarding(env, profile.email);
	  await db.update(users).set({ forwardingEmail: profile.email }).where(eq(users.id, userId));
	 } catch { forwardingStatus = "error"; }
	}
	const response = await completeLogin(env, request, userId, { body: { redirect: parsed.data.forwardToGmail ? (forwardingStatus === "error" ? "/settings/account?googleForwarding=error" : "/settings/account") : "/inbox", forwardingStatus } });
	response.cookies.set(GOOGLE_PENDING_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
	return response;
}
