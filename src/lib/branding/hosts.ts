/**
 * Per-hostname branding for client webmail domains served by the same worker.
 * Adding a client domain is one entry here; any other host gets the default branding.
 */
export const DEFAULT_APP_NAME = "Fmail";

const DEFAULT_NAME_PATTERN = new RegExp(DEFAULT_APP_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");

export type HostBranding = { appName: string };

export const HOST_BRANDING: Readonly<Record<string, HostBranding>> = {
	// Example: serve a client webmail at mail.example.com under its own name.
	// "mail.example.com": { appName: "Example Mail" },
};

/** Lowercases and strips port / trailing dot; takes the first value of a comma-separated forwarded header. */
export function normalizeHost(host: string | null | undefined): string {
	return (host ?? "").split(",")[0].trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

export function resolveHostBranding(host: string | null | undefined): HostBranding | undefined {
	const key = normalizeHost(host);
	return Object.hasOwn(HOST_BRANDING, key) ? HOST_BRANDING[key] : undefined;
}

export function resolveAppName(host: string | null | undefined): string {
	return resolveHostBranding(host)?.appName ?? DEFAULT_APP_NAME;
}

/** Swaps the default product name in copy (translations, etc.) for the host's app name. */
export function applyBrandName(text: string, appName: string): string {
	return appName === DEFAULT_APP_NAME ? text : text.replace(DEFAULT_NAME_PATTERN, () => appName);
}

export function brandMessages<T extends Record<string, string>>(messages: T, appName: string): T {
	if (appName === DEFAULT_APP_NAME) return messages;
	return Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, applyBrandName(value, appName)])) as T;
}
