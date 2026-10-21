export function createWorkerRuntime({
  config, maintenance, uploadJobs, uploadWorker, transcoding, recognition, loudness,
  federationImport, federation, federationSync, federationAvailability,
  loadFederationIdentity, probeFederationEndpoint,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, logError = console.error,
}) {
  const timers = [];
  let recovering = false;
  const guarded = (label, task) => () => Promise.resolve().then(task).catch(error => logError(label, error));
  const schedule = (label, task, interval, immediate = true) => {
    const run = guarded(label, task);
    if (immediate) run();
    timers.push(setIntervalFn(run, interval));
  };

  async function syncFederationCatalogs() {
    const settings = await federation.settings();
    const identity = loadFederationIdentity();
    if (settings.enabled && identity) await federationSync.sync(identity);
  }
  async function notifyFederationPeers() {
    const settings = await federation.settings();
    const identity = loadFederationIdentity();
    if (settings.enabled && identity) await federationSync.notify(identity);
  }
  async function checkFederationPeers() {
    const settings = await federation.settings();
    if (settings.enabled) await federationAvailability.check(probeFederationEndpoint);
  }

  function start() {
    schedule('Ошибка heartbeat worker:', maintenance.heartbeat, 15000);
    uploadJobs.recover().then(uploadWorker.processNext).catch(error => logError('Ошибка восстановления очереди:', error));
    schedule('Ошибка worker:', uploadWorker.processNext, Math.max(250, config.workerPollMs), false);
    transcoding.recover().catch(error => logError('Ошибка восстановления транскодирования:', error));
    schedule('Ошибка transcode worker:', transcoding.processNext, 2000, false);
    recognition.recover().catch(error => logError('Ошибка восстановления распознавания:', error));
    schedule('Ошибка recognition worker:', recognition.processNext, 5000, false);
    loudness.recover().catch(error => logError('Ошибка восстановления анализа громкости:', error));
    schedule('Ошибка анализа громкости:', loudness.pump, 3000, false);
    federationImport.recover().then(federationImport.processNext).catch(error => logError('Ошибка восстановления реплик:', error));
    schedule('Ошибка worker реплик:', federationImport.processNext, 2000, false);
    schedule('Ошибка очистки загрузок:', maintenance.cleanupUploads, Math.max(1, config.uploadCleanupMinutes) * 60000);
    schedule('Ошибка ротации отчётов:', maintenance.cleanupReports, 6 * 60 * 60 * 1000);
    if(maintenance.cleanupListening)schedule('Ошибка очистки сеансов прослушивания:',maintenance.cleanupListening,6*60*60*1000);
    schedule('Ошибка очистки федерации:', maintenance.cleanupFederation, 6 * 60 * 60 * 1000);
    schedule('Ошибка federation sync:', syncFederationCatalogs, 5000);
    schedule('Ошибка federation notify:', notifyFederationPeers, 5000);
    schedule('Ошибка federation health:', checkFederationPeers, 15000);
    guarded('Ошибка фоновой индексации:', maintenance.enrichTracks)();
    schedule('Ошибка периодического восстановления:', async()=>{
      if(recovering)return;
      recovering=true;
      try {
        const results=await Promise.allSettled([uploadJobs.recover(),transcoding.recover(),recognition.recover(),loudness.recover(),federationImport.recover({legacy:false})]);
        for(const result of results)if(result.status==='rejected')logError('Ошибка восстановления очереди:',result.reason);
      }
      finally { recovering=false; }
    },60000,false);
  }

  function stop() {
    for (const timer of timers.splice(0)) clearIntervalFn(timer);
  }

  return { start, stop, syncFederationCatalogs, notifyFederationPeers, checkFederationPeers };
}
