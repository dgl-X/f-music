import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function javascriptFiles(root) {
  return fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(root,entry.name);
    return entry.isDirectory()?(entry.name==='node_modules'?[]:javascriptFiles(file)):entry.isFile()&&/\.(m?js)$/.test(entry.name)?[file]:[];
  }).sort();
}
export function checkSyntax(files) {
  for(const file of files){
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    if(result.error)throw result.error;
    if(result.status!==0)throw new Error(`Syntax error: ${file}\n${result.stderr}`);
  }
  return files.length;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const files=['src','public','scripts','test','tools'].flatMap(javascriptFiles);
  console.log(`Syntax OK: ${checkSyntax(files)} JavaScript files`);
}
