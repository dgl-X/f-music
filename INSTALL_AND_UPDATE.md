# Установка, обновление и откат Family Music

Этот runbook предназначен для владельца домашней ноды и не содержит адресов,
доменов или секретов конкретной установки. Команды рассчитаны на Debian 13 или
совместимую систему, systemd, локальный PostgreSQL и отдельный nginx перед API.

## Схема одной ноды

```text
клиент -> HTTPS reverse proxy -> внутренний nginx:80
                              -> Node.js API:127.0.0.1:8095
                              -> PostgreSQL:127.0.0.1:5432
                              -> worker -> storage
```

API и worker используют один код, одну БД и один каталог хранения. Оригиналы,
обложки, производные файлы, `.env` и identity федерации не должны находиться в
Git. Публичный reverse proxy может располагаться на другой машине.

## 1. Системные зависимости

Для ручной установки нужны Node.js 24 или новее, PostgreSQL, nginx, FFmpeg и Chromaprint:

```bash
apt update
apt install -y postgresql nginx ffmpeg libchromaprint-tools git curl acl ca-certificates
node --version
ffmpeg -version
fpcalc -version
```

Если пакетный менеджер дистрибутива предлагает Node.js старее 24, Node.js надо
установить из поддерживаемого репозитория дистрибутива до продолжения.
DEB-пакет использует встроенный официальный Node.js 24 и от системного пакета
`nodejs` не зависит.

## 2. Пользователь, код и каталоги

```bash
useradd --system --home /opt/family-music --shell /usr/sbin/nologin family-music
git clone https://github.com/dgl-X/f-music.git /opt/family-music
cd /opt/family-music
npm ci --omit=dev
install -d -o family-music -g family-music -m 0750 storage
cp .env.example .env
chown root:family-music .env
chmod 0640 .env
```

Корнем проекта владеет `root`, а `family-music` получает запись только в
`storage`. Это не позволяет процессу приложения подменить собственный код или
прочитать настройки других сервисов.

## 3. PostgreSQL

Создайте отдельного пользователя и БД. Пароль генерируется локально и вместо
`СЛУЧАЙНЫЙ_ПАРОЛЬ` не должен попадать в shell history или Git:

```sql
CREATE ROLE family_music LOGIN PASSWORD 'СЛУЧАЙНЫЙ_ПАРОЛЬ';
CREATE DATABASE family_music OWNER family_music;
```

В `.env` задайте как минимум:

```text
MUSIC_HOST=127.0.0.1
MUSIC_PORT=8095
DATABASE_URL=postgresql://family_music:URL_ENCODED_PASSWORD@127.0.0.1/family_music
MUSIC_STORAGE_DIR=/opt/family-music/storage
MUSIC_SECURE_COOKIES=true
MUSIC_X_ACCEL_REDIRECT=true
```

Пароль внутри URL должен быть percent-encoded. Остальные настройки и их
назначение описаны в [`.env.example`](.env.example) и [`README.md`](README.md).
При первом старте схема создаётся автоматически под advisory lock, поэтому API
и worker могут запускаться одновременно.

## 4. systemd

```bash
install -o root -g root -m 0644 deploy/family-music.service /etc/systemd/system/
install -o root -g root -m 0644 deploy/family-music-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now family-music.service family-music-worker.service
systemctl is-active family-music.service family-music-worker.service
curl --fail http://127.0.0.1:8095/api/health
```

Для диагностики:

```bash
journalctl -u family-music.service -u family-music-worker.service -n 100 --no-pager
```

## 5. Внутренний nginx и X-Accel-Redirect

Скопируйте [`deploy/family-music.nginx`](deploy/family-music.nginx), замените
`REVERSE_PROXY_PRIVATE_IP` точным адресом доверенного reverse proxy и включите
конфигурацию обычным для дистрибутива способом.

Nginx нужны только чтение медиа и проход по родительским каталогам. Не следует
добавлять `www-data` в группу `family-music`, иначе nginx получит доступ к
`.env` и закрытой identity федерации.

```bash
setfacl -m u:www-data:--x /opt/family-music
setfacl -R -m u:www-data:rX /opt/family-music/storage/originals /opt/family-music/storage/derived /opt/family-music/storage/covers
setfacl -R -d -m u:www-data:rX /opt/family-music/storage/originals /opt/family-music/storage/derived /opt/family-music/storage/covers
nginx -t
systemctl reload nginx
```

Если какого-либо медиакаталога ещё нет, сначала создайте его от имени
`family-music`. Внешний reverse proxy настраивается по шаблону
[`deploy/edge-nginx.example`](deploy/edge-nginx.example). Между ним и внутренним
nginx порт должен быть доступен только из доверенной сети.

## 6. Первичная настройка

Откройте HTTPS-адрес ноды и создайте первого администратора. После появления
первого пользователя `/api/setup` блокируется, публичной регистрации нет.

Проверьте:

- вход и выход;
- загрузку небольшого MP3 или FLAC;
- появление метаданных после обработки worker;
- Range-воспроизведение и обложку;
- создание обычного пользователя администратором.

Только после этого подключайте Android и федерацию. Pairing выполняется через
настройки WEB; копировать identity или БД между двумя нодами нельзя.

## 7. Безопасное обновление

Перед каждым обновлением запишите текущий commit и сделайте snapshot VM. Если
snapshot недоступен, создайте дамп PostgreSQL и отдельную копию `.env` и
`storage`; подробности находятся в [`BACKUP.md`](BACKUP.md).

```bash
cd /opt/family-music
git status --short
git rev-parse HEAD
git fetch --prune origin
git log --oneline HEAD..origin/main
npm test
```

Если рабочее дерево содержит неожиданные изменения, обновление надо остановить,
а не стирать их. После просмотра списка изменений:

```bash
systemctl stop family-music.service family-music-worker.service
git merge --ff-only origin/main
npm ci --omit=dev
npm test
systemctl start family-music-worker.service family-music.service
curl --fail http://127.0.0.1:8095/api/health
systemctl is-active family-music.service family-music-worker.service
```

Затем проверьте WEB-вход, один локальный Range-запрос и административные метрики.
Для сопряжённых нод выполните:

```bash
runuser -u family-music -- node scripts/federation-stream-smoke.mjs
```

Обновляйте федеративные ноды по одной. Capability negotiation сохраняет базовую
совместимость новой и предыдущей версии; локальная библиотека не зависит от
доступности второй ноды.

## 8. Откат к предыдущему коду

Обычные миграции проекта добавляют таблицы и поля и рассчитаны на rolling
update. Поэтому для большинства неудачных релизов достаточно вернуть код и
зависимости, не восстанавливая БД и не трогая `storage`.

```bash
cd /opt/family-music
systemctl stop family-music.service family-music-worker.service
git switch --detach ПРЕДЫДУЩИЙ_COMMIT
npm ci --omit=dev
npm test
systemctl start family-music-worker.service family-music.service
curl --fail http://127.0.0.1:8095/api/health
```

После исправления можно вернуться на ветку и обновиться fast-forward:

```bash
git switch main
git merge --ff-only origin/main
```

БД следует восстанавливать только если release notes прямо сообщают о
несовместимой миграции или данные действительно повреждены. Это отдельная
операция из [`BACKUP.md`](BACKUP.md); распаковывать старое
хранилище поверх рабочего запрещено.

## 9. Проверка после перезагрузки VM

```bash
systemctl is-enabled family-music.service family-music-worker.service nginx postgresql
systemctl is-active family-music.service family-music-worker.service nginx postgresql
curl --fail http://127.0.0.1:8095/api/health
journalctl -u family-music.service -u family-music-worker.service --since boot --no-pager
```

Если настроен Zabbix Agent 2, установка master-item описана в
[`deploy/zabbix/README.md`](deploy/zabbix/README.md). Токен метрик и любые
сетевые адреса остаются только в локальной конфигурации ноды.

## Чего нельзя делать при обновлении

- удалять или заменять `.env`;
- удалять `storage`, особенно `originals` и `federation/identity.json`;
- запускать две ноды из клона одной БД или одной identity;
- делать `git reset --hard`, не разобрав локальные изменения;
- открывать порт Node.js или PostgreSQL напрямую в Интернет;
- считать snapshot единственной долговременной резервной копией.
