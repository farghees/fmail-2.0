# Fmail 2.0

This repository combines the Fmail app, Google signup/login changes and the standalone React/Three.js setup tutorial in `tutorial/`. It preserves the original Fmail source history and AGPL-3.0 license.

The app and tutorial build separately. For Google setup, see `docs/google-signup.md`; for the guide, see `tutorial/README.md`. This source update does not deploy anything or include production credentials.

Operator configuration, database migrations, review of the privacy template and live mail/forwarding tests are still required before enabling the features in another installation.

## Prerequisites (setup through Instinct)

For the Cloudflare + Resend setup, prepare the items below. You do **not** need to install Node.js, Git, Wrangler or a VPS on your own device when Instinct handles the technical setup. Those tools belong to the installer workflow in [INSTALL.md](INSTALL.md), not this reader checklist.

1. **Domain**: a domain you own, access to its registrar/nameservers and DNS, and your chosen webmail address (for example `mail.example.com`). The mail domain and webmail zone must be active in the intended Cloudflare account before deployment. Approve any mail DNS/MX changes first if the domain already receives email elsewhere.
2. **Cloudflare account and API access**: access to the correct account and any sign-in approvals. A **Global API Key plus its Cloudflare account email** is supported (`CF_API_KEY` + `CF_EMAIL`), but is a broad, legacy credential. Prefer scoped API tokens where possible: `CF_TOKEN` for the app, with separate deploy authorization for the installer. See the permission tables in [INSTALL.md](INSTALL.md). A Global API Key is not an API token, and you do not need both runtime methods.
3. **Resend account and API key**: a sender domain verified in Resend. A domain-limited **Sending access** key can send mail; automated domain creation/verification, domain-status checks and webhook management need **Full access**. If using a sending-only key, domain setup must be completed separately in the provider dashboard; do not expect in-app domain management to work with it. Approve broader access only when needed.
4. **Google OAuth Client ID and Client Secret (optional)**: only for Google sign-in/public signup, not the core mailbox installation. Use a Google Cloud project you control and a **Web application** OAuth client. Configure its consent/audience settings and the exact HTTPS callback `<APP_URL>/api/auth/google/callback`. Client ID alone is not enough for this app. Instinct configures `APP_URL`, `SIGNUP_DOMAIN` and the required migrations. See [Google signup](docs/google-signup.md).

### Anything else to have ready?

- **R2 activation and billing approval**: the default Cloudflare setup stores mail/files in R2. Enable the R2 subscription in your account and complete Cloudflare's billing/payment-method checks when requested. It has a free monthly allowance, not a guarantee of no charges. Review usage limits and approve costs before activation or a plan upgrade.
- **First admin details**: choose the admin mailbox name and an external recovery email you can access. Set the password or passkey on the secure setup page, not in chat. The recovery address need not be Gmail; Google login is optional.
- **Verification and final checks**: be available for account sign-in, email verification and registrar changes that require you. Allow an external mailbox to be used for send/receive tests. Public signup also needs a reviewed privacy notice with your own support/privacy contact.

**Optional incoming forwarding** stays off by default. Enabling copies to a user's Google recovery address requires that user's opt-in, Cloudflare destination-email verification, and account-level Email Routing Addresses edit permission for a scoped runtime token, with the account owner's approval. Forwarding is not required to receive mail inside Fmail.

**Instinct handles the generated setup**: identifying the correct account/zone IDs, creating the Worker, D1 database, R2 bucket, queues and other bindings, setting configuration/secrets, applying migrations, configuring Email Routing and checking delivery. These are installation work, not extra accounts or API keys you must prepare. A GitHub token, AWS account, external database, Turnstile keys and separate paid AI-provider key are not prerequisites for this basic path; optional features or other hosting/provider choices have their own requirements.

**Keep secrets private**: request a secure secret-storage link from Instinct, or enter credentials directly on the provider's secure page when guided. Never paste API keys, OAuth Client Secrets, passwords or payment details into chat, screenshots, issues or this repository. Do not rotate existing keys just to install Fmail.

Provider references: [Cloudflare Global API Key and token guidance](https://developers.cloudflare.com/fundamentals/api/get-started/keys/), [R2 activation](https://developers.cloudflare.com/r2/get-started/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Cloudflare billing](https://developers.cloudflare.com/billing/understand/billing-policy/), [Resend key permissions](https://resend.com/docs/dashboard/api-keys), [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

<img src="public/icon-192.png" alt="Fmail" width="96" />

# Fmail

A self-hosted alternative to Google Workspace. Setup **custom domain Emails**, **Calendar, Drive, Booking** and **built-in AI agents**.

Fmail is a fork of [Mailflare](https://github.com/hieunc229/mailflare) by hieunc229, licensed AGPL-3.0. See [License](#license).

Run it on Cloudflare or Docker. Send and receive with Cloudflare, Resend or Amazon SES. Store files in R2, Backblaze B2 or AWS S3. Use D1, Postgres, MySQL or Turso for the database.

> Installing with an AI coding agent? Point it at [INSTALL.md](INSTALL.md).

## Features

### Apps

- **Email**: Custom domain mailboxes, personal or shared, with access you control. Send and receive with Cloudflare Email, Resend or Amazon SES.
- **Routing rules**: Store, forward, reject or sort incoming mail.
- **Calendar**: Repeating events with time zones. Attendees get email invitations.
- **Booking**: Share a public link so anyone can book a free time on your calendar.
- **Drive**: Store and share files.
- **AI agents**: Search mail, draft replies and manage events. Connect other AI tools over MCP.

### Technical

- **Databases**: Cloudflare D1 (default), PostgreSQL, MySQL, Turso / libSQL, or a local SQLite file. Set `DATABASE_URL` to switch. Works with Supabase, Neon, PlanetScale, TiDB and more. See [Databases](docs/databases.md).
- **File storage**: Cloudflare R2, Backblaze B2 or AWS S3.
- **Hosting**: Cloudflare Workers or a single Docker container.
- **Admin**: Users, API keys, webhooks, audit logs and backups.
- **Import**: Bring in mail from IMAP, Gmail Takeout, `.eml` and `.mbox` files.

Fmail currently supports 34 languages, including English, Português (Brasil), Português (Portugal), Español, Français, Deutsch, Italiano, Nederlands, Polski, Українська, Русский, Türkçe, 中文（简体）, 日本語, 한국어, Bahasa Indonesia, Bahasa Melayu, Tiếng Việt, ไทย, हिन्दी, বাংলা, मराठी, తెలుగు, தமிழ், ગુજરાતી, ಕನ್ನಡ, മലയാളം, ਪੰਜਾਬੀ, සිංහල, Kiswahili, Hausa, plus العربية, اردو and فارسی (right-to-left).

## Cost

You can receive and send mail for free.

- **Receiving**: Cloudflare Email Routing is free.
- **Sending**: Use the free tier of Resend (3,000 emails a month) or Amazon SES. Cloudflare's own sending needs the $5/month Paid Worker plan.

New Amazon SES accounts start in a sandbox. Ask AWS for production access to lift it. Prices change, so check [Resend](https://resend.com/pricing), [Amazon SES](https://aws.amazon.com/ses/pricing/) and [Cloudflare](https://developers.cloudflare.com/workers/platform/pricing/).

## Deploy

The recommended path is [INSTALL.md](INSTALL.md), a step-by-step guide written for an AI coding agent (and readable by humans). In short:

1. Copy `wrangler.jsonc.example` to `wrangler.jsonc` and fill in your Cloudflare account ID, D1 database ID and webmail hostname.
2. Create the D1 database, R2 bucket and queues, apply the D1 migrations, set the Worker secrets, then run `npm run deploy`.
3. Open the app, create your admin account and connect a domain.

> **Cloudflare runtime API access is required.** Prefer a scoped `CF_TOKEN` with the permissions listed in [INSTALL.md](INSTALL.md). The app also supports the legacy `CF_API_KEY` + `CF_EMAIL` pair. Installer deployment authorization is separate.

More options: [deployment guide](docs/deployment.md).

### Self-host with Docker

Runs as one container on any server, with SQLite and local files.

```bash
cp .env.docker.example .env.docker
docker compose up -d --build
```

See [self-hosting](docs/self-hosting.md).

## Local development

```bash
cp wrangler.jsonc.example wrangler.jsonc
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev
```

Add your Cloudflare credentials to `.dev.vars`, then open [localhost:3000](http://localhost:3000). Run `npm run db:seed` to load sample data.

- `npm run build`: build the Worker
- `npm run deploy`: build and deploy
- `npm run lint`: lint and type check

A schema change needs a migration for each database type. See [Databases](docs/databases.md#migrations).

## Documentation

- [Deployment and configuration](docs/deployment.md)
- [Databases](docs/databases.md)
- [Sending and receiving providers](docs/providers.md)
- [API and integrations](docs/api.md)
- [Email assistant and MCP](docs/email-assistant-and-mcp.md)
- [Adding a language](docs/localization.md)
- [Troubleshooting](docs/troubleshooting.md)

## License

Fmail is licensed under the [GNU Affero General Public License v3.0](LICENSE). It is a fork of [Mailflare](https://github.com/hieunc229/mailflare) (c) its contributors, also AGPL-3.0; upstream copyright and attribution are retained as the license requires.

If you run a modified Fmail as a network service, the AGPL requires you to offer your users the corresponding source. The app links to `/source.tar.gz` on your deployment; `npm run build` regenerates that archive from your committed `HEAD`, so commit your changes before building.

## Google sign-in and public signup

Optional Google sign-in supports a chosen UserID, verified Google recovery address and default-off incoming forwarding. See [configuration and security notes](docs/google-signup.md). This is separate from first-admin setup and requires operator configuration, database migrations and service verification.
