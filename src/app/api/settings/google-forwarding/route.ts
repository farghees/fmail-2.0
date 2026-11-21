import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { getCurrentUser } from "@/lib/auth/cookies";
import { googleForwardingStatus, requestGoogleForwarding } from "@/lib/auth/google-forwarding";
import { allowLoginAttempt } from "@/lib/auth/rate-limit";

export async function GET(request: Request) {
 const env = getEnv();
 const user = await getCurrentUser(env, request);
 if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 if (!user.googleSub || !user.googleEmail) return NextResponse.json({ available: false });
 try {
  const status = user.forwardingEmail === user.googleEmail ? await googleForwardingStatus(env, user.googleEmail) : "off";
  return NextResponse.json({ available: true, email: user.googleEmail, status }, { headers: { "Cache-Control": "no-store" } });
 } catch { return NextResponse.json({ available: true, email: user.googleEmail, status: "error" }); }
}

export async function PATCH(request: Request) {
 const env = getEnv();
 const user = await getCurrentUser(env, request);
 if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 if (request.headers.get("Origin") !== new URL(request.url).origin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
 if (!user.googleSub || !user.googleEmail) return NextResponse.json({ error: "Google signup is required" }, { status: 403 });
 if (!(await allowLoginAttempt(env, request))) return NextResponse.json({ error: "Try again shortly" }, { status: 429 });
 const body: unknown = await request.json().catch(() => null);
 if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean") return NextResponse.json({ error: "Choose on or off" }, { status: 400 });
 try {
  const status = body.enabled ? await requestGoogleForwarding(env, user.googleEmail) : "off";
  await getDb(env).update(users).set({ forwardingEmail: body.enabled ? user.googleEmail : null }).where(eq(users.id, user.id));
  return NextResponse.json({ available: true, email: user.googleEmail, status });
 } catch { return NextResponse.json({ error: "Forwarding setup could not be completed. Your Fmail inbox is unchanged." }, { status: 502 }); }
}
