import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-default-mailbox-"));
const realFetch = globalThis.fetch;
after(() => rmSync(outDir, { recursive: true, force: true }));
afterEach(() => { globalThis.fetch = realFetch; });

await build({
	entryPoints: {
		service: join(root, "src/lib/domains/service.ts"),
		mailbox: join(root, "src/lib/domains/default-mailbox.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	alias: { "@": join(root, "src") },
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});
const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { addDomainForUser } = await load("service");
const { ensureDefaultMailbox } = await load("mailbox");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const FORWARD_TO = "owner@example.org";
const now = () => Math.floor(Date.now() / 1000);

async function fixture(t, { enabled = true, forwardTo = FORWARD_TO } = {}) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	sql.prepare("INSERT INTO users (id, email, name, password_hash, is_primary_admin, role, created_at) VALUES ('primary', 'p@example.com', 'P', 'x', 1, 'admin', ?)").run(now());
	sql.prepare("INSERT INTO users (id, email, name, password_hash, is_primary_admin, role, created_at) VALUES ('other', 'o@example.com', 'O', 'x', 0, 'admin', ?)").run(now());
	sql.prepare("INSERT INTO app_settings (id, updated_at) VALUES ('default', ?) ON CONFLICT(id) DO NOTHING").run(now());
	sql.prepare("UPDATE app_settings SET default_mailbox_enabled = ?, default_mailbox_forward_to = ? WHERE id = 'default'").run(enabled ? 1 : 0, forwardTo || null);
	const rows = (table) => sql.prepare(`SELECT * FROM ${table}`).all();
	return { env: { DB: database }, sql, rows };
}

test("a newly added domain gets admin@ owned by the primary admin, forwarding with a kept copy", async (t) => {
	const { env, rows } = await fixture(t);
	// Added by a non-primary admin: the mailbox still belongs to the primary admin.
	const result = await addDomainForUser(env, "other", "example.com");
	assert.equal(result.defaultMailbox.status, "created");
	assert.equal(result.defaultMailbox.address, "admin@example.com");
	assert.equal(result.defaultMailbox.forward, "unchecked");
	const [mailbox] = rows("mailboxes");
	assert.equal(mailbox.local_part, "admin");
	assert.equal(mailbox.user_id, "primary");
	assert.equal(mailbox.domain_id, result.domain.id);
	assert.equal(mailbox.use_all_domains, 0);
	const [rule] = rows("routing_rules");
	assert.equal(rule.scope, "mailbox");
	assert.equal(rule.action, "forward");
	assert.equal(rule.forward_to, FORWARD_TO);
	assert.equal(rule.keep_copy, 1);
	assert.equal(rule.mailbox_id, mailbox.id);
	assert.equal(rule.match_value, "*");
});

test("nothing is created when the setting is disabled", async (t) => {
	const { env, rows } = await fixture(t, { enabled: false });
	const result = await addDomainForUser(env, "primary", "example.com");
	assert.equal(result.defaultMailbox, undefined);
	assert.equal(rows("mailboxes").length, 0);
	assert.equal(rows("routing_rules").length, 0);
});

test("without a forward address the mailbox is created with no rule", async (t) => {
	const { env, rows } = await fixture(t, { forwardTo: "" });
	const result = await addDomainForUser(env, "primary", "example.com");
	assert.equal(result.defaultMailbox.status, "created");
	assert.equal(result.defaultMailbox.forward, "none");
	assert.equal(rows("mailboxes").length, 1);
	assert.equal(rows("routing_rules").length, 0);
});

test("a failed add creates no mailbox", async (t) => {
	const { env, sql, rows } = await fixture(t);
	sql.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d0', 'other', 'taken.example', 'manual', ?)").run(now());
	await assert.rejects(addDomainForUser(env, "primary", "taken.example"), /already registered/);
	assert.equal(rows("mailboxes").length, 0);
	assert.equal(rows("routing_rules").length, 0);
});

test("an add that rolls back after the domain row was written creates no mailbox", async (t) => {
	const { env, sql, rows } = await fixture(t);
	// The alias-routing step runs after the row is inserted and inside the rollback scope.
	sql.exec("DROP TABLE mailbox_aliases; ALTER TABLE mailboxes RENAME TO mailboxes_gone");
	const warn = console.warn;
	console.warn = () => {};
	try {
		await assert.rejects(addDomainForUser(env, "primary", "example.com"));
	} finally {
		console.warn = warn;
	}
	assert.equal(rows("domains").length, 0);
	assert.equal(rows("routing_rules").length, 0);
	assert.equal(rows("mailboxes_gone").length, 0);
});

test("an existing mailbox is left untouched", async (t) => {
	const { env, sql, rows } = await fixture(t);
	sql.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'primary', 'example.com', 'manual', 'active', ?)").run(now());
	sql.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, display_name, created_at) VALUES ('mb1', 'other', 'd1', 'admin', 'Keep me', ?)").run(now());
	const result = await ensureDefaultMailbox(env, { id: "d1", hostname: "example.com", zoneId: "manual", userId: "primary" });
	assert.equal(result.status, "exists");
	const all = rows("mailboxes");
	assert.equal(all.length, 1);
	assert.equal(all[0].user_id, "other");
	assert.equal(all[0].display_name, "Keep me");
	assert.equal(rows("routing_rules").length, 0);
});

function fakeCloudflare({ destinations }) {
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		const u = new URL(String(url));
		const path = u.pathname.replace("/client/v4", "");
		calls.push(`${init.method ?? "GET"} ${path}`);
		const ok = (result) => Response.json({ success: true, errors: [], result });
		if (path === "/zones/z1") return ok({ id: "z1", name: "example.com", account: { id: "acct1" } });
		if (path === "/accounts/acct1/email/routing/addresses") return ok(destinations);
		if (path === "/zones/z1/email/routing/rules") return ok(init.method === "POST" ? { id: "r1" } : []);
		return Response.json({ success: false, errors: [{ code: 7003, message: `unmocked ${path}` }], result: null }, { status: 404 });
	};
	return calls;
}
const cfDomain = { id: "d1", hostname: "example.com", zoneId: "z1", userId: "primary" };

test("an unverified forward destination still creates the mailbox but skips the forward and warns", async (t) => {
	const { env, sql, rows } = await fixture(t);
	sql.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, created_at) VALUES ('d1', 'primary', 'example.com', 'z1', 'active', ?)").run(now());
	fakeCloudflare({ destinations: [{ email: FORWARD_TO, verified: null }] });
	const warn = console.warn;
	console.warn = () => {};
	let result;
	try {
		result = await ensureDefaultMailbox({ ...env, CF_TOKEN: "t" }, cfDomain);
	} finally {
		console.warn = warn;
	}
	assert.equal(result.status, "created");
	assert.equal(result.forward, "skipped");
	assert.match(result.warning, /not a verified Email Routing destination/);
	assert.equal(rows("mailboxes").length, 1);
	assert.equal(rows("routing_rules").length, 0);
});

test("a verified destination configures the forward and the per-address worker route", async (t) => {
	const { env, sql, rows } = await fixture(t);
	sql.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, status, receiving_provider, created_at) VALUES ('d1', 'primary', 'example.com', 'z1', 'active', 'cloudflare', ?)").run(now());
	const calls = fakeCloudflare({ destinations: [{ email: FORWARD_TO.toUpperCase(), verified: "2026-01-01T00:00:00Z" }] });
	const result = await ensureDefaultMailbox({ ...env, CF_TOKEN: "t" }, cfDomain);
	assert.equal(result.forward, "configured");
	assert.equal(result.warning, undefined);
	assert.equal(rows("routing_rules").length, 1);
	assert.ok(calls.includes("POST /zones/z1/email/routing/rules"), "admin@ is routed to the worker");
});
