#!/bin/sh
# lego renew hook for pop.example.com. Run as root, e.g.
#   lego --path /etc/lego --domains pop.example.com --dns cloudflare ... renew --renew-hook /usr/local/sbin/mailflare-pop3-renew-hook
# lego exports LEGO_CERT_PATH / LEGO_CERT_KEY_PATH (<path>/certificates/pop.example.com.crt/.key).
# The unit uses LoadCredential=, which is read at start, so the service is restarted after the swap.
# The swap is atomic: a new versioned dir is populated, then a symlink is renamed over `current`.
set -eu
CERT="${LEGO_CERT_PATH:-${1:-}}"
KEY="${LEGO_CERT_KEY_PATH:-${2:-}}"
[ -r "$CERT" ] && [ -r "$KEY" ] || { echo "cert/key not readable" >&2; exit 1; }
BASE="${MFPOP3_CERT_DIR:-/etc/mailflare-pop3/certs}"   # contains v-*/ and current -> v-*
SERVICE="${MFPOP3_SERVICE:-mailflare-pop3}"

umask 077
install -d -m 700 "$BASE"
VER="$BASE/v-$(date +%Y%m%d%H%M%S)"
mkdir -m 700 "$VER"
install -m 600 "$CERT" "$VER/pop.example.com.crt"
install -m 600 "$KEY"  "$VER/pop.example.com.key"
ln -sfn "$(basename "$VER")" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"
# keep the two newest versions
ls -1d "$BASE"/v-* | sort | head -n -2 | xargs -r rm -rf
systemctl restart "$SERVICE"
