"use client";

import { useLanguage } from "./language-provider";

export const SOURCE_CODE_URL = "/source.tar.gz";

export function SourceCodeLink({ className = "" }: { className?: string }) {
	const { t } = useLanguage();
	return (
		<a
			href={SOURCE_CODE_URL}
			download
			className={`text-xs text-neutral-400 hover:text-neutral-700 hover:underline ${className}`}
		>
			{t("navigation.sourceCode")}
		</a>
	);
}
