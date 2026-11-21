import { cfRequest } from "@/lib/cloudflare-api";

type Destination = { email?: string; verified?: string | null };

/** Only returns the status of the authenticated user's Google-verified email. */
export async function googleForwardingStatus(env: CloudflareEnv, email: string): Promise<"missing" | "pending" | "verified"> {
 const accountId = env.CF_ACCOUNT_ID?.trim();
 if (!accountId || !/^[a-f0-9]{32}$/.test(accountId)) throw new Error("Forwarding account is not configured");
 for (let page = 1; page <= 20; page++) {
  const rows = await cfRequest<Destination[]>(env, `/accounts/${accountId}/email/routing/addresses?page=${page}&per_page=50`);
  const destination = rows.find((row) => row.email?.toLowerCase() === email.toLowerCase());
  if (destination) return destination.verified ? "verified" : "pending";
  if (rows.length < 50) return "missing";
 }
 throw new Error("Could not check forwarding address");
}

/** Called only after the mailbox owner explicitly opts in. Never accepts a client-supplied email. */
export async function requestGoogleForwarding(env: CloudflareEnv, email: string): Promise<"pending" | "verified"> {
 const status = await googleForwardingStatus(env, email);
 if (status !== "missing") return status;
 const result = await cfRequest<Destination>(env, `/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses`, {
  method: "POST", body: JSON.stringify({ email }),
 });
 return result.verified ? "verified" : "pending";
}
