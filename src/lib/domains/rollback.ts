import {
	deleteEmailRoutingRuleForAddress,
	deleteSendingSubdomain,
	disableEmailRouting,
} from "@/lib/cloudflare-api";
import { restoreEmailRoutingCatchAll } from "@/lib/domains/catch-all-routing";
import { restoreMissingMailDns } from "@/lib/domains/mail-dns-snapshot";
import { restoreMxRecords } from "@/lib/domains/mx-records";
import type { DomainProvisioningChanges } from "@/lib/domains/types";

async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
	try {
		await run();
	} catch (err) {
		// A rollback runs while another error is already on its way to the caller,
		// so a failure here must be logged, never thrown — it would mask the cause.
		console.warn(`rollbackDomainProvisioning: ${label}`, err);
	}
}

/**
 * Undo exactly what a provisioning attempt changed on the zone, so a failed
 * signup or domain add leaves the Cloudflare account as it was rather than
 * stranding Email Routing and a sending subdomain with nothing referencing them.
 *
 * Anything the attempt merely reused is deliberately left alone.
 */
export async function rollbackDomainProvisioning(
	env: CloudflareEnv,
	changes: DomainProvisioningChanges,
): Promise<void> {
	const { zoneId } = changes;

	for (const address of changes.createdAddressRules) {
		await attempt(`deleteEmailRoutingRuleForAddress ${address}`, () =>
			deleteEmailRoutingRuleForAddress(env, zoneId, address),
		);
	}

	if (changes.createdSendingSubdomainTag) {
		await attempt("deleteSendingSubdomain", () =>
			deleteSendingSubdomain(env, zoneId, changes.createdSendingSubdomainTag!),
		);
	}

	// Restore before disabling: Cloudflare keeps the routing config around when
	// Email Routing is switched off, so leaving the Worker catch-all in place would
	// quietly resurrect it the next time someone re-enables routing on the zone.
	if (changes.previousCatchAll || changes.enabledEmailRouting) {
		await attempt("restoreEmailRoutingCatchAll", () =>
			restoreEmailRoutingCatchAll(env, zoneId, changes.previousCatchAll),
		);
	}

	if (changes.enabledEmailRouting) {
		// Cloudflare offers no way to switch Email Routing off that keeps DNS:
		// DELETE /email/routing/dns removes every MX, SPF and DKIM record it manages.
		// Only do it when the zone provably had no mail DNS before this attempt.
		if (changes.previousMailDns && changes.previousMailDns.length === 0) {
			await attempt("disableEmailRouting", () => disableEmailRouting(env, zoneId));
		} else {
			console.warn(
				"rollbackDomainProvisioning: leaving Email Routing enabled because the zone had mail DNS records before provisioning (or they could not be read); disabling it would delete them",
			);
		}
	}

	if (changes.deletedMxRecords.length > 0) {
		await attempt("restoreMxRecords", () => restoreMxRecords(env, zoneId, changes.deletedMxRecords));
	}

	if (changes.previousMailDns?.length && changes.mailDnsHostname) {
		await attempt("restoreMissingMailDns", () =>
			restoreMissingMailDns(env, zoneId, changes.mailDnsHostname!, changes.previousMailDns!),
		);
	}
}
