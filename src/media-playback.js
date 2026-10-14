const CODECS=new Set(['mp3','aac','flac','alac','opus','vorbis','pcm_u8','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_f64le']);
export const PLAYBACK_QUALITIES=new Set(['original','source','compact','aac_96','high','medium','auto','aac_192']);

export function parsePlaybackCodecs(value){
  if(typeof value!=='string'||value.length>256)return null;
  const codecs=[...new Set(value.toLowerCase().split(',').map(item=>item.trim()))];
  return codecs.length&&codecs.every(codec=>CODECS.has(codec))?codecs:null;
}

export function selectMediaPlayback({requested='original',sourceCodec,codecs,files=[]}){
  const supports=new Set(codecs),codec=String(sourceCodec||'').toLowerCase();
  const repaired=files.find(file=>file.variant==='normalized_flac');
  const nativeCodec=repaired?'flac':codec;
  const native=supports.has(nativeCodec)&&(!repaired||repaired.status==='ready')
    ? {status:'ready',variant:repaired?'normalized_flac':'original',codec:nativeCodec,lossless:repaired?true:nativeCodec!=='mp3'&&nativeCodec!=='aac'&&nativeCodec!=='opus'&&nativeCodec!=='vorbis'} : null;
  if(requested==='source')return{status:'ready',variant:'original',codec:codec||null,lossless:null};
  const requestedVariant=['compact','aac_96'].includes(requested)?'aac_96':['high','medium','auto','aac_192'].includes(requested)?'aac_192':null;
  if(!requestedVariant&&native)return native;
  if(!supports.has('aac'))return native||{status:'unsupported',error_code:'media_codec_unsupported'};
  const variant=requestedVariant||'aac_192',file=files.find(item=>item.variant===variant);
  if(file?.status==='ready')return{status:'ready',variant,codec:'aac',lossless:false};
  if(native)return{...native,requested_variant:variant,preparation_status:file?.status==='failed'?'failed':'preparing'};
  if(file?.status==='failed')return{status:'failed',variant,error_code:'media_preparation_failed'};
  return{status:'preparing',variant,codec:'aac',lossless:false,retry_after_ms:1500};
}
