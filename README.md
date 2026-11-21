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

> **`CF_TOKEN` is required.** Create a scoped Cloudflare API token with the permissions listed in [INSTALL.md](INSTALL.md) (the supported install path).

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
