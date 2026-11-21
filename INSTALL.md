# Installing Fmail (guide for an AI coding agent)

This guide is written for an AI coding agent (Claude Code, Codex, Cursor and similar) that is installing Fmail on a user's Cloudflare account. A human can follow it too. It installs the Cloudflare Workers flavour: a Worker backed by D1, R2, Queues and a Durable Object, with Cloudflare Email Routing for inbound mail and Resend (optionally Amazon SES) for outbound mail.

Everything below comes from this repository: `package.json` scripts, `wrangler.jsonc.example`, `env.d.ts` and `docs/deployment.md`. If something here disagrees with the code, trust the code and tell the user.

Rules for the agent:

- Never print, log, commit, or pass secrets as command-line arguments. Secrets go in through `wrangler secret put` (it reads stdin) or the user's own shell environment.
- `wrangler.jsonc` and `.dev.vars` are gitignored on purpose. Do not remove them from `.gitignore`.
- Do not call Cloudflare's "disable Email Routing" API at any point (see Troubleshooting).
- Do not run destructive commands (deleting databases, buckets, domains or DNS records) unless the user asks.

---

## Before you start: ask the user

Ask for all of the following before running any command. Do not guess values.

### 1. Domains

- The domain(s) to use for mail, for example `example.com`.
- The webmail hostname, for example `mail.example.com`. It can be a subdomain of the mail domain or a different domain.
- Each domain, and the webmail hostname's zone, must already be on Cloudflare (the registrar's nameservers point to Cloudflare, zone status "Active"), in the same Cloudflare account as the Worker.

### 2. Cloudflare details

- Cloudflare **account ID** (dashboard, any zone's overview page, right sidebar, or Workers & Pages overview).
- **Two** API tokens, created at <https://dash.cloudflare.com/profile/api-tokens> (or Manage Account, Account API Tokens). Keeping them separate limits the damage if one leaks.

**Deploy token** (used only by Wrangler on this machine, as `CLOUDFLARE_API_TOKEN`). Scope it to the target account:

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | `wrangler deploy` (also covers cron triggers and the Durable Object migration) |
| Account | D1: Edit | create the database, apply migrations |
| Account | Workers R2 Storage: Edit | create the bucket |
| Account | Queues: Edit | create queues, attach consumers |
| Account | Account Settings: Read | Wrangler account lookup |
| Zone (the webmail hostname's zone) | Workers Routes: Edit | custom domain for the Worker |
| Zone (the webmail hostname's zone) | DNS: Edit, Zone: Read | Wrangler creates the custom-domain DNS record and certificate |

If Cloudflare shows newer role names (for example "Workers Admin"), pick the equivalent. If you skip the zone permissions, drop the `routes` block from `wrangler.jsonc` and add the custom domain in the dashboard instead (step 8).

**Runtime token** (stored as the Worker secret `CF_TOKEN`, used by the app itself to manage domains). These are the Cloudflare API calls the app makes (`src/lib/cloudflare-api.ts`, `src/lib/cloudflare-dns.ts`, `src/lib/domains/catch-all-routing.ts`):

| Scope | Permission | Used for |
| --- | --- | --- |
| Zones: every zone you will connect | Zone: Read | look up the zone by hostname |
| Zones: same | DNS: Edit | add MX/SPF/DKIM records, replace conflicting MX (after user confirmation) |
| Zones: same | Zone Settings: Edit | per `docs/deployment.md` |
| Zones: same | Email Routing Rules: Edit | create the per-address rules and the catch-all rule that sends mail to the Worker |
| Account | Email Routing Addresses: Edit | list/verify forward destinations (`/accounts/{id}/email/routing/addresses`) |
| Account | Email Sending: Edit | only if outbound mail should go through Cloudflare Email Sending (needs a paid Workers plan). Not needed when using Resend or SES. |

Paste only the token secret, never the word `Bearer` and never the token ID. Verify a token with:

```bash
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify -H "Authorization: Bearer $CF_TOKEN_VALUE"
```

(Account-owned tokens use `/accounts/<ACCOUNT_ID>/tokens/verify` instead.)

**How the user should hand over secrets.** Ask the user to either export them in their own terminal before starting you (`export CLOUDFLARE_API_TOKEN=...`), or to type them when `wrangler secret put` prompts. Do not ask them to paste secrets into chat if a safer channel exists, and never write a secret into any tracked file.

### 3. Email providers

- **Resend API key** with **full access** (a sending-only key cannot add domains or webhooks), created at <https://resend.com/api-keys>. Also the **sender domain** to verify in Resend (normally the mail domain from question 1).
- **Optional, backup sending: Amazon SES**: access key ID, secret access key and region (for example `us-east-1`). The IAM user needs the permissions the app reports after saving (it lists what is missing and gives a policy to attach).

### 4. First admin and defaults

- The first admin's mailbox name (the part before `@`; the first account is `<name>@<primary domain>`) and a **password**. The user should type the password into the browser at `/setup` themselves. Do not store it anywhere.
- A recovery email address for the admin (asked on the setup page).
- Optional: a forward address for a default `admin@<domain>` mailbox. Leave it empty by default. If given, it must be a verified destination in Cloudflare Email Routing (the app tells the user to verify it).

---

## Step 1: Prerequisites

- Node.js 22 or newer (the Dockerfile uses 22; development used 24) and npm.
- git.
- Authenticate Wrangler, using one of:
  - `export CLOUDFLARE_API_TOKEN=<deploy token>` (set by the user), or
  - `npx wrangler login` (opens a browser).
- If the user's login can see more than one Cloudflare account, also `export CLOUDFLARE_ACCOUNT_ID=<account id>`. Without it Wrangler may stop to ask which account, or pick the wrong one.

## Step 2: Get the code and install

```bash
git clone https://github.com/farghees/Fmail fmail && cd fmail
npm install
```

(Replace the URL with the repository the user is installing from. `npm ci` also works because `package-lock.json` is committed.)

## Step 3: Create the Cloudflare resources

Names must match `wrangler.jsonc.example`. The Worker is `fmail`; the app creates its Email Routing rules pointing at a Worker called `fmail` (`getEmailWorkerName()` in `src/lib/cloudflare-api-utils.ts`), so do not rename it unless you also change that function.

```bash
npx wrangler d1 create fmail
npx wrangler r2 bucket create fmail-raw
npx wrangler queues create fmail-inbound
npx wrangler queues create fmail-outbound
npx wrangler queues create fmail-agent
```

`d1 create` prints a `database_id` (a UUID). Note it for the next step. If any resource already exists, reuse it.

## Step 4: Fill in the Wrangler config

```bash
cp wrangler.jsonc.example wrangler.jsonc
```

Edit `wrangler.jsonc`:

- `account_id`: the Cloudflare account ID (or delete the line and rely on `CLOUDFLARE_ACCOUNT_ID`).
- `routes`: set `pattern` to the webmail hostname (for example `mail.example.com`). Delete the whole `routes` block to deploy only to `*.workers.dev` first.
- `d1_databases[0].database_id`: the UUID from step 3.
- `vars`: keep `"MAILFLARE_SELF_LICENSED": "1"` and add `"APP_URL": "https://mail.example.com"` (the public HTTPS origin). `APP_URL` is required for Resend/SES receiving, webhooks, password-reset links and passkeys.
- Leave binding names, queue names, the cron triggers, the `REALTIME` Durable Object and its migration as they are.

`keep_vars` is `true`, so variables set in the dashboard survive deploys. `wrangler.jsonc` is gitignored: keep it out of commits, and back it up somewhere private because the repository does not store it.

## Step 5: Apply the D1 migrations

```bash
npm run db:migrate:remote
```

This is `wrangler d1 migrations apply DB --remote` against `drizzle/migrations`. (The `/setup` page and the admin **Update database** button apply the same migrations through the Worker, so this step is optional, but running it first surfaces credential or ID mistakes early.) Do not apply the migrations twice with different tooling against a database that is already in use.

## Step 6: Deploy

```bash
npm run deploy
```

`deploy` = `npm run build && wrangler deploy`. The build runs `db:bundle` (generates the migration bundle), `source:archive` (writes `public/source.tar.gz` from `git archive HEAD`, which is the AGPL source link the app serves at `/source.tar.gz`) and `vp build`. The source archive step needs a git repository with at least one commit, so keep the clone's `.git` directory; if you modified files, commit them first so the archive matches what you run.

When it finishes Wrangler prints the Worker URL (`https://fmail.<subdomain>.workers.dev`) and, if `routes` is set, attaches the custom domain.

## Step 7: Set the secrets

Each command prompts for the value on stdin. Do not put values on the command line.

```bash
npx wrangler secret put CF_TOKEN              # the runtime token from "Before you start"
npx wrangler secret put RESEND_API_KEY        # Resend full-access key
```

Optional, only if the user provided them:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put AWS_REGION            # e.g. us-east-1
```

Resend, SES and Cloudflare credentials can also be entered in the admin UI (Admin, Domains), and values saved there take precedence over the secrets. The primary administrator is the only one who can change them.

### Every variable and secret the code reads

Required for the Cloudflare install: `CF_TOKEN` (or the legacy pair `CF_API_KEY` + `CF_EMAIL`), `APP_URL`. Everything else is optional.

| Name | Kind | Purpose |
| --- | --- | --- |
| `CF_TOKEN` | secret | Runtime Cloudflare API token (above) |
| `CF_API_KEY`, `CF_EMAIL` | secret | Legacy Global API Key alternative to `CF_TOKEN` |
| `CF_ACCOUNT_ID` | var | Needed for Cloudflare Email Sending off Workers and for listing Workers AI models |
| `APP_URL` | var | Public HTTPS origin of the install |
| `MAILFLARE_SELF_LICENSED` | var | `1` marks the install as fully licensed (set in the example config) |
| `RESEND_API_KEY` | secret | Resend key, used when none is saved in the app |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` (`AWS_DEFAULT_REGION`) | secret | Amazon SES credentials (also fallback for S3) |
| `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | secret / build-time var | Cloudflare Turnstile on login and first-run registration. The site key is baked in at build time, so set it in the shell before `npm run deploy` |
| `GITHUB_UPDATE_TOKEN`, `GITHUB_UPDATE_REPO`, `GITHUB_UPDATE_REF` | secret / var | Admin "Update" button (see `docs/deployment.md#updating-fmail`) |
| `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY` | var / secret | Override the Workers AI model or use an OpenAI-compatible endpoint for the assistant |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | var / secret / var | Web Push. Generate a pair once with `npm run push:keys` |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_RELAY_URL` | secret / var | Native mobile push |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET`, `B2_ENDPOINT` | secret | Backblaze B2 instead of R2 (all four) |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | secret | AWS S3 instead of R2 |
| `DATABASE_URL`, `DATABASE_DRIVER`, `DATABASE_AUTH_TOKEN` | secret | External database instead of D1 (see `docs/databases.md`) |
| `SPAMHAUS_DQS_KEY`, `ABUSECH_AUTH_KEY`, `SPAM_DOMAIN_AGE_CHECK` | secret / var | Optional spam intelligence |
| `INBOUND_WEBHOOK_SECRET`, `INBOUND_REQUIRE_SIGNED_HEADERS` | secret / var | Only for the self-hosted (Docker) runtime with the email relay Worker |

The Docker/Node runtime reads further variables (`SMTP_URL`, `DATA_DIR`, `SMTP_*`, `TRUST_PROXY`, and so on); they are documented in `docs/self-hosting.md` and are not used on Workers.

## Step 8: Custom domain

If `routes` was set in step 4 and the deploy token had zone permissions, the custom domain is already attached. Otherwise: Cloudflare dashboard, Workers & Pages, `fmail`, Settings, Domains & Routes, Add, Custom domain, enter the webmail hostname. Then confirm `APP_URL` matches it and redeploy if you changed it.

## Step 9: Inbound mail (Email Routing, catch-all to the Worker)

The app configures this itself when a domain with "Receive mail with: Cloudflare" is added (step 10): it enables Email Routing on the zone, publishes the MX and SPF records, creates per-address rules and a catch-all rule whose action is "Send to a Worker: `fmail`". If another provider's MX records already exist, the app shows them and asks for confirmation before replacing them (the previous provider then stops receiving mail).

To check or do it by hand: Cloudflare dashboard, the domain, Email, Email Routing. Routing status should be enabled, MX/SPF records present, and Routing rules, Catch-all address should be "Send to a Worker" with destination `fmail`.

## Step 10: Create the admin account and add the domain

1. Open `https://<webmail hostname>/setup`. Let it run its checks (it initializes the D1 database if step 5 was skipped).
2. Enter the primary domain, the admin mailbox name, the recovery email and the password (the user types the password, or chooses a passkey).
3. In **Admin, Domains**, add each mail domain. Choose **Receive mail with: Cloudflare** and **Send mail with: Resend** (or Amazon SES).
4. Optional default mailbox: Admin, Settings, General, "Default mailbox for new domains". It is **off by default** and the forward address is empty by default. Enable it and set "Forward to" only if the user asked for it.

## Step 11: Resend sender-domain verification

With a full-access key the app adds the domain to Resend, writes the DNS records to the Cloudflare zone and asks Resend to verify. If the key is sending-only, or the zone is not on this account, add the domain at <https://resend.com/domains> and create the records Resend shows in Cloudflare DNS. Resend typically asks for:

- a TXT record for DKIM at `resend._domainkey.<domain>`,
- an MX record and an SPF TXT record on the `send` subdomain (`send.<domain>`).

Use exactly what the Resend dashboard displays; the names above vary by account and region. Records that are CNAMEs must be "DNS only" (grey cloud) in Cloudflare. Verification can stay "pending" for several minutes; use **Check status** on the domain card.

## Verification checklist

- [ ] `https://<webmail hostname>/` loads and `/setup` (or the login page, after setup) works.
- [ ] `https://<webmail hostname>/source.tar.gz` downloads (the AGPL source link).
- [ ] Log in as the admin; the app name shown is "Fmail".
- [ ] Admin, Domains: the domain shows receiving and sending as ready; DNS records are green.
- [ ] Cloudflare dashboard: Email Routing enabled, catch-all points to Worker `fmail`.
- [ ] Send a mail from an external account to `<admin>@<domain>`; it appears in the inbox.
- [ ] Send a mail from Fmail to an external address; it arrives (check spam on first send) and the headers show SPF/DKIM pass.
- [ ] `npx wrangler tail fmail` shows no repeating errors while doing the above.
- [ ] `git status` shows no `wrangler.jsonc`, `.dev.vars` or other secret files staged.

## Troubleshooting

- **Never call Cloudflare's "disable Email Routing" API** (`DELETE /zones/{zone_id}/email/routing/dns`) on a live domain. It removes the MX and SPF records Email Routing created, so inbound mail stops immediately. The app itself calls it when a domain is deleted or a failed provisioning is rolled back, so do not delete a domain in Admin, Domains unless the user intends to stop receiving mail for it. Re-enabling means re-running the domain setup.
- **Wrangler asks which account, or deploys to the wrong one.** Set `CLOUDFLARE_ACCOUNT_ID` (and keep `account_id` in `wrangler.jsonc` consistent). `npx wrangler whoami` lists the accounts the credentials can see.
- **Cloudflare error 9109 or 10000 in the app.** `CF_TOKEN` is wrong, expired or lacks a permission from the runtime table. Verify it with the curl command above, fix the token, run `npx wrangler secret put CF_TOKEN` again. See `docs/troubleshooting.md`.
- **D1 error 7404 (database could not be found).** `database_id` in `wrangler.jsonc` is from another account or mistyped. Use the ID printed by `npx wrangler d1 create fmail` (or `npx wrangler d1 list`).
- **Error 2008 / "domain has MX records for another mail service".** Another provider owns the MX records. The app asks for confirmation before replacing them; confirm only if the user agrees to stop using the old provider.
- **Inbound mail does not arrive.** Check that the Worker is named `fmail`, `services[].service` is `fmail`, Email Routing is enabled for the domain and its catch-all goes to `fmail`.
- **Resend/SES receiving or webhooks fail.** `APP_URL` must be a public HTTPS address.
- **`/source.tar.gz` is missing (or `source:archive` warns about git).** The directory is not a git repository with a commit, so the AGPL source archive is skipped. Run `git init && git add -A && git commit -m init` (the files you committed must not include secrets), or restore `.git`.
- **Build warns or fails on placeholder IDs.** The build itself does not contact Cloudflare, but `wrangler deploy` and `db:migrate:remote` do; they need the real `database_id` and account ID.
- **Resend domain stays pending.** See `docs/troubleshooting.md`; check for duplicate TXT records and for proxied (orange cloud) CNAMEs.
- **Scheduled backups or the five-minute cron are not running.** Deploy the complete Worker with `npm run deploy` (cron triggers come from `wrangler.jsonc`).

## Updating

```bash
git pull                       # or merge the new Fmail release into your clone
npm install
npm run deploy                 # builds and deploys the Worker; your wrangler.jsonc is untouched
```

Then open Admin settings and, if the update card lists pending database migrations, select **Update database** (or run `npm run db:migrate:remote`). Deploying and migrating are separate steps, deploy first. Keep your private `wrangler.jsonc` and re-check `wrangler.jsonc.example` for new bindings after an update, because new releases can add bindings or queues that your copy needs.

The admin "Update" button and `.github/workflows/deploy-update.yml` replace the whole tracked tree of the repository they run in with the source repository's tree, then expect a connected Cloudflare Git build to deploy it. That flow expects `wrangler.jsonc` to be available to the build, which this repository deliberately does not track. If you use it, set up the Cloudflare Git integration with the build variables in the dashboard, or keep updating from your own clone with the commands above. Set `UPDATE_SOURCE_REPOSITORY` (GitHub repository variable) and the constant in `src/app/api/admin/update/utils.ts` to the repository you publish.
