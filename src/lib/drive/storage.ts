import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, driveItems, users } from "@/db/schema";
import { formatDriveSize } from "./utils";

export const GIB = 1024 ** 3;
/** Default per-user Drive quota when the administrator has not changed it. */
export const DRIVE_DEFAULT_QUOTA_BYTES = 5 * GIB;

type Db = ReturnType<typeof getDb>;

/**
 * The effective quota in bytes, or null for unlimited.
 * A per-user override wins (0 is unlimited); without one, admins are unlimited and everyone else
 * gets the app default (0 is unlimited).
 */
export function resolveDriveQuota(input: { role: string; override: number | null | undefined; defaultBytes: number }): number | null {
	const bytes = input.override ?? (input.role === "admin" ? 0 : input.defaultBytes);
	return bytes > 0 ? bytes : null;
}

/** Whether adding `addBytes` to `used` stays within `quota` (null is unlimited). */
export function fitsDriveQuota(used: number, addBytes: number, quota: number | null): boolean {
	return quota === null || used + addBytes <= quota;
}

export function driveQuotaMessage(used: number, quota: number): string {
	return `Storage full: ${formatDriveSize(used)} of ${formatDriveSize(quota)} used`;
}

/** App-wide default per-user quota in bytes; 0 is unlimited. */
export async function getDriveDefaultQuota(db: Db): Promise<number> {
	try {
		const [row] = await db.select({ bytes: appSettings.driveDefaultQuotaBytes }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
		return row ? Number(row.bytes) : DRIVE_DEFAULT_QUOTA_BYTES;
	} catch {
		return DRIVE_DEFAULT_QUOTA_BYTES;
	}
}

/** Effective quota of one user in bytes, or null for unlimited. */
export async function getDriveQuota(db: Db, userId: string): Promise<number | null> {
	const [user] = await db.select({ role: users.role, override: users.driveQuotaBytes }).from(users).where(eq(users.id, userId)).limit(1);
	if (!user) return null;
	return resolveDriveQuota({ role: user.role, override: user.override === null ? null : Number(user.override), defaultBytes: await getDriveDefaultQuota(db) });
}

/** Bytes of every file the user owns. Trashed files and in-progress uploads (at their declared size) still cost storage. */
export async function getDriveStorageUsed(db: Db, ownerId: string): Promise<number> {
	const [usage] = await db.select({ total: sql<number>`coalesce(sum(${driveItems.size}), 0)` }).from(driveItems).where(and(eq(driveItems.ownerId, ownerId), eq(driveItems.kind, "file")));
	return Number(usage?.total ?? 0);
}

/**
 * Checks that `ownerId` can store `addBytes` more. `releasedBytes` is space about to be given back,
 * such as the declared size of an upload being finalised. Returns a 413 response when it does not fit.
 */
export async function checkDriveQuota(db: Db, ownerId: string, addBytes: number, releasedBytes = 0): Promise<Response | null> {
	const quota = await getDriveQuota(db, ownerId);
	if (quota === null) return null;
	const used = Math.max(0, (await getDriveStorageUsed(db, ownerId)) - releasedBytes);
	return fitsDriveQuota(used, addBytes, quota) ? null : Response.json({ error: driveQuotaMessage(used, quota), code: "drive_quota_exceeded", used, quota }, { status: 413 });
}
