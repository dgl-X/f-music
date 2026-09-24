import { spawn } from 'node:child_process';

export function validateDecodedDuration(expectedSeconds, decodedSeconds) {
  const expected=Number(expectedSeconds)||0,decoded=Number(decodedSeconds)||0;
  if(decoded<=0)return false;
  if(expected<=0)return true;
  const tolerance=Math.max(1,expected*.1);
  return expected-decoded<=tolerance;
}

export function validateAudioDecode(filename, expectedSeconds) {
  return new Promise(resolve=>{
    const process=spawn('ffmpeg',['-nostdin','-v','error','-xerror','-i',filename,'-map','0:a:0','-f','null','-','-progress','pipe:1','-nostats']);
    let progress='';process.stdout.on('data',chunk=>{progress+=chunk;});
    const finish=code=>{
      const values=[...progress.matchAll(/^out_time_us=(\d+)$/gm)].map(match=>Number(match[1])/1_000_000);
      const decodedSeconds=values.length?Math.max(...values):0;
      resolve({valid:code===0&&validateDecodedDuration(expectedSeconds,decodedSeconds),decodedSeconds,exitCode:code});
    };
    process.once('error',()=>resolve({valid:false,decodedSeconds:0,exitCode:null}));
    process.once('close',finish);
  });
}
