#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

if [[ $# -ne 3 ]]; then
  echo "Использование: $0 <каталог-backup> <DATABASE_URL_restoretest> <временный-каталог>" >&2
  exit 2
fi

backup_dir=$(realpath "$1")
database_url=$2
restore_dir=$(realpath -m "$3")

[[ -f "$backup_dir/database.dump" && -f "$backup_dir/media.tar.zst" && -f "$backup_dir/SHA256SUMS" ]] \
  || { echo "Точка backup неполна" >&2; exit 1; }
case "$restore_dir" in /tmp/family-music-restore-*) ;; *) echo "Каталог восстановления должен начинаться с /tmp/family-music-restore-" >&2; exit 2;; esac
[[ ! -e "$restore_dir" ]] || { echo "Каталог восстановления уже существует" >&2; exit 1; }

for command in psql pg_restore tar sha256sum; do
  command -v "$command" >/dev/null || { echo "Не найдена команда: $command" >&2; exit 1; }
done

database_name=$(psql "$database_url" -Atc 'SELECT current_database()')
[[ "$database_name" == *_restoretest ]] || { echo "Целевая БД должна оканчиваться на _restoretest" >&2; exit 2; }
existing_tables=$(psql "$database_url" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
[[ "$existing_tables" == 0 ]] || { echo "Целевая БД не пуста" >&2; exit 1; }

(cd "$backup_dir" && sha256sum -c SHA256SUMS)
pg_restore --list "$backup_dir/database.dump" >/dev/null
mkdir -p "$restore_dir"
trap 'rm -rf -- "$restore_dir"' EXIT INT TERM
tar --extract --zstd --file="$backup_dir/media.tar.zst" --directory="$restore_dir"
pg_restore --no-owner --no-privileges --dbname="$database_url" "$backup_dir/database.dump"

tracks=$(psql "$database_url" -Atc 'SELECT count(*) FROM tracks')
users=$(psql "$database_url" -Atc 'SELECT count(*) FROM users')
missing=$(psql "$database_url" -Atc "SELECT count(*) FROM tracks WHERE storage_key IS NULL OR storage_key='' ")
[[ "$tracks" -gt 0 && "$users" -gt 0 && "$missing" == 0 ]] || { echo "Восстановленная БД не прошла проверку" >&2; exit 1; }
[[ -d "$restore_dir/originals" ]] || { echo "В архиве нет originals" >&2; exit 1; }
sample_key=$(psql "$database_url" -Atc 'SELECT storage_key FROM tracks ORDER BY id LIMIT 1')
sample_file=$(realpath -m "$restore_dir/$sample_key")
case "$sample_file" in "$restore_dir"/*) ;; *) echo "storage_key выходит за пределы хранилища" >&2; exit 1;; esac
[[ -f "$sample_file" && -r "$sample_file" ]] || { echo "Восстановленный аудиофайл не читается" >&2; exit 1; }

printf 'Restore smoke complete: database=%s tracks=%s users=%s\n' "$database_name" "$tracks" "$users"
