export interface GeneralSettings {
	outboundAttachmentMaxMb: number;
	/** Per-user Drive cap in GB; null when unlimited. */
	driveStorageLimitGb: number | null;
	/** Mailbox created for every newly added domain. */
	defaultMailbox: { enabled: boolean; localPart: string; forwardTo: string };
}
