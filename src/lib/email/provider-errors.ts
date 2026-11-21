import type { SendingProvider } from "@/lib/email/outbound-provider-types";

/**
 * A failure talking to a sending provider. `status` is the HTTP status when the
 * provider answered; `phase` says how far the request got when it did not.
 * "connect" means it never reached the provider (refused, DNS), so nothing was
 * accepted; "unknown" covers timeouts and dropped connections, where the
 * provider may still have accepted the message.
 */
export class ProviderSendError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly code?: string,
		readonly phase: "response" | "connect" | "unknown" = status ? "response" : "unknown",
	) {
		super(message);
	}
}

/** The primary provider is selected but cannot be used at all (for example, no credentials). Nothing was sent. */
export class ProviderConfigError extends Error {
	override readonly name = "ProviderConfigError";
	constructor(message: string, readonly provider: SendingProvider) {
		super(message);
	}
}

/** Provider error codes that mean quota, rate limit, outage or a broken account, whatever the HTTP status. */
const FALLBACK_CODES = /^(LimitExceeded|TooManyRequests|Throttling|ServiceUnavailable|InternalFailure|SendingPaused|AccountSuspended|AccountSendingPaused|E_RATE_LIMIT_EXCEEDED|E_DAILY_LIMIT_EXCEEDED|E_INTERNAL_SERVER_ERROR|E_SENDER_NOT_VERIFIED|E_SENDER_DOMAIN_NOT_AVAILABLE)/i;

const CONNECT_FAILURE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|connection refused|getaddrinfo|could not resolve|failed to resolve|dns (lookup|resolution)/i;

function describeCause(error: unknown): string {
	const parts: string[] = [];
	for (let current: unknown = error, depth = 0; current && depth < 3; depth++) {
		const item = current as { message?: unknown; code?: unknown; cause?: unknown };
		if (typeof item.code === "string") parts.push(item.code);
		if (typeof item.message === "string") parts.push(item.message);
		current = item.cause;
	}
	return parts.join(" ");
}

/**
 * Whether a failed send may be retried once through the backup provider.
 * Only definitive provider-side failures qualify: rate limits and quota (429),
 * outages (5xx), rejected or revoked credentials (401/403), a provider that is
 * not configured, and connections that never opened. Recipient and validation
 * errors (other 4xx) and anything ambiguous, such as a timeout after the request
 * went out, never do, because the message may already be on its way.
 */
export function shouldFallBack(error: unknown): boolean {
	if (error instanceof ProviderConfigError || (error as { name?: unknown } | null)?.name === "ProviderConfigError") return true;
	const item = error as { status?: unknown; code?: unknown; phase?: unknown } | null;
	if (!item || typeof item !== "object") return false;
	const status = typeof item.status === "number" ? item.status : undefined;
	const code = typeof item.code === "string" ? item.code : "";
	if (status !== undefined) {
		if (status === 429 || status === 401 || status === 403 || status >= 500) return true;
		return FALLBACK_CODES.test(code);
	}
	if (FALLBACK_CODES.test(code)) return true;
	if (item.phase === "connect") return true;
	if (item.phase === "unknown" && error instanceof ProviderSendError) return false;
	// A raw fetch failure: refused or unresolvable hosts never saw the request.
	return CONNECT_FAILURE.test(describeCause(error));
}

/** Wraps a rejected `fetch` so the connect-versus-ambiguous call is made once, here. */
export function toNetworkError(provider: string, error: unknown): ProviderSendError {
	const phase = CONNECT_FAILURE.test(describeCause(error)) ? "connect" : "unknown";
	return new ProviderSendError(`${provider}: ${error instanceof Error ? error.message : "network error"}`, undefined, undefined, phase);
}
