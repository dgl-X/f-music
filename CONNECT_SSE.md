# SSE для Family Music Connect

## Назначение

SSE уведомляет клиентов об изменениях, сокращая ожидание следующего polling.
Это не аудиопоток и не отдельный источник состояния плеера. Для использования
нужны общий и персональный Connect и `MUSIC_CONNECT_EVENTS_ENABLED=true`.
Значение флага по умолчанию — `false`.

## Протокол

Авторизованный `GET /api/v1/connect/events?device_id=<registered-device-id>`
возвращает `text/event-stream`, `retry: 1500` и события `resync` с пустым
JSON. Клиент перечитывает `/connect/commands` и `/connect/state`.

Проверяются аккаунт, сессия и её срок, принадлежность устройства, отзыв доступа
и персональная настройка. ID устройства не заменяет авторизацию.
Команды, очереди и названия песен в SSE не передаются.

Повторный сигнал допустим. После подключения нужна полная сверка состояния:
`Last-Event-ID` не является durable cursor. ACK, revision, playback epoch
и дедупликация остаются частью основного протокола Connect.

## Ограничения

- Контрольный resync — каждые 15 секунд; переподключение потока — через 5 минут.
- Доступ повторно проверяется перед сигналами; персональное отключение закрывает поток.
- Лимиты на процесс/аккаунт/устройство — 128/8/2; превышение возвращает 429.
- Медленные получатели отключаются без неограниченного накопления событий.
- Между API-процессами нет PostgreSQL LISTEN/NOTIFY; сохраняется периодическая сверка.
- WEB и Android используют reconnect с backoff и polling-fallback.
- Длительность SSE не входит в среднюю задержку обычных API-запросов.

## Reverse proxy

Приложение задаёт `X-Accel-Buffering: no`, `Cache-Control: private, no-store,
no-transform` и `Content-Encoding: identity`. На каждом proxy-хопе проверьте
буферизацию, сжатие и read timeout. Вложенный nginx может поглотить заголовок
управления буферизацией; при необходимости задайте `proxy_buffering off`
для SSE-маршрута явно. Тайм-аут должен превышать heartbeat с запасом.

## Проверки

```sh
node --test test/connect-events.test.js test/connect-http.test.js
CONNECT_TEST_DATABASE_URL=... npm run test:connect:integration
```

Используйте отдельную пустую тестовую БД. Для проверки внешнего тестового
proxy задайте `CONNECT_TEST_EVENTS_ORIGIN`, оставив API на `CONNECT_TEST_PORT`.
Интеграция проверяет доставку, повторы, ACK, fallback и reconnect; она не заменяет
проверку браузерного audio, Android Doze, Bluetooth и переходов Wi-Fi/LTE.
