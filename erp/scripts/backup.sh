#!/bin/sh
# Nightly pg_dump; keeps 30 days of compressed backups.
# Dump to a temp file first and verify pg_dump's own exit status —
# piping straight into gzip would mask a failed dump as "complete".
#
# Two modes (#354). With no argument this is the ONE-SHOT: one dump, then exit 0 (verified archive),
# 1 (no verified archive) or 10 (a verified archive whose bookkeeping failed). `--scheduled` is the
# backup container's entrypoint: it runs that one-shot as a child at a fixed local time of day
# (BACKUP_TIME in BACKUP_TZ, both set in docker-compose.yml) and never falls through to it.
#
# Phase 8C §6.4: also writes a tiny status file the app reads for its staleness indicator. The file
# carries the LAST RUN only — the app derives `lastSuccessAt` from the newest integrity-passing
# archive, which is precisely what lets this be a single overwrite with no JSON read-merge. Written
# temp-then-rename so a reader never sees a half-written file.
set -e
DIR="${BACKUP_DIR:-/backups}"
STATUS="$DIR/backup-status.json"
# Issue #132: retention's outcome ALSO goes in a shell-only sidecar, because the main status file
# cannot hold it — the app's manual "Back up now" overwrites $STATUS whole (no read-merge, by
# design), so a green manual run ERASED a standing retention failure and the light went green while
# old dumps kept accumulating. Nothing but this script ever writes the sidecar, and this script
# re-attempts retention every night, so the sidecar is always the nightly's own latest verdict.
RETENTION_STATUS="$DIR/retention-status.json"

write_status() {   # $1 = true|false, $2 = error message (may be empty)
  tmp="$STATUS.$$.tmp"
  # Sanitize before the emptiness check, not after: JSON strings can't carry a raw newline/CR/tab
  # (they must be escaped), so a dynamic message with one of those would otherwise write a status
  # file the app's parseStatus rejects as unparseable — which reads as "no readable status file"
  # (red) instead of the real failure reason. `printf '%s'` (not `echo`) avoids shell-dependent
  # backslash-escape interpretation in $2; the trailing `tr` folds newline/CR/tab to spaces so the
  # quoted value always stays on one line. Still lossy (quotes/backslashes are dropped, not
  # escaped) — acceptable for a one-line status summary, not acceptable if this ever needs to
  # round-trip an exact message.
  msg=$(printf '%s' "$2" | tr -d '"\\' | tr '\n\r\t' '   ')
  printf '{\n  "lastRunAt": "%s",\n  "ok": %s,\n  "source": "nightly",\n  "error": %s\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" \
    "$([ -n "$msg" ] && printf '"%s"' "$msg" || echo null)" > "$tmp"
  mv "$tmp" "$STATUS"
}

write_retention_status() {   # $1 = true|false, $2 = error message (may be empty)
  # Same sanitization and temp-then-rename as write_status, for the same reasons.
  tmp="$RETENTION_STATUS.$$.tmp"
  msg=$(printf '%s' "$2" | tr -d '"\\' | tr '\n\r\t' '   ')
  printf '{\n  "lastRunAt": "%s",\n  "ok": %s,\n  "error": %s\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" \
    "$([ -n "$msg" ] && printf '"%s"' "$msg" || echo null)" > "$tmp"
  mv "$tmp" "$RETENTION_STATUS"
}

# ---------------------------------------------------------------------------------------------
# The scheduler (#354; design docs/superpowers/specs/2026-09-29-fixed-backup-time-design.md).
#
# Before #354 the container ran `backup.sh; sleep 86400` in a loop, so every start (a reboot, an
# upgrade, every nightly deploy's recreate) backed up at once and moved the schedule to that
# moment. Now the time of day is fixed and a start only catches up a slot it can prove was missed.
#
# Shell rules this section depends on (each one measured, see the design critique):
# - every `date` result the schedule depends on is captured as `var=$(…)` followed by `|| return 1`
#   / `|| scheduler_fail`, never inline in `[ ]` or a condition (describe() only formats log text):
#   `set -e` is suspended in `if` and `||` conditions, and a failure inside an inline `$(…)` does not
#   stop the parent, so a failed computation would otherwise read as an empty string;
# - TZ is only ever a per-command prefix and is never exported, so the one-shot child keeps the
#   container's UTC and archive names stay UTC like the app's manual ones;
# - waits are `sleep N & wait $!`, which the INT/TERM trap can interrupt; a foreground sleep would
#   hold `docker stop` for the whole grace period.
# ---------------------------------------------------------------------------------------------

# The shell form of NIGHTLY_ARCHIVE_RE (erp/src/lib/backup-constants.ts); a drift test ties them.
NIGHTLY_GLOB='erp_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9].sql.gz'

scheduler_fail() {   # $1 = reason. Log FIRST, so a failed status write cannot lose the reason.
  echo "backup scheduler: $1" >&2
  write_status false "$1" || :
  exit 1
}

validate_schedule() {
  # `case` matches the WHOLE value; a line-oriented grep would accept "23:10<newline>junk".
  case "${BACKUP_TIME:-}" in
    [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
    *) scheduler_fail "BACKUP_TIME must be HH:MM from 00:00 to 23:59, got '${BACKUP_TIME:-}'" ;;
  esac
  # A US daylight-saving change skips or repeats these hours (the CD design's ruling 4). GNU date
  # refuses a skipped time outright, which would stop the scheduler once a year.
  case "$BACKUP_TIME" in
    01:* | 02:*) scheduler_fail "BACKUP_TIME $BACKUP_TIME is in 01:00-02:59, which a daylight-saving change skips or repeats" ;;
  esac
  # A mistyped zone, or a non-zone file such as zone.tab, runs silently as UTC in GNU and uutils
  # date alike, so require a real TZif file. A path is not a zone name: glibc reads a leading `/`
  # as an absolute path, so /America/Chicago passes the file check below and still runs as UTC.
  case "${BACKUP_TZ:-}" in
    /* | *..*) scheduler_fail "BACKUP_TZ must name a time zone such as America/Chicago, got '$BACKUP_TZ'" ;;
  esac
  zone_file="/usr/share/zoneinfo/${BACKUP_TZ:-}"
  if [ -z "${BACKUP_TZ:-}" ] || [ ! -f "$zone_file" ] || [ "$(head -c 4 "$zone_file")" != TZif ]; then
    scheduler_fail "BACKUP_TZ must name a time zone such as America/Chicago, got '${BACKUP_TZ:-}'"
  fi
  # The scheduler never reaches the one-shot's code, and dash parses as it goes, so a syntax error
  # there would otherwise surface only at the first run.
  sh -n "$0" || scheduler_fail "backup.sh does not parse, so the backup itself would fail"
}

slot_on() {   # $1 = local date YYYY-MM-DD -> epoch of BACKUP_TIME on that date in BACKUP_TZ
  TZ="$BACKUP_TZ" date -d "$1 $BACKUP_TIME" +%s
}

local_date() {   # $1 = epoch -> its YYYY-MM-DD in BACKUP_TZ
  TZ="$BACKUP_TZ" date -d "@$1" +%F
}

shift_day() {   # $1 = local date, $2 = 1 or -1 -> the neighbouring local date
  # From noon, never from the slot: a DST day is 23 or 25 hours long, so slot + 86400 can skip or
  # repeat a date, while noon +/- 86400 always lands on the neighbouring day.
  sd_noon=$(TZ="$BACKUP_TZ" date -d "$1 12:00" +%s) || return 1
  local_date "$((sd_noon + $2 * 86400))"
}

slot_at_or_before() {   # $1 = epoch -> the most recent slot at or before it
  sb_day=$(local_date "$1") || return 1
  sb_slot=$(slot_on "$sb_day") || return 1
  if [ "$sb_slot" -gt "$1" ]; then
    sb_day=$(shift_day "$sb_day" -1) || return 1
    sb_slot=$(slot_on "$sb_day") || return 1
  fi
  echo "$sb_slot"
}

slot_after() {   # $1 = epoch -> the first slot strictly after it
  sa_day=$(local_date "$1") || return 1
  sa_slot=$(slot_on "$sa_day") || return 1
  if [ "$sa_slot" -le "$1" ]; then
    sa_day=$(shift_day "$sa_day" 1) || return 1
    sa_slot=$(slot_on "$sa_day") || return 1
  fi
  echo "$sa_slot"
}

describe() {   # $1 = epoch -> "2026-09-29 23:10 CDT (2026-09-30T04:10:00Z)", for the log
  printf '%s (%s)' "$(TZ="$BACKUP_TZ" date -d "@$1" '+%F %H:%M %Z')" "$(date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ)"
}

intact_nightly_since() {   # $1 = epoch -> the name of a nightly archive completed after it that passes gzip -t
  # Strictly newer (-newermt), nightly names only (a manual "Back up now" runs no retention, so it
  # must not stand in for the nightly), and intact, the app's own rule (backups.ts newestIntactAt):
  # a dump killed mid-compress leaves a truncated file under a nightly name.
  find "$DIR" -maxdepth 1 -type f -name "$NIGHTLY_GLOB" -newermt "@$1" -exec gzip -t {} \; -print -quit
}

pause() {   # $1 = seconds; the INT/TERM trap interrupts the wait
  sleep "$1" &
  # `|| :` only absorbs a sleep killed by something else; the trap still ends the scheduler.
  wait $! || :
}

wait_until() {   # $1 = epoch; re-reads the wall clock at least hourly
  # sleep counts neither suspend nor a wall-clock step, so a single long sleep could wake far from
  # the slot. Chunks bound the error to an hour, and a slot already passed runs at once.
  while :; do
    wu_now=$(date +%s) || scheduler_fail "cannot read the clock"
    wu_left=$(($1 - wu_now))
    [ "$wu_left" -gt 0 ] || return 0
    [ "$wu_left" -le 3600 ] || wu_left=3600
    pause "$wu_left"
  done
}

run_until_served() {   # the one-shot as a child; retry soon, not tomorrow (GitLab issue 313, MR !325)
  while :; do
    rc=0
    sh "$0" || rc=$?
    case $rc in
      # 10: a verified archive whose retention or status bookkeeping failed. Repeating full dumps
      # would only worsen a disk problem, so it keeps the schedule and its failure evidence.
      0 | 10) return 0 ;;
    esac
    echo "backup failed (exit $rc); retrying in 5 minutes" >&2
    pause 300
  done
}

run_scheduler() {
  validate_schedule
  # `|| :` is required: under `set -e` a kill of an already-reaped (or never-started) sleep would
  # abort the trap before `exit 0`. `$!` directly, not a copy, because the trap can fire between
  # `sleep &` and any assignment. A stop during a dump is deferred until the child finishes.
  trap 'kill $! 2>/dev/null || :; exit 0' INT TERM
  echo "nightly backup scheduled daily at $BACKUP_TIME $BACKUP_TZ"
  # ONE clock reading decides both whether the last slot was missed and which slot comes next: a
  # second reading could cross the slot and skip that night.
  now=$(date +%s) || scheduler_fail "cannot read the clock"
  last=$(slot_at_or_before "$now") || scheduler_fail "cannot compute the $BACKUP_TIME $BACKUP_TZ slot"
  # A failed probe prints nothing, so it reads as a missed slot; find names the error in the log.
  if [ -z "$(intact_nightly_since "$last")" ]; then
    echo "no intact nightly archive since $(describe "$last"); backing up now"
    run_until_served
    now=$(date +%s) || scheduler_fail "cannot read the clock"
  fi
  while :; do
    next=$(slot_after "$now") || scheduler_fail "cannot compute the $BACKUP_TIME $BACKUP_TZ slot"
    echo "next nightly backup: $(describe "$next")"
    wait_until "$next"
    run_until_served
    now=$(date +%s) || scheduler_fail "cannot read the clock"
  done
}

case "${1:-}" in
  "") ;;
  --scheduled) run_scheduler ;;
  *) echo "usage: backup.sh [--scheduled]" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------------------------
# The one-shot.
# ---------------------------------------------------------------------------------------------

STAMP=$(date +%Y-%m-%d_%H%M%S)
TMP="$DIR/.erp_${STAMP}.sql.tmp"
if ! pg_dump "$DATABASE_URL" > "$TMP"; then
  rm -f "$TMP"
  write_status false "pg_dump error"
  echo "backup FAILED: pg_dump error" >&2
  exit 1
fi
# Fail loud on an empty dump: pg_dump can exit zero having written nothing, and an empty archive
# that looks like a backup is worse than no archive at all.
if [ ! -s "$TMP" ]; then
  rm -f "$TMP"
  write_status false "pg_dump produced an empty dump"
  echo "backup FAILED: empty dump" >&2
  exit 1
fi
if ! gzip < "$TMP" > "$DIR/erp_${STAMP}.sql.gz"; then
  rm -f "$TMP" "$DIR/erp_${STAMP}.sql.gz"
  write_status false "could not compress the dump"
  echo "backup FAILED: compress error" >&2
  exit 1
fi
rm -f "$TMP"
if ! gzip -t "$DIR/erp_${STAMP}.sql.gz"; then
  rm -f "$DIR/erp_${STAMP}.sql.gz"
  write_status false "the written archive failed its gzip integrity check"
  echo "backup FAILED: integrity check" >&2
  exit 1
fi
# A verified archive already exists. Keep later bookkeeping failures nonzero, but distinguish
# them for the scheduler: retrying a full dump every five minutes for a retention/status-write
# failure would consume more disk. An EXIT trap preserves set -e inside the status writers;
# putting those functions in an if/|| guard would suppress it and could mask a failed write.
# Exit 10 is reserved for this post-integrity outcome (sh itself uses 2 for launcher errors).
trap 'result=$?; if [ "$result" -ne 0 ]; then exit 10; fi' 0

# Retention (a deploy value, not a setting). The pattern covers BOTH writers' archives — on-demand
# names also start `erp_` — which is the owner's one-retention-rule decision (§6.4).
#
# Issue #120: each prune is guarded and its failure RECORDED, never allowed to abort the script.
# These run AFTER the archive is written and verified, so under a bare `set -e` a failing `find` (a
# read-only folder, an NFS hiccup, a permission change on one old file) exited before
# `write_status true` — leaving the PREVIOUS run's `{"ok":true}` in place beside a fresh intact
# archive. The UI then read GREEN while retention was silently broken and old dumps accumulated
# toward a full disk; "retention broken" was not a state the light could express. It is now the
# ordinary red `ok:false` path, with a message that says the DUMP succeeded so nobody hunts a
# nonexistent dump problem.
RETENTION_ERR=""
prune() {   # $1 = name pattern, $2 = -mtime spec
  find "$DIR" -name "$1" -mtime "$2" -delete || RETENTION_ERR="${RETENTION_ERR}${RETENTION_ERR:+, }$1"
}
prune 'erp_*.sql.gz' +30
# Codex re-review, MR !117 (finding #2): the restore runbook's pre-restore safety dump
# (`before-restore-<epoch>.sql.gz`, README.md's "Restoring" section) lands in this SAME folder but
# never matched the pattern above, so full production dumps piled up forever and the README's "copy
# it out if you want to keep it — everything in here is pruned at 30 days" claim was false for
# exactly the file holding a complete copy of the database. Same 30-day rule, same folder.
prune 'before-restore-*.sql.gz' +30
# Orphaned temps from a crashed dump would otherwise accumulate forever.
prune '.erp_*.sql.tmp' +1

# The sidecar is written FIRST in both branches, deliberately: under `set -e` a failing sidecar
# write then aborts before the main status can go green, which fails toward red — the reverse order
# could leave a fresh green main status behind a run that exited non-zero. Main-status behavior and
# exit codes are otherwise exactly the #120 shape: the sidecar is additional evidence, not a
# replacement.
if [ -n "$RETENTION_ERR" ]; then
  # The archive is KEPT: a retention failure is no reason to throw away a good backup, which is
  # precisely why this reports rather than aborting earlier.
  write_retention_status false "retention cleanup failed for: $RETENTION_ERR"
  write_status false "the dump succeeded but retention cleanup failed for: $RETENTION_ERR"
  echo "backup wrote erp_${STAMP}.sql.gz but retention FAILED for: $RETENTION_ERR" >&2
  exit 1
fi
write_retention_status true ""
write_status true ""
echo "backup complete: erp_${STAMP}.sql.gz"
