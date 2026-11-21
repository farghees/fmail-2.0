import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxAliases, mailboxes, routingRules, users } from "@/db/schema";
import { isEmailRoutingDestinationVerified } from "@/lib/cloudflare-api";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { newId } from "@/lib/ids";
import { ensureMailboxDomainRouting } from "@/lib/mailboxes/domain-addresses";
import { hasCloudflareCredentials } from "@/lib/runtime";
import { isManualZone } from "./provision";
import { getDefaultMailboxSettings } from "./default-mailbox-settings";
import type { DefaultMailboxResult } from "./default-mailbox-types";

/**
 * Creates the configured default mailbox (`admin@<domain>` by default) on a freshly added domain.
 *
 * It is owned by the primary admin account and forwards through an ordinary mailbox-scope forward rule
 * that keeps a copy, the same mechanism as a forward rule created by hand: the Worker resolves the
 * rule and calls `message.forward()`, which needs a verified Email Routing destination address.
 * An existing mailbox or alias is never touched. Never throws, because the domain is already set up.
 */
export async function ensureDefaultMailbox(
	env: CloudflareEnv,
	domain: Pick<typeof domains.$inferSelect, "id" | "hostname" | "zoneId" | "userId">,
): Promise<DefaultMailboxResult> {
	try {
		const settings = await getDefaultMailboxSettings(env);
		if (!settings.enabled) return { status: "disabled", forward: "none" };
		const localPart = normalizeRecipientLocalPart(settings.localPart);
		if (!localPart) return { status: "failed", forward: "none", warning: "The default mailbox name is not valid." };
		const address = `${localPart}@${domain.hostname}`;
		const db = getDb(env);

		const [existingMailbox] = await db.select({ id: mailboxes.id }).from(mailboxes)
			.where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart))).limit(1);
		const [existingAlias] = await db.select({ id: mailboxAliases.id }).from(mailboxAliases)
			.where(and(eq(mailboxAliases.domainId, domain.id), eq(mailboxAliases.localPart, localPart))).limit(1);
		if (existingMailbox || existingAlias) return { status: "exists", address, forward: "none" };

		const [primaryAdmin] = await db.select({ id: users.id }).from(users).where(eq(users.isPrimaryAdmin, true)).limit(1);
		const ownerId = primaryAdmin?.id ?? domain.userId;
		const mailboxId = newId("mbx");
		await db.insert(mailboxes).values({
			id: mailboxId,
			userId: ownerId,
			domainId: domain.id,
			localPart,
			displayName: localPart,
			// Scoped to this domain: an all-domains mailbox would also answer for the same name elsewhere.
			useAllDomains: false,
		});

		const result: DefaultMailboxResult = { status: "created", address, forward: "none" };
		const warnings: string[] = [];
		try {
			await ensureMailboxDomainRouting(env, db, { id: mailboxId, domainId: domain.id, localPart, useAllDomains: false });
		} catch (error) {
			console.warn("ensureDefaultMailbox: routing rule", error);
			warnings.push(`${address} was created, but its Email Routing rule failed; the domain catch-all still delivers to it.`);
		}

		if (settings.forwardTo) {
			const verified = !isManualZone(domain.zoneId) && hasCloudflareCredentials(env)
				? await isEmailRoutingDestinationVerified(env, domain.zoneId, settings.forwardTo)
				: null;
			if (verified === false) {
				result.forward = "skipped";
				warnings.push(`${settings.forwardTo} is not a verified Email Routing destination address, so forwarding for ${address} was not set up. Verify it in Cloudflare Email Routing, then add the forward rule to the mailbox.`);
			} else {
				await db.insert(routingRules).values({
					id: newId("rule"),
					userId: ownerId,
					domainId: domain.id,
					scope: "mailbox",
					name: "Default forward",
					pattern: "*",
					matchField: "email",
					matchOperator: "contains",
					matchValue: "*",
					action: "forward",
					mailboxId,
					forwardTo: settings.forwardTo,
					keepCopy: true,
					priority: 0,
				});
				result.forward = verified === true ? "configured" : "unchecked";
				if (verified === null) warnings.push(`Could not confirm that ${settings.forwardTo} is a verified Email Routing destination; check it in Cloudflare Email Routing.`);
			}
		}
		if (warnings.length) {
			result.warning = warnings.join(" ");
			console.warn("ensureDefaultMailbox", warnings.join(" "));
		}
		return result;
	} catch (error) {
		console.warn("ensureDefaultMailbox failed", error);
		return { status: "failed", forward: "none", warning: "The default mailbox could not be created." };
	}
}
