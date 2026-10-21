import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {javascriptFiles,checkSyntax} from '../scripts/check-syntax.mjs';

test('syntax checker covers js and mjs recursively without executing modules',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fm-syntax-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'public'));
  fs.writeFileSync(path.join(root,'public','module.mjs'),'throw new Error("must not execute");');
  fs.writeFileSync(path.join(root,'script.js'),'const valid = 1;');fs.writeFileSync(path.join(root,'ignore.txt'),'not javascript');
  fs.mkdirSync(path.join(root,'node_modules'));fs.writeFileSync(path.join(root,'node_modules','ignored.mjs'),'invalid dependency syntax !');
  const files=javascriptFiles(root);assert.equal(files.length,2);assert.equal(checkSyntax(files),2);
  fs.writeFileSync(path.join(root,'public','module.mjs'),'export const broken = ;');
  assert.throws(()=>checkSyntax(files),/Syntax error:/);
});
