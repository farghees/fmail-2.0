// Builds public/source.tar.gz from the committed HEAD so the AGPL-3.0 "Source code"
// link always serves exactly what is deployed. Files marked export-ignore in
// .gitattributes (wrangler.jsonc, env files) are left out. Uncommitted changes are
// not included, so commit before deploying.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "public/source.tar.gz");

try {
	execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
} catch {
	console.warn("[source-archive] not a git checkout; skipping" + (existsSync(out) ? " (keeping existing archive)" : ""));
	process.exit(0);
}

mkdirSync(dirname(out), { recursive: true });
execFileSync("git", ["archive", "--format=tar.gz", "--prefix=fmail/", "-o", out, "HEAD"], { cwd: root, stdio: "inherit" });
console.log(`[source-archive] wrote ${out} from ${execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim()}`);
