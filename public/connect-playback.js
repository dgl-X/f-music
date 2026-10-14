// Wait for actual transport state before acknowledging a Connect command.
export function webConnectPlaybackStatus(player) {
  const playing=Boolean(player&&!player.paused&&!player.ended);
  const isPlaying=playing&&player.readyState>=3;
  const buffering=playing&&!isPlaying;
  return{playing,is_playing:isPlaying,buffering,playback_status:isPlaying?'playing':buffering?'buffering':'paused'};
}

export function connectPositionAdvances(state) {
  return Boolean(state?.playing&&(typeof state.is_playing==='boolean'?state.is_playing:!state.buffering));
}

export async function waitForPlayback(check, { timeoutMs = 12000, intervalMs = 50 } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error('Плеер не подтвердил команду');
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
