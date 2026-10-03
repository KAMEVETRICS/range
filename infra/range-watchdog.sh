#!/usr/bin/env bash
# Emails the operator when Range needs attention: the root disk nearing the disk guard's threshold, a connector or the
# opportunity worker not running (the guard stops them and they stay stopped), or the live pair evaluations going
# stale. Runs every 5 minutes from range-watchdog.timer and sends only when the set of problems changes, so one
# incident is one email and its recovery another.
#
# /etc/range-watchdog.env (0600, outside the repository) sets RANGE_ALERT_EMAIL and RANGE_ALERT_TOPIC, an unguessable
# ntfy.sh topic: ntfy forwards each message to the address, so no mail server is needed here. Topics are readable by
# anyone who knows their name, so messages carry status only. `range-watchdog.sh --test` sends one test message.
set -u
[ -r /etc/range-watchdog.env ] && . /etc/range-watchdog.env
: "${RANGE_ALERT_EMAIL:?set RANGE_ALERT_EMAIL in /etc/range-watchdog.env}"
: "${RANGE_ALERT_TOPIC:?set RANGE_ALERT_TOPIC in /etc/range-watchdog.env}"
warn_percent=${RANGE_WATCHDOG_DISK_PERCENT:-80}
stale_seconds=${RANGE_WATCHDOG_STALE_SECONDS:-300}
pairs_url=${RANGE_WATCHDOG_PAIRS_URL:-http://127.0.0.1:4173/v1/pairs}
state_file=/var/lib/range-watchdog/state

send() {
  curl -s -o /dev/null -m 20 -w '%{http_code}' -H "X-Email: $RANGE_ALERT_EMAIL" -H "Title: $1" -H "Tags: $2" \
    --data-binary "$3" "https://ntfy.sh/$RANGE_ALERT_TOPIC"
}

if [ "${1:-}" = "--test" ]; then
  code=$(send "Range watchdog test" "white_check_mark" "Range's watchdog on $(hostname) can reach you. It checks the disk, the producers and the live pair evaluations every 5 minutes.")
  echo "test message sent: HTTP $code"; exit 0
fi

problems=()
used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$used" -ge "$warn_percent" ] && problems+=("disk: root disk at ${used}% (the disk guard stops Range's producers at 85%)")
stopped=$(docker ps -a --filter "name=range-connector-" --filter "name=range-opportunity-worker" --format '{{.Names}} {{.State}}' \
  | awk '$2 != "running" {print $1}' | tr '\n' ' ')
[ -n "${stopped// }" ] && problems+=("stopped: not running: ${stopped% }")
as_of=$(curl -s -m 15 "$pairs_url" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["as_of_ms"] or 0)' 2>/dev/null || echo 0)
age=$(( $(date +%s) - ${as_of:-0} / 1000 ))
[ "${as_of:-0}" -eq 0 ] && problems+=("board: pair evaluations unavailable from $pairs_url") \
  || { [ "$age" -gt "$stale_seconds" ] && problems+=("board: pair evaluations are ${age} s old"); }

# The kinds of problem present, such as "board disk": an empty string when every check passes.
current=$(for problem in "${problems[@]+"${problems[@]}"}"; do echo "${problem%%:*}"; done | sort -u | paste -sd ' ' -)
mkdir -p "$(dirname "$state_file")"
previous=$(cat "$state_file" 2>/dev/null || true)
[ "$current" = "$previous" ] && exit 0

if [ -n "$current" ]; then
  body=$(printf '%s\n' "${problems[@]}"; printf '\nOn %s at %s UTC. Runbook: Disk capacity, in docs/operations/runbook.md.\n' "$(hostname)" "$(date -u '+%F %T')")
  code=$(send "Range needs attention: $current" "warning" "$body")
else
  code=$(send "Range recovered" "white_check_mark" "Every check passes again on $(hostname) at $(date -u '+%F %T') UTC.")
fi
# Remember the state only once the message went out, so a failed send is retried on the next run.
[ "$code" = "200" ] && printf '%s' "$current" > "$state_file"
logger -t range-watchdog "state '$current' (was '$previous'), ntfy HTTP $code"
