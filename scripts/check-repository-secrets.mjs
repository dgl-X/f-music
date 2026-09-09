#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { localForbiddenTerms, publishedTestVectors, secretPatterns } from './secret-scan-rules.mjs';

const listed=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'});
if(listed.status!==0)throw new Error(listed.stderr||'Не удалось получить список файлов Git');
const files=listed.stdout.split('\0').filter(Boolean),findings=[];
const termsFile=localForbiddenTerms();
const forbidden=termsFile&&fs.existsSync(termsFile)
  ? fs.readFileSync(termsFile,'utf8').split(/\r?\n/).map(value=>value.trim()).filter(value=>value&&!value.startsWith('#'))
  : [];
for(const file of files){
  if(!fs.existsSync(file)||fs.statSync(file).size>2*1024*1024)continue;
  const bytes=fs.readFileSync(file);if(bytes.includes(0))continue;
  const text=bytes.toString('utf8');
  for(const value of forbidden)if(text.includes(value))findings.push(`${file}: локальное запрещённое значение`);
  for(const [label,pattern] of secretPatterns)if(pattern.test(text)&&!(label==='приватный ключ'&&publishedTestVectors.has(file)))findings.push(`${file}: ${label}`);
}
if(findings.length){console.error(`Обнаружены потенциально личные данные:\n${findings.join('\n')}`);process.exit(1);}
console.log(`Проверено файлов: ${files.length}. Явных секретов и личных адресов не найдено.`);
