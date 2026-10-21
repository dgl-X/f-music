import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadLegacySqlite} from '../scripts/sqlite-migration-loader.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fm-legacy-tool-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'package.json'),'{}');return root;
}
test('legacy migration explains a missing optional dependency without loading root dependencies',t=>{
  const root=fixture(t);
  assert.throws(()=>loadLegacySqlite(path.join(root,'package.json')),error=>error.code==='sqlite_migration_dependency_missing'&&error.message.includes('npm ci --prefix tools/sqlite-migration'));
  const module=path.join(root,'node_modules','better-sqlite3');fs.mkdirSync(module,{recursive:true});
  fs.writeFileSync(path.join(module,'index.js'),'module.exports = class WrongAncestorSqlite {};');
  const child=path.join(root,'tool');fs.mkdirSync(child);fs.writeFileSync(path.join(child,'package.json'),'{}');
  assert.throws(()=>loadLegacySqlite(path.join(child,'package.json')),error=>error.code==='sqlite_migration_dependency_missing');
});
test('legacy loader uses the isolated tool module and preserves actual load failures',t=>{
  const root=fixture(t),module=path.join(root,'node_modules','better-sqlite3');fs.mkdirSync(module,{recursive:true});
  fs.writeFileSync(path.join(module,'index.js'),'module.exports = class LegacySqlite {};');
  assert.equal(loadLegacySqlite(path.join(root,'package.json')).name,'LegacySqlite');
  const broken=fixture(t),bad=path.join(broken,'node_modules','better-sqlite3');fs.mkdirSync(bad,{recursive:true});
  fs.writeFileSync(path.join(bad,'index.js'),'throw Object.assign(new Error("native ABI fixture"),{code:"ERR_DLOPEN_FAILED"});');
  assert.throws(()=>loadLegacySqlite(path.join(broken,'package.json')),error=>error.code==='ERR_DLOPEN_FAILED');
});
