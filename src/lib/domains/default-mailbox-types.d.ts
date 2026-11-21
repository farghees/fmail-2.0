export type DefaultMailboxSettings = {
	enabled: boolean;
	localPart: string;
	/** External address the default mailbox forwards to (a copy stays in the mailbox); empty means none. */
	forwardTo: string;
};

export type DefaultMailboxResult = {
	status: "created" | "exists" | "disabled" | "failed";
	address?: string;
	/**
	 * configured: forward rule created to a verified Email Routing destination.
	 * unchecked: rule created, but verification was not possible (no Cloudflare access).
	 * skipped: destination is not a verified Email Routing destination, so no rule was created.
	 * none: no forward address configured.
	 */
	forward: "configured" | "unchecked" | "skipped" | "none";
	warning?: string;
};
