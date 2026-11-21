import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-provision-rollback-"));
const realFetch = globalThis.fetch;
after(() => rmSync(outDir, { recursive: true, force: true }));
afterEach(() => {
	globalThis.fetch = realFetch;
});

await build({
	entryPoints: [join(root, "src/lib/domains/provision.ts")],
	outfile: join(outDir, "provision.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	alias: { "@": join(root, "src") },
	logLevel: "silent",
});
const { provisionDomainOnCloudflare } = await import(pathToFileURL(join(outDir, "provision.mjs")).href);

const ZONE = { id: "zone1", name: "example.com" };
const env = { CF_TOKEN: "test-token" };
const CF_MX = [
	{ id: "mx1", type: "MX", name: "example.com", content: "route3.mx.cloudflare.net", priority: 51, ttl: 1 },
	{ id: "mx2", type: "MX", name: "example.com", content: "route1.mx.cloudflare.net", priority: 64, ttl: 1 },
	{ id: "mx3", type: "MX", name: "example.com", content: "route2.mx.cloudflare.net", priority: 99, ttl: 1 },
];
const CF_SPF = { id: "txt1", type: "TXT", name: "example.com", content: "v=spf1 include:_spf.mx.cloudflare.net ~all", ttl: 1 };
const UNRELATED = { id: "txt2", type: "TXT", name: "example.com", content: "11111111-2222-3333-4444-555555555555", ttl: 1 };
const FORWARD = {
	matchers: [{ type: "all" }],
	actions: [{ type: "forward", value: ["owner@example.com"] }],
	enabled: true,
	name: "Forward everything",
};
const DROP = { matchers: [{ type: "all" }], actions: [{ type: "drop" }], enabled: false };

/** A small stateful fake of the Cloudflare endpoints provisioning touches. */
function fakeCloudflare({ routingEnabled, dns, catchAll }) {
	const state = { routingEnabled, dns: dns.map((r) => ({ ...r })), catchAll, calls: [], nextId: 100 };
	globalThis.fetch = async (url, init = {}) => {
		const u = new URL(String(url));
		const path = u.pathname.replace("/client/v4", "");
		const method = init.method ?? "GET";
		state.calls.push(`${method} ${path}${u.search}`);
		const ok = (result) => Response.json({ success: true, errors: [], result });
		const fail = (status, code, message) => Response.json({ success: false, errors: [{ code, message }], result: null }, { status });
		if (path === "/zones") return ok([ZONE]);
		if (path === `/zones/${ZONE.id}/email/routing`) return ok({ enabled: state.routingEnabled });
		if (path === `/zones/${ZONE.id}/email/routing/dns`) {
			if (method === "POST") {
				state.routingEnabled = true;
				if (!state.dns.some((r) => r.type === "MX")) state.dns.push(...CF_MX.map((r) => ({ ...r })), { ...CF_SPF });
				return ok({ enabled: true, status: "ready" });
			}
			if (method === "DELETE") {
				state.routingEnabled = false;
				state.dns = state.dns.filter((r) => r.type !== "MX" && r.content !== CF_SPF.content);
				return ok({});
			}
		}
		if (path === `/zones/${ZONE.id}/email/routing/rules/catch_all`) {
			if (method === "PUT") {
				state.catchAll = JSON.parse(init.body);
				return ok(state.catchAll);
			}
			return state.catchAll ? ok(state.catchAll) : fail(404, 1000, "not found");
		}
		if (path === `/zones/${ZONE.id}/dns_records`) {
			if (method === "POST") {
				const record = { id: `new${state.nextId++}`, ...JSON.parse(init.body) };
				state.dns.push(record);
				return ok(record);
			}
			const type = u.searchParams.get("type");
			const name = u.searchParams.get("name");
			return ok(state.dns.filter((r) => r.type === type && r.name === name));
		}
		if (path.startsWith(`/zones/${ZONE.id}/email/sending`)) return fail(403, 10000, "Authentication error");
		return fail(404, 7003, `unmocked ${method} ${path}`);
	};
	return state;
}

const mailRecords = (state) =>
	state.dns
		.filter((r) => r.type === "MX" || r.content?.startsWith("v=spf1"))
		.map((r) => `${r.type} ${r.priority ?? ""} ${r.content}`.replace("  ", " "))
		.sort();
const deleteDnsCalls = (state) => state.calls.filter((c) => c === `DELETE /zones/${ZONE.id}/email/routing/dns`);
const silenceWarnings = () => {
	const original = console.warn;
	console.warn = () => {};
	return () => {
		console.warn = original;
	};
};

test("routing disabled with existing Cloudflare MX/SPF and a forward catch-all: failed sending step keeps DNS and catch-all", async () => {
	const state = fakeCloudflare({ routingEnabled: false, dns: [...CF_MX, CF_SPF, UNRELATED], catchAll: FORWARD });
	const restore = silenceWarnings();
	try {
		await assert.rejects(provisionDomainOnCloudflare(env, "example.com"), /403|Authentication/);
	} finally {
		restore();
	}
	assert.deepEqual(deleteDnsCalls(state), []);
	assert.deepEqual(mailRecords(state), [
		"MX 51 route3.mx.cloudflare.net",
		"MX 64 route1.mx.cloudflare.net",
		"MX 99 route2.mx.cloudflare.net",
		"TXT v=spf1 include:_spf.mx.cloudflare.net ~all",
	]);
	assert.ok(state.dns.some((r) => r.id === "txt2"), "unrelated TXT is untouched");
	assert.deepEqual(state.catchAll, { actions: FORWARD.actions, enabled: true, matchers: FORWARD.matchers, name: FORWARD.name });
});

test("a missing snapshotted MX/SPF record is re-created after rollback", async () => {
	const state = fakeCloudflare({ routingEnabled: false, dns: [...CF_MX, CF_SPF], catchAll: FORWARD });
	// Cloudflare drops one record while routing is being enabled (simulated).
	const baseFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const res = await baseFetch(url, init);
		if (init?.method === "POST" && String(url).endsWith("/email/routing/dns")) {
			state.dns = state.dns.filter((r) => r.id !== "mx1" && r.id !== "txt1");
		}
		return res;
	};
	const restore = silenceWarnings();
	try {
		await assert.rejects(provisionDomainOnCloudflare(env, "example.com"));
	} finally {
		restore();
	}
	assert.deepEqual(deleteDnsCalls(state), []);
	assert.deepEqual(mailRecords(state), [
		"MX 51 route3.mx.cloudflare.net",
		"MX 64 route1.mx.cloudflare.net",
		"MX 99 route2.mx.cloudflare.net",
		"TXT v=spf1 include:_spf.mx.cloudflare.net ~all",
	]);
});

test("zone with no mail records: failure cleans up fully as before", async () => {
	const state = fakeCloudflare({ routingEnabled: false, dns: [UNRELATED], catchAll: DROP });
	const restore = silenceWarnings();
	try {
		await assert.rejects(provisionDomainOnCloudflare(env, "example.com"));
	} finally {
		restore();
	}
	assert.equal(deleteDnsCalls(state).length, 1);
	assert.equal(state.routingEnabled, false);
	assert.deepEqual(mailRecords(state), []);
	assert.deepEqual(state.catchAll, { actions: DROP.actions, enabled: false, matchers: DROP.matchers });
});

test("routing already enabled: previous catch-all is restored and routing stays on", async () => {
	const state = fakeCloudflare({ routingEnabled: true, dns: [...CF_MX, CF_SPF], catchAll: FORWARD });
	const restore = silenceWarnings();
	try {
		await assert.rejects(provisionDomainOnCloudflare(env, "example.com"));
	} finally {
		restore();
	}
	assert.deepEqual(deleteDnsCalls(state), []);
	assert.equal(state.routingEnabled, true);
	assert.equal(mailRecords(state).length, 4);
	assert.deepEqual(state.catchAll, { actions: FORWARD.actions, enabled: true, matchers: FORWARD.matchers, name: FORWARD.name });
});

test("unreadable mail DNS is treated as existing: routing is never disabled", async () => {
	const state = fakeCloudflare({ routingEnabled: false, dns: [...CF_MX, CF_SPF], catchAll: FORWARD });
	const baseFetch = globalThis.fetch;
	let first = true;
	globalThis.fetch = async (url, init) => {
		if (String(url).includes("/dns_records?type=MX") && first) {
			first = false;
			return Response.json({ success: false, errors: [{ code: 10000, message: "denied" }], result: null }, { status: 403 });
		}
		return baseFetch(url, init);
	};
	const restore = silenceWarnings();
	try {
		await assert.rejects(provisionDomainOnCloudflare(env, "example.com"));
	} finally {
		restore();
	}
	assert.deepEqual(deleteDnsCalls(state), []);
	assert.equal(mailRecords(state).length, 4);
});
