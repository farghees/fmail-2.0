"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
type State = { available: boolean; email?: string; status?: string };
export function GoogleForwarding() {
 const [state, setState] = useState<State | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState("");
 async function refresh() {
  const response = await authFetch("/api/settings/google-forwarding");
  if (response.ok) setState(await response.json() as State);
 }
 useEffect(() => { if (new URLSearchParams(window.location.search).get("googleForwarding") === "error") setError("Your mailbox is ready, but forwarding setup failed. Forwarding is off. You can try turning it on below."); void refresh().catch(() => undefined); }, []);
 if (!state?.available) return null;
 const enabled = state.status === "pending" || state.status === "verified";
 async function toggle() {
  setBusy(true); setError("");
  try {
   const response = await authFetch("/api/settings/google-forwarding", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
   const result = await response.json() as State & { error?: string };
   if (!response.ok) setError(result.error || "Could not update forwarding"); else setState(result);
  } catch { setError("Could not update forwarding"); } finally { setBusy(false); }
 }
 return <section className="space-y-4 rounded-2xl border p-6">
  <h2 className="text-lg font-semibold">Google backup and forwarding</h2>
  <p className="text-sm">Your Google backup address is {state.email}.</p>
  <p className="text-sm text-neutral-500">{state.status === "verified" ? "Forwarding is on. A copy of incoming mail is sent to your Google email; the original stays in Fmail." : state.status === "pending" ? "Forwarding is waiting for verification. Open the email from Cloudflare in your Google inbox and click Verify email address, then check status below." : state.status === "error" ? "Forwarding status is unavailable. Check again before relying on it." : "Forwarding is off. Incoming mail stays in Fmail only."}</p>
  <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void toggle()}>{busy ? "Saving..." : enabled ? "Turn forwarding off" : "Turn forwarding on"}</Button><Button variant="outline" disabled={busy} onClick={() => void refresh().catch(() => setError("Could not check status"))}>Check status</Button></div>
  {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
 </section>;
}
