# Спецификация экспериментальной закрытой федерации Family Music

Статус: **experimental**, протокол 1.0. Базовый pairing, delta/notify, объединённый
каталог, Range-прокси и локальный импорт реализованы, но совместимость пока не
гарантируется за пределами явно документированного federation v1. Режим рассчитан
только на вручную сопряжённые доверенные домашние ноды и не является публичной
федерацией.

Пошаговый план внедрения и правила rolling upgrade вынесены в [`FEDERATION_IMPLEMENTATION.md`](FEDERATION_IMPLEMENTATION.md).

## Цель и границы

Независимые серверы вручную устанавливают доверие и открывают друг другу выбранную музыку. Пользователь входит только на домашний сервер; Android и WEB не подключаются к чужому узлу напрямую. Лайки, история, рекомендации, очередь, плейлисты, устройства и отчёты остаются локальными.

В v1 входят pairing, синхронизация метаданных, объединённый поиск, прокси-поток, удалённые ссылки в очередях/плейлистах, отзыв доверия и аудит. Публичного каталога узлов, глобальных аккаунтов, автоматического копирования файлов и relay в v1 нет.

## Идентичность и адрес

При включении федерации инстанция создаёт Ed25519-ключ. Закрытый ключ никогда не покидает сервер.

```text
node_id = "fm1_" + base32(sha256(raw_ed25519_public_key))[0:32]
трек    = fm://{node_id}/track/{uuid}
```

Домен не является идентификатором. У одного `node_id` может быть сменяемый список точных endpoint:

- `https://music.example.org`;
- `https://203.0.113.25:8443` для белого IP без домена;
- `https://10.23.45.67:8096` только после явного разрешения конкретного private endpoint.

Для IP подходит автоматически обновляемый сертификат публичного CA на IP. Альтернатива — локальный сертификат с закреплённым в приглашении SHA-256 отпечатком SPKI. HTTP запрещён, кроме development на loopback. Смена адреса подтверждается старым Ed25519-ключом либо вручную со сверкой прежнего `node_id`.

## Обнаружение

`GET /.well-known/family-music` возвращает версии, node ID, публичный ключ, federation base и capabilities. Документ не создаёт доверия: ключ обязан совпасть с приглашением или ранее закреплённым ключом.

```json
{"protocol":"family-music-federation","versions":["1"],"node_id":"fm1_abcd...","name":"Домашняя музыка","public_key":"base64url","federation_base":"https://203.0.113.25:8443/federation/v1","capabilities":["catalog_delta","range_stream","covers"]}
```

## Pairing

Администратор создаёт одноразовое приглашение на 15 минут. Оно передаётся QR, файлом или через доверенный мессенджер и содержит `invite_id`, 256-bit secret, node ID, публичный ключ, endpoint, необязательный TLS SPKI pin и срок.

1. B проверяет HTTPS, pin, срок и node ID A.
2. B вызывает подписанный `POST /federation/v1/pairing/accept`, дополнительно доказывая знание secret.
3. A сохраняет B как `pending_approval`.
4. Администратор A сверяет отпечаток и выбирает export policy.
5. После двустороннего подтверждения peer становится `active`.

Знания URL или secret недостаточно без закрытого ключа B. Новый peer по умолчанию не получает каталог.

## Подписи запросов

Используем HTTP Message Signatures RFC 9421 с Ed25519 и `Content-Digest: sha-256` по RFC 9530. Подписываются:

```text
@method @authority @path @query content-digest
x-fm-node x-fm-request-id x-fm-nonce
```

`Signature-Input` содержит `created`, `expires` не более 60 секунд и `keyid=node_id`. Допустимый clock skew — 90 секунд. Nonce атомарно принимается один раз и хранится 5 минут. Ответ подписывается и содержит тот же request ID.

## Разрешения

Policy независима для каждого направления. Область: `none`, `all`, выбранные `albums` или специальные `collections`. Возможности задаются отдельно:

Текущая экспериментальная реализация поддерживает `none`, `all` и выбранные
`albums` как общую исходящую политику ноды. Индивидуальные правила для каждого
peer и `collections` остаются следующим совместимым расширением.

```json
{"catalog":true,"covers":true,"stream":true,"max_streams":2,"allow_original":false,"allowed_variants":["aac_192","aac_96"]}
```

Изменение policy создаёт новую export revision и tombstone для потерявших доступ объектов. Фильтрация выполняется SQL origin до формирования ответа.

## API v1

```text
POST /federation/v1/pairing/accept
GET  /federation/v1/node
GET  /federation/v1/health
GET  /federation/v1/catalog/delta?cursor=&limit=
GET  /federation/v1/tracks/{id}
GET  /federation/v1/tracks/{id}/cover
GET  /federation/v1/tracks/{id}/stream?variant=aac_192
```

Обложка и аудиопоток доступны только сопряжённой ноде с корректной Ed25519-подписью. При локальном импорте worker сначала извлекает встроенную картинку из оригинала, а при её отсутствии загружает опубликованную JPEG-обложку с origin с лимитом 12 МиБ.

JSON содержит `protocol_version`, `request_id`, `generated_at`. Максимальный `limit` — 500. Неизвестная major-версия получает `426`.

## Синхронизация

Origin ведёт монотонную revision экспортируемых upsert/delete. Cursor непрозрачен и привязан к peer и policy. Удалённый ключ объекта — `(origin_node_id, remote_id)`. `federated_tracks` является локальным индексом, а origin остаётся источником истины.

Worker синхронизирует peer примерно раз в 5 минут с jitter и backoff. При утрате истории изменений origin отвечает `409 cursor_reset_required`, после чего индекс пересобирается страницами. Ошибка peer не блокирует локальную библиотеку или другие узлы.

## Поиск и локальные действия

Результат явно содержит `origin=local` либо `origin=remote`, `origin_node_id` и имя сервера. Лайк и добавление удалённого трека в плейлист сохраняют локальную ссылку. При недоступности или отзыве ссылка остаётся видимой с причиной, но не воспроизводится.

## Аудио и кэш

```text
Android/WEB -> домашний /api/v1 -> подписанный /federation/v1 -> origin
```

Обязательны Range, `206`, `Content-Range`, `Accept-Ranges`, корректный `416` и неизменяемый ETag варианта. Redirect origin автоматически не выполняется. В первой версии разрешаем AAC 192/96; оригинал — отдельным permission.

Кэш имеет отдельный namespace origin/track, общий и per-peer LRU-лимит. По умолчанию сохраняются временные диапазоны, не постоянный импорт. После revoke новые чтения блокируются, кэш планируется к очистке. Таймауты: connect 5 с, first byte 10 с, idle 30 с. Повторные ошибки включают circuit breaker.

## Сети без домена

- **Статический белый IP:** полноценный endpoint `https://IP:port`; домен не нужен.
- **Динамический белый IP:** подписанное обновление endpoint. Позднее возможен directory, хранящий только подписанный адрес, без каталога и аудио.
- **Private IP/VPN:** по умолчанию SSRF-блокировка; администратор разрешает ровно один IP и порт. Разрешение `10.23.45.67:8096` не открывает `10.0.0.0/8`.
- **CGNAT без входящего порта:** не входит в v1. В будущем — WireGuard/Tailscale либо отдельный исходящий relay с новой моделью угроз.

## Таблицы

- `federation_identity`, `federation_peers`, `federation_endpoints`;
- `federation_invites`, `federation_export_policies`;
- `federation_changes`, `federation_sync_state`, `federation_nonces`;
- `federated_tracks`, `federated_track_artists`, `federated_albums`;
- `federation_audit_log`.

Все функции отключены при `FEDERATION_ENABLED=false`.

## Модель угроз

- SSRF: только закреплённые scheme/host/IP/port; redirect запрещён; DNS не может переключиться в private/link-local диапазон.
- Replay: короткий срок подписи, nonce и request ID.
- Подмена: TLS/pin, Ed25519, Content-Digest для JSON, ETag и длина для Range.
- Компрометация peer: deny by default, rate/size/stream limits; peer не получает cookie и пароли пользователей.
- Отзыв: `revoked` проверяется до sync и выдачи файла; ключ нельзя заменить молча.
- DoS: bounded JSON, limit 500, worker queue, backoff и circuit breaker.
- Аудит не хранит secret, cookie, аудиобайты и закрытые ключи.

## Этапы

1. Feature flag, identity, миграции, endpoint validator и тестовые векторы RFC 9421.
2. Pairing, двустороннее подтверждение, WEB-панель, revoke и аудит.
3. Второй изолированный экземпляр на отдельной VM: собственные пользователь ОС, БД, каталог и localhost-порт.
4. Export policy, revision log, cursor/delta, tombstone и worker sync.
5. Объединённый поиск и обозначение origin.
6. Подписанный Range endpoint, домашний proxy, AAC policy, LRU и circuit breaker.
7. Удалённые ссылки в очередях, лайках и плейлистах.
8. Тесты домена, белого/private IP, смены адреса, revoke, replay, clock skew, DNS rebinding и недоступности.
9. Простая инструкция: single-node остаётся режимом по умолчанию, федерация включается отдельно.

Каждый этап выпускается отдельно и остаётся совместимым с уже подключённой нодой. Одновременное обновление peer не требуется.

## Критерии готовности

- два узла работают без общей учётной записи;
- белый IP без домена поддерживается;
- до явного policy не экспортируется ничего;
- удалённый трек ищется и играет через Range-прокси;
- локальная музыка работает при выключенном peer;
- revoke блокирует sync/stream немедленно;
- replay, подмена endpoint/ключа и SSRF отклоняются тестами;
- Android не хранит межсерверные ключи и не соединяется с origin.

## Отложено

Relay для CGNAT, постоянный импорт чужого файла, публичная discovery-сеть, окончательные лимиты кэша и более мелкая гранулярность экспорта.

## Нормативная база

- [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421.html) — HTTP Message Signatures;
- [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530.html) — Digest Fields;
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) — HTTP Semantics/Range;
- [Let's Encrypt: IP certificates](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html) — публичные короткоживущие сертификаты на IP;
- Ed25519 — ключи узлов.
