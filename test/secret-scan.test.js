import test from 'node:test';
import assert from 'node:assert/strict';
import { secretPatterns } from '../scripts/secret-scan-rules.mjs';

const assignmentPattern=secretPatterns.find(([label])=>label==='секрет в присваивании')[1];
const detected=value=>{assignmentPattern.lastIndex=0;return assignmentPattern.test(value);};

test('secret assignment scanner catches values but ignores JavaScript identifiers',()=>{
  const key=['pass','word'].join('');
  assert.equal(detected(`${key}="${'abcdefghijklmnopqrstuvwxyz'}1234"`),true);
  assert.equal(detected(`${key.toUpperCase()}=${'abcdefghijklmnopqrstuv'}_1234\n`),true);
  assert.equal(detected(`${key}:changedAccountSecret`),false);
  assert.equal(detected(`new_${key}:changedCredential})`),false);
});
