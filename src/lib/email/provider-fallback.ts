import { shouldFallBack } from "@/lib/email/provider-errors";
import type { OutboundProviderConfig, OutboundProviderMessage, SendingProvider } from "@/lib/email/outbound-provider-types";

export type ProviderSendResult = {
	messageId: string;
	/** The provider that actually accepted the message. */
	provider: SendingProvider;
	/** Set when the primary failed and the backup sent it. */
	fallbackFrom?: SendingProvider;
	primaryError?: string;
};

type SendOnce = (config: OutboundProviderConfig, message: OutboundProviderMessage, idempotencyKey?: string) => Promise<{ messageId: string }>;

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Sends through `primary`; when that fails definitively on the provider's side
 * (see `shouldFallBack`) and `resolveFallback` yields a ready backup, sends once
 * more through it. The message, including any Message-ID header, is passed
 * unchanged to both attempts. `resolveFallback` runs only after a qualifying
 * failure, so the happy path costs nothing. If the backup also fails, the
 * primary's error is the one reported, since that is the configured sender.
 */
export async function sendWithFallback(options: {
	primary: OutboundProviderConfig;
	resolveFallback: () => Promise<OutboundProviderConfig | null>;
	message: OutboundProviderMessage;
	send: SendOnce;
	idempotencyKey?: string;
}): Promise<ProviderSendResult> {
	const { primary, message, send, idempotencyKey } = options;
	try {
		const sent = await send(primary, message, idempotencyKey);
		return { messageId: sent.messageId, provider: primary.provider };
	} catch (primaryError) {
		if (!shouldFallBack(primaryError)) throw primaryError;
		let fallback: OutboundProviderConfig | null = null;
		try { fallback = await options.resolveFallback(); } catch (resolveError) {
			console.warn("Backup sending provider could not be checked", describe(resolveError));
		}
		if (!fallback || fallback.provider === primary.provider) throw primaryError;
		try {
			const sent = await send(fallback, message, idempotencyKey);
			console.warn(`Sent through ${fallback.provider} after ${primary.provider} failed: ${describe(primaryError)}`);
			return { messageId: sent.messageId, provider: fallback.provider, fallbackFrom: primary.provider, primaryError: describe(primaryError) };
		} catch (fallbackError) {
			console.error(`Backup provider ${fallback.provider} also failed`, describe(fallbackError));
			throw primaryError;
		}
	}
}
