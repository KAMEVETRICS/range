#!/usr/bin/env bash
# Emails the operator when Range needs attention: the root disk nearing the disk guard's threshold, a connector or the
# opportunity worker not running (the guard stops them and they stay stopped), or the live pair evaluations going
# stale. Runs every 5 minutes from range-watchdog.timer and sends only when the set of problems changes, so one
# incident is one email and its recovery another.
#
# /etc/range-watchdog.env (0600, outside the repository) chooses where messages go; set either or both:
# - email: RANGE_ALERT_EMAIL and RANGE_SMTP_PASSWORD, sent with curl over SMTP with STARTTLS (no mail server needed
#   here). RANGE_SMTP_HOST and RANGE_SMTP_PORT default to Gmail's smtp.gmail.com:587, whose password is a Google app
#   password; RANGE_SMTP_USER defaults to the address. The host's outbound port 25 is blocked, so direct delivery is out.
# - push: RANGE_ALERT_TOPIC, an unguessable ntfy.sh topic to subscribe to in the ntfy app. Topics are readable by
#   anyone who knows their name, so messages carry status only. (ntfy.sh no longer forwards email for anonymous senders.)
# `range-watchdog.sh --test` sends one test message on every configured channel.
set -u
[ -r /etc/range-watchdog.env ] && . /etc/range-watchdog.env
if [ -z "${RANGE_SMTP_PASSWORD:-}" ] && [ -z "${RANGE_ALERT_TOPIC:-}" ]; then
  echo "set RANGE_ALERT_EMAIL and RANGE_SMTP_PASSWORD, or RANGE_ALERT_TOPIC, in /etc/range-watchdog.env" >&2; exit 1
fi
warn_percent=${RANGE_WATCHDOG_DISK_PERCENT:-80}
stale_seconds=${RANGE_WATCHDOG_STALE_SECONDS:-600}
pairs_url=${RANGE_WATCHDOG_PAIRS_URL:-http://127.0.0.1:4173/v1/pairs}
state_file=/var/lib/range-watchdog/state

# Sends a title, ntfy tags and a body on every configured channel; succeeds when at least one delivered it.
send() {
  local delivered=1 sent=()
  if [ -n "${RANGE_SMTP_PASSWORD:-}" ] && [ -n "${RANGE_ALERT_EMAIL:-}" ]; then
    local host=${RANGE_SMTP_HOST:-smtp.gmail.com} user=${RANGE_SMTP_USER:-$RANGE_ALERT_EMAIL} netrc
    # The password reaches curl through a private netrc file, never the command line, where any process could read it.
    netrc=$(umask 077 && mktemp)
    printf 'machine %s login %s password %s\n' "$host" "$user" "$RANGE_SMTP_PASSWORD" > "$netrc"
    if printf 'From: Range watchdog <%s>\r\nTo: %s\r\nSubject: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
        "$user" "$RANGE_ALERT_EMAIL" "$1" "$3" | curl -s -m 30 --ssl-reqd --netrc-file "$netrc" \
        "smtp://$host:${RANGE_SMTP_PORT:-587}" --mail-from "$user" --mail-rcpt "$RANGE_ALERT_EMAIL" -T -; then
      delivered=0; sent+=(email)
    fi
    rm -f "$netrc"
  fi
  if [ -n "${RANGE_ALERT_TOPIC:-}" ] && [ "$(curl -s -o /dev/null -m 20 -w '%{http_code}' -H "Title: $1" -H "Tags: $2" \
      --data-binary "$3" "https://ntfy.sh/$RANGE_ALERT_TOPIC")" = 200 ]; then
    delivered=0; sent+=(push)
  fi
  echo "${sent[*]:-nothing}"
  return $delivered
}

if [ "${1:-}" = "--test" ]; then
  echo "test message delivered by: $(send "Range watchdog test" "white_check_mark" "Range's watchdog on $(hostname) can reach you. It checks the disk, the producers and the live pair evaluations every 5 minutes.")"
  exit 0
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
  channels=$(send "Range needs attention: $current" "warning" "$body"); status=$?
else
  channels=$(send "Range recovered" "white_check_mark" "Every check passes again on $(hostname) at $(date -u '+%F %T') UTC."); status=$?
fi
# Remember the state only once a message went out, so a failed send is retried on the next run.
[ "$status" -eq 0 ] && printf '%s' "$current" > "$state_file"
logger -t range-watchdog "state '$current' (was '$previous'), delivered by: $channels"
