#!/usr/bin/env bash
# Stops Range's data producers (connectors and the opportunity worker) once the shared root disk reaches the
# threshold, so Range can never fill a disk other services depend on. Stopped containers stay stopped until an
# operator restarts them. RANGE_DISK_GUARD_DRY_RUN=1 only reports what it would stop.
set -u
threshold=${RANGE_DISK_GUARD_PERCENT:-85}
used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$used" -lt "$threshold" ] && exit 0
running=$(docker ps --filter "name=range-connector-" --filter "name=range-opportunity-worker" --format '{{.Names}}' | tr '\n' ' ')
[ -z "${running// }" ] && exit 0
if [ "${RANGE_DISK_GUARD_DRY_RUN:-0}" = "1" ]; then
  echo "range-disk-guard (dry run): root disk at ${used}% (>= ${threshold}%); would stop: ${running}"
  exit 0
fi
logger -t range-disk-guard "root disk at ${used}% (>= ${threshold}%): stopping Range producers: ${running}"
# shellcheck disable=SC2086
docker stop ${running} >/dev/null
