import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const postinst = fs.readFileSync(new URL('../packaging/postinst', import.meta.url), 'utf8');
const lxcSmoke = fs.readFileSync(new URL('../scripts/deb-lxc-smoke.sh', import.meta.url), 'utf8');
const workerUnit = fs.readFileSync(new URL('../deploy/family-music-worker.service', import.meta.url), 'utf8');

test('DEB creates an isolated PostgreSQL role and database', () => {
  assert.match(postinst, /createuser --no-createdb --no-createrole --no-superuser family-music/);
  assert.match(postinst, /createdb --owner=family-music family_music/);
});

test('DEB starts services on a fresh install and restarts them on update', () => {
  assert.doesNotMatch(postinst, /try-restart/);
  assert.match(postinst, /deb-systemd-invoke restart family-music\.service family-music-worker\.service/);
  assert.match(postinst, /systemctl restart family-music\.service family-music-worker\.service/);
  assert.match(postinst, /127\.0\.0\.1:8095\/api\/v1\/health/);
  assert.match(postinst, /Family Music API не прошёл health-check/);
  assert.match(workerUnit, /Requires=.*family-music\.service/);
  assert.match(workerUnit, /ExecStartPre=.*wait-for-api\.js/);
});

test('LXC smoke test covers reboot and persistent state', () => {
  assert.match(lxcSmoke, /pct reboot "\$CTID"/);
  assert.match(lxcSmoke, /lxc-smoke-preserved\.marker/);
  assert.match(lxcSmoke, /USERS_BEFORE/);
  assert.match(lxcSmoke, /USERS_AFTER/);
});
