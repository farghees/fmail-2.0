import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import type { DefaultMailboxSettings } from "./default-mailbox-types";

export const DEFAULT_MAILBOX_SETTINGS_ID = "default";
export const DEFAULT_MAILBOX_LOCAL_PART = "admin";

export const defaultMailboxSettingsSchema = z.object({
	enabled: z.boolean(),
	localPart: z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9]([a-z0-9._+-]*[a-z0-9])?$/),
	forwardTo: z.union([z.literal(""), z.string().trim().toLowerCase().max(254).email()]),
});

export const DISABLED_DEFAULT_MAILBOX: DefaultMailboxSettings = { enabled: false, localPart: DEFAULT_MAILBOX_LOCAL_PART, forwardTo: "" };

/** Disabled until the migration that adds the columns has run, so adding a domain never depends on it. */
export async function getDefaultMailboxSettings(env: CloudflareEnv): Promise<DefaultMailboxSettings> {
	try {
		const [row] = await getDb(env).select({
			enabled: appSettings.defaultMailboxEnabled,
			localPart: appSettings.defaultMailboxLocalPart,
			forwardTo: appSettings.defaultMailboxForwardTo,
		}).from(appSettings).where(eq(appSettings.id, DEFAULT_MAILBOX_SETTINGS_ID)).limit(1);
		if (!row) return DISABLED_DEFAULT_MAILBOX;
		return {
			enabled: !!row.enabled,
			localPart: normalizeRecipientLocalPart(row.localPart) || DEFAULT_MAILBOX_LOCAL_PART,
			forwardTo: row.forwardTo?.trim() ?? "",
		};
	} catch {
		return DISABLED_DEFAULT_MAILBOX;
	}
}

export async function saveDefaultMailboxSettings(env: CloudflareEnv, settings: DefaultMailboxSettings) {
	const set = {
		defaultMailboxEnabled: settings.enabled,
		defaultMailboxLocalPart: settings.localPart,
		defaultMailboxForwardTo: settings.forwardTo || null,
		updatedAt: new Date(),
	};
	await getDb(env).insert(appSettings).values({ id: DEFAULT_MAILBOX_SETTINGS_ID, ...set }).onConflictDoUpdate({ target: appSettings.id, set });
}
