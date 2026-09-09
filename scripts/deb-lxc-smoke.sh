#!/bin/sh
set -eu

usage() {
  echo "Использование: $0 <VMID> <первый.deb> [обновление.deb]" >&2
  echo "ВНИМАНИЕ: скрипт устанавливает пакет и перезагружает указанный расходный LXC." >&2
  exit 2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage
CTID=$1
FIRST_DEB=$2
UPGRADE_DEB=${3:-}

case "$CTID" in *[!0-9]*|'') usage;; esac
[ -f "$FIRST_DEB" ] || { echo "Пакет не найден: $FIRST_DEB" >&2; exit 1; }
[ -z "$UPGRADE_DEB" ] || [ -f "$UPGRADE_DEB" ] || { echo "Пакет не найден: $UPGRADE_DEB" >&2; exit 1; }
command -v pct >/dev/null || { echo "Команда pct не найдена; запускайте скрипт на Proxmox VE" >&2; exit 1; }
[ "$(pct status "$CTID" | awk '{print $2}')" = running ] || { echo "LXC $CTID не запущен" >&2; exit 1; }

push_and_install() {
  package=$1
  remote="/root/$(basename "$package")"
  pct push "$CTID" "$package" "$remote"
  pct exec "$CTID" -- env DEBIAN_FRONTEND=noninteractive apt-get -qq install -y "$remote"
}

check_runtime() {
  pct exec "$CTID" -- systemctl is-active --quiet postgresql family-music family-music-worker
  pct exec "$CTID" -- /opt/family-music/runtime/bin/node -e \
    "const r=await fetch('http://127.0.0.1:8095/api/v1/health'); const b=await r.json(); if(!r.ok||b.status!=='ok'||b.database!=='ok'||b.storage!=='ok') process.exit(1)"
}

pct exec "$CTID" -- apt-get -qq update
push_and_install "$FIRST_DEB"
check_runtime

pct exec "$CTID" -- /opt/family-music/runtime/bin/node -e \
  "const base='http://127.0.0.1:8095'; const s=await (await fetch(base+'/api/v1/setup/status')).json(); if(s.needs_setup){const password=['lxc','upgrade','fixture'].join('-'); const r=await fetch(base+'/api/v1/setup',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({username:'lxcsmoke',display_name:'LXC smoke test',password})}); if(!r.ok) process.exit(1)}"
pct exec "$CTID" -- runuser -u family-music -- touch /opt/family-music/storage/lxc-smoke-preserved.marker
USERS_BEFORE=$(pct exec "$CTID" -- runuser -u postgres -- psql -d family_music -tAc 'SELECT count(*) FROM users')

if [ -n "$UPGRADE_DEB" ]; then
  push_and_install "$UPGRADE_DEB"
  check_runtime
fi

pct reboot "$CTID"
pct exec "$CTID" -- systemctl is-system-running --wait >/dev/null
check_runtime
pct exec "$CTID" -- test -f /opt/family-music/storage/lxc-smoke-preserved.marker
USERS_AFTER=$(pct exec "$CTID" -- runuser -u postgres -- psql -d family_music -tAc 'SELECT count(*) FROM users')
[ "$USERS_BEFORE" = "$USERS_AFTER" ] || { echo "Количество пользователей изменилось после обновления" >&2; exit 1; }

echo "DEB LXC smoke test passed (LXC $CTID, users preserved: $USERS_AFTER)"
