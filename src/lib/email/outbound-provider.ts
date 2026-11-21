import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, domains } from "@/db/schema";
import { getResendDomainStatus } from "@/lib/domains/resend-domain";
import { requireAwsConfig } from "@/lib/aws/config";
import { sendSesEmail } from "@/lib/aws/ses";
import { getSesIdentity } from "@/lib/aws/ses";
import { getAwsConfig } from "@/lib/aws/config";
import { getEmailAddress } from "@/lib/email/address";
import { ProviderConfigError, ProviderSendError, toNetworkError } from "@/lib/email/provider-errors";
import { sendWithFallback, type ProviderSendResult } from "@/lib/email/provider-fallback";
import { isMissingColumnError } from "@/lib/database-errors";
import type { OutboundProviderConfig, OutboundProviderMessage, ResendKeyStatus, SendingProvider } from "@/lib/email/outbound-provider-types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Each domain picks its own sender: Cloudflare Email Sending, Resend, or none
 * (receive-only). Receiving and storage always stay on Cloudflare. The Resend key
 * is shared by every domain; it comes from the admin setting, falling back to a
 * RESEND_API_KEY secret so it can be provisioned outside the database.
 */
export async function getResendKeyStatus(env: CloudflareEnv): Promise<ResendKeyStatus & { apiKey: string | null }> {
	const [settings] = await getDb(env)
		.select({ resendApiKey: appSettings.resendApiKey })
		.from(appSettings)
		.where(eq(appSettings.id, "default"))
		.limit(1);
	const saved = settings?.resendApiKey?.trim();
	const fromEnv = (env as { RESEND_API_KEY?: string }).RESEND_API_KEY?.trim();
	return {
		configured: !!(saved || fromEnv),
		source: saved ? "settings" : fromEnv ? "environment" : null,
		apiKey: saved || fromEnv || null,
	};
}

export async function getResendApiKey(env: CloudflareEnv): Promise<string> {
	const { apiKey } = await getResendKeyStatus(env);
	if (!apiKey) throw new ProviderConfigError("Resend is selected but no API key is configured", "resend");
	return apiKey;
}

function hostnameOf(fromAddress: string): string | undefined {
	return getEmailAddress(fromAddress).split("@")[1]?.toLowerCase();
}

async function loadProvider(env: CloudflareEnv, provider: SendingProvider): Promise<OutboundProviderConfig> {
	if (provider === "resend") return { provider: "resend", apiKey: await getResendApiKey(env) };
	if (provider === "ses") return { provider: "ses", config: await requireAwsConfig(env) };
	return { provider: "cloudflare" };
}

/**
 * The backup for a domain, only when it can really send: credentials present and
 * the domain verified with that provider. Anything else, including a database
 * without the column yet, yields null and the send behaves exactly as without a backup.
 */
export async function resolveFallbackProvider(env: CloudflareEnv, hostname: string | undefined, primary: SendingProvider): Promise<OutboundProviderConfig | null> {
	if (!hostname) return null;
	try {
		const [domain] = await getDb(env).select().from(domains).where(eq(domains.hostname, hostname)).limit(1);
		const fallback = domain?.fallbackSendingProvider;
		if (!domain || !fallback || fallback === primary) return null;
		if (fallback === "cloudflare") return domain.sendingEnabled ? { provider: "cloudflare" } : null;
		if (fallback === "resend") {
			const status = await getResendDomainStatus(env, domain);
			return status === "verified" ? await loadProvider(env, "resend") : null;
		}
		const config = await getAwsConfig(env);
		if (!config) return null;
		return (await getSesIdentity(config, hostname)).verified ? { provider: "ses", config } : null;
	} catch (error) {
		if (!isMissingColumnError(error)) console.warn("Backup sending provider unavailable", error instanceof Error ? error.message : error);
		return null;
	}
}

/**
 * The provider for the domain a message is sent from. When the primary cannot be
 * used at all (credentials missing) and a ready backup exists, the backup is returned
 * with `degradedFrom` naming the primary.
 */
export async function getOutboundProviderConfig(env: CloudflareEnv, fromAddress: string): Promise<OutboundProviderConfig> {
	const hostname = hostnameOf(fromAddress);
	const [domain] = hostname
		? await getDb(env).select({ provider: domains.sendingProvider }).from(domains).where(eq(domains.hostname, hostname)).limit(1)
		: [];
	if (!domain || domain.provider === "none") {
		throw new Error(`Sending is not set up for ${hostname ?? "this domain"}. Choose a sending provider on the Domains page.`);
	}
	try {
		return await loadProvider(env, domain.provider);
	} catch (error) {
		if (!(error instanceof ProviderConfigError)) throw error;
		const fallback = await resolveFallbackProvider(env, hostname, domain.provider);
		if (!fallback) throw error;
		console.warn(`Sending through ${fallback.provider}: ${error.message}`);
		return { ...fallback, degradedFrom: domain.provider, degradedReason: error.message };
	}
}

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

/** Resend does not return the RFC 5322 Message-ID, so we mint one for replies to thread against. */
function mintMessageId(from: string): string {
	const domain = getEmailAddress(from).split("@")[1] || "mailflare.local";
	return `<${crypto.randomUUID()}@${domain}>`;
}

async function sendWithResend(
	apiKey: string,
	message: OutboundProviderMessage,
	idempotencyKey?: string,
): Promise<{ messageId: string }> {
	const messageId = message.headers?.["Message-ID"] ?? mintMessageId(message.from);
	const response = await fetch(RESEND_ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
		},
		body: JSON.stringify({
			from: message.from,
			to: message.to,
			...(message.cc?.length ? { cc: message.cc } : {}),
			...(message.bcc?.length ? { bcc: message.bcc } : {}),
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers: { ...message.headers, "Message-ID": messageId },
			attachments: message.attachments?.map((attachment) => ({
				filename: attachment.filename,
				content: toBase64(attachment.content),
				content_type: attachment.type,
				...(attachment.disposition === "inline" && attachment.contentId ? { content_id: attachment.contentId } : {}),
			})),
		}),
	}).catch((error) => { throw toNetworkError("Resend", error); });
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { message?: string; name?: string } | null;
		throw new ProviderSendError(`Resend: ${body?.message ?? `request failed (${response.status})`}`, response.status, body?.name);
	}
	return { messageId };
}

export async function sendThroughProvider(
	env: CloudflareEnv,
	config: OutboundProviderConfig,
	message: OutboundProviderMessage,
	idempotencyKey?: string,
): Promise<{ messageId: string }> {
	if (config.provider === "resend") return sendWithResend(config.apiKey, message, idempotencyKey);
	if (config.provider === "ses") return sendSesEmail(config.config, message);
	const response = await env.EMAIL.send({
		from: message.from,
		to: message.to,
		...(message.cc?.length ? { cc: message.cc } : {}),
		...(message.bcc?.length ? { bcc: message.bcc } : {}),
		subject: message.subject,
		headers: message.headers && Object.keys(message.headers).length ? message.headers : undefined,
		html: message.html,
		text: message.text,
		attachments: message.attachments?.map((attachment) =>
			attachment.disposition === "inline" && attachment.contentId
				? { filename: attachment.filename, type: attachment.type, content: attachment.content, disposition: "inline" as const, contentId: attachment.contentId }
				: { filename: attachment.filename, type: attachment.type, content: attachment.content, disposition: "attachment" as const },
		),
	}).catch((error: unknown) => {
		const code = (error as { code?: unknown } | null)?.code;
		throw new ProviderSendError(`Cloudflare: ${error instanceof Error ? error.message : "send failed"}`, undefined, typeof code === "string" ? code : undefined, "unknown");
	});
	return { messageId: response.messageId };
}

/**
 * Sends through the domain's provider and, when that fails on the provider's side,
 * once more through its ready backup. The result names the provider that sent it.
 */
export async function sendViaDomainProviders(
	env: CloudflareEnv,
	primary: OutboundProviderConfig,
	from: string,
	message: OutboundProviderMessage,
	idempotencyKey?: string,
): Promise<ProviderSendResult> {
	// Resend mints a Message-ID per call; fix one up front so a retry through
	// another provider presents the same value. SES and Cloudflare assign their own.
	const messageId = message.headers?.["Message-ID"] ?? (primary.provider === "resend" ? mintMessageId(message.from) : undefined);
	const prepared = messageId ? { ...message, headers: { ...message.headers, "Message-ID": messageId } } : message;
	const result = await sendWithFallback({
		primary,
		resolveFallback: () => resolveFallbackProvider(env, hostnameOf(from), primary.provider),
		message: prepared,
		send: (config, outgoing, key) => sendThroughProvider(env, config, outgoing, key),
		idempotencyKey,
	});
	if (primary.degradedFrom) return { ...result, fallbackFrom: primary.degradedFrom, primaryError: primary.degradedReason };
	return result;
}
