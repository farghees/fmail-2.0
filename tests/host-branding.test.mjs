import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-host-branding-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: { hosts: join(root, "src/lib/branding/hosts.ts"), utils: join(root, "src/lib/i18n/utils.ts") },
	outdir: outDir,
	bundle: true,
	format: "esm",
	platform: "node",
	logLevel: "silent",
	alias: { "@": join(root, "src") },
	loader: { ".json": "json" },
});
const hosts = await import(pathToFileURL(join(outDir, "hosts.js")).href);
const i18n = await import(pathToFileURL(join(outDir, "utils.js")).href);

// The shipped map is empty; register one client host for the tests.
hosts.HOST_BRANDING["mail.example.com"] = { appName: "Example Mail" };

test("a registered host resolves to its own branding", () => {
	assert.equal(hosts.resolveAppName("mail.example.com"), "Example Mail");
	assert.equal(hosts.resolveAppName("MAIL.EXAMPLE.COM:443"), "Example Mail");
	assert.equal(hosts.resolveAppName("mail.example.com, proxy.internal"), "Example Mail");
});

test("unknown, empty and prototype-key hosts fall back to Fmail", () => {
	for (const host of ["other.example.com", "", null, undefined, "evil.example", "constructor", "__proto__"]) {
		assert.equal(hosts.resolveAppName(host), "Fmail");
	}
});

test("applyBrandName rewrites the default name only for branded hosts", () => {
	assert.equal(hosts.applyBrandName("Open Fmail now", "Example Mail"), "Open Example Mail now");
	assert.equal(hosts.applyBrandName("Open Fmail now", "Fmail"), "Open Fmail now");
});

test("translator brands templates but not interpolated user data", () => {
	const t = i18n.createTranslator("en", undefined, "Example Mail");
	assert.equal(t("update.upToDate", { current: "Fmail@example.com" }), "Example Mail vFmail@example.com is up to date.");
	assert.equal(i18n.createTranslator("en")("update.updateButton"), "Update Fmail");
	assert.equal(t("update.updateButton"), "Update Example Mail");
});
