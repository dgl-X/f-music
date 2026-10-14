export function connectStatusLabel({ enabled, connection = 'connected', pending = 0, state, remote = false, preparing = false } = {}) {
  if (!enabled) return '';
  if (connection === 'reconnecting') return 'Connect · восстанавливаем связь';
  if (connection === 'error') return 'Connect · команда не отправлена';
  if (preparing) return 'Connect · готовим передачу';
  if (pending) return 'Connect · отправляем команду';
  if (!remote) return '';
  const status = state?.playback_status;
  return status === 'buffering' ? 'Другое устройство · буферизация'
    : status === 'waiting' ? 'Другое устройство · ожидание воспроизведения'
    : status === 'preparing' ? 'Другое устройство · подготовка'
    : state?.playing ? 'Играет на другом устройстве' : 'Другое устройство · пауза';
}
