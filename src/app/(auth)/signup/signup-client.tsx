"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Mail } from "@/components/icons";
import { AuthShell } from "@/components/auth/auth-shell";
import { TurnstileField } from "@/components/auth/turnstile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type GoogleConfig = {
	enabled: boolean;
	signupAvailable: boolean;
	domain: string | null;
	pending: { email: string; name: string | null } | null;
};

export function SignupClient() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [config, setConfig] = useState<GoogleConfig | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [forwardToGmail, setForwardToGmail] = useState(false);
	const [turnstileReset, setTurnstileReset] = useState(0);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const response = await fetch("/api/auth/google/config", { cache: "no-store" });
				if (!response.ok) throw new Error("Sign-up is unavailable");
				if (!cancelled) setConfig((await response.json()) as GoogleConfig);
			} catch {
				if (!cancelled) setError("Could not load sign-up. Refresh to try again.");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		setLoading(true);
		try {
			const form = new FormData(event.currentTarget);
			const response = await fetch("/api/auth/google/complete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: String(form.get("username") ?? ""),
					forwardToGmail,
					turnstileToken: String(form.get("turnstileToken") ?? ""),
				}),
			});
			const data = (await response.json().catch(() => ({}))) as { error?: string; redirect?: string };
			if (!response.ok) {
				setError(data.error ?? "Sign-up failed. Try again.");
				setTurnstileReset((value) => value + 1);
				return;
			}
			router.replace(data.redirect ?? "/inbox");
			router.refresh();
		} catch {
			setError("Sign-up failed. Try again.");
		} finally {
			setLoading(false);
		}
	}

	const googleButton = (
		<Button size="lg" className="w-full rounded-full" asChild>
			<a href="/api/auth/google/start">Continue with Google</a>
		</Button>
	);

	let content: React.ReactNode;
	if (!config) {
		content = <p role={error ? "alert" : "status"} className="text-sm text-neutral-500">{error || "Loading..."}</p>;
	} else if (!config.enabled || !config.signupAvailable) {
		content = <p className="text-sm text-neutral-600">Account creation is not available right now.</p>;
	} else if (config.pending && searchParams.get("step") === "username") {
		const domain = config.domain;
		content = (
			<form onSubmit={onSubmit} className="flex flex-col gap-4">
				<p className="text-sm text-neutral-600">
					Google account: <span className="font-medium text-neutral-900">{config.pending.email}</span>. This Gmail is your
					backup address for password resets.
				</p>
				<div className="flex flex-col gap-2">
					<Label htmlFor="username">Choose your UserID</Label>
					<div className="flex items-center gap-2">
						<Input id="username" name="username" autoComplete="off" autoFocus required maxLength={32}
							pattern="[A-Za-z0-9][A-Za-z0-9_-]*" placeholder="yourname" className="flex-1" />
						<span className="text-sm text-neutral-500">@{domain}</span>
					</div>
				</div>
				<label className="flex items-start gap-2 text-sm text-neutral-700">
					<input
						type="checkbox"
						className="mt-1"
						checked={forwardToGmail}
						onChange={(event) => setForwardToGmail(event.target.checked)}
					/>
					<span>
						Forward a copy of all incoming mail to {config.pending.email}. Forwarding starts after you click the Cloudflare verification email. Your mail stays in
						Fmail either way.
					</span>
				</label>
				<TurnstileField resetSignal={turnstileReset} />
				{error ? <p className="text-sm text-red-600">{error}</p> : null}
				<Button type="submit" size="lg" className="rounded-full" disabled={loading}>
					{loading ? "Creating your mailbox…" : "Create mailbox"}
				</Button>
			</form>
		);
	} else {
		content = (
			<div className="flex flex-col gap-4">
				<p className="text-sm text-neutral-600">
					Create a mailbox on {config.domain} with your Google account. Your Gmail stays your backup and recovery
					address.
				</p>
				{googleButton}
			</div>
		);
	}

	return (
		<AuthShell
			icon={Mail}
			title="Create account"
			description="Sign up with Google and pick your own address."
			footer={
				<p className="text-sm text-neutral-500">
					<Link href="/privacy" className="text-blue-600 hover:underline">Notis Privasi</Link><br />
					Already have a mailbox?{" "}
					<Link href="/login" className="text-blue-600 hover:underline">
						Log in
					</Link>
				</p>
			}
		>
			{content}
		</AuthShell>
	);
}
