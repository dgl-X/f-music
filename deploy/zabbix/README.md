# Метрики Family Music для Zabbix

API отдаёт ограниченный набор эксплуатационных показателей по адресу
`/api/v1/metrics/zabbix`. Личные данные, адреса узлов и ключи в ответ не входят.

1. Задайте случайный `MUSIC_METRICS_TOKEN` в `/opt/family-music/.env`.
2. Запишите только значение токена в `/etc/zabbix/family-music.token` с правами
   `root:zabbix 0640`.
3. Установите `family-music-metrics` в `/usr/local/bin/` с правами `0755`.
4. Установите `family-music.conf` в каталог `zabbix_agent2.d` и перезапустите
   `zabbix-agent2`.
5. Импортируйте `template_family_music.yaml` и привяжите шаблон
   `Family Music by Zabbix agent` к хосту. Шаблон рассчитан на Zabbix 7.0+
   и создаёт один master-item, dependent items и основные триггеры.

Проверить получение JSON от имени агента можно до импорта шаблона:

```bash
sudo -u zabbix /usr/local/bin/family-music-metrics
zabbix_agent2 -t familymusic.metrics
```

Для числовых dependent items можно использовать JSONPath, например:

- `$.worker.age_seconds` — возраст heartbeat worker;
- `$.api.errors_5xx` — число HTTP 5xx после запуска API;
- `$.api.memory_rss_bytes` — RSS процесса API;
- `$.summary.new_reports` — новые диагностические отчёты;
- `$.federation.peers_offline` — недоступные федеративные узлы;
- `$.federation.incoming_streams` и `$.federation.outgoing_streams` — текущие потоки.

Токен нельзя добавлять в Git или непосредственно в UserParameter: он хранится
в отдельном закрытом файле и может быть отозван заменой значения на сервере.

Шаблон только читает метрики и ничего не меняет на сервере. Настройка резервного
копирования с ним не связана; `family-music-backup.timer` остаётся выключенным,
пока администратор не включит его вручную.
