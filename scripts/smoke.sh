#!/usr/bin/env bash
# Post-deploy smoke check. The whole site sits behind
# Cloudflare Access, so an unauthenticated request must redirect to the Access
# login. A 200 or a 5xx here means Access is off or the Worker is broken.
set -euo pipefail

# Defaults to the first route in wrangler.jsonc; SMOKE_URL overrides it.
cd "$(dirname "$0")/.."
route=$(grep -o '"pattern": *"[^"]*"' wrangler.jsonc | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
BASE="${SMOKE_URL:-https://$route}"
if [[ "$BASE" == "https://" ]]; then
	echo "No route in wrangler.jsonc. Set SMOKE_URL." >&2
	exit 2
fi
fail=0

check() {
	local method="$1" path="$2"
	local out code location
	out=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -X "$method" \
		-H 'content-type: application/json' --max-time 15 "$BASE$path" || true)
	code=${out%% *}
	location=${out#* }
	if [[ "$code" == "302" && "$location" == *".cloudflareaccess.com/"* ]]; then
		printf '  ok   %-5s %s -> Access\n' "$method" "$path"
	else
		printf '  FAIL %-5s %s -> %s\n' "$method" "$path" "$code" >&2
		fail=1
	fi
}

echo "Smoke: $BASE"
check GET /
check GET /api/v1/mail
check GET /api/v1/labels
check POST /api/v1/mail/bulk
exit "$fail"
