# Резервное копирование и восстановление

Резервная копия Family Music должна храниться вне диска с рабочей нодой. Snapshot
VM удобен перед обновлением, но не заменяет отдельную копию на NAS, другом сервере
или съёмном носителе.

## Что сохранять

- PostgreSQL в формате custom dump;
- `storage/originals` и `storage/covers`;
- `.env` с правами доступа только для администратора;
- `storage/federation/identity.json`, если используется федерация.

Производные AAC из `storage/derived` можно построить повторно. Незавершённые
`storage/uploads/*.part` не требуется включать в долговременную копию.

## Создание точки

В репозитории находятся systemd unit и timer для [`scripts/backup.sh`](scripts/backup.sh).
Перед использованием задайте локальные пути через environment-файл и выполните
первый запуск вручную. Не добавляйте пароли, токены и реальные адреса в Git.

```bash
systemctl start family-music-backup.service
journalctl -u family-music-backup.service -n 100 --no-pager
```

Автоматический timer следует включать только после проверки первой точки:

```bash
systemctl enable --now family-music-backup.timer
systemctl list-timers family-music-backup.timer
```

## Проверка

Для каждой точки обязательно проверяйте контрольные суммы и читаемость архивов:

```bash
sha256sum -c SHA256SUMS
pg_restore --list database.dump >/dev/null
tar --list --zstd --file media.tar.zst >/dev/null
```

Периодически выполняйте пробное восстановление в отдельную БД и каталог. Наличие
файла резервной копии без такого теста не гарантирует возможность восстановления.

Автоматический smoke-тест принимает только пустую БД с суффиксом `_restoretest`
и временный путь `/tmp/family-music-restore-*`:

```bash
scripts/backup-restore-smoke.sh \
  /путь/к/точке/daily/2026-09-08_03-20-00 \
  'postgresql:///family_music_restoretest?host=/var/run/postgresql' \
  /tmp/family-music-restore-check
```

Он проверяет SHA-256, читаемость dump и media-архива, восстанавливает PostgreSQL,
сверяет наличие пользователей и треков, проверяет чтение аудиофайла по
восстановленному `storage_key` и после завершения удаляет извлечённые медиафайлы.
Целевую тестовую БД скрипт намеренно не удаляет.

Контрольный прогон 8 сентября 2026 года восстановил отдельную точку с 10 000
тестовых треков и очередью из 10 000 ID. Планировщик backup при проверке не
включался.

## Восстановление

1. Остановите API и worker.
2. Не распаковывайте архив поверх рабочей медиатеки без snapshot или отдельной
   копии повреждённого состояния.
3. Восстановите дамп сначала во временную PostgreSQL-базу и проверьте его.
4. Восстановите оригиналы, обложки, `.env` и federation identity.
5. Верните владельца файлов `family-music:family-music` и права каталогов `0750`.
6. Запустите worker и API, затем проверьте health, вход и Range-воспроизведение.

```bash
systemctl start family-music-worker.service family-music.service
curl --fail http://127.0.0.1:8095/api/v1/health
```

Восстановление рабочей БД и замена медиатеки являются разрушительными операциями;
точные имена БД и пути выбирает администратор конкретной установки.
