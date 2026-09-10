export const FEDERATION_PROTOCOL_MAJOR = 1;
export const FEDERATION_PROTOCOL_MINOR = 0;

export const FEDERATION_CAPABILITIES = Object.freeze({
  'node.info.v1': {},
  'health.v1': {},
  'pairing.v1': {},
  'catalog.delta.v1': { max_page: 500 },
  'catalog.notify.v1': {},
  'stream.range.v1': { variants: ['original', 'aac_96', 'aac_192'] },
});

export function negotiateFederation(remote, requiredCapabilities = []) {
  const protocols = remote?.protocols && typeof remote.protocols === 'object' ? remote.protocols : {};
  const protocol = protocols[String(FEDERATION_PROTOCOL_MAJOR)];
  const minor = protocol?.minor;
  if (!Number.isSafeInteger(minor) || minor < 0) {
    return { status: 'upgrade_required', major: null, minor: null, capabilities: [], missing: requiredCapabilities };
  }
  const remoteCapabilities = remote?.capabilities && typeof remote.capabilities === 'object' ? remote.capabilities : {};
  const common = Object.keys(FEDERATION_CAPABILITIES).filter(name => Object.hasOwn(remoteCapabilities, name));
  const missing = requiredCapabilities.filter(name => !Object.hasOwn(remoteCapabilities, name));
  if (missing.length) return { status: 'upgrade_required', major: FEDERATION_PROTOCOL_MAJOR, minor, capabilities: common, missing };
  const limited = Object.keys(FEDERATION_CAPABILITIES).some(name => !Object.hasOwn(remoteCapabilities, name));
  return { status: limited ? 'limited' : 'compatible', major: FEDERATION_PROTOCOL_MAJOR, minor, capabilities: common, missing: [] };
}

export function validateDeltaCompatibility(page, readerMinor = FEDERATION_PROTOCOL_MINOR) {
  const producerMinor = page?.producer_minor;
  const minReaderMinor = page?.min_reader_minor;
  if (!Number.isSafeInteger(producerMinor) || producerMinor < 0 || !Number.isSafeInteger(minReaderMinor) || minReaderMinor < 0) {
    throw Object.assign(new Error('Некорректная версия delta-страницы'), { code: 'invalid_delta' });
  }
  if (minReaderMinor > readerMinor) {
    throw Object.assign(new Error(`Delta требует federation minor ${minReaderMinor}, поддерживается ${readerMinor}`), {
      code: 'upgrade_required', requiredMinor: minReaderMinor, supportedMinor: readerMinor,
    });
  }
  return { producerMinor, minReaderMinor };
}
