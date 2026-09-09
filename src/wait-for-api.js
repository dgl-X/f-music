const configuredHost = String(process.env.MUSIC_HOST || '127.0.0.1').trim();
const host = ['0.0.0.0', '::', ''].includes(configuredHost) ? '127.0.0.1' : configuredHost;
const port = Number(process.env.MUSIC_PORT || 8095);
const address = `http://${host.includes(':') ? `[${host}]` : host}:${port}/api/v1/health`;

for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(address, { signal: AbortSignal.timeout(1000) });
    if (response.ok) process.exit(0);
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}

console.error(`Family Music API не готов: ${address}`);
process.exit(1);
