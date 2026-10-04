#!/usr/bin/env bash
# Keeps Range from filling the shared root disk, which other services depend on. Runs every minute.
#
# At the threshold it first reclaims what Range can safely lose: the Docker build cache, which the next deploy
# rebuilds, and what Redis's append-only file has grown since its last rewrite. Only if the disk is still at the
# threshold does it stop Range's data producers (connectors and the opportunity worker). It starts the ones it stopped
# again once the disk is under the resume level, unless they refilled it within an hour of an earlier restart: then they
# wait for an operator. A stop alone frees nothing, but the broker deletes its oldest segments within 6 hours.
#
# Each action is logged as range-disk-guard and sent on the watchdog's channels. RANGE_DISK_GUARD_DRY_RUN=1 only
# reports what it would do; RANGE_DISK_GUARD_STATE_DIR is for tests.
set -u
threshold=${RANGE_DISK_GUARD_PERCENT:-85}
resume=${RANGE_DISK_GUARD_RESUME_PERCENT:-80}
dry=${RANGE_DISK_GUARD_DRY_RUN:-0}
state_dir=${RANGE_DISK_GUARD_STATE_DIR:-/var/lib/range-disk-guard}
used() { df --output=pcent / | tail -1 | tr -dc '0-9'; }
tell() {
  logger -t range-disk-guard "$2"
  /bin/bash "$(dirname "$0")/range-watchdog.sh" --notify "$1" "$3" "$2. On $(hostname) at $(date -u '+%F %T') UTC." >/dev/null 2>&1 || true
}
disk=$(used)
running=$(docker ps --filter "name=range-connector-" --filter "name=range-opportunity-worker" --format '{{.Names}}' | sort | tr '\n' ' ')

if [ "$disk" -ge "$threshold" ] && [ -n "${running// }" ]; then
  if [ "$dry" = 1 ]; then
    echo "range-disk-guard (dry run): root disk at ${disk}% (>= ${threshold}%); would reclaim, then stop if still full: ${running}"
    exit 0
  fi
  docker builder prune --all --force >/dev/null 2>&1
  if docker exec range-redis-1 redis-cli BGREWRITEAOF >/dev/null 2>&1; then
    for _ in $(seq 1 24); do
      sleep 5
      docker exec range-redis-1 redis-cli INFO persistence 2>/dev/null | grep -q '^aof_rewrite_in_progress:0' && break
    done
  fi
  after=$(used)
  if [ "$after" -lt "$threshold" ]; then
    tell "Range disk guard reclaimed space" "The root disk reached ${disk}%. Clearing the build cache and rewriting Redis's append-only file brought it to ${after}%" "white_check_mark"
    exit 0
  fi
  mkdir -p "$state_dir"
  printf '%s\n' $running >> "$state_dir/stopped"
  # shellcheck disable=SC2086
  docker stop $running >/dev/null
  last=$(cat "$state_dir/restarted-at" 2>/dev/null || echo 0)
  if [ $(( $(date +%s) - last )) -lt 3600 ]; then
    touch "$state_dir/hold"
    tell "Range disk guard stopped producers again" "The root disk is at ${after}% after reclaiming, within an hour of restarting them, so ${running% } stay stopped until an operator frees space and starts them" "warning"
  else
    tell "Range disk guard stopped producers" "The root disk is at ${after}% after reclaiming, so it stopped ${running% }. They start again once the disk is under ${resume}%" "warning"
  fi
  exit 0
fi

# Start what this guard stopped once the disk has room again.
[ -s "$state_dir/stopped" ] || exit 0
waiting=$(sort -u "$state_dir/stopped" | while read -r name; do
  [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] || printf '%s ' "$name"; done)
# An operator already started them.
if [ -z "${waiting// }" ]; then rm -f "$state_dir/stopped" "$state_dir/hold"; exit 0; fi
if [ -e "$state_dir/hold" ] || [ "$disk" -ge "$resume" ]; then exit 0; fi
if [ "$dry" = 1 ]; then echo "range-disk-guard (dry run): root disk at ${disk}% (< ${resume}%); would start: ${waiting}"; exit 0; fi
# shellcheck disable=SC2086
docker start $waiting >/dev/null
date +%s > "$state_dir/restarted-at"
rm -f "$state_dir/stopped"
tell "Range disk guard restarted producers" "The root disk is back to ${disk}%, so it started ${waiting% }" "white_check_mark"
