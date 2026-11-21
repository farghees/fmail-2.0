import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-drive-quota-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		storage: join(root, "src/lib/drive/storage.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		db: join(root, "src/db/index.ts"),
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
const { resolveDriveQuota, fitsDriveQuota, driveQuotaMessage, getDriveQuota, getDriveStorageUsed, getDriveDefaultQuota, checkDriveQuota, GIB } = await load("storage");
const { getDb } = await load("db");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");

const now = () => Math.floor(Date.now() / 1000);

test("resolveDriveQuota: default, override, unlimited and admin", () => {
	const d = 5 * GIB;
	assert.equal(resolveDriveQuota({ role: "user", override: null, defaultBytes: d }), d);
	assert.equal(resolveDriveQuota({ role: "user", override: undefined, defaultBytes: d }), d);
	assert.equal(resolveDriveQuota({ role: "user", override: 2 * GIB, defaultBytes: d }), 2 * GIB);
	assert.equal(resolveDriveQuota({ role: "user", override: 0, defaultBytes: d }), null);
	assert.equal(resolveDriveQuota({ role: "user", override: null, defaultBytes: 0 }), null);
	assert.equal(resolveDriveQuota({ role: "admin", override: null, defaultBytes: d }), null);
	assert.equal(resolveDriveQuota({ role: "admin", override: GIB, defaultBytes: d }), GIB);
});

test("fitsDriveQuota allows exactly the quota and rejects one byte more", () => {
	assert.equal(fitsDriveQuota(GIB, GIB, 2 * GIB), true);
	assert.equal(fitsDriveQuota(GIB, GIB + 1, 2 * GIB), false);
	assert.equal(fitsDriveQuota(10 * GIB, GIB, null), true);
});

test("driveQuotaMessage names used and total", () => {
	assert.equal(driveQuotaMessage(4.5 * GIB, 5 * GIB), "Storage full: 4.5 GB of 5.0 GB used");
});

async function fixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const sql = database.db;
	const user = (id, role, quota = null) => sql.prepare("INSERT INTO users (id, email, name, password_hash, role, drive_quota_bytes, created_at) VALUES (?, ?, ?, 'x', ?, ?, ?)").run(id, `${id}@example.test`, id, role, quota, now());
	user("u1", "user"); user("u2", "user", 100); user("u3", "user", 0); user("a1", "admin");
	const item = (id, owner, kind, size, extra = {}) => sql.prepare("INSERT INTO drive_items (id, owner_id, kind, name, size, trashed_at, upload_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, owner, kind, id, size, extra.trashed ? now() : null, extra.upload ?? null, now(), now());
	return { db: getDb({ DB: database }), sql, item };
}

test("the default is 5 GB after migration and can be changed or disabled", async (t) => {
	const { db, sql } = await fixture(t);
	assert.equal(await getDriveDefaultQuota(db), 5 * GIB);
	assert.equal(await getDriveDefaultQuota(db), 5 * GIB);
	assert.equal(await getDriveQuota(db, "u1"), 5 * GIB);
	sql.prepare("UPDATE app_settings SET drive_default_quota_bytes = 0").run();
	assert.equal(await getDriveQuota(db, "u1"), null);
	sql.prepare("UPDATE app_settings SET drive_default_quota_bytes = 1000").run();
	assert.equal(await getDriveQuota(db, "u1"), 1000);
	assert.equal(await getDriveQuota(db, "u2"), 100, "override wins over default");
	assert.equal(await getDriveQuota(db, "u3"), null, "0 override is unlimited");
	assert.equal(await getDriveQuota(db, "a1"), null, "admins are unlimited by default");
	sql.prepare("UPDATE users SET drive_quota_bytes = 50 WHERE id = 'a1'").run();
	assert.equal(await getDriveQuota(db, "a1"), 50, "an admin override applies");
});

test("usage counts files including trashed and in-progress uploads, not folders or other owners", async (t) => {
	const { db, item } = await fixture(t);
	item("f1", "u1", "file", 10);
	item("f2", "u1", "file", 20, { trashed: true });
	item("f3", "u1", "file", 30, { upload: "mpu-1" });
	item("d1", "u1", "folder", 999);
	item("o1", "u2", "file", 500);
	assert.equal(await getDriveStorageUsed(db, "u1"), 60);
	assert.equal(await getDriveStorageUsed(db, "nobody"), 0);
});

test("checkDriveQuota rejects with 413 and a clear message, accepts what fits", async (t) => {
	const { db, item } = await fixture(t);
	item("f1", "u2", "file", 60);
	assert.equal(await checkDriveQuota(db, "u2", 40), null);
	const res = await checkDriveQuota(db, "u2", 41);
	assert.equal(res.status, 413);
	const body = await res.json();
	assert.equal(body.error, "Storage full: 60 B of 100 B used");
	assert.equal(body.code, "drive_quota_exceeded");
	// Unlimited accounts are never rejected.
	assert.equal(await checkDriveQuota(db, "u3", 10 * GIB), null);
	assert.equal(await checkDriveQuota(db, "a1", 10 * GIB), null);
});

test("finalising an upload only needs the growth over the declared size to fit", async (t) => {
	const { db, item } = await fixture(t);
	item("f1", "u2", "file", 90, { upload: "mpu" });
	assert.equal(await checkDriveQuota(db, "u2", 100, 90), null);
	assert.equal((await checkDriveQuota(db, "u2", 101, 90)).status, 413);
});
