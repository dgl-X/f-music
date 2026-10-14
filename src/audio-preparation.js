import fs from 'node:fs';
import { inspectAudio as inspectDefault } from './media-tools.js';
import { normalizeHybridFlac as normalizeDefault } from './audio-normalization.js';
import { validateAudioDecode as validateDefault } from './audio-validation.js';
import { audioCodec as codecDefault } from './audio-compatibility.js';

const FORMATS=new Set(['mp3','flac','ogg','opus','aac','m4a','mp4','wav']);
const invalid=(message,code)=>Object.assign(new Error(message),{code});

// Both upload and federation import use the same validation/repair contract.
// The caller owns the uploaded source; cleanup touches only our derivative.
export async function prepareAudio(source,options={}) {
  const {inspectAudio=inspectDefault,normalizeHybridFlac=normalizeDefault,validateAudioDecode=validateDefault,audioCodec=codecDefault}=options;
  const sourceMetadata=Object.hasOwn(options,'sourceMetadata')?options.sourceMetadata:await inspectAudio(source);
  const normalization=await normalizeHybridFlac(source);
  const cleanup=()=>{if(normalization.normalized)fs.rmSync(normalization.output,{force:true});};
  try{
    const playbackSource=normalization.normalized?normalization.output:source;
    const metadata=normalization.normalized?await inspectAudio(playbackSource):sourceMetadata;
    if(!metadata||!String(metadata.format_name||'').split(',').some(name=>FORMATS.has(name)))throw invalid('Файл не распознан как аудио','audio_unrecognized');
    if(normalization.normalized&&audioCodec(metadata)!=='flac')throw invalid('Подготовленный вариант не распознан как FLAC','audio_invalid_variant');
    const validation=await validateAudioDecode(playbackSource,metadata.duration);
    if(!validation.valid)throw invalid('Аудиофайл повреждён или обрезан','audio_invalid');
    return {...normalization,metadata:{...metadata,duration:Number(metadata.duration)||validation.decodedSeconds||null},sourceMetadata,playbackSource,cleanup};
  }catch(error){cleanup();throw error;}
}
