#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { localForbiddenTerms, publishedTestVectors, secretPatterns } from './secret-scan-rules.mjs';

function git(args, options = {}) {
  const encoding = Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8';
  const result = spawnSync('git', args, { encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.toString() || `git ${args.join(' ')}: код ${result.status}`);
  return result.stdout;
}

const commits = git(['rev-list', '--all']).trim().split('\n').filter(Boolean);
const blobs = new Map();
for (const commit of commits) {
  const entries = git(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (match && !blobs.has(match[1])) blobs.set(match[1], { commit, path: match[2] });
  }
}

const termsFile = localForbiddenTerms();
const forbidden = termsFile && fs.existsSync(termsFile)
  ? fs.readFileSync(termsFile, 'utf8').split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'))
  : [];
const findings = [];
let checked = 0;
function inspectText(text, source, allowPublishedVector = false) {
  for (const value of forbidden) if (text.includes(value)) findings.push({ ...source, label: 'локальное запрещённое значение' });
  for (const [label, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text) && !(label === 'приватный ключ' && allowPublishedVector)) findings.push({ ...source, label });
  }
}

for (const [object, source] of blobs) {
  const size = Number(git(['cat-file', '-s', object]).trim());
  if (!Number.isSafeInteger(size) || size > 2 * 1024 * 1024) continue;
  const bytes = git(['cat-file', 'blob', object], { encoding: null });
  if (bytes.includes(0)) continue;
  checked++;
  const text = bytes.toString('utf8');
  inspectText(text, source, publishedTestVectors.has(source.path));
}

for (const commit of commits) inspectText(git(['cat-file', 'commit', commit]), { commit, path: '[commit metadata/message]' });
const tags = git(['for-each-ref', '--format=%(objectname) %(objecttype)', 'refs/tags']).trim().split('\n').filter(Boolean);
for (const entry of tags) {
  const [object, type] = entry.split(' ');
  if (type === 'tag') inspectText(git(['cat-file', 'tag', object]), { commit: object, path: '[annotated tag metadata/message]' });
}

if (findings.length) {
  console.error(`В истории найдены потенциальные секреты: ${findings.length}`);
  for (const finding of findings) console.error(`${finding.commit.slice(0, 12)} ${finding.path}: ${finding.label}`);
  process.exit(1);
}
console.log(`Проверено commits: ${commits.length}, tags: ${tags.length}, уникальных текстовых blobs: ${checked}. Потенциальных секретов не найдено.`);
