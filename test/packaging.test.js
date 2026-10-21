import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('package installation smoke refuses system changes without explicit disposable opt-in',()=>{
  const result=spawnSync('bash',['scripts/ci-deb-smoke.sh','missing.deb','missing.deb'],{encoding:'utf8',env:{...process.env,FM_PACKAGE_SMOKE_ALLOW_SYSTEM_CHANGES:''}});
  assert.equal(result.status,2);assert.match(result.stderr,/Refusing system changes/);
});
test('package installation smoke rejects missing arguments before touching the host',()=>{
  const result=spawnSync('bash',['scripts/ci-deb-smoke.sh'],{encoding:'utf8',env:{...process.env,FM_PACKAGE_SMOKE_ALLOW_SYSTEM_CHANGES:'disposable'}});
  assert.equal(result.status,2);assert.match(result.stderr,/Usage:/);
});
