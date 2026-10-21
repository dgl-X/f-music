# Старый перенос SQLite → PostgreSQL

Необязательный инструмент для старых установок Family Music. Рабочий сервер
и DEB используют PostgreSQL и не устанавливают SQLite-драйвер.

Нужен Node.js 24; при отсутствии готового native binary понадобятся средства
сборки C/C++ и Python. Из корня исходного репозитория:

```sh
npm ci
npm ci --prefix tools/sqlite-migration
DATABASE_URL='postgresql:///migration_test?host=/var/run/postgresql' \
  npm run migrate:postgres -- /absolute/path/to/old-music.db
```

Сначала сделай копию исходной SQLite-БД и запускай на отдельной PostgreSQL-БД.
Скрипт читает SQLite в readonly, создаёт целевую схему и переносит прежний набор
таблиц в транзакции; конфликты пропускаются. Это старый импортёр, а не способ
объединять две произвольные современные библиотеки. Его поведение не расширено
этим разделением зависимостей.

`tools/sqlite-migration/node_modules` устанавливается отдельно, не попадает
в DEB, не нужен при запуске API/worker и не используется ими как запасная БД.
Без установки инструмента команда выдаёт инструкцию, а не подключается к серверу.

Изолированная проверка с синтетическим SQLite-файлом (не входит в обычный CI):

```sh
LEGACY_MIGRATION_TEST_URL='postgresql:///fm_legacy_test_local?host=/var/run/postgresql' \
  npm run test:integration --prefix tools/sqlite-migration
```

БД должна быть пустой и иметь имя `fm_legacy_test_*`. Проверяются перенос,
повторный запуск, лайки/плейлист/история и неизменность исходного SQLite-файла.
