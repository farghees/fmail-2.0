import { z } from "zod";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getOutboundAttachmentMaxMb, MAX_OUTBOUND_ATTACHMENT_MAX_MB } from "@/lib/email/attachment-policy";
import { getDriveDefaultQuota } from "@/lib/drive/storage";
import { defaultMailboxSettingsSchema, getDefaultMailboxSettings, saveDefaultMailboxSettings } from "@/lib/domains/default-mailbox-settings";

const GIB = 1024 ** 3;

const schema = z.object({
	outboundAttachmentMaxMb: z.number().int().min(1).max(MAX_OUTBOUND_ATTACHMENT_MAX_MB).optional(),
	/** Default per-user Drive quota in GB; null means unlimited (stored as 0). */
	driveStorageLimitGb: z.number().positive().max(1_000_000).nullable().optional(),
	defaultMailbox: defaultMailboxSettingsSchema.optional(),
});

async function readSettings(env: CloudflareEnv) {
	const quota = await getDriveDefaultQuota(getDb(env));
	const limit = quota > 0 ? quota : null;
	return { outboundAttachmentMaxMb: await getOutboundAttachmentMaxMb(env), driveStorageLimitGb: limit === null ? null : Math.round((limit / GIB) * 100) / 100, defaultMailbox: await getDefaultMailboxSettings(env) };
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	return Response.json(await readSettings(env), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success || (parsed.data.outboundAttachmentMaxMb === undefined && parsed.data.driveStorageLimitGb === undefined && parsed.data.defaultMailbox === undefined)) return Response.json({ error: "Enter a valid attachment limit (1 to 25 MB), Drive storage limit or default mailbox" }, { status: 400 });
	const values: Partial<typeof appSettings.$inferInsert> = { updatedAt: new Date() };
	if (parsed.data.outboundAttachmentMaxMb !== undefined) values.outboundAttachmentMaxMb = parsed.data.outboundAttachmentMaxMb;
	if (parsed.data.driveStorageLimitGb !== undefined) values.driveDefaultQuotaBytes = parsed.data.driveStorageLimitGb === null ? 0 : Math.round(parsed.data.driveStorageLimitGb * GIB);
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
	if (parsed.data.defaultMailbox) await saveDefaultMailboxSettings(env, parsed.data.defaultMailbox);
	return Response.json(await readSettings(env), { headers: { "Cache-Control": "no-store" } });
}
