#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR="${FAMILY_MUSIC_APP_DIR:-/opt/family-music}"
BACKUP_DIR="${FAMILY_MUSIC_BACKUP_DIR:-/opt/family-music-backups}"
ENV_FILE="${FAMILY_MUSIC_ENV_FILE:-${APP_DIR}/.env}"
KEEP_DAILY="${FAMILY_MUSIC_KEEP_DAILY:-7}"
KEEP_WEEKLY="${FAMILY_MUSIC_KEEP_WEEKLY:-4}"

notify_failure() {
  local status=$?
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl --fail --silent --show-error --max-time 15 \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=Family Music: резервное копирование на $(hostname) завершилось ошибкой (код ${status})." \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null || true
  fi
  exit "$status"
}
trap notify_failure ERR

for command in pg_dump pg_restore tar zstd sha256sum flock; do
  command -v "$command" >/dev/null || { echo "Не найдена команда: $command" >&2; exit 1; }
done
[[ -r "$ENV_FILE" ]] || { echo "Не читается $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${DATABASE_URL:?DATABASE_URL не задан в $ENV_FILE}"
STORAGE_DIR="${MUSIC_STORAGE_DIR:-${APP_DIR}/storage}"
[[ -d "$STORAGE_DIR/originals" ]] || { echo "Нет $STORAGE_DIR/originals" >&2; exit 1; }

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { echo "Другая резервная копия уже выполняется" >&2; exit 1; }

stamp="$(date +%Y-%m-%d_%H-%M-%S)"
day="$(date +%F)"
week="$(date +%G-W%V)"
temporary="$BACKUP_DIR/.${stamp}.partial"
destination="$BACKUP_DIR/daily/${stamp}"
mkdir "$temporary"

pg_dump --format=custom --compress=6 --file="$temporary/database.dump" "$DATABASE_URL"
pg_restore --list "$temporary/database.dump" >/dev/null

include=()
for directory in originals covers federation; do
  [[ -d "$STORAGE_DIR/$directory" ]] && include+=("$directory")
done
# Один поток держит фоновую задачу лёгкой для небольшой VM.
tar --create --file=- --directory="$STORAGE_DIR" "${include[@]}" | zstd -3 -T1 -q -o "$temporary/media.tar.zst"
tar --list --zstd --file="$temporary/media.tar.zst" >/dev/null
install -m 600 "$ENV_FILE" "$temporary/app.env"

cat >"$temporary/manifest.txt" <<EOF
created_at=$(date --iso-8601=seconds)
host=$(hostname)
app_dir=$APP_DIR
storage_dir=$STORAGE_DIR
database_format=postgresql-custom
media=originals,covers,federation
EOF
(cd "$temporary" && sha256sum database.dump media.tar.zst app.env >SHA256SUMS)
mv "$temporary" "$destination"

# По воскресеньям сохраняем недельную точку. Hard links не занимают второй объём.
if [[ "$(date +%u)" == 7 && ! -e "$BACKUP_DIR/weekly/$week" ]]; then
  cp -al "$destination" "$BACKUP_DIR/weekly/$week"
fi

mapfile -t daily < <(find "$BACKUP_DIR/daily" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
for ((index=KEEP_DAILY; index<${#daily[@]}; index++)); do rm -rf -- "$BACKUP_DIR/daily/${daily[$index]}"; done
mapfile -t weekly < <(find "$BACKUP_DIR/weekly" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
for ((index=KEEP_WEEKLY; index<${#weekly[@]}; index++)); do rm -rf -- "$BACKUP_DIR/weekly/${weekly[$index]}"; done

echo "Backup complete: $destination"
