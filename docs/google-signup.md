# Google signup and backup forwarding

Public signup is a separate flow from the first administrator setup. It creates ordinary users only. Existing users are not linked by matching email; a Google subject can own at most one account.

## Configuration

- Set `SIGNUP_DOMAIN` to an active domain already configured in Fmail.
- Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as server-side secrets.
- Set `APP_URL` to the canonical HTTPS webmail URL.
- Register the exact OAuth redirect URI `<APP_URL>/api/auth/google/callback` in a Google Web application OAuth client. Configure an external audience if signup is intended for everyone.
- Only `openid email profile` are requested. No Gmail inbox or sending access is requested or stored.
- Apply the Google signup database migration for the selected dialect before enabling the credentials.

Signup uses signed, short-lived browser cookies, OAuth state and PKCE. UserIDs allow 1-32 letters, numbers, underscores and hyphens, beginning with a letter or number. Reserved names and existing normalized mailbox/alias names cannot be claimed. Signup does not grant other domain access or administrator permissions.

## Backup and recovery

The Google-verified email is saved as the initial recovery address. New Google-only accounts can use the existing password recovery process to explicitly set a password through that address. Existing explicitly passkey-only accounts remain excluded from email password recovery, including after a Google account is linked. Existing required second-factor accounts are not allowed through the new OAuth-only login path.

## Optional incoming forwarding

Forwarding defaults off. Enabling it registers only the authenticated user's stored Google email with Cloudflare Email Routing, which sends its own destination-verification email. The destination must be verified before Cloudflare delivers forwarded copies. Incoming mail remains in Fmail even if forwarding fails. This does not resend incoming mail through the outbound sending provider.

The runtime Cloudflare token needs account-scoped **Email Routing Addresses Write** to create and inspect destinations. This permission is account-wide and is separate from zone-scoped routing-rule permissions. Obtain the account owner's approval before adding it. Never expose that token or destination lists to normal users. The settings API returns only the current user's destination status and ignores client-supplied destination addresses.

Turning forwarding off stops future forwarding from this mailbox. It does not delete the shared Cloudflare destination, which could be used elsewhere.

## Checks

Run `node --test tests/google-oauth.test.mjs tests/google-forwarding.test.mjs tests/password-reset-race.test.mjs tests/database-dialects.test.mjs` and the TypeScript/build checks. Verify the Google OAuth roundtrip and destination verification against the configured services before announcing signup and forwarding ready.

## Installation-specific privacy notice

The included `/privacy` page is a starting template, not legal advice. Before enabling public signup, the operator must review it against actual storage, email providers, retention and deletion practices, and add the installation's support/privacy contact. Do not copy another operator's contact details or claim unverified practices.

## Repository updates

For the optional dashboard update workflow, the source defaults to the current repository. Set repository variable `UPDATE_SOURCE_REPOSITORY` only when deliberately selecting another source. Do not point it at an earlier baseline that lacks these features.
