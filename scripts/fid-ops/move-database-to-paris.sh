#!/usr/bin/env bash
# Moves the FID ERP books from the Tokyo Supabase project to the Paris one.
#
#   scripts/move-database-to-paris.sh rehearse   copy live → a local practice database, compare
#   scripts/move-database-to-paris.sh run        copy live → NEW_DATABASE_URL (Paris), compare
#   scripts/move-database-to-paris.sh check-old  fingerprint live again: proves nothing was written during the move
#
# Live is only ever read (pg_dump). The target must be empty. Every table is
# fingerprinted on both sides — row count and an md5 of every row's full
# content — and the move only counts as done when the two match exactly.
set -euo pipefail

ROOT="/home/synthor/export dubbai/fid-erp"
BIN="/home/synthor/.local/share/pg17/usr/lib/postgresql/17/bin"
export LD_LIBRARY_PATH="/home/synthor/.local/share/pg17/usr/lib/x86_64-linux-gnu"
OUT="$ROOT/backups/eu-move"
mkdir -p "$OUT"

env_value() { grep "^$1=" "$ROOT/.env" | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }
redact() { sed -E 's#postgres(ql)?://[^ ]*#<url>#g'; }
host_of() { echo "$1" | sed -E 's#.*@([^:/]+).*#\1#'; }

OLD="$(env_value DIRECT_URL)"
[ -n "$OLD" ] || { echo "No DIRECT_URL in .env"; exit 1; }

fingerprint() { # $1 url, $2 file
  "$BIN/psql" "$1" -X -At -v ON_ERROR_STOP=1 <<'SQL' > "$2"
SET TimeZone = 'UTC';
SELECT format(
  'SELECT %L, count(*), md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) FROM %I.%I x',
  table_name, table_schema, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name
\gexec
SQL
}

mode="${1:-}"
stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"

case "$mode" in
  rehearse)
    TEST="$(env_value TEST_DATABASE_URL | sed 's/?.*$//')"
    NEW="${TEST%/*}/fid_eu_move_rehearsal"
    "$BIN/psql" "$TEST" -X -Atc "DROP DATABASE IF EXISTS fid_eu_move_rehearsal" >/dev/null
    "$BIN/psql" "$TEST" -X -Atc "CREATE DATABASE fid_eu_move_rehearsal" >/dev/null
    ;;
  run)
    NEW="$(env_value NEW_DATABASE_URL)"
    [ -n "$NEW" ] || { echo "Add NEW_DATABASE_URL (the Paris session-pooler URI) to .env first."; exit 1; }
    case "$(host_of "$NEW")" in *eu-west-3*) ;; *) echo "NEW_DATABASE_URL is not in eu-west-3 (Paris): $(host_of "$NEW")"; exit 1;; esac
    [ "$(host_of "$NEW")" != "$(host_of "$OLD")" ] || { echo "NEW_DATABASE_URL points at the live database."; exit 1; }
    ;;
  check-old)
    fingerprint "$OLD" "$OUT/live-after-$stamp.txt"
    last="$(ls -t "$OUT"/live-before-*.txt | head -1)"
    if diff -q "$last" "$OUT/live-after-$stamp.txt" >/dev/null; then echo "Live unchanged since $(basename "$last")."; else echo "LIVE CHANGED during the move:"; diff "$last" "$OUT/live-after-$stamp.txt" | head -20; exit 2; fi
    exit 0
    ;;
  *) echo "usage: scripts/move-database-to-paris.sh rehearse|run|check-old"; exit 1 ;;
esac

echo "Target: $(host_of "$NEW") ($("$BIN/psql" "$NEW" -X -Atc "select current_setting('server_version')" 2>&1 | redact))"
existing="$("$BIN/psql" "$NEW" -X -Atc "select count(*) from information_schema.tables where table_schema='public'" | redact)"
[ "$existing" = "0" ] || { echo "Target already has $existing tables in public — refusing to write over anything."; exit 1; }

echo "1/4 Backing up live (read-only dump)…"
DUMP="$OUT/live-before-eu-move-$stamp.dump"
"$BIN/pg_dump" "$OLD" -Fc -n public --no-owner --no-privileges -f "$DUMP" 2>&1 | redact
echo "    $(du -h "$DUMP" | cut -f1) → backups/eu-move/$(basename "$DUMP")"

echo "2/4 Fingerprinting live…"
fingerprint "$OLD" "$OUT/live-before-$stamp.txt"
echo "    $(wc -l < "$OUT/live-before-$stamp.txt") tables, $(awk -F'|' '{s+=$2} END {print s}' "$OUT/live-before-$stamp.txt") rows"

echo "3/4 Restoring into the target…"
"$BIN/pg_restore" -d "$NEW" --no-owner --no-privileges -n public "$DUMP" 2>&1 | redact | grep -vE "^$" > "$OUT/restore-$mode-$stamp.log" || true
if [ -s "$OUT/restore-$mode-$stamp.log" ]; then echo "    restore messages:"; sed 's/^/      /' "$OUT/restore-$mode-$stamp.log" | head -20; fi

echo "4/4 Fingerprinting the target and comparing…"
fingerprint "$NEW" "$OUT/target-$mode-$stamp.txt"
if diff -q "$OUT/live-before-$stamp.txt" "$OUT/target-$mode-$stamp.txt" >/dev/null; then
  echo "MATCH: every table has the same rows and the same content ($(wc -l < "$OUT/target-$mode-$stamp.txt") tables)."
else
  echo "MISMATCH:"; diff "$OUT/live-before-$stamp.txt" "$OUT/target-$mode-$stamp.txt" | head -30; exit 2
fi
