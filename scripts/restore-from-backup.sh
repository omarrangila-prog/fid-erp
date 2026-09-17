#!/usr/bin/env bash
#
# Puts a logical backup back into the database, table by table.
#
# Only tables that are *empty now* and had rows in the backup are touched, so
# the installation (companies, chart of accounts, users, roles) is never
# duplicated — this restores the business data that was cleared, and nothing
# else.
#
# Foreign keys decide the order and the order is not obvious from the schema,
# so rather than encode it the script sweeps the list repeatedly until a pass
# loads nothing new. A table whose parents are not in yet simply fails, whole,
# and is retried on the next pass. Anything still failing when no progress is
# possible is reported rather than forced.
#
#   scripts/restore-from-backup.sh <backup directory>
#
set -euo pipefail

DIR="${1:?usage: restore-from-backup.sh <backup directory>}"
[ -d "$DIR/tables" ] || { echo "No tables/ in $DIR"; exit 1; }
[ -f "$DIR/row-counts.csv" ] || { echo "No row-counts.csv in $DIR"; exit 1; }

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
: "${DIRECT_URL:?DIRECT_URL must be set}"

echo "→ Restoring from $DIR"

# Tables worth restoring: had rows then, has none now.
PENDING=()
while IFS=, read -r table count; do
  [ "${count:-0}" -gt 0 ] || continue
  [ "$table" = "_prisma_migrations" ] && continue
  current=$(psql "$DIRECT_URL" -Atc "SELECT count(*) FROM \"$table\"")
  if [ "$current" -eq 0 ]; then
    PENDING+=("$table")
  else
    echo "  skip $table — already holds $current row(s)"
  fi
done < "$DIR/row-counts.csv"

[ ${#PENDING[@]} -gt 0 ] || { echo "Nothing to restore."; exit 0; }

while [ ${#PENDING[@]} -gt 0 ]; do
  BLOCKED=()
  PROGRESS=0

  for table in "${PENDING[@]}"; do
    if psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -q \
         -c "\\copy \"$table\" FROM '$DIR/tables/$table.csv' CSV HEADER" >/dev/null 2>&1; then
      loaded=$(psql "$DIRECT_URL" -Atc "SELECT count(*) FROM \"$table\"")
      printf '  %-34s %s\n' "$table" "$loaded"
      PROGRESS=1
    else
      BLOCKED+=("$table")
    fi
  done

  if [ "$PROGRESS" -eq 0 ]; then
    echo "Could not restore: ${BLOCKED[*]}"
    echo "Nothing was left half-done — each table loads whole or not at all."
    exit 1
  fi
  PENDING=("${BLOCKED[@]+"${BLOCKED[@]}"}")
done

echo "✓ Restored."
