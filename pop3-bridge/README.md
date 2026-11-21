# mailflare-pop3

A small, stateless POP3 server that fronts Mailflare's JMAP API (https://mail.example.com).
Mail clients that only speak POP3 log in with a Mailflare **App password**; the bridge
reads the inbox over JMAP and streams raw messages. No mail, passwords or state are stored on disk.

## How it works

- `PASS` is a Mailflare App password (jmap scope). Login = fetching `/jmap/session` with it (Bearer). Passwords are never stored or logged.
- `USER` should be the mailbox address. If it matches one Mailflare mailbox, only that mailbox's Inbox is the maildrop; otherwise all inboxes in the account are used.
- The maildrop is snapshotted at login (`Email/query` by receivedAt ascending, `Email/get` id/blobId/size). UIDL = JMAP email id, LIST size = JMAP size.
- `RETR`/`TOP` stream the raw blob from the session `downloadUrl` (CRLF-normalised, dot-stuffed).
- `DELE` is applied at `QUIT`: the message is moved to that mailbox's Trash (`Email/set` mailboxIds), never destroyed. `delete_mode: keep` ignores deletes. Dropped connections delete nothing.
- Redirects are never followed and the proxy environment is ignored. Session URLs pointing outside the configured `jmap_url` origin are rejected, so the key is never sent elsewhere.

Commands: CAPA, USER, PASS, STAT, LIST, UIDL, RETR, TOP, DELE, RSET, NOOP, QUIT, STLS (plain listener only).

## Build and test

Needs Go 1.23+.

    go vet ./... && go test ./...
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/mailflare-pop3 .

## Configuration

YAML file (`-config path` or `MFPOP3_CONFIG`) with env overrides. See `config.example.yaml`.

| key / env | default | meaning |
|---|---|---|
| `jmap_url` / `MFPOP3_JMAP_URL` | `https://mail.example.com` | JMAP origin |
| `listen` / `MFPOP3_LISTEN` | `:995` | implicit-TLS listener (needs `tls_cert`, `tls_key`); empty in YAML disables |
| `listen_plain` / `MFPOP3_LISTEN_PLAIN` | off | plaintext listener, for local testing; offers STLS |
| `tls_cert`, `tls_key` | none | PEM paths; default to `$CREDENTIALS_DIRECTORY/tls.crt` and `tls.key` (systemd LoadCredential); reloaded on SIGHUP when read from paths |
| `delete_mode` | `trash` | `trash` or `keep` |
| `allow_insecure_auth` | false | allow PASS without TLS (testing only) |
| `max_failures`, `fail_window` | 5, 10m | failures per IP (IPv6 per /64) and per presented-key hash before a temporary block |
| `max_conns`, `max_conns_per_ip` | 200, 10 | connection limits |
| `idle_timeout`, `auth_timeout` | 10m, 60s | idle timer; absolute time allowed to log in |
| `max_line` | 1024 | maximum command line |
| `max_messages` | 50000 | newest N inbox messages are exposed (oldest dropped from the snapshot) |
| `global_fail_per_min` | 100 | above this many failed logins/min, every login is delayed 2s |

## Deployment (notes, nothing is done automatically)

1. Create user `mailflare-pop3`; install the binary to `/usr/local/bin/`, config to `/etc/mailflare-pop3/config.yaml`.
2. Obtain a certificate for `pop.example.com` with lego (dns-cloudflare). Install `deploy/lego-renew-hook.sh` and pass it as `lego ... renew --renew-hook`. It stores cert+key in a versioned dir under `/etc/mailflare-pop3/certs`, atomically repoints `current`, and restarts the service (the unit loads them via `LoadCredential=`). For the first run, call the hook once by hand with `LEGO_CERT_PATH` and `LEGO_CERT_KEY_PATH` set.
3. Install `deploy/mailflare-pop3.service`, `systemctl enable --now mailflare-pop3`.
4. DNS `pop.example.com` and the firewall for TCP 995 are managed separately.

## Client settings

- Server: `pop.example.com`, port 995, SSL/TLS (not STARTTLS)
- Username: the mailbox address (e.g. `you@example.com`)
- Password: a Mailflare App password (Settings > Account > App passwords)
- Leave "delete from server" off if you want mail to stay in the Inbox. If on, mail is moved to Trash, not erased.
- Sending is not handled by POP3; use Mailflare's own sending.
