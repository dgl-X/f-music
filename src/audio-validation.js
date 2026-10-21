import { runMediaProcess } from './media-process.js';

export function validateDecodedDuration(expectedSeconds, decodedSeconds) {
  const expected=Number(expectedSeconds)||0,decoded=Number(decodedSeconds)||0;
  if(decoded<=0)return false;
  if(expected<=0)return true;
  const tolerance=Math.max(1,expected*.1);
  return expected-decoded<=tolerance;
}

export async function validateAudioDecode(filename, expectedSeconds, options = {}) {
  const result=await runMediaProcess('ffmpeg',['-v','error','-xerror','-i',filename,'-map','0:a:0','-f','null','-','-progress','pipe:1','-nostats'],options);
  if(result.error)throw Object.assign(new Error(`Не удалось декодировать аудио: ${result.error}`),{code:`media_${result.error}`});
  let decodedSeconds=0;
  for(const match of result.stdout.matchAll(/^out_time_us=(\d+)$/gm))decodedSeconds=Math.max(decodedSeconds,Number(match[1])/1_000_000);
  return {valid:result.code===0&&validateDecodedDuration(expectedSeconds,decodedSeconds),decodedSeconds,exitCode:result.code};
}
