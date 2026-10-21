#!/usr/bin/env bash
set -Eeuo pipefail
# NOT a production deployment command. Only a fresh disposable machine.
[[ "${FM_PACKAGE_SMOKE_ALLOW_SYSTEM_CHANGES:-}" == disposable ]] || { echo 'Refusing system changes: disposable-machine opt-in required' >&2; exit 2; }
[[ $# == 2 ]] || { echo 'Usage: ci-deb-smoke.sh baseline.deb candidate.deb' >&2; exit 2; }
[[ $EUID == 0 ]] || { echo 'Run as root on a disposable machine' >&2; exit 2; }
[[ ! -e /opt/family-music/.env && ! -e /opt/family-music/storage ]] || { echo 'Refusing an existing application/data directory' >&2; exit 2; }
FM_BASELINE=$(readlink -f "$1")
FM_CANDIDATE=$(readlink -f "$2")
for FM_DEB in "$FM_BASELINE" "$FM_CANDIDATE"; do [[ $(dpkg-deb -f "$FM_DEB" Package) == family-music-server ]]; done
dpkg --compare-versions "$(dpkg-deb -f "$FM_CANDIDATE" Version)" gt "$(dpkg-deb -f "$FM_BASELINE" Version)"
FM_ROOT=$(cd "$(dirname "$0")/.." && pwd)
FM_WORK=$(mktemp -d /tmp/fm-package-smoke.XXXXXX)
chmod 0755 "$FM_WORK"
FM_RESTORE_DB="fm_package_restore_test_$$"
FM_RESTORE_CREATED=0
cleanup(){
  if [[ $FM_RESTORE_CREATED == 1 ]]; then runuser -u postgres -- dropdb "$FM_RESTORE_DB"; fi
  rm -r -- "$FM_WORK"
}
trap cleanup EXIT
# The service user must not need access to the runner's private checkout directory.
install -m 0644 "$FM_ROOT/scripts/package-fixture.mjs" "$FM_WORK/package-fixture.mjs"
install -m 0755 "$FM_ROOT/scripts/backup.sh" "$FM_WORK/backup.sh"
export DEBIAN_FRONTEND=noninteractive
apt-get install --yes "$FM_BASELINE" zstd
install -d -o family-music -g family-music -m 0700 "$FM_WORK/state" "$FM_WORK/backup"
check_runtime(){
  systemctl is-active --quiet postgresql family-music family-music-worker
  /opt/family-music/runtime/bin/node --input-type=module -e '
    const response=await fetch("http://127.0.0.1:8095/api/v1/health");
    const body=await response.json();
    if(!response.ok||body.status!=="ok"||body.database!=="ok"||body.storage!=="ok")throw Error("Package health failed");'
  ffmpeg -version >/dev/null
  ffprobe -version >/dev/null
  FM_AUDIT=$(dpkg --audit)
  [[ -z "$FM_AUDIT" ]] || { printf '%s\n' "$FM_AUDIT"; return 1; }
}
fixture(){
  (cd "$FM_WORK"; runuser -u family-music -- env "DATABASE_URL=postgresql:///${1}?host=/var/run/postgresql" \
    /opt/family-music/runtime/bin/node "$FM_WORK/package-fixture.mjs" "$2" "$FM_WORK/state/snapshot.json")
}
check_runtime
fixture family_music seed
apt-get install --yes "$FM_CANDIDATE"
check_runtime
[[ $(dpkg-query -W -f='${Version}' family-music-server) == "$(dpkg-deb -f "$FM_CANDIDATE" Version)" ]]
[[ ! -d /opt/family-music/node_modules/fake-indexeddb ]]
[[ ! -d /opt/family-music/node_modules/better-sqlite3 ]]
fixture family_music verify
systemctl restart family-music family-music-worker
check_runtime
fixture family_music verify
(cd "$FM_WORK"; runuser -u family-music -- env FAMILY_MUSIC_APP_DIR=/opt/family-music FAMILY_MUSIC_BACKUP_DIR="$FM_WORK/backup" bash "$FM_WORK/backup.sh")
FM_BACKUP=$(find "$FM_WORK/backup/daily" -mindepth 1 -maxdepth 1 -type d)
[[ -n "$FM_BACKUP" && -f "$FM_BACKUP/database.dump" ]]
(cd "$FM_BACKUP" && sha256sum -c SHA256SUMS)
runuser -u postgres -- createdb -O family-music "$FM_RESTORE_DB"
FM_RESTORE_CREATED=1
runuser -u postgres -- pg_restore --exit-on-error -d "$FM_RESTORE_DB" < "$FM_BACKUP/database.dump"
fixture "$FM_RESTORE_DB" verify
mkdir "$FM_WORK/restored-media"
tar --extract --zstd --file="$FM_BACKUP/media.tar.zst" --directory="$FM_WORK/restored-media"
for FM_FILE in originals/package-fixture.mp3 covers/package-fixture.png albums/package-fixture.png federation/replicas/package-fixture.mp3 derived/normalized_flac/package-fixture.flac; do cmp "/opt/family-music/storage/$FM_FILE" "$FM_WORK/restored-media/$FM_FILE"; done
cmp /opt/family-music/.env "$FM_BACKUP/app.env"
# Also exercise the candidate's fresh-install branches, not just its upgrade path.
# Only the synthetic DB/storage created above are removed; initial existing data is refused.
systemctl stop family-music family-music-worker
apt-get remove --yes family-music-server
mv /opt/family-music/.env "$FM_WORK/upgrade.env"
mv /opt/family-music/storage "$FM_WORK/upgrade-storage"
runuser -u postgres -- dropdb family_music
apt-get install --yes "$FM_CANDIDATE"
check_runtime
[[ ! -d /opt/family-music/node_modules/better-sqlite3 ]]
fixture family_music seed
fixture family_music verify
echo 'DEB: candidate fresh install, baseline upgrade, restart, retained data and actual backup restore OK'
