import { headers } from "next/headers";

/** Host the current request was addressed to, or null outside a request (cron, queues, tests). */
export async function getRequestHost(): Promise<string | null> {
	try {
		const h = await headers();
		return h.get("x-forwarded-host") ?? h.get("host");
	} catch {
		return null;
	}
}
