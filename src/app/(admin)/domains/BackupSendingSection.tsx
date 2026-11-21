"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Select } from "@/components/ui/select";
import { requestJson } from "./api";
import SesSendingConfig from "./SesSendingConfig";
import type { Domain } from "./types";

type Choice = "none" | "ses";

/**
 * The backup sender: tried once when the main provider fails on its side (rate
 * limit, outage, rejected key), never for recipient errors. Choosing only records
 * the intent; it is used once the provider's own setup below shows verified.
 */
export default function BackupSendingSection({ domain }: { domain: Domain }) {
	const { t } = useLanguage();
	const [choice, setChoice] = useState<Choice>("none");
	const [loaded, setLoaded] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		setLoaded(false);
		requestJson<{ fallbackProvider?: string }>(`/api/domains/${domain.id}/sending`, "GET")
			.then((data) => { if (active) setChoice(data.fallbackProvider === "ses" ? "ses" : "none"); })
			.catch(() => undefined)
			.finally(() => { if (active) setLoaded(true); });
		return () => { active = false; };
	}, [domain.id, domain.sendingProvider]);

	if (domain.sendingProvider === "none") return null;

	async function change(next: Choice) {
		setBusy(true);
		setError("");
		try {
			await requestJson(`/api/domains/${domain.id}/sending`, "PATCH", { fallbackProvider: next });
			setChoice(next);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("domains.backupSaveFailed"));
		} finally { setBusy(false); }
	}

	return (
		<section className="mt-6">
			<h2 className="text-base font-semibold text-neutral-900">{t("domains.backupTitle")}</h2>
			<p className="mt-0.5 text-sm text-neutral-500">{t("domains.backupHint")}</p>
			<div className="mt-3 rounded-xl bg-neutral-50 px-4 py-3 text-sm">
				<Select
					aria-label={t("domains.backupTitle")}
					value={choice}
					disabled={busy || !loaded || domain.sendingProvider === "ses"}
					onChange={(event) => void change(event.target.value as Choice)}
					containerClassName="h-9 max-w-xs rounded-md bg-white px-0"
					className="px-3 text-sm"
				>
					<option value="none">{t("domains.backupNone")}</option>
					{domain.sendingProvider !== "ses" && <option value="ses">{t("domains.providerSes")}</option>}
				</Select>
				{choice === "ses" && (
					<div className="mt-3 space-y-2 border-t border-neutral-200 pt-3">
						<SesSendingConfig domainId={domain.id} onStatus={setStatus} />
						<p className="text-xs text-neutral-500">{status === "verified" ? t("domains.backupReady") : t("domains.backupNotReady")}</p>
					</div>
				)}
				{error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
			</div>
		</section>
	);
}
