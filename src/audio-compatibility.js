export function audioCodec(metadata) {
  return String(metadata?.streams?.find(stream => stream.codec_type === 'audio')?.codec_name || '').trim().toLowerCase() || null;
}

export function requiresCompatibilityVariant(codec) {
  return String(codec || '').toLowerCase() === 'alac';
}

export function playbackVariant(requested, codec) {
  if (['compact', 'aac_96'].includes(requested)) return 'aac_96';
  if (['high', 'medium', 'auto', 'aac_192'].includes(requested)) return 'aac_192';
  if (requested === 'original' && requiresCompatibilityVariant(codec)) return 'aac_192';
  return null;
}
