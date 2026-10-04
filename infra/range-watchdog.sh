#!/usr/bin/env bash
# Emails the operator when Range needs attention: the root disk nearing the disk guard's threshold, a connector or the
# opportunity worker not running (the guard stops them and they stay stopped), any Range container restarting, or the
# live pair evaluations going stale. Runs every 5 minutes from range-watchdog.timer and sends only when the set of problems changes, so one
# incident is one email and its recovery another. A deploy stops a container for seconds and leaves the board empty for
# minutes, so a stopped container counts once two runs in a row see it, and a missing board once it has lasted as long
# as a stale one would.
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
state_dir=/var/lib/range-watchdog
state_file=$state_dir/state

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

# Succeeds once the problem named $1 has lasted $2 seconds. Its first sighting is kept in $state_dir/$1.since, which
# the caller removes when the check passes.
lasted() {
  local since=$state_dir/$1.since
  [[ "$(cat "$since" 2>/dev/null)" =~ ^[0-9]+$ ]] || date +%s > "$since"
  [ $(( $(date +%s) - $(cat "$since") )) -ge "$2" ]
}

mkdir -p "$state_dir"
problems=()
used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$used" -ge "$warn_percent" ] && problems+=("disk: root disk at ${used}% (the disk guard stops Range's producers at 85%)")
stopped=$(docker ps -a --filter "name=range-connector-" --filter "name=range-opportunity-worker" --format '{{.Names}} {{.State}}' \
  | awk '$2 != "running" {print $1}' | tr '\n' ' ')
# Runs are 5 minutes apart, give or take the timer's minute of slack, so 240 s is the next run.
if [ -z "${stopped// }" ]; then rm -f "$state_dir/stopped.since"
elif lasted stopped 240; then problems+=("stopped: not running: ${stopped% }"); fi
# A container that keeps crashing is running between restarts, so the check above misses it: on 2026-10-04 Redis was
# killed every minute for an hour and a half without an alert. Any restart counts, since none of Range's containers
# restarts in normal operation and a deploy replaces a container rather than restarting it.
counts=$(docker ps -a --filter "name=range-" --format '{{.Names}}' | xargs -r docker inspect -f '{{.Name}} {{.RestartCount}}' \
  | sed 's#^/##' | sort)
if [ -s "$state_dir/restarts" ]; then
  restarted=$(join "$state_dir/restarts" <(printf '%s\n' "$counts") | awk '$3 > $2 { printf "%s (+%d) ", $1, $3 - $2 }')
  [ -n "$restarted" ] && problems+=("restarting: restarted since the last check: ${restarted% }")
fi
printf '%s\n' "$counts" > "$state_dir/restarts"
as_of=$(curl -s -m 15 "$pairs_url" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["as_of_ms"] or 0)' 2>/dev/null || echo 0)
age=$(( $(date +%s) - ${as_of:-0} / 1000 ))
# A restarted worker serves no evaluations for 3 to 5 minutes while it replays the instrument registry.
if [ "${as_of:-0}" -ne 0 ]; then
  rm -f "$state_dir/board.since"
  [ "$age" -gt "$stale_seconds" ] && problems+=("board: pair evaluations are ${age} s old")
elif lasted board "$stale_seconds"; then problems+=("board: pair evaluations unavailable from $pairs_url"); fi

# The kinds of problem present, such as "board disk": an empty string when every check passes.
current=$(for problem in "${problems[@]+"${problems[@]}"}"; do echo "${problem%%:*}"; done | sort -u | paste -sd ' ' -)
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
