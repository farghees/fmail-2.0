import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-fallback-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({ entryPoints: [join(root, entry)], outfile: join(outDir, outfile), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent", alias: { "@": join(root, "src") } });
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { sendWithFallback } = await bundle("src/lib/email/provider-fallback.ts", "fallback.mjs");
const { ProviderSendError, ProviderConfigError, toNetworkError } = await bundle("src/lib/email/provider-errors.ts", "errors.mjs");
const { AwsError } = await bundle("src/lib/aws/client.ts", "client.mjs");

const primary = { provider: "resend", apiKey: "re_x" };
const backup = { provider: "ses", config: { accessKeyId: "A", secretAccessKey: "S", region: "us-east-1" } };
const message = { from: "a@example.com", to: ["b@example.com"], subject: "hi", text: "hi", headers: { "Message-ID": "<fixed@example.com>" } };

function harness({ failPrimary, fallback = backup, failBackup } = {}) {
	const calls = [];
	let resolved = 0;
	return {
		calls,
		get resolved() { return resolved; },
		run: () => sendWithFallback({
			primary,
			message,
			resolveFallback: async () => { resolved++; return fallback; },
			send: async (config, outgoing) => {
				calls.push({ provider: config.provider, headers: outgoing.headers });
				if (config.provider === "resend" && failPrimary) throw failPrimary;
				if (config.provider === "ses" && failBackup) throw failBackup;
				return { messageId: `<${config.provider}-id@x>` };
			},
		}),
	};
}

test("a healthy primary never consults the backup", async () => {
	const h = harness();
	const result = await h.run();
	assert.equal(result.provider, "resend");
	assert.equal(result.fallbackFrom, undefined);
	assert.equal(h.resolved, 0);
	assert.equal(h.calls.length, 1);
});

for (const [name, error] of [
	["HTTP 429", new ProviderSendError("Resend: rate limited", 429)],
	["HTTP 500", new ProviderSendError("Resend: boom", 500)],
	["HTTP 503", new ProviderSendError("Resend: down", 503)],
	["HTTP 401", new ProviderSendError("Resend: invalid key", 401)],
	["HTTP 403", new ProviderSendError("Resend: revoked", 403)],
	["AWS throttling", new AwsError("slow down", 400, "TooManyRequestsException")],
	["connection refused", toNetworkError("Resend", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))],
	["DNS failure", toNetworkError("Resend", new TypeError("getaddrinfo ENOTFOUND api.resend.com"))],
	["missing credentials", new ProviderConfigError("no key", "resend")],
]) {
	test(`falls back on ${name}`, async () => {
		const h = harness({ failPrimary: error });
		const result = await h.run();
		assert.equal(result.provider, "ses");
		assert.equal(result.fallbackFrom, "resend");
		assert.equal(result.messageId, "<ses-id@x>");
		assert.deepEqual(h.calls.map((call) => call.provider), ["resend", "ses"]);
	});
}

for (const [name, error] of [
	["HTTP 422 validation error", new ProviderSendError("Resend: invalid to address", 422)],
	["HTTP 400", new ProviderSendError("Resend: bad request", 400)],
	["AWS MessageRejected", new AwsError("Email address is not verified", 400, "MessageRejected")],
	["timeout after the request was sent", toNetworkError("Resend", Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }))],
	["dropped connection", toNetworkError("Resend", new TypeError("Network connection lost."))],
	["unknown error", new Error("???")],
]) {
	test(`does not fall back on ${name}`, async () => {
		const h = harness({ failPrimary: error });
		await assert.rejects(h.run(), (thrown) => thrown === error);
		assert.deepEqual(h.calls.map((call) => call.provider), ["resend"]);
		assert.equal(h.resolved, 0);
	});
}

test("does not fall back when no backup is configured or verified", async () => {
	const error = new ProviderSendError("Resend: down", 503);
	const h = harness({ failPrimary: error, fallback: null });
	await assert.rejects(h.run(), (thrown) => thrown === error);
	assert.equal(h.resolved, 1);
	assert.deepEqual(h.calls.map((call) => call.provider), ["resend"]);
});

test("reports the primary error when the backup fails too", async () => {
	const error = new ProviderSendError("Resend: down", 503);
	const h = harness({ failPrimary: error, failBackup: new AwsError("denied", 403, "AccessDenied") });
	await assert.rejects(h.run(), (thrown) => thrown === error);
	assert.deepEqual(h.calls.map((call) => call.provider), ["resend", "ses"]);
});

test("a backup lookup that throws leaves the original failure", async () => {
	const error = new ProviderSendError("Resend: down", 503);
	await assert.rejects(sendWithFallback({
		primary, message, send: async () => { throw error; }, resolveFallback: async () => { throw new Error("aws unreachable"); },
	}), (thrown) => thrown === error);
});

test("the same Message-ID header goes to both attempts", async () => {
	const h = harness({ failPrimary: new ProviderSendError("Resend: down", 503) });
	await h.run();
	assert.equal(h.calls[0].headers["Message-ID"], "<fixed@example.com>");
	assert.equal(h.calls[1].headers["Message-ID"], "<fixed@example.com>");
});
