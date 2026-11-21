import { createDnsRecord, listDnsRecords, listMxRecords } from "@/lib/cloudflare-dns";
import type { CfDnsRecord } from "@/lib/cloudflare-api.types";
import type { CloudflareDnsRecordCreate } from "@/lib/cloudflare-dns.types";

function stripQuotes(value: string | undefined): string {
	return (value ?? "").trim().replace(/^"|"$/g, "");
}

function isSpf(record: CfDnsRecord): boolean {
	return stripQuotes(record.content).toLowerCase().startsWith("v=spf1");
}

/**
 * The MX and SPF TXT records on `hostname` as they stand now. Returns null when
 * they cannot be read, which callers must treat as "unknown, assume mail DNS exists".
 */
export async function snapshotMailDns(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
): Promise<CfDnsRecord[] | null> {
	try {
		const [mx, txt] = await Promise.all([
			listMxRecords(env, zoneId, hostname),
			listDnsRecords(env, zoneId, { type: "TXT", name: hostname }),
		]);
		return [...mx, ...txt.filter(isSpf)];
	} catch (error) {
		console.warn("snapshotMailDns: could not read existing mail DNS", error);
		return null;
	}
}

function sameRecord(a: CfDnsRecord, b: CfDnsRecord): boolean {
	if (a.type !== b.type) return false;
	if (a.name?.toLowerCase() !== b.name?.toLowerCase()) return false;
	if (stripQuotes(a.content).toLowerCase() !== stripQuotes(b.content).toLowerCase()) return false;
	return a.type !== "MX" || a.priority === b.priority;
}

/** Re-create any snapshotted record that is no longer on the zone (matching content and priority). */
export async function restoreMissingMailDns(
	env: CloudflareEnv,
	zoneId: string,
	hostname: string,
	snapshot: CfDnsRecord[],
): Promise<void> {
	if (snapshot.length === 0) return;
	const current = await snapshotMailDns(env, zoneId, hostname);
	if (!current) throw new Error("Could not list current mail DNS records to restore the snapshot");
	for (const record of snapshot) {
		if (current.some((existing) => sameRecord(existing, record))) continue;
		if (!record.type || !record.name || !record.content) continue;
		const input = {
			type: record.type,
			name: record.name,
			content: record.content,
			ttl: record.ttl ?? 1,
			...(record.type === "MX" ? { priority: record.priority ?? 10 } : {}),
			...(record.comment === undefined ? {} : { comment: record.comment }),
		} as CloudflareDnsRecordCreate;
		await createDnsRecord(env, zoneId, input);
		current.push(record);
	}
}
