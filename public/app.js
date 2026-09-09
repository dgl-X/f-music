const app = document.querySelector('#app');
const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `HTTP ${response.status}`); }
  return response.status === 204 ? null : response.json();
};
const escapeHtml = text => String(text ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const duration = value => value ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '—';
const bytes = value => { const units=['Б','КиБ','МиБ','ГиБ','ТиБ'];let size=Number(value)||0,index=0;while(size>=1024&&index<units.length-1){size/=1024;index++;}return `${size.toLocaleString('ru-RU',{maximumFractionDigits:index?1:0})} ${units[index]}`; };
const longDuration = value => { const seconds=Number(value)||0,hours=Math.floor(seconds/3600),days=Math.floor(hours/24);return days?`${days} дн. ${hours%24} ч.`:hours?`${hours} ч. ${Math.floor(seconds%3600/60)} мин.`:`${Math.floor(seconds/60)} мин.`; };
let queue = [];
let displayedTracks = [];
let currentQueueRequest = '';
let currentIndex = -1;
const playbackFailures = new Set();
let playbackErrorTimer = null;
let activeView = 'liked';
let activeArtist = '';
let activeArtistId = 0;
let activeAlbum = '';
let searchQuery = '';
let searchScope = localStorage.getItem('music-search-scope') || 'all';
let federationNode='';
let federationPage=0;
let sortMode = 'newest';
let pageIndex = 0;
let pageSize = Math.min(200,Math.max(50,Number(localStorage.getItem('music-page-size'))||50));
let searchTimer;
let activePlaylist = null;
let playerRestored = false;
let lastPositionSave = 0;
let shuffleEnabled = false;
let repeatMode = 'off';
let stateSaveTimer;
let sessionUser=null;
let uploadTasks=[];
let uploadWorkers=0;
let uploadTaskSequence=0;
let audioContext=null,audioGain=null,audioSource=null;
let instanceName='Family Music';

function applyWebGain(){
  const player=document.querySelector('#player'),track=queue[currentIndex],userVolume=Number(localStorage.getItem('music-volume')??.8);
  const enabled=localStorage.getItem('music-normalization')==='1',db=enabled?Number(track?.replay_gain_db||0):0;
  const gain=userVolume*Math.pow(10,db/20);
  if(audioGain)audioGain.gain.setTargetAtTime(gain,audioContext.currentTime,.015);else if(player)player.volume=Math.min(1,gain);
}

function enableWebAudio(){
  const player=document.querySelector('#player');if(!player)return;
  if(!audioContext){audioContext=new AudioContext();audioSource=audioContext.createMediaElementSource(player);audioGain=audioContext.createGain();audioSource.connect(audioGain).connect(audioContext.destination);player.volume=1;}
  audioContext.resume().catch(()=>{});applyWebGain();
}

async function start() {
  const setup = await api('/api/v1/setup/status');
  instanceName=setup.library_name||'Family Music';document.title=instanceName;
  if (setup.needs_setup) return renderSetup(setup);
  try { renderLibrary(await api('/api/v1/me')); } catch { renderAuth(false); }
}

function renderSetup(status) {
  const check=(name,value)=>`<span class="setup-check ${value==='ok'?'ok':'wait'}"><i></i>${escapeHtml(name)}<small>${value==='ok'?'готово':'запускается'}</small></span>`;
  app.innerHTML=`<section class="auth setup-auth"><div class="card setup-card"><div class="brand">◉ Family Music</div><div class="setup-steps"><span class="active">1</span><span>2</span><span>3</span></div>
    <form id="setup-form"><section class="setup-page active" data-step="1"><div><h1>Добро пожаловать</h1><p class="subtitle">Проверим сервер и за пару шагов подготовим семейную библиотеку.</p></div><div class="setup-checks">${check('PostgreSQL',status.checks?.database)}${check('Хранилище',status.checks?.storage)}${check('Фоновая обработка',status.checks?.worker)}</div><small class="setup-version">Family Music Server ${escapeHtml(status.server_version||'')}</small></section>
    <section class="setup-page" data-step="2"><div><h2>Ваша библиотека</h2><p class="subtitle">Название будет видно на странице входа и в WEB-интерфейсе.</p></div><label>Название библиотеки<input name="library_name" value="${escapeHtml(status.library_name||'Family Music')}" minlength="2" maxlength="60" required></label><label class="setup-toggle"><input type="checkbox" name="recognition_enabled"><span><strong>Автораспознавание</strong><small>Искать метаданные для файлов без тегов. API-ключ можно добавить позже в настройках.</small></span></label></section>
    <section class="setup-page" data-step="3"><div><h2>Администратор</h2><p class="subtitle">Публичной регистрации нет. Остальные аккаунты вы создадите после входа.</p></div><label>Отображаемое имя<input name="display_name" autocomplete="name" maxlength="80" required></label><label>Логин<input name="username" autocomplete="username" minlength="3" maxlength="32" pattern="[A-Za-z0-9_.-]+" required></label><label>Пароль<input type="password" name="password" autocomplete="new-password" minlength="10" required></label><label>Повторите пароль<input type="password" name="confirmation" autocomplete="new-password" minlength="10" required></label></section>
    <div class="error" id="auth-error"></div><div class="setup-actions"><button type="button" class="secondary setup-back" hidden>Назад</button><button type="button" class="primary setup-next">Продолжить</button><button class="primary setup-finish" hidden>Завершить настройку</button></div></form></div></section>`;
  const form=document.querySelector('#setup-form'),pages=[...form.querySelectorAll('.setup-page')],steps=[...document.querySelectorAll('.setup-steps span')],back=form.querySelector('.setup-back'),next=form.querySelector('.setup-next'),finish=form.querySelector('.setup-finish');let current=0;
  const show=()=>{pages.forEach((page,index)=>page.classList.toggle('active',index===current));steps.forEach((step,index)=>step.classList.toggle('active',index<=current));back.hidden=current===0;next.hidden=current===pages.length-1;finish.hidden=current!==pages.length-1;};
  next.onclick=()=>{const inputs=[...pages[current].querySelectorAll('input')];if(inputs.some(input=>!input.reportValidity()))return;current++;show();};back.onclick=()=>{current--;show();};
  form.onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(form));const error=document.querySelector('#auth-error');error.textContent='';if(values.password!==values.confirmation){error.textContent='Пароли не совпадают';return;}delete values.confirmation;values.recognition_enabled=Boolean(values.recognition_enabled);finish.disabled=true;finish.textContent='Настраиваем…';try{const configured=await api('/api/v1/setup',{method:'POST',body:JSON.stringify(values)});instanceName=configured.library_name||values.library_name;document.title=instanceName;await api('/api/v1/login',{method:'POST',body:JSON.stringify({username:values.username,password:values.password})});renderLibrary(await api('/api/v1/me'));}catch(problem){error.textContent=problem.message;finish.disabled=false;finish.textContent='Завершить настройку';}};
}

function renderAuth(isSetup) {
  app.innerHTML = `<section class="auth"><div class="card"><div class="brand">◉ ${escapeHtml(instanceName)}</div><p class="subtitle">${isSetup ? 'Создайте первого администратора' : 'Ваша личная музыкальная библиотека'}</p>
    <form id="auth-form">
      ${isSetup ? '<label>Отображаемое имя<input name="display_name" autocomplete="name" required></label>' : ''}
      <label>Логин<input name="username" autocomplete="username" minlength="3" required></label>
      <label>Пароль<input type="password" name="password" autocomplete="${isSetup ? 'new-password' : 'current-password'}" minlength="10" required></label>
      <div class="error" id="auth-error"></div><button class="primary">${isSetup ? 'Создать аккаунт' : 'Войти'}</button>
    </form></div></section>`;
  document.querySelector('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api(isSetup ? '/api/v1/setup' : '/api/v1/login', { method:'POST', body:JSON.stringify(values) }); if (isSetup) await api('/api/v1/login',{method:'POST',body:JSON.stringify(values)}); renderLibrary(await api('/api/v1/me')); }
    catch (error) { document.querySelector('#auth-error').textContent = error.message; }
  });
}

async function renderLibrary(user) {
  sessionUser=user;
  app.innerHTML = `<section class="shell"><header><div class="brand">◉ ${escapeHtml(instanceName)}</div><div class="user"><span>${escapeHtml(user.display_name)}</span><button class="secondary" id="web-settings">Настройки</button><button class="secondary" id="logout">Выйти</button></div></header>
    <div class="hero"><div><h1>Музыка</h1></div></div>
    <nav class="catalog-tabs"><button class="tab active" data-view="liked">Мне нравится</button><button class="tab" data-view="recommendations">Для вас</button><button class="tab" data-view="search">Поиск</button><button class="tab" data-view="tracks">Все треки</button><button class="tab" data-view="history">Недавно слушали</button><button class="tab" data-view="artists">Исполнители</button><button class="tab" data-view="albums">Альбомы</button><button class="tab" data-view="playlists">Плейлисты</button><button class="tab" data-view="upload">Загрузка</button></nav>
    <div class="catalog-tools"><div class="search-box">⌕<input id="search" type="search" placeholder="Поиск в медиатеке" autocomplete="off"></div><div class="catalog-options"><select id="search-scope" aria-label="Какие треки показывать"><option value="all">Общая библиотека</option><option value="local">Только этот сервер</option><option value="remote">Только федерация</option></select><select id="sort" aria-label="Сортировка"><option value="newest">Сначала новые</option><option value="oldest">Снача старые</option><option value="title">По названию</option><option value="artist">По исполнителю</option><option value="album">По альбому</option><option value="year">По году</option></select><select id="page-size" aria-label="Треков на странице"><option value="50">50 на странице</option><option value="100">100 на странице</option><option value="200">200 на странице</option></select></div></div>
    <div class="active-filter" id="active-filter"></div><div id="catalog-content"></div></section>
    <section class="player-bar" id="player-bar" aria-label="Музыкальный плеер">
      <audio id="player" preload="metadata"></audio>
      <div class="now-playing"><div class="cover" id="now-cover">♫</div><button class="now-text" id="now-details" title="Открыть трек"><span class="now-title" id="now-title">Выберите трек</span><span class="now-artist" id="now-artist">Family Music</span></button><button class="player-like" id="player-like" title="Мне нравится" aria-label="Добавить во Мне нравится">♡</button></div>
      <div class="transport"><div class="transport-buttons"><button class="mode-control" id="shuffle" title="Перемешать">⌘</button><button class="control" id="previous" title="Предыдущий">‹</button><button class="control main-control" id="toggle" title="Воспроизвести">▶</button><button class="control" id="next" title="Следующий">›</button><button class="mode-control" id="repeat" title="Повтор выключен">↻</button></div><div class="timeline"><span id="elapsed">0:00</span><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Позиция воспроизведения"><span id="total">0:00</span></div></div>
      <div class="volume"><button class="mode-control" id="normalization" title="Выравнивание громкости">RG</button><span>♩</span><input id="volume" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Громкость"><button class="queue-toggle" id="queue-toggle" title="Очередь">☷</button></div>
    </section><aside class="queue-panel" id="queue-panel"><div class="queue-header"><div><strong>Очередь</strong><span id="queue-count"></span></div><button id="queue-close" aria-label="Закрыть">×</button></div><div class="queue-list" id="queue-list"></div></aside>`;
  document.querySelector('#web-settings').onclick=showWebSettings;
  document.querySelector('#logout').onclick = async () => { await api('/api/v1/logout',{method:'POST'}); renderAuth(false); };
  document.querySelectorAll('.tab').forEach(tab=>tab.onclick=()=>switchView(tab.dataset.view));
  document.querySelector('#page-size').value=String(pageSize);
  document.querySelector('#search-scope').value=searchScope;
  document.querySelector('#search-scope').hidden=activeView!=='tracks';
  document.querySelector('#search').oninput=event=>{ searchQuery=event.target.value.trim();pageIndex=0;clearTimeout(searchTimer); searchTimer=setTimeout(loadCurrentView,180); };
  document.querySelector('#sort').onchange=event=>{ sortMode=event.target.value;pageIndex=0;loadCurrentView(); };
  document.querySelector('#search-scope').onchange=event=>{searchScope=event.target.value;localStorage.setItem('music-search-scope',searchScope);pageIndex=0;loadCurrentView();};
  document.querySelector('#page-size').onchange=event=>{pageSize=Number(event.target.value)||50;pageIndex=0;localStorage.setItem('music-page-size',String(pageSize));loadCurrentView();};
  document.querySelector('#queue-toggle').onclick=()=>{document.querySelector('#queue-panel').classList.toggle('open');renderQueue();};
  document.querySelector('#queue-close').onclick=()=>document.querySelector('#queue-panel').classList.remove('open');
  document.querySelector('#player-like').onclick=toggleCurrentLike;
  document.querySelector('#now-details').onclick=()=>{const track=queue[currentIndex];if(track?.remote)return showRemoteTrack(track.remote_ref);if(track)editTrack(track);};
  setupPlayer();
  await loadCurrentView();
}

function showWebSettings(){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog settings-dialog';
  const admin=sessionUser?.is_admin?`<div class="settings-group"><h3>Администрирование</h3><button data-action="stats"><span>Статистика</span><small>Состояние сервера, очереди и громкость</small></button><button data-action="users"><span>Аккаунты</span><small>Пользователи и сброс паролей</small></button><button data-action="federation"><span>Федерация</span><small>Identity, адреса и доступность ноды</small></button><button data-action="recognition-settings"><span>Автораспознавание</span><small>AcoustID, включение и Client API key</small></button><button data-action="reports"><span>Отчёты об ошибках</span><small>Диагностика из Android-приложения</small></button><button data-action="recognition"><span>Требуют внимания</span><small>Распознавание и исправление метаданных</small></button></div>`:'';
  dialog.innerHTML=`<div class="stats-shell"><div class="stats-head"><div><div class="dialog-title">Настройки</div><small>${escapeHtml(sessionUser?.display_name||'')}</small></div><button class="stats-close" aria-label="Закрыть">×</button></div><div class="settings-group"><h3>Аккаунт</h3><button data-action="password"><span>Изменить пароль</span><small>Обновить пароль текущего пользователя</small></button></div><div class="settings-group"><h3>Библиотека</h3><label>«Все треки» по умолчанию<select name="library_scope"><option value="all">Общая библиотека</option><option value="local">Только этот сервер</option><option value="remote">Только федерация</option></select></label><button data-action="duplicates"><span>Возможные дубликаты</span><small>Совпадения по названию и исполнителю</small></button></div>${admin}</div>`;
  document.body.append(dialog);dialog.showModal();dialog.querySelector('.stats-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  const open=action=>{dialog.close();action();};
  dialog.querySelector('[data-action="password"]').onclick=()=>open(changeOwnPassword);
  dialog.querySelector('[data-action="duplicates"]').onclick=()=>open(showDuplicates);
  const scopeSelect=dialog.querySelector('[name="library_scope"]');scopeSelect.value=searchScope;scopeSelect.onchange=()=>{searchScope=scopeSelect.value;localStorage.setItem('music-search-scope',searchScope);const toolbarScope=document.querySelector('#search-scope');if(toolbarScope)toolbarScope.value=searchScope;pageIndex=0;if(activeView==='tracks')loadCurrentView();};
  if(sessionUser?.is_admin){dialog.querySelector('[data-action="stats"]').onclick=()=>open(showAdminStats);dialog.querySelector('[data-action="users"]').onclick=()=>open(manageUsers);dialog.querySelector('[data-action="federation"]').onclick=()=>open(showFederationSettings);dialog.querySelector('[data-action="recognition-settings"]').onclick=()=>open(showRecognitionSettings);dialog.querySelector('[data-action="reports"]').onclick=()=>open(showDiagnosticReports);dialog.querySelector('[data-action="recognition"]').onclick=()=>{dialog.close();switchView('recognition');};}
}

async function editFederationCollection(collection=null){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog settings-dialog';
  dialog.innerHTML=`<form class="stats-shell recognition-settings-form"><div class="stats-head"><div><div class="dialog-title">${collection?'Изменить':'Новая'} коллекция</div><small>Локальные треки, доступные выбранным нодам</small></div><button type="button" class="stats-close" aria-label="Закрыть">×</button></div><label>Название<input name="name" maxlength="120" required></label><label>Добавить треки<input name="search" type="search" placeholder="Название, исполнитель или альбом"></label><div class="federation-track-search invitation-list settings-hint">Введите хотя бы два символа.</div><div class="federation-selected-tracks invitation-list settings-hint"></div><div class="error"></div><div class="dialog-actions">${collection?'<button type="button" class="danger delete-collection">Удалить</button>':''}<button type="button" class="secondary cancel">Отмена</button><button class="primary">Сохранить</button></div></form>`;
  document.body.append(dialog);dialog.showModal();let resolveClose;const completion=new Promise(resolve=>{resolveClose=resolve;});dialog.addEventListener('close',()=>{const changed=dialog.returnValue==='saved';dialog.remove();resolveClose(changed);},{once:true});const form=dialog.querySelector('form'),error=form.querySelector('.error'),selected=new Map();form.elements.name.value=collection?.name||'';
  const close=value=>{dialog.close(value);};form.querySelector('.stats-close').onclick=()=>close('');form.querySelector('.cancel').onclick=()=>close('');
  const renderSelected=()=>{const root=form.querySelector('.federation-selected-tracks');root.innerHTML=selected.size?[...selected.values()].map(track=>`<div><span><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist||'Неизвестный исполнитель')} · ${escapeHtml(track.album||'Без альбома')}</small></span><button type="button" class="secondary remove-track" data-id="${track.id}">Убрать</button></div>`).join(''):'В коллекции пока нет треков.';root.querySelectorAll('.remove-track').forEach(button=>button.onclick=()=>{selected.delete(button.dataset.id);renderSelected();});};
  if(collection){try{const data=await api(`/api/v1/admin/federation/collections/${collection.id}`);data.tracks.forEach(track=>selected.set(track.id,track));renderSelected();}catch(problem){error.textContent=problem.message;}}
  else renderSelected();
  let timer;form.elements.search.oninput=()=>{clearTimeout(timer);timer=setTimeout(async()=>{const q=form.elements.search.value.trim(),root=form.querySelector('.federation-track-search');if(q.length<2){root.textContent='Введите хотя бы два символа.';return;}try{const data=await api(`/api/v1/library?scope=local&limit=50&q=${encodeURIComponent(q)}&sort=artist`);root.innerHTML=data.items.length?data.items.map(track=>`<div><span><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist||'Неизвестный исполнитель')} · ${escapeHtml(track.album||'Без альбома')}</small></span><button type="button" class="secondary add-track" data-id="${track.id}" ${selected.has(track.id)?'disabled':''}>Добавить</button></div>`).join(''):'Ничего не найдено.';root.querySelectorAll('.add-track').forEach((button,index)=>button.onclick=()=>{const track=data.items[index];selected.set(track.id,track);button.disabled=true;renderSelected();});}catch(problem){root.textContent=problem.message;}},250);};
  if(collection)form.querySelector('.delete-collection').onclick=async()=>{if(!confirm(`Удалить коллекцию «${collection.name}»?`))return;try{await api(`/api/v1/admin/federation/collections/${collection.id}`,{method:'DELETE'});close('saved');}catch(problem){error.textContent=problem.message;}};
  form.onsubmit=async event=>{event.preventDefault();error.textContent='';try{let target=collection;if(!target)target=await api('/api/v1/admin/federation/collections',{method:'POST',body:JSON.stringify({name:form.elements.name.value})});await api(`/api/v1/admin/federation/collections/${target.id}`,{method:'PUT',body:JSON.stringify({name:form.elements.name.value,track_ids:[...selected.keys()]})});close('saved');}catch(problem){error.textContent=problem.message;}};
  return completion;
}

async function editFederationPeerPolicy(peer,settings){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog settings-dialog';
  dialog.innerHTML=`<form class="stats-shell recognition-settings-form"><div class="stats-head"><div><div class="dialog-title">Доступ для ноды</div><small>${escapeHtml(peer.label||peer.endpoint)}</small></div><button type="button" class="stats-close" aria-label="Закрыть">×</button></div><label>Что публиковать<select name="policy"><option value="inherit">Общие настройки</option><option value="none">Ничего</option><option value="albums">Выбранные альбомы</option><option value="collections">Выбранные коллекции</option><option value="all">Всю библиотеку</option></select></label><section class="peer-albums" hidden><div class="federation-album-list invitation-list settings-hint"></div></section><section class="peer-collections" hidden><div class="federation-collection-list invitation-list settings-hint"></div></section><small class="settings-hint">Индивидуальное правило имеет приоритет над общей политикой экспорта.</small><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary cancel">Отмена</button><button class="primary">Сохранить</button></div></form>`;
  document.body.append(dialog);dialog.showModal();const form=dialog.querySelector('form'),error=form.querySelector('.error'),albumSelected=new Set(peer.selected_albums||[]),collectionSelected=new Set(peer.selected_collections||[]);form.elements.policy.value=peer.export_policy||'inherit';
  form.querySelector('.federation-album-list').innerHTML=(settings.available_albums||[]).map(item=>`<label class="settings-check"><input type="checkbox" value="${escapeHtml(item.name)}" ${albumSelected.has(item.name)?'checked':''}><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.artist||'Неизвестный исполнитель')} · ${Number(item.track_count)} тр.</small></span></label>`).join('')||'Альбомов нет.';
  form.querySelector('.federation-collection-list').innerHTML=(settings.collections||[]).map(item=>`<label class="settings-check"><input type="checkbox" value="${item.id}" ${collectionSelected.has(item.id)?'checked':''}><span><strong>${escapeHtml(item.name)}</strong><small>${Number(item.track_count)} тр.</small></span></label>`).join('')||'Коллекций нет.';
  const render=()=>{form.querySelector('.peer-albums').hidden=form.elements.policy.value!=='albums';form.querySelector('.peer-collections').hidden=form.elements.policy.value!=='collections';};render();form.elements.policy.onchange=render;
  const close=value=>dialog.close(value);form.querySelector('.stats-close').onclick=()=>close('');form.querySelector('.cancel').onclick=()=>close('');form.onsubmit=async event=>{event.preventDefault();try{await api(`/api/v1/admin/federation/peers/${peer.node_id}/export-policy`,{method:'PUT',body:JSON.stringify({policy:form.elements.policy.value,selected_albums:[...form.querySelectorAll('.federation-album-list input:checked')].map(input=>input.value),selected_collections:[...form.querySelectorAll('.federation-collection-list input:checked')].map(input=>input.value)})});close('saved');}catch(problem){error.textContent=problem.message;}};
  return new Promise(resolve=>dialog.addEventListener('close',()=>{const changed=dialog.returnValue==='saved';dialog.remove();resolve(changed);},{once:true}));
}

async function showFederationSettings(){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog settings-dialog';
  dialog.innerHTML=`<form class="stats-shell recognition-settings-form"><div class="stats-head"><div><div class="dialog-title">Федерация</div><small>Identity, адреса и доверенные ноды</small></div><button type="button" class="stats-close" aria-label="Закрыть">×</button></div><div class="federation-identity">Загрузка…</div><label class="settings-check"><input type="checkbox" name="enabled"><span><strong>Включить федерацию</strong><small>Публичное описание ноды станет доступно по federation/v1</small></span></label><label>Экспорт каталога<select name="export_policy"><option value="none">Ничего не публиковать</option><option value="albums">Только выбранные альбомы</option><option value="collections">Только выбранные коллекции</option><option value="all">Вся библиотека — только метаданные</option></select></label><section class="federation-album-picker" hidden><div class="federation-section-head"><strong>Опубликованные альбомы</strong></div><input class="federation-album-search" type="search" placeholder="Найти альбом"><div class="federation-album-list invitation-list settings-hint"></div></section><section class="federation-collection-picker" hidden><div class="federation-section-head"><strong>Опубликованные коллекции</strong></div><div class="federation-collection-list invitation-list settings-hint"></div></section><section class="federation-invitations"><div class="federation-section-head"><strong>Коллекции публикации</strong><button type="button" class="secondary create-collection">Создать</button></div><div class="federation-collections invitation-list settings-hint"></div></section><small class="settings-hint">Соседние ноды видят только выбранную часть библиотеки. Лайки, история, пользователи и плейлисты не передаются.</small><label>Публичный HTTPS-адрес<input name="public_endpoint" type="url" placeholder="https://music.example.net"></label><label>Внутренний HTTPS-адрес<input name="private_endpoint" type="url" placeholder="https://PRIVATE-IP:8443"></label><div class="endpoint-check-result settings-hint">Адреса ещё не проверялись.</div><small class="settings-hint">Private endpoint принимает только точный частный IP. Identity создаётся один раз и не меняется при смене адреса.</small><section class="federation-invitations"><div class="federation-section-head"><strong>Подключить другую ноду</strong></div><textarea name="invitation_code" rows="4" placeholder="Вставьте fm-invite-v1:…"></textarea><button type="button" class="secondary accept-invitation">Подключить по приглашению</button><div class="pairing-result settings-hint"></div></section><section class="federation-invitations"><div class="federation-section-head"><strong>Подключённые ноды</strong></div><div class="peer-list invitation-list settings-hint">Загрузка…</div></section><section class="federation-invitations"><div class="federation-section-head"><strong>Одноразовые приглашения</strong><button type="button" class="secondary create-invitation">Создать</button></div><div class="invitation-result"></div><div class="invitation-list settings-hint">Загрузка…</div></section><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary initialize-identity">Создать identity</button><button type="button" class="secondary check-endpoints">Проверить адреса</button><button type="button" class="secondary federation-cancel">Отмена</button><button class="primary">Сохранить</button></div></form>`;
  document.body.append(dialog);dialog.showModal();const form=dialog.querySelector('form'),error=form.querySelector('.error'),identityBox=form.querySelector('.federation-identity');
  const close=()=>dialog.close();form.querySelector('.stats-close').onclick=close;form.querySelector('.federation-cancel').onclick=close;dialog.addEventListener('close',()=>dialog.remove());
  let state;
  const selectedAlbums=()=>[...form.querySelectorAll('.federation-album-list input:checked')].map(input=>input.value);
  const selectedCollections=()=>[...form.querySelectorAll('.federation-collection-list input:checked')].map(input=>input.value);
  const renderAlbums=()=>{const root=form.querySelector('.federation-album-list'),query=form.querySelector('.federation-album-search').value.trim().toLocaleLowerCase('ru');const selected=new Set(state.selected_albums||[]),albums=(state.available_albums||[]).filter(item=>!query||`${item.name} ${item.artist}`.toLocaleLowerCase('ru').includes(query));root.innerHTML=albums.length?albums.map(item=>`<label class="settings-check"><input type="checkbox" value="${escapeHtml(item.name)}" ${selected.has(item.name)?'checked':''}><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.artist||'Неизвестный исполнитель')} · ${Number(item.track_count)} тр.</small></span></label>`).join(''):'Альбомы не найдены.';root.onchange=()=>{state.selected_albums=selectedAlbums();};};
  const renderCollections=()=>{const selected=new Set(state.selected_collections||[]),picker=form.querySelector('.federation-collection-list'),manager=form.querySelector('.federation-collections'),items=state.collections||[];picker.innerHTML=items.length?items.map(item=>`<label class="settings-check"><input type="checkbox" value="${item.id}" ${selected.has(item.id)?'checked':''}><span><strong>${escapeHtml(item.name)}</strong><small>${Number(item.track_count)} тр.</small></span></label>`).join(''):'Сначала создайте коллекцию.';picker.onchange=()=>{state.selected_collections=selectedCollections();};manager.innerHTML=items.length?items.map(item=>`<div><span><strong>${escapeHtml(item.name)}</strong><small>${Number(item.track_count)} треков</small></span><button type="button" class="secondary edit-collection" data-id="${item.id}">Изменить</button></div>`).join(''):'Коллекций пока нет.';manager.querySelectorAll('.edit-collection').forEach(button=>button.onclick=async()=>{const item=items.find(value=>value.id===button.dataset.id);if(await editFederationCollection(item)){state=await api('/api/v1/admin/federation');render();}});};
  const render=()=>{identityBox.innerHTML=state.initialized?`<span>Node ID</span><strong>${escapeHtml(state.node_id)}</strong><span>Fingerprint</span><code>${escapeHtml(state.fingerprint)}</code>`:'<span>Identity ещё не создана</span><small>Закрытый Ed25519-ключ будет сохранён только на сервере.</small>';form.querySelector('.initialize-identity').hidden=state.initialized;form.querySelector('.federation-album-picker').hidden=form.elements.export_policy.value!=='albums';form.querySelector('.federation-collection-picker').hidden=form.elements.export_policy.value!=='collections';renderAlbums();renderCollections();};
  const endpoints=()=>[{url:form.elements.public_endpoint.value.trim(),scope:'public',priority:10},{url:form.elements.private_endpoint.value.trim(),scope:'private',priority:20}].filter(item=>item.url);
  try{state=await api('/api/v1/admin/federation');form.elements.enabled.checked=state.enabled;form.elements.export_policy.value=state.export_policy||'none';form.elements.public_endpoint.value=state.endpoints.find(item=>item.scope==='public')?.url||'';form.elements.private_endpoint.value=state.endpoints.find(item=>item.scope==='private')?.url||'';render();}catch(problem){error.textContent=problem.message;return;}
  form.elements.export_policy.onchange=render;form.querySelector('.federation-album-search').oninput=()=>{state.selected_albums=selectedAlbums();renderAlbums();};
  form.querySelector('.create-collection').onclick=async()=>{if(await editFederationCollection()){state=await api('/api/v1/admin/federation');render();}};
  form.querySelector('.initialize-identity').onclick=async()=>{error.textContent='';try{state=await api('/api/v1/admin/federation',{method:'PUT',body:JSON.stringify({initialize:true,enabled:false,export_policy:form.elements.export_policy.value,selected_albums:selectedAlbums(),selected_collections:selectedCollections(),endpoints:endpoints()})});render();}catch(problem){error.textContent=problem.message;}};
  form.querySelector('.check-endpoints').onclick=async()=>{error.textContent='';const values=endpoints(),result=form.querySelector('.endpoint-check-result');if(!values.length){result.textContent='Сначала укажите хотя бы один HTTPS-адрес.';return;}result.textContent='Проверяем TLS, DNS и описание ноды…';const lines=[];for(const item of values)try{const checked=await api('/api/v1/admin/federation/check-endpoint',{method:'POST',body:JSON.stringify(item)});lines.push(`✓ ${item.scope}: ${checked.node_id} · ${checked.address}`);}catch(problem){lines.push(`✕ ${item.scope}: ${problem.message}`);}result.textContent=lines.join('\n');};
  const loadInvitations=async()=>{const root=form.querySelector('.invitation-list');try{const data=await api('/api/v1/admin/federation/invitations');const names={active:'Активно',used:'Использовано',expired:'Истекло',revoked:'Отозвано'};root.innerHTML=data.items.length?data.items.map(item=>`<div><span><strong>${names[item.status]||item.status}</strong><small>${escapeHtml(item.endpoint)} · до ${new Date(item.expires_at).toLocaleString('ru-RU')}</small></span>${item.status==='active'?`<button type="button" class="secondary revoke-invitation" data-id="${item.id}">Отозвать</button>`:''}</div>`).join(''):'Активных и старых приглашений пока нет.';root.querySelectorAll('.revoke-invitation').forEach(button=>button.onclick=async()=>{await api(`/api/v1/admin/federation/invitations/${button.dataset.id}`,{method:'DELETE'});loadInvitations();});}catch(problem){root.textContent=problem.message;}};
  form.querySelector('.create-invitation').onclick=async()=>{error.textContent='';try{const created=await api('/api/v1/admin/federation/invitations',{method:'POST',body:JSON.stringify({expires_minutes:15})}),root=form.querySelector('.invitation-result');root.innerHTML=`<textarea readonly rows="4">${escapeHtml(created.code)}</textarea><button type="button" class="secondary copy-invitation">Копировать</button><small>Секрет показан один раз и действует 15 минут.</small>`;root.querySelector('.copy-invitation').onclick=async()=>{const area=root.querySelector('textarea');try{await navigator.clipboard.writeText(area.value);root.querySelector('.copy-invitation').textContent='Скопировано';}catch{area.select();document.execCommand('copy');}};loadInvitations();}catch(problem){error.textContent=problem.message;}};
  const loadPeers=async()=>{const root=form.querySelector('.peer-list');try{const data=await api('/api/v1/admin/federation/peers'),names={compatible:'Совместима',limited:'Ограниченная совместимость',upgrade_required:'Требуется обновление',revoked:'Отключена'},policies={inherit:'Общие правила',none:'Ничего',all:'Вся библиотека',albums:'Выбранные альбомы',collections:'Выбранные коллекции'};root.innerHTML=data.items.length?data.items.map(item=>`<div><span><strong>${escapeHtml(item.label||item.endpoint)}</strong><small>${names[item.status]||escapeHtml(item.status)} · удалённых треков: ${Number(item.remote_tracks||0)}</small><small>Публикация: ${policies[item.export_policy]||'Общие правила'}</small><small>${item.sync_error?`Ошибка sync: ${escapeHtml(item.sync_error)}`:item.last_synced_at?`Синхронизация: ${new Date(item.last_synced_at).toLocaleString('ru-RU')}`:'Синхронизация ещё не выполнялась'}</small>${item.notify_error?`<small>Ошибка notify: ${escapeHtml(item.notify_error)}</small>`:''}<small>${escapeHtml(item.node_id)}</small></span><span class="peer-actions">${item.status!=='revoked'?`<button type="button" class="secondary peer-policy" data-id="${escapeHtml(item.node_id)}">Доступ</button><button type="button" class="secondary revoke-peer" data-id="${escapeHtml(item.node_id)}">Отключить</button>`:''}</span></div>`).join(''):'Подключённых нод пока нет.';root.querySelectorAll('.peer-policy').forEach(button=>button.onclick=async()=>{const peer=data.items.find(item=>item.node_id===button.dataset.id);if(await editFederationPeerPolicy(peer,state))loadPeers();});root.querySelectorAll('.revoke-peer').forEach(button=>button.onclick=async()=>{if(!confirm('Отключить доверенную ноду?'))return;await api(`/api/v1/admin/federation/peers/${button.dataset.id}`,{method:'DELETE'});loadPeers();});}catch(problem){root.textContent=problem.message;}};
  form.querySelector('.accept-invitation').onclick=async()=>{error.textContent='';const result=form.querySelector('.pairing-result'),button=form.querySelector('.accept-invitation'),code=form.elements.invitation_code.value.trim();if(!code){result.textContent='Вставьте код приглашения.';return;}button.disabled=true;result.textContent='Проверяем ноду и устанавливаем доверие…';try{const paired=await api('/api/v1/admin/federation/accept',{method:'POST',body:JSON.stringify({code})});form.elements.invitation_code.value='';result.textContent=`✓ Подключена ${paired.endpoint}`;await loadPeers();}catch(problem){result.textContent=`✕ ${problem.message}`;}finally{button.disabled=false;}};
  loadInvitations();loadPeers();
  form.onsubmit=async event=>{event.preventDefault();error.textContent='';try{state=await api('/api/v1/admin/federation',{method:'PUT',body:JSON.stringify({enabled:form.elements.enabled.checked,export_policy:form.elements.export_policy.value,selected_albums:selectedAlbums(),selected_collections:selectedCollections(),endpoints:endpoints()})});dialog.close();showWebSettings();}catch(problem){error.textContent=problem.message;}};
}

async function showDuplicates(){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog duplicates-dialog';
  dialog.innerHTML='<div class="stats-shell"><div class="stats-head"><div><div class="dialog-title">Возможные дубликаты</div><small>Проверка по исполнителю и названию</small></div><button class="stats-close" aria-label="Закрыть">×</button></div><div class="duplicates-content">Ищем совпадения…</div></div>';
  document.body.append(dialog);dialog.showModal();dialog.querySelector('.stats-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  const load=async()=>{const data=await api('/api/v1/duplicates'),root=dialog.querySelector('.duplicates-content');dialog.querySelector('.stats-head small').textContent=data.total_groups?`${data.total_groups} групп · ${data.total_tracks} треков`:'Совпадений нет';
    root.innerHTML=data.groups.length?data.groups.map((group,groupIndex)=>`<section class="duplicate-group"><div class="duplicate-title"><strong>${escapeHtml(group.artist)} — ${escapeHtml(group.title)}</strong><span>${group.items.length} варианта</span></div>${group.items.map((track,trackIndex)=>`<div class="duplicate-track"><div class="duplicate-cover" ${track.cover_url?`style="background-image:url('${track.cover_url}')"`:''}>${track.cover_url?'':'♫'}</div><div><strong>${escapeHtml(track.album||'Без альбома')}</strong><small>${duration(track.duration_seconds)} · ${escapeHtml(track.mime_type)} · ${bytes(track.size_bytes)} · ${new Date(track.created_at).toLocaleDateString('ru-RU')}</small><small>Загрузил: ${escapeHtml(track.owner_name)}</small></div><button class="secondary duplicate-play" data-group="${groupIndex}" data-track="${trackIndex}">▶ Слушать</button><button class="danger duplicate-delete" data-group="${groupIndex}" data-track="${trackIndex}" ${track.can_delete?'':'disabled'}>${track.can_delete?'Удалить':'Нет прав'}</button></div>`).join('')}</section>`).join(''):'<div class="stats-empty">Одинаковых названий и исполнителей не найдено.</div>';
    root.querySelectorAll('.duplicate-play').forEach(button=>button.onclick=()=>{const track=data.groups[Number(button.dataset.group)].items[Number(button.dataset.track)];queue=[track];playTrack(0);});
    root.querySelectorAll('.duplicate-delete:not(:disabled)').forEach(button=>button.onclick=async()=>{const track=data.groups[Number(button.dataset.group)].items[Number(button.dataset.track)];if(!confirm(`Удалить «${track.artist} — ${track.title}» (${bytes(track.size_bytes)})?`))return;const current=queue[currentIndex]?.id,next=current===track.id?(queue[currentIndex+1]||queue[currentIndex-1]):null;await api(`/api/v1/tracks/${track.id}`,{method:'DELETE'});queue=queue.filter(item=>item.id!==track.id);if(next){currentIndex=queue.findIndex(item=>item.id===next.id);playTrack(currentIndex);}else if(current===track.id){document.querySelector('#player').pause();document.querySelector('#player').removeAttribute('src');currentIndex=-1;}else currentIndex=queue.findIndex(item=>item.id===current);await load();});
  };try{await load();}catch(error){dialog.querySelector('.duplicates-content').innerHTML=`<div class="error">${escapeHtml(error.message)}</div>`;}
}

async function showRecognitionSettings(){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog settings-dialog';
  dialog.innerHTML=`<form class="stats-shell recognition-settings-form"><div class="stats-head"><div><div class="dialog-title">Автораспознавание</div><small>AcoustID распознаёт треки без заполненного исполнителя или названия</small></div><button type="button" class="stats-close" aria-label="Закрыть">×</button></div><label class="settings-check"><input type="checkbox" name="enabled"><span><strong>Включить автораспознавание</strong><small>Новые неизвестные треки будут автоматически добавляться в очередь</small></span></label><label>Client API key AcoustID<input name="client_key" type="password" maxlength="128" autocomplete="off" placeholder="Загрузка…"></label><small class="settings-hint">Сохранённый ключ никогда не возвращается браузеру. Пустое поле оставит его без изменений.</small><label class="settings-check remove-key"><input type="checkbox" name="remove_key"><span><strong>Удалить сохранённый ключ</strong><small>Распознавание остановится до добавления нового ключа</small></span></label><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary cancel-recognition-settings">Отмена</button><button class="primary">Сохранить</button></div></form>`;
  document.body.append(dialog);dialog.showModal();const close=()=>dialog.close();dialog.querySelector('.stats-close').onclick=close;dialog.querySelector('.cancel-recognition-settings').onclick=close;dialog.addEventListener('close',()=>dialog.remove());
  const form=dialog.querySelector('form'),error=form.querySelector('.error'),keyInput=form.elements.client_key;
  try{const state=await api('/api/v1/admin/recognition-settings');form.elements.enabled.checked=state.enabled;keyInput.placeholder=state.key_configured?'Ключ сохранён · введите только для замены':'Введите Client API key';form.querySelector('.settings-hint').textContent=state.key_configured?'Ключ настроен. Пустое поле оставит его без изменений.':'Ключ пока не настроен.';}catch(problem){error.textContent=problem.message;form.querySelector('button.primary').disabled=true;}
  form.onsubmit=async event=>{event.preventDefault();error.textContent='';const body={enabled:form.elements.enabled.checked};if(keyInput.value.trim())body.client_key=keyInput.value.trim();else if(form.elements.remove_key.checked)body.client_key='';try{await api('/api/v1/admin/recognition-settings',{method:'PUT',body:JSON.stringify(body)});dialog.close();showWebSettings();}catch(problem){error.textContent=problem.message;}};
}

async function manageUsers(){
  const dialog=document.createElement('dialog');
  dialog.innerHTML=`<div class="users-dialog"><div class="dialog-title">Аккаунты</div><div class="users-list">Загрузка…</div>
    <form id="create-user"><div class="users-subtitle">Новый пользователь</div><label>Имя<input name="display_name" maxlength="80" required></label><label>Логин<input name="username" minlength="3" maxlength="32" pattern="[a-zA-Z0-9_.-]+" autocomplete="off" required></label><label>Временный пароль<input name="password" type="password" minlength="10" autocomplete="new-password" required></label><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary close-users">Закрыть</button><button class="primary">Создать</button></div></form></div>`;
  document.body.append(dialog);dialog.showModal();
  const load=async()=>{const {items}=await api('/api/v1/users');dialog.querySelector('.users-list').innerHTML=items.map(item=>`<div class="user-row"><span><strong>${escapeHtml(item.display_name)}</strong><small>@${escapeHtml(item.username)} · ${item.is_admin?'Администратор':'Пользователь'}</small></span>${item.id!==sessionUser.id?`<button class="secondary reset-password" data-id="${item.id}" data-name="${escapeHtml(item.display_name)}">Сбросить пароль</button>`:'<em>Это вы</em>'}</div>`).join('');dialog.querySelectorAll('.reset-password').forEach(button=>button.onclick=()=>resetUserPassword(button.dataset.id,button.dataset.name));};
  dialog.querySelector('.close-users').onclick=()=>dialog.close();
  dialog.querySelector('#create-user').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,error=form.querySelector('.error');error.textContent='';try{await api('/api/v1/users',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});form.reset();await load();}catch(problem){error.textContent=problem.message;}};
  dialog.addEventListener('close',()=>dialog.remove());
  try{await load();}catch(error){dialog.querySelector('.users-list').innerHTML=`<div class="error">${escapeHtml(error.message)}</div>`;}
}

async function showAdminStats(){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog';
  dialog.innerHTML='<div class="stats-shell"><div class="stats-head"><div><div class="dialog-title">Состояние сервера</div><small>Загрузка данных…</small></div><button class="stats-close" aria-label="Закрыть">×</button></div><div class="stats-content"></div></div>';
  document.body.append(dialog);dialog.showModal();dialog.querySelector('.stats-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  try{
    const [data,metrics,loudness]=await Promise.all([api('/api/v1/admin/stats'),api('/api/v1/admin/metrics'),api('/api/v1/admin/loudness')]),library=data.library,storage=data.storage,integrity=data.integrity;
    const missing=integrity.missing_originals.length+integrity.missing_covers.length+integrity.missing_variants.length;
    const queueCount=[data.queues.uploads,data.queues.transcodes].flatMap(Object.entries).filter(([key])=>['queued','processing','retry'].includes(key)).reduce((sum,[,value])=>sum+Number(value),0);
    dialog.querySelector('.stats-head small').textContent=`Обновлено ${new Date(data.generated_at).toLocaleString('ru-RU')}`;
    dialog.querySelector('.stats-content').innerHTML=`
      <div class="stat-grid"><div class="stat-card"><span>Треков</span><strong>${library.tracks.toLocaleString('ru-RU')}</strong><small>${library.artists} исполнителей · ${library.albums} альбомов</small></div><div class="stat-card"><span>Длительность</span><strong>${longDuration(library.duration_seconds)}</strong><small>Оригиналы: ${bytes(library.original_bytes)}</small></div><div class="stat-card"><span>Пользователи</span><strong>${data.users.users}</strong><small>${data.users.active_sessions} активных сессий</small></div><div class="stat-card ${missing?'warn':'ok'}"><span>Целостность</span><strong>${missing?'Есть ошибки':'Всё хорошо'}</strong><small>${missing?`Не найдено файлов: ${missing}`:'Все учтённые файлы на месте'}</small></div><div class="stat-card ${metrics.worker.status==='ok'?'ok':'warn'}"><span>Worker</span><strong>${metrics.worker.status==='ok'?'Работает':'Нет heartbeat'}</strong><small>${metrics.worker.age_seconds==null?'Ещё не запускался':`Ответ ${metrics.worker.age_seconds} сек. назад`}</small></div><div class="stat-card ${metrics.api.errors_5xx?'warn':'ok'}"><span>API</span><strong>${Math.floor(metrics.api.uptime_seconds/60)} мин.</strong><small>${metrics.api.requests} запросов · ${metrics.api.errors_5xx} ошибок 5xx</small></div><div class="stat-card"><span>Память API</span><strong>${bytes(metrics.api.memory_rss_bytes)}</strong><small>RSS процесса Node.js</small></div><div class="stat-card ${metrics.summary.new_reports?'warn':'ok'}"><span>Новые отчёты</span><strong>${metrics.summary.new_reports}</strong><small>Ошибок загрузки за сутки: ${metrics.summary.upload_errors_24h}</small></div><div class="stat-card"><span>Громкость</span><strong>${loudness.values.analyzed} / ${library.tracks}</strong><small>${loudness.values.average_lufs==null?'Анализ ещё не запускался':`Среднее ${loudness.values.average_lufs} LUFS`}</small></div><div class="stat-card ${metrics.federation.peers_offline||metrics.federation.sync_errors?'warn':'ok'}"><span>Федерация</span><strong>${metrics.federation.peers_active} нод</strong><small>${metrics.federation.remote_tracks} удалённых треков · offline: ${metrics.federation.peers_offline}</small></div></div>
      <div class="stats-section"><h3>Хранилище</h3><div class="storage-bar"><span style="width:${Math.min(100,(data.disk.total_bytes-data.disk.free_bytes)/data.disk.total_bytes*100)}%"></span></div><div class="stats-lines"><span>Диск: ${bytes(data.disk.total_bytes-data.disk.free_bytes)} из ${bytes(data.disk.total_bytes)}</span><span>Свободно ${bytes(data.disk.free_bytes)}</span></div><div class="storage-parts"><span>Оригиналы <strong>${bytes(storage.originals.bytes)}</strong></span><span>Обложки <strong>${bytes(storage.covers.bytes)}</strong></span><span>AAC <strong>${bytes(storage.derived.bytes)}</strong></span><span>Временные <strong>${bytes(storage.uploads.bytes)}</strong></span></div></div>
      <div class="stats-two"><div class="stats-section"><h3>Активность</h3><div class="stats-list"><span>Прослушиваний <strong>${data.activity.plays}</strong></span><span>Сердечек <strong>${data.activity.likes}</strong></span><span>Плейлистов <strong>${data.activity.playlists}</strong></span><span>Треков с обложкой <strong>${library.with_cover}</strong></span></div></div><div class="stats-section"><h3>Очереди</h3><div class="stats-list"><span>Сейчас в работе <strong>${queueCount}</strong></span><span>Загрузки <strong>${metricQueue(metrics.queues.uploads)}</strong></span><span>Транскодирование <strong>${metricQueue(metrics.queues.transcodes)}</strong></span><span>Распознавание <strong>${metricQueue(metrics.queues.recognition)}</strong></span><span>Громкость <strong>${metricQueue(metrics.queues.loudness)}</strong></span><span>Реплики федерации <strong>${metricQueue(metrics.queues.federation_replicas)}</strong></span></div><button class="secondary" id="loudness-scan">Проанализировать библиотеку</button></div><div class="stats-section"><h3>Федерация</h3><div class="stats-list"><span>Активные / отозванные <strong>${metrics.federation.peers_active} / ${metrics.federation.peers_revoked}</strong></span><span>Ошибки sync / notify <strong>${metrics.federation.sync_errors} / ${metrics.federation.notify_errors}</strong></span><span>Удалённые лайки / плейлисты <strong>${metrics.federation.remote_likes} / ${metrics.federation.remote_playlist_tracks}</strong></span><span>Потоки вход / выход <strong>${metrics.federation.incoming_streams} / ${metrics.federation.outgoing_streams}</strong></span></div></div></div>
      <div class="stats-section"><h3>Последние ошибки</h3>${data.recent_errors.length?`<div class="error-list">${data.recent_errors.map(item=>`<div><strong>${escapeHtml(item.kind)} · ${escapeHtml(item.item)}</strong><span>${escapeHtml(item.error||'Без описания')} · ${new Date(item.updated_at).toLocaleString('ru-RU')}</span></div>`).join('')}</div>`:'<div class="stats-empty">Ошибок нет</div>'}</div>`;
    dialog.querySelector('#loudness-scan').onclick=async()=>{const result=await api('/api/v1/admin/loudness/scan',{method:'POST',body:'{}'});alert(result.queued?`Добавлено в очередь: ${result.queued}`:'Все треки уже учтены');dialog.close();showAdminStats();};
  }catch(error){dialog.querySelector('.stats-content').innerHTML=`<div class="error stats-load-error">${escapeHtml(error.message)}</div>`;}
}

function metricQueue(queue){const items=Object.entries(queue||{});return items.length?items.map(([status,item])=>`${status}: ${item.count}${item.oldest_seconds?` · старейшее ${Math.round(item.oldest_seconds/60)} мин.`:''}`).join(' · '):'пусто';}

async function showDiagnosticReports(){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog';
  dialog.innerHTML='<div class="stats-shell"><div class="stats-head"><div><div class="dialog-title">Отчёты из приложения</div><small>Последние 100 сообщений</small></div><button class="stats-close" aria-label="Закрыть">×</button></div><div class="reports-content">Загрузка…</div></div>';
  document.body.append(dialog);dialog.showModal();dialog.querySelector('.stats-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  const statusName={new:'Новый',viewed:'Просмотрен',fixed:'Исправлен'};
  const renderDetails=details=>{const track=details.track||{},player=details.player||{},queue=details.queue||{},network=details.network||{},storage=details.storage||{},events=Array.isArray(details.events)?details.events:[];return `<div class="report-facts"><span>Трек<strong>${escapeHtml([track.artist,track.title].filter(Boolean).join(' — ')||track.id||'не определён')}</strong></span><span>Плеер<strong>${player.playing?'Играет':'Остановлен'} · ${Math.round(Number(player.position_ms||0)/1000)} сек.</strong></span><span>Очередь<strong>${escapeHtml(queue.source||'Очередь')} · ${Number(queue.count||0)} треков</strong></span><span>Сеть и кэш<strong>${escapeHtml(network.transport||'—')} · ${bytes(Number(storage.cache_bytes||0))}</strong></span></div><div class="report-events">${events.length?events.map(event=>`<div>${escapeHtml(event)}</div>`).join(''):'<span class="stats-empty">Событий нет</span>'}</div>`;};
  const load=async()=>{try{const {items}=await api('/api/v1/admin/reports'),content=dialog.querySelector('.reports-content');content.innerHTML=items.length?`<div class="report-list">${items.map(item=>`<details class="report-item status-${item.status||'new'}" data-id="${item.id}"><summary><span><strong>№${item.id} · ${escapeHtml(item.description)}</strong><small>${escapeHtml(item.display_name)} · ${new Date(item.created_at).toLocaleString('ru-RU')} · Android ${escapeHtml(item.app_version)}</small></span><em>${statusName[item.status]||statusName.new}</em></summary><div class="report-device">${escapeHtml(item.device)} · ${escapeHtml(item.android_version)}</div>${renderDetails(item.details||{})}<div class="report-actions"><button class="secondary report-viewed">Просмотрен</button><button class="primary report-fixed">Исправлен</button><button class="danger report-delete">Удалить</button></div></details>`).join('')}</div>`:'<div class="stats-empty">Отчётов пока нет</div>';content.querySelectorAll('.report-item').forEach(item=>{const id=item.dataset.id;item.querySelector('.report-viewed').onclick=async()=>{await api(`/api/v1/admin/reports/${id}`,{method:'PATCH',body:JSON.stringify({status:'viewed'})});await load();};item.querySelector('.report-fixed').onclick=async()=>{await api(`/api/v1/admin/reports/${id}`,{method:'PATCH',body:JSON.stringify({status:'fixed'})});await load();};item.querySelector('.report-delete').onclick=async()=>{if(!confirm(`Удалить отчёт №${id}?`))return;await api(`/api/v1/admin/reports/${id}`,{method:'DELETE'});await load();};});}catch(error){dialog.querySelector('.reports-content').innerHTML=`<div class="error stats-load-error">${escapeHtml(error.message)}</div>`;}};
  await load();
}

function passwordDialog({title,requiresCurrent,onSubmit}){
  const dialog=document.createElement('dialog');
  dialog.innerHTML=`<form class="edit-form password-form"><div class="dialog-title">${escapeHtml(title)}</div>${requiresCurrent?'<label>Текущий пароль<input name="current_password" type="password" autocomplete="current-password" required></label>':''}<label>Новый пароль<input name="new_password" type="password" minlength="10" autocomplete="new-password" required></label><label>Повторите пароль<input name="confirmation" type="password" minlength="10" autocomplete="new-password" required></label><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary cancel-password">Отмена</button><button class="primary">Сохранить</button></div></form>`;
  document.body.append(dialog);dialog.showModal();dialog.querySelector('.cancel-password').onclick=()=>dialog.close();
  dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget)),error=event.currentTarget.querySelector('.error');error.textContent='';if(values.new_password!==values.confirmation){error.textContent='Пароли не совпадают';return;}delete values.confirmation;try{await onSubmit(values);dialog.close();}catch(problem){error.textContent=problem.message;}};
  dialog.addEventListener('close',()=>dialog.remove());
}

function changeOwnPassword(){passwordDialog({title:'Смена пароля',requiresCurrent:true,onSubmit:values=>api('/api/v1/me/password',{method:'PUT',body:JSON.stringify(values)})});}
function resetUserPassword(id,name){passwordDialog({title:`Новый пароль: ${name}`,requiresCurrent:false,onSubmit:values=>api(`/api/v1/users/${id}/password`,{method:'PUT',body:JSON.stringify(values)})});}

function switchView(view) {
  pageIndex=0;
  if(view!=='collection'){activeArtist='';activeArtistId=0;activeAlbum='';if(view!=='playlist')activePlaylist=null;}
  activeView=view;
  document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.view===view));
  document.querySelector('#sort').hidden=!['tracks','liked'].includes(view);
  document.querySelector('#search-scope').hidden=view!=='tracks';
  document.querySelector('#sort').value=sortMode;
  document.querySelector('.catalog-tools').hidden=['recognition','upload','recommendations','search'].includes(view);
  loadCurrentView();
}

function setTrackFilter(artist='',album='',artistId=0) {
  activeArtist=artist;activeArtistId=Number(artistId)||0;activeAlbum=album;activeView='collection';document.querySelectorAll('.tab').forEach(tab=>tab.classList.remove('active'));document.querySelector('.catalog-tools').hidden=true;loadCollection();
}

async function loadCurrentView() {
  renderActiveFilter();
  if(['tracks','liked','playlist'].includes(activeView)) return loadTracks();
  if(activeView==='history') return loadHistory();
  if(activeView==='playlists') return loadPlaylists();
  if(activeView==='recommendations') return loadRecommendations();
  if(activeView==='search') return loadFederationBrowser();
  if(activeView==='upload') return loadUploadView();
  if(activeView==='recognition') return loadRecognition();
  if(activeView==='collection') return loadCollection();
  return loadCatalog(activeView);
}

async function loadFederationBrowser(){
  currentQueueRequest='';const root=document.querySelector('#catalog-content');root.innerHTML='<div class="empty">Загружаем поиск…</div>';
  const nodes=await api('/api/v1/federation/nodes');
  root.innerHTML=`<section class="federation-browser"><div class="federation-search-tools"><div class="search-box">⌕<input class="federation-query" type="search" placeholder="Песня, альбом или исполнитель"></div><select class="federation-kind"><option value="tracks">Песни</option><option value="albums">Альбомы</option><option value="artists">Исполнители</option></select></div><div class="federation-node-list"><button class="secondary ${federationNode?'':'active'}" data-node="">Все серверы</button>${nodes.items.map(node=>`<button class="secondary ${federationNode===node.node_id?'active':''}" data-node="${escapeHtml(node.node_id)}">${escapeHtml(node.label||node.endpoint)} · ${node.track_count}</button>`).join('')}</div><div class="federation-play-actions" ${federationNode?'':'hidden'}><button class="primary federation-play-all">▶ Слушать всё</button><button class="secondary federation-shuffle-all">Перемешать</button></div><div class="federation-browser-results"></div></section>`;
  const query=root.querySelector('.federation-query'),kind=root.querySelector('.federation-kind'),results=root.querySelector('.federation-browser-results');let timer;
  const load=async()=>{const q=query.value.trim();if(!federationNode&&q.length<2){results.innerHTML='<div class="empty">Выберите сервер, чтобы открыть всю его музыку, или введите запрос.</div>';return;}const data=await api(`/api/v1/federation/search?q=${encodeURIComponent(q)}&node_id=${encodeURIComponent(federationNode)}&limit=100&offset=${federationPage*100}`);if(kind.value==='tracks'){renderFederationTracks(results,data.items);const pager=document.createElement('div');pager.className='catalog-pager';pager.innerHTML=`<button class="secondary prev" ${federationPage?'':'disabled'}>‹ Назад</button><span>${data.offset+1}–${data.offset+data.items.length} из ${data.total}</span><button class="secondary next" ${data.has_more?'':'disabled'}>Далее ›</button>`;results.append(pager);pager.querySelector('.prev').onclick=()=>{federationPage--;load();};pager.querySelector('.next').onclick=()=>{federationPage++;load();};return;}const items=kind.value==='albums'?data.albums:data.artists;results.innerHTML=items.length?`<div class="catalog-grid">${items.map(item=>`<button class="catalog-card federation-collection" data-name="${escapeHtml(item.name)}"><div class="catalog-cover">♫</div><div class="catalog-name">${escapeHtml(item.name)}</div><div class="catalog-meta">${kind.value==='albums'?escapeHtml(item.artist)+' · ':''}${item.track_count} треков</div></button>`).join('')}</div>`:'<div class="empty">Ничего не найдено.</div>';results.querySelectorAll('.federation-collection').forEach(button=>button.onclick=()=>{query.value=button.dataset.name;kind.value='tracks';federationPage=0;load();});};
  root.querySelectorAll('.federation-node-list button').forEach(button=>button.onclick=()=>{federationNode=button.dataset.node;federationPage=0;loadFederationBrowser();});query.oninput=()=>{federationPage=0;clearTimeout(timer);timer=setTimeout(load,180);};kind.onchange=()=>{federationPage=0;load();};load();
  const playAll=async shuffle=>{const button=shuffle?root.querySelector('.federation-shuffle-all'):root.querySelector('.federation-play-all'),label=button.textContent;button.disabled=true;button.textContent='Собираем очередь…';try{const data=await api(`/api/v1/federation/search?q=${encodeURIComponent(query.value.trim())}&node_id=${encodeURIComponent(federationNode)}&queue=1&limit=10000`);playbackFailures.clear();queue=shuffle?[...data.items].sort(()=>Math.random()-.5):data.items;if(queue.length){shuffleEnabled=shuffle;document.querySelector('#shuffle').classList.toggle('active',shuffle);playTrack(0);}}finally{button.disabled=false;button.textContent=label;}};root.querySelector('.federation-play-all')?.addEventListener('click',()=>playAll(false));root.querySelector('.federation-shuffle-all')?.addEventListener('click',()=>playAll(true));
}

function renderFederationTracks(root,items){const holder=document.querySelector('#catalog-content'),old=holder.querySelector('#tracks');old?.remove();const container=document.createElement('div');container.id='tracks';container.className='tracks';root.replaceChildren(container);displayedTracks=items;container.innerHTML=items.length?items.map(track=>`<article class="track" data-id="${track.id}"><button class="play artwork no-cover"><span>▶</span></button><div><div class="title">${escapeHtml(track.title)}</div><div class="meta">${escapeHtml(track.artist)}${track.album?` · ${escapeHtml(track.album)}`:''} · ${escapeHtml(track.source_label)}</div></div><button class="like ${track.liked?'liked':''}">${track.liked?'♥':'♡'}</button><div class="muted">${duration(track.duration_seconds)}</div><button class="edit-track">•••</button></article>`).join(''):'<div class="empty">Ничего не найдено.</div>';container.querySelectorAll('.play').forEach((button,index)=>button.onclick=()=>prepareRemotePlayback(items[index]));container.querySelectorAll('.like').forEach((button,index)=>button.onclick=async()=>{const track=items[index],next=!track.liked;await api(`/api/v1/federation/like?ref=${encodeURIComponent(track.remote_ref)}`,{method:next?'PUT':'DELETE'});track.liked=next;button.classList.toggle('liked',next);button.textContent=next?'♥':'♡';});container.querySelectorAll('.edit-track').forEach((button,index)=>button.onclick=()=>showRemoteTrack(items[index].remote_ref));}

async function loadRecommendations(){
  const root=document.querySelector('#catalog-content');root.innerHTML='<div class="empty">Собираем подборки…</div>';
  const {sections}=await api('/api/v1/recommendations');
  if(!sections.length){root.innerHTML='<div class="empty">Добавьте музыку и послушайте несколько треков — здесь появятся персональные подборки.</div>';return;}
  root.innerHTML=`<div class="recommendations">${sections.map((section,sectionIndex)=>`<section class="recommendation-section"><div class="recommendation-head"><div><h2>${escapeHtml(section.title)}</h2><small>${escapeHtml(section.subtitle)}</small></div><button class="secondary play-recommendation" data-section="${sectionIndex}">▶ Слушать</button></div><div class="recommendation-row">${section.items.map((track,trackIndex)=>`<button class="recommendation-card" data-section="${sectionIndex}" data-track="${trackIndex}"><div class="recommendation-cover ${track.cover_url?'has-cover':''}" ${track.cover_url?`style="background-image:url('${track.cover_url}')"`:''}><span>▶</span></div><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist)}</small></button>`).join('')}</div></section>`).join('')}</div>`;
  const play=(sectionIndex,trackIndex=0)=>{const items=sections[sectionIndex].items;if(!items.length)return;queue=[...items];displayedTracks=items;playTrack(trackIndex);};
  root.querySelectorAll('.play-recommendation').forEach(button=>button.onclick=()=>play(Number(button.dataset.section)));
  root.querySelectorAll('.recommendation-card').forEach(card=>card.onclick=()=>play(Number(card.dataset.section),Number(card.dataset.track)));
  updatePlayingState();if(!playerRestored)restorePlayer();
}

function loadUploadView(){
  const root=document.querySelector('#catalog-content');
  root.innerHTML=`<section class="upload-view"><div class="upload-view-head"><div><strong>Добавить музыку</strong><small>Файлы сохраняются в общей семейной библиотеке</small></div><div class="upload-buttons"><label class="primary upload">＋ Выбрать файлы<input id="files" type="file" accept="audio/*" multiple></label><label class="secondary upload">Выбрать папку<input id="folder" type="file" accept="audio/*" webkitdirectory directory multiple></label></div></div><div class="drop-zone" id="drop-zone"><strong>Перетащите музыку сюда</strong><small>Можно сразу несколько файлов или целую папку</small></div><section class="upload-panel" id="progress"><div class="upload-panel-head"><div><strong id="progress-text">Подготовка…</strong><small id="upload-summary"></small></div><div class="upload-panel-actions"><button class="secondary" id="retry-uploads">Повторить ошибки</button><button class="secondary" id="clear-uploads">Убрать готовые</button></div></div><div class="bar"><span id="progress-bar"></span></div><div class="upload-list" id="upload-list"></div></section></section>`;
  root.querySelector('#files').onchange=event=>{enqueueUploads([...event.target.files]);event.target.value='';};
  root.querySelector('#folder').onchange=event=>{enqueueUploads([...event.target.files]);event.target.value='';};
  root.querySelector('#retry-uploads').onclick=retryFailedUploads;
  root.querySelector('#clear-uploads').onclick=clearFinishedUploads;
  setupUploadDropZone();renderUploadQueue();
}

async function loadRecognition(){
  const root=document.querySelector('#catalog-content'),data=await api('/api/v1/recognition');
  const states=data.states||{},working=(states.queued||0)+(states.processing||0)+(states.retry||0),problems=(states.failed||0)+(states.unmatched||0),review=states.review||0;
  root.innerHTML=`<div class="recognition-head"><div><strong>Распознавание музыки</strong><small>${data.enabled?'Работает в фоне после загрузки':'Сервис отключён в настройках'}</small></div><div class="recognition-head-actions"><button class="secondary" id="recognition-retry-all">Повторить ошибки</button><button class="secondary" id="recognition-scan">Найти файлы без тегов</button></div></div><div class="recognition-summary"><span><strong>${working}</strong> в работе</span><span><strong>${review}</strong> ждут решения</span><span><strong>${problems}</strong> не распознано</span><span><strong>${states.applied||0}</strong> применено</span></div><div class="recognition-bulk"><label><input type="checkbox" id="recognition-select-visible"> Выбрать показанные</label><span id="recognition-selected">Выбрано: 0</span><button class="primary" data-bulk="apply" disabled>Применить варианты</button><button class="secondary" data-bulk="metadata" disabled>Общие метаданные</button><button class="secondary" data-bulk="retry" disabled>Повторить</button><button class="secondary" data-bulk="ignore" disabled>Убрать</button></div><div class="recognition-filters"><button class="active" data-filter="all">Все</button><button data-filter="working">В работе</button><button data-filter="unresolved">Не найдено</button><button data-filter="review">Низкая уверенность</button><button data-filter="cover">Без обложки</button></div><div class="recognition-list">${data.items.length?data.items.map(item=>{
    const state={queued:'Ожидает',processing:'Распознаётся',retry:'Повторим позже',unmatched:'Не найдено',failed:'Ошибка',ignored:'Отклонено',applied:'Распознано'}[item.status]||'Нужно подтверждение';
    const options=item.candidates.map((candidate,index)=>`<option value="${index}">${escapeHtml(candidate.artist)} — ${escapeHtml(candidate.title)}${candidate.album?` · ${escapeHtml(candidate.album)}`:''}${candidate.year?` · ${candidate.year}`:''} · ${Math.round(candidate.confidence*100)}%</option>`).join('');
    return `<article class="recognition-item" data-id="${item.id}" data-status="${item.status}" data-cover="${item.cover_url?'1':'0'}"><input class="recognition-select" type="checkbox" aria-label="Выбрать ${escapeHtml(item.filename)}"><div><strong>${escapeHtml(item.filename)}</strong><small>Сейчас: ${escapeHtml(item.artist)} — ${escapeHtml(item.title)}${item.album?` · ${escapeHtml(item.album)}`:''}${item.year?` · ${item.year}`:''} · ${duration(item.duration_seconds)}</small></div>${item.status==='review'?`<select class="recognition-choice">${options}</select>`:`<div class="recognition-state">${escapeHtml(item.status==='applied'&&!item.cover_url?'Распознано, но обложка не найдена':state)}${item.error?` · ${escapeHtml(item.error)}`:''}</div>`}<div class="recognition-actions">${item.status==='review'?'<button class="primary recognition-apply">Применить</button>':''}${['failed','unmatched','ignored'].includes(item.status)?'<button class="secondary recognition-retry">Повторить</button>':''}<button class="secondary recognition-manual">Ввести вручную</button>${item.status!=='applied'?'<button class="secondary recognition-ignore">Убрать</button>':''}</div></article>`;
  }).join(''):'<div class="empty">Треков, требующих внимания, нет.</div>'}</div>`;
  root.querySelector('#recognition-scan').onclick=async()=>{await api('/api/v1/recognition/scan',{method:'POST',body:'{}'});setTimeout(loadRecognition,700);};
  root.querySelector('#recognition-retry-all').onclick=async()=>{const result=await api('/api/v1/recognition/retry-all',{method:'POST',body:'{}'});alert(`Поставлено в очередь: ${result.queued}`);loadRecognition();};
  const updateSelection=()=>{const selected=[...root.querySelectorAll('.recognition-select:checked')];root.querySelector('#recognition-selected').textContent=`Выбрано: ${selected.length}`;root.querySelectorAll('[data-bulk]').forEach(button=>button.disabled=!selected.length);};
  root.querySelectorAll('.recognition-select').forEach(box=>box.onchange=updateSelection);
  root.querySelector('#recognition-select-visible').onchange=event=>{root.querySelectorAll('.recognition-item:not([hidden]) .recognition-select').forEach(box=>box.checked=event.target.checked);updateSelection();};
  root.querySelectorAll('.recognition-filters button').forEach(button=>button.onclick=()=>{root.querySelectorAll('.recognition-filters button').forEach(item=>item.classList.toggle('active',item===button));root.querySelectorAll('.recognition-item').forEach(row=>{const filter=button.dataset.filter,status=row.dataset.status;row.hidden=filter==='working'?!['queued','processing','retry'].includes(status):filter==='unresolved'?!['unmatched','failed','ignored'].includes(status):filter==='review'?status!=='review':filter==='cover'?row.dataset.cover==='1':false;});root.querySelector('#recognition-select-visible').checked=false;});
  const selectedIds=()=>[...root.querySelectorAll('.recognition-select:checked')].map(box=>Number(box.closest('.recognition-item').dataset.id));
  root.querySelectorAll('[data-bulk]').forEach(button=>button.onclick=async()=>{const ids=selectedIds(),action=button.dataset.bulk;if(action==='metadata')return bulkRecognitionMetadata(ids);if(!confirm(`${action==='apply'?'Применить первые предложенные варианты':action==='retry'?'Повторить распознавание': 'Убрать из списка'} для ${ids.length} треков?`))return;const result=await api('/api/v1/recognition/bulk',{method:'POST',body:JSON.stringify({ids,action})});alert(`Обработано: ${result.updated}${result.skipped?` · пропущено: ${result.skipped}`:''}`);loadRecognition();});
  root.querySelectorAll('.recognition-item').forEach((row,index)=>{const id=row.dataset.id,choice=row.querySelector('.recognition-choice'),item=data.items[index];const call=async(action,body={})=>{await api(`/api/v1/recognition/${id}/${action}`,{method:'POST',body:JSON.stringify(body)});await loadRecognition();};row.querySelector('.recognition-apply')?.addEventListener('click',()=>call('apply',{candidate:Number(choice.value)}));row.querySelector('.recognition-ignore')?.addEventListener('click',()=>call('ignore'));row.querySelector('.recognition-retry')?.addEventListener('click',()=>call('retry'));row.querySelector('.recognition-manual')?.addEventListener('click',()=>manualRecognition(item,call));});
}

function bulkRecognitionMetadata(ids){
  const dialog=document.createElement('dialog');dialog.innerHTML=`<form class="edit-form"><div class="dialog-title">Общие метаданные · ${ids.length} треков</div><small class="settings-hint">Заполненные поля заменят значения у всех выбранных треков. Пустые останутся без изменений.</small><label>Исполнитель<input name="artist"></label><label>Альбом<input name="album"></label><div class="form-row"><label>Жанр<input name="genre"></label><label>Год<input name="year" type="number" min="1000" max="9999"></label></div><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary bulk-cancel">Отмена</button><button class="primary">Применить</button></div></form>`;document.body.append(dialog);dialog.showModal();dialog.querySelector('.bulk-cancel').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const error=event.currentTarget.querySelector('.error'),fields=Object.fromEntries(new FormData(event.currentTarget));try{const result=await api('/api/v1/recognition/bulk',{method:'POST',body:JSON.stringify({ids,action:'metadata',fields})});dialog.close();alert(`Обновлено: ${result.updated}`);loadRecognition();}catch(problem){error.textContent=problem.message;}};
}

function manualRecognition(item,save){
  const dialog=document.createElement('dialog');dialog.innerHTML=`<form class="edit-form"><div class="dialog-title">Заполнить метаданные</div><label>Название<input name="title" value="${escapeHtml(item.title)}" required></label><label>Исполнитель<input name="artist" value="${escapeHtml(item.artist==='Неизвестный исполнитель'?'':item.artist)}" required></label><label>Альбом<input name="album" value="${escapeHtml(item.album||'')}"></label><div class="form-row"><label>Жанр<input name="genre" value="${escapeHtml(item.genre||'')}"></label><label>Год<input name="year" type="number" min="1000" max="9999" value="${item.year||''}"></label></div><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary manual-cancel">Отмена</button><button class="primary">Сохранить</button></div></form>`;document.body.append(dialog);dialog.showModal();dialog.querySelector('.manual-cancel').onclick=()=>dialog.close();dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const error=event.currentTarget.querySelector('.error');try{await save('manual',Object.fromEntries(new FormData(event.currentTarget)));dialog.close();}catch(problem){error.textContent=problem.message;}};dialog.addEventListener('close',()=>dialog.remove());
}

function renderActiveFilter() {
  const target=document.querySelector('#active-filter');
  const value=activePlaylist ? `Плейлист: ${activePlaylist.title}` : activeAlbum ? `Альбом: ${activeAlbum}` : activeArtist ? `Исполнитель: ${activeArtist}` : '';
  target.innerHTML=value ? `<button id="clear-filter">${escapeHtml(value)} ×</button>${activePlaylist?'<button id="manage-playlist" class="secondary">Настроить</button>':''}${activeAlbum?'<button id="manage-album" class="secondary">Оформить альбом</button>':''}` : '';
  if(value) document.querySelector('#clear-filter').onclick=()=>{activeArtist='';activeArtistId=0;activeAlbum='';activePlaylist=null;switchView('tracks');};
  if(activePlaylist)document.querySelector('#manage-playlist').onclick=async()=>{const title=prompt('Новое название плейлиста. Пустое значение удалит плейлист.',activePlaylist.title);if(title===null)return;if(!title.trim()){if(confirm(`Удалить плейлист «${activePlaylist.title}»?`)){await api(`/api/v1/playlists/${activePlaylist.id}`,{method:'DELETE'});activePlaylist=null;switchView('playlists');}}else{await api(`/api/v1/playlists/${activePlaylist.id}`,{method:'PATCH',body:JSON.stringify({title})});activePlaylist.title=title.trim();renderActiveFilter();}};
  if(activeAlbum)document.querySelector('#manage-album').onclick=()=>{if(displayedTracks.length<2)return alert('Для оформления нужно минимум два трека');editUploadedAlbum({name:activeAlbum,tasks:displayedTracks.map(track=>({status:'ready',trackId:track.id,discNumber:track.disc_number,trackNumber:track.track_number,file:{name:track.filename||track.title,webkitRelativePath:track.filename||track.title},albumDone:false}))});};
}

function setupPlayer() {
  const player=document.querySelector('#player'), toggle=document.querySelector('#toggle'), seek=document.querySelector('#seek'), volume=document.querySelector('#volume');
  const savedVolume=Number(localStorage.getItem('music-volume') ?? 0.8);player.volume=savedVolume;volume.value=savedVolume;
  const normalization=document.querySelector('#normalization');normalization.classList.toggle('active',localStorage.getItem('music-normalization')==='1');
  normalization.onclick=()=>{const enabled=localStorage.getItem('music-normalization')!=='1';localStorage.setItem('music-normalization',enabled?'1':'0');normalization.classList.toggle('active',enabled);enableWebAudio();};
  toggle.onclick=()=>{ enableWebAudio();if(currentIndex<0&&queue.length) return playTrack(0); player.paused ? player.play() : player.pause(); };
  document.querySelector('#previous').onclick=()=>advanceTrack(-1);
  document.querySelector('#next').onclick=()=>advanceTrack(1);
  document.querySelector('#shuffle').onclick=()=>{shuffleEnabled=!shuffleEnabled;document.querySelector('#shuffle').classList.toggle('active',shuffleEnabled);scheduleStateSave();};
  document.querySelector('#repeat').onclick=()=>{repeatMode=repeatMode==='off'?'all':repeatMode==='all'?'one':'off';const button=document.querySelector('#repeat');button.classList.toggle('active',repeatMode!=='off');button.textContent=repeatMode==='one'?'↻1':'↻';button.title={off:'Повтор выключен',all:'Повтор очереди',one:'Повтор трека'}[repeatMode];scheduleStateSave();};
  player.onplay=()=>{ toggle.textContent='❚❚'; toggle.title='Пауза'; if('mediaSession' in navigator)navigator.mediaSession.playbackState='playing'; updatePlayingState(); };
  player.onpause=()=>{ toggle.textContent='▶'; toggle.title='Воспроизвести'; if('mediaSession' in navigator)navigator.mediaSession.playbackState='paused'; updatePlayingState(); };
  player.onended=()=>{playbackFailures.delete(queue[currentIndex]?.id);if(repeatMode==='one')playTrack(currentIndex);else advanceTrack(1,true);};
  player.onerror=()=>{const failed=queue[currentIndex];if(!failed?.remote)return;playbackFailures.add(failed.id);clearTimeout(playbackErrorTimer);playbackErrorTimer=setTimeout(()=>{if(queue[currentIndex]?.id===failed.id)advanceTrack(1,true);},250);};
  player.ontimeupdate=()=>{ if(!player.duration)return; seek.value=String(Math.round(player.currentTime/player.duration*1000)); document.querySelector('#elapsed').textContent=duration(player.currentTime);if(Date.now()-lastPositionSave>3000){lastPositionSave=Date.now();localStorage.setItem('music-position',String(player.currentTime));updateMediaPosition();scheduleStateSave();} };
  player.onloadedmetadata=()=>{ document.querySelector('#total').textContent=duration(player.duration); };
  seek.oninput=()=>{ if(player.duration) player.currentTime=Number(seek.value)/1000*player.duration; };
  volume.oninput=()=>{localStorage.setItem('music-volume',volume.value);if(audioGain)applyWebGain();else player.volume=Number(volume.value);};
  setupMediaSession();
}

function advanceTrack(direction,automatic=false){
  if(!queue.length)return;
  const playable=(track,index)=>index!==currentIndex&&track.stream_available!==false&&!playbackFailures.has(track.id);
  if(shuffleEnabled&&queue.length>1){const choices=queue.map((track,index)=>({track,index})).filter(item=>playable(item.track,item.index));if(choices.length)return playTrack(choices[Math.floor(Math.random()*choices.length)].index);return;}
  const wrap=repeatMode==='all'||!automatic;
  for(let step=1;step<=queue.length;step++){const candidate=currentIndex+direction*step;if(!wrap&&(candidate<0||candidate>=queue.length))break;const index=(candidate%queue.length+queue.length)%queue.length;if(playable(queue[index],index))return playTrack(index);}
}

function scheduleStateSave(){clearTimeout(stateSaveTimer);stateSaveTimer=setTimeout(()=>{const player=document.querySelector('#player'),track=queue[currentIndex];api('/api/v1/playback-state',{method:'PUT',body:JSON.stringify({track_id:track?.id??null,position_seconds:player?.currentTime??0,queue:queue.map(item=>item.id),shuffle:shuffleEnabled,repeat_mode:repeatMode})}).catch(()=>{});},500);}

function playTrack(index) {
  if(!queue.length || index<0) return;
  currentIndex=index;
  const track=queue[index], player=document.querySelector('#player');
  if(track.remote&&track.stream_available===false){playbackFailures.add(track.id);return advanceTrack(1,true);}
  document.querySelector('#now-title').textContent=track.title;
  document.querySelector('#now-artist').textContent=track.artist || 'Неизвестный исполнитель';
  const cover=document.querySelector('#now-cover');
  cover.style.backgroundImage=track.cover_url ? `url("${track.cover_url}")` : '';
  cover.textContent=track.cover_url ? '' : '♫';
  updatePlayerLike(track);
  document.querySelector('#player-bar').classList.add('active');
  player.src=track.remote?track.stream_url:`/api/v1/tracks/${track.id}/stream`;
  applyWebGain();
  localStorage.setItem('music-track-id',track.id);localStorage.setItem('music-position','0');
  if(!track.remote)api('/api/v1/history',{method:'POST',body:JSON.stringify({track_id:track.id})}).catch(()=>{});
  scheduleStateSave();
  player.play().catch(()=>{});
  updateMediaSession(track);
  renderQueue();
  updatePlayingState();
}

async function restorePlayer(){
  playerRestored=true;let state;try{state=await api('/api/v1/playback-state');}catch{}
  const id=state?.track_id||localStorage.getItem('music-track-id');if(!id)return;
  if(state?.queue?.length){let candidates=queue;try{candidates=(await api('/api/v1/tracks/resolve',{method:'POST',body:JSON.stringify({ids:state.queue})})).items;}catch{}const byId=new Map(candidates.map(track=>[track.id,track]));const restored=state.queue.map(id=>byId.get(id)).filter(Boolean);if(restored.length)queue=restored;}
  shuffleEnabled=Boolean(state?.shuffle);repeatMode=state?.repeat_mode||'off';document.querySelector('#shuffle').classList.toggle('active',shuffleEnabled);const repeat=document.querySelector('#repeat');repeat.classList.toggle('active',repeatMode!=='off');repeat.textContent=repeatMode==='one'?'↻1':'↻';
  const index=queue.findIndex(track=>track.id===id);if(index<0)return;
  currentIndex=index;const track=queue[index],player=document.querySelector('#player'),position=Number(state?.position_seconds??localStorage.getItem('music-position')??0);
  document.querySelector('#now-title').textContent=track.title;document.querySelector('#now-artist').textContent=track.artist||'Неизвестный исполнитель';
  const cover=document.querySelector('#now-cover');cover.style.backgroundImage=track.cover_url?`url("${track.cover_url}")`:'';cover.textContent=track.cover_url?'':'♫';
  updatePlayerLike(track);
  document.querySelector('#player-bar').classList.add('active');player.addEventListener('loadedmetadata',()=>{if(position>0&&position<player.duration)player.currentTime=position;updateMediaPosition();},{once:true});player.src=track.remote?track.stream_url:`/api/v1/tracks/${track.id}/stream`;updateMediaSession(track);renderQueue();updatePlayingState();
}

function updatePlayerLike(track){
  const button=document.querySelector('#player-like');if(!button)return;
  button.classList.toggle('liked',Boolean(track?.liked));button.textContent=track?.liked?'♥':'♡';button.disabled=!track;button.title='Мне нравится';
}

async function toggleCurrentLike(){
  const track=queue[currentIndex];if(!track)return;
  const next=!track.liked;
  try{
    await api(track.remote?`/api/v1/federation/like?ref=${encodeURIComponent(track.remote_ref)}`:`/api/v1/tracks/${track.id}/like`,{method:next?'PUT':'DELETE'});
    queue.filter(item=>item.id===track.id).forEach(item=>item.liked=next);
    displayedTracks.filter(item=>item.id===track.id).forEach(item=>item.liked=next);
    updatePlayerLike(track);
    if(activeView==='liked'&&!next)await loadTracks();
    else document.querySelectorAll(`.track[data-id="${track.id}"] .like`).forEach(button=>{button.classList.toggle('liked',next);button.textContent=next?'♥':'♡';});
  }catch(error){alert(error.message);}
}

function setupMediaSession(){
  if(!('mediaSession' in navigator))return;
  const player=document.querySelector('#player');
  const handlers={
    play:()=>player.play(), pause:()=>player.pause(), previoustrack:()=>advanceTrack(-1), nexttrack:()=>advanceTrack(1),
    seekbackward:event=>{player.currentTime=Math.max(0,player.currentTime-(event.seekOffset||10));},
    seekforward:event=>{player.currentTime=Math.min(player.duration||Infinity,player.currentTime+(event.seekOffset||10));},
    seekto:event=>{if(Number.isFinite(event.seekTime))player.currentTime=event.seekTime;}
  };
  Object.entries(handlers).forEach(([action,handler])=>{try{navigator.mediaSession.setActionHandler(action,handler);}catch{}});
}

function updateMediaSession(track){
  if(!('mediaSession' in navigator)||!('MediaMetadata' in window))return;
  navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.artist||'Неизвестный исполнитель',album:track.album||'Family Music',artwork:track.cover_url?[{src:new URL(track.cover_url,location.origin).href}]:[]});
}

function updateMediaPosition(){
  const player=document.querySelector('#player');
  if(!('mediaSession' in navigator)||!navigator.mediaSession.setPositionState||!Number.isFinite(player.duration)||player.duration<=0)return;
  try{navigator.mediaSession.setPositionState({duration:player.duration,playbackRate:player.playbackRate,position:Math.min(player.currentTime,player.duration)});}catch{}
}

function updatePlayingState() {
  const player=document.querySelector('#player');
  const currentId=queue[currentIndex]?.id;
  document.querySelectorAll('.track').forEach(row=>{
    const active=row.dataset.id===String(currentId);
    row.classList.toggle('playing',active);
    const button=row.querySelector('.play');
    const icon=button.querySelector('span');
    if(icon) icon.textContent=active&&!player.paused ? '❚❚' : '▶';
  });
  renderQueue();
}

function renderQueue(){
  const list=document.querySelector('#queue-list'),count=document.querySelector('#queue-count');
  if(!list||!count)return;
  count.textContent=queue.length?`${queue.length} треков`:'';
  if(!queue.length){list.innerHTML='<div class="queue-empty">Очередь пуста</div>';return;}
  list.innerHTML=queue.map((track,index)=>`<article class="queue-item ${index===currentIndex?'current':''}" data-index="${index}">
    <button class="queue-play" aria-label="Воспроизвести"><span class="queue-cover" ${track.cover_url?`style="background-image:url('${track.cover_url}')"`:''}>${track.cover_url?'':'♫'}</span><span class="queue-text"><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist||'Неизвестный исполнитель')}</small></span></button>
    <div class="queue-actions"><button class="queue-up" title="Выше" ${index===0?'disabled':''}>↑</button><button class="queue-down" title="Ниже" ${index===queue.length-1?'disabled':''}>↓</button><button class="queue-remove" title="Убрать">×</button></div></article>`).join('');
  list.querySelectorAll('.queue-play').forEach((button,index)=>button.onclick=()=>playTrack(index));
  list.querySelectorAll('.queue-up').forEach((button,index)=>button.onclick=()=>moveQueueItem(index,index-1));
  list.querySelectorAll('.queue-down').forEach((button,index)=>button.onclick=()=>moveQueueItem(index,index+1));
  list.querySelectorAll('.queue-remove').forEach((button,index)=>button.onclick=()=>removeQueueItem(index));
}

function moveQueueItem(from,to){
  if(to<0||to>=queue.length)return;
  const currentId=queue[currentIndex]?.id;
  const [item]=queue.splice(from,1);queue.splice(to,0,item);
  currentIndex=queue.findIndex(track=>track.id===currentId);
  renderQueue();scheduleStateSave();
}

function removeQueueItem(index){
  const player=document.querySelector('#player'),wasCurrent=index===currentIndex;
  queue.splice(index,1);
  if(!queue.length){player.pause();player.removeAttribute('src');currentIndex=-1;document.querySelector('#player-bar').classList.remove('active');}
  else if(wasCurrent){currentIndex=Math.min(index,queue.length-1);playTrack(currentIndex);}
  else if(index<currentIndex)currentIndex--;
  renderQueue();updatePlayingState();scheduleStateSave();
}

function playNext(track){
  const existing=queue.findIndex(item=>item.id===track.id);
  if(existing===currentIndex)return;
  if(existing>=0){queue.splice(existing,1);if(existing<currentIndex)currentIndex--;}
  const position=currentIndex>=0?currentIndex+1:0;
  queue.splice(position,0,track);
  renderQueue();scheduleStateSave();
}

async function loadTracks() {
  const params=new URLSearchParams({sort:sortMode,limit:String(pageSize),offset:String(pageIndex*pageSize)});
  if(searchQuery)params.set('q',searchQuery); if(activeArtist)params.set('artist',activeArtist); if(activeAlbum)params.set('album',activeAlbum);
  if(activeView==='liked')params.set('liked','1'); if(activePlaylist)params.set('playlist_id',activePlaylist.id);
  const queueParams=new URLSearchParams(params);queueParams.set('queue','1');queueParams.set('limit','10000');queueParams.set('offset','0');if(activeView==='tracks'){params.set('scope',searchScope);queueParams.set('scope',searchScope);}currentQueueRequest=activeView==='liked'?`/api/v1/favorites?${queueParams}`:activeView==='tracks'?`/api/v1/library?${queueParams}`:`/api/v1/tracks?${queueParams}`;
  const data=activeView==='liked'?await api(`/api/v1/favorites?${params}`):activeView==='tracks'?await api(`/api/v1/library?${params}`):await api(`/api/v1/tracks?${params}`);
  if(activePlaylist&&pageIndex===0){try{const remote=await api(`/api/v1/playlists/${activePlaylist.id}/remote`);data.items.push(...remote.items);data.total=Number(data.total||0)+remote.items.length;}catch{}}
  renderTracks(data.items,searchQuery?'Совпадений не найдено.':'Треки не найдены.');renderPager(data,loadTracks);
}

function remoteReplicaText(track){
  if(track.replica_status==='imported')return 'Трек уже импортирован в локальную библиотеку';
  if(track.replica_status==='ready')return `Оригинал сохранён на этом сервере · ${bytes(track.replica_size_bytes||0)}`;
  if(track.replica_status==='downloading'){
    const percent=track.replica_size_bytes?Math.min(100,Math.round(Number(track.replica_received_bytes||0)*100/Number(track.replica_size_bytes))):0;
    return `Сохранение на сервер · ${percent}%`;
  }
  if(track.replica_status==='queued')return 'Оригинал поставлен в очередь сохранения';
  if(track.replica_status==='retry')return `Origin временно недоступен, повтор будет автоматически${track.replica_error?` · ${track.replica_error}`:''}`;
  return track.liked?'Локальная копия ещё не создана':'После лайка оригинал автоматически сохранится на этом сервере';
}

async function showRemoteTrack(reference){
  const dialog=document.createElement('dialog');dialog.className='stats-dialog remote-track-dialog';dialog.innerHTML='<div class="stats-shell"><div class="stats-head"><div><div class="dialog-title">Удалённый трек</div><small>Загрузка…</small></div><button class="stats-close" aria-label="Закрыть">×</button></div></div>';document.body.append(dialog);dialog.showModal();dialog.querySelector('.stats-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  try{
    const track=await api(`/api/v1/federation/track?ref=${encodeURIComponent(reference)}`),shell=dialog.querySelector('.stats-shell');
    if(track.replica_status==='imported'&&track.local_track_id){const resolved=await api('/api/v1/tracks/resolve',{method:'POST',body:JSON.stringify({ids:[track.local_track_id]})});dialog.close();if(resolved.items?.[0])editTrack(resolved.items[0]);return;}
    const replicaAction=track.liked&&track.replica_status!=='imported'?`<button class="secondary remote-replica">Повторить импорт</button>`:'';
    shell.innerHTML=`<div class="stats-head"><div><div class="dialog-title">${escapeHtml(track.title)}</div><small>${escapeHtml(track.artist)}</small></div><button class="stats-close" aria-label="Закрыть">×</button></div><div class="remote-track-card"><div class="collection-cover">♫</div><div><strong>${escapeHtml(track.album||'Без альбома')}</strong><span>${track.year||'Год не указан'} · ${duration(track.duration_seconds)}</span><span>Источник: ${escapeHtml(track.source_label)}</span><span>${track.sync_error?'Источник временно недоступен':'Метаданные синхронизированы'}</span><span>${escapeHtml(remoteReplicaText(track))}</span><div class="remote-card-actions"><button class="primary remote-play">▶ Слушать</button><button class="secondary remote-like">${track.liked?'♥ В «Мне нравится»':'♡ Нравится'}</button><button class="secondary remote-playlist">＋ В плейлист</button>${replicaAction}</div></div></div><div class="settings-hint">Лайк персональный, а сохранённый оригинал один для всех пользователей домашнего сервера.</div>${track.related.length?`<div class="remote-related"><strong>Связанные треки</strong>${track.related.map(item=>`<button data-ref="${item.remote_ref}"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(item.artist)}${item.album?` · ${escapeHtml(item.album)}`:''}</small></button>`).join('')}</div>`:''}`;
    shell.querySelector('.stats-close').onclick=()=>dialog.close();
    shell.querySelector('.remote-play').onclick=async()=>{await prepareRemotePlayback({...track,cover_url:null});dialog.close();};
    shell.querySelector('.remote-like').onclick=async()=>{const next=!track.liked;try{await api(`/api/v1/federation/like?ref=${encodeURIComponent(track.remote_ref)}`,{method:next?'PUT':'DELETE'});dialog.close();showRemoteTrack(reference);}catch(error){alert(error.message);}};
    shell.querySelector('.remote-replica')?.addEventListener('click',async()=>{try{await api(`/api/v1/federation/replica?ref=${encodeURIComponent(track.remote_ref)}`,{method:'POST',body:'{}'});dialog.close();showRemoteTrack(reference);}catch(error){alert(error.message);}});
    shell.querySelector('.remote-playlist').onclick=async()=>{const {items}=await api('/api/v1/playlists?limit=200');if(!items.length)return alert('Сначала создайте плейлист');const answer=prompt(items.map((item,index)=>`${index+1}. ${item.title}`).join('\n')+'\n\nВведите номер плейлиста');const playlist=items[Number(answer)-1];if(playlist){await api(`/api/v1/playlists/${playlist.id}/remote?ref=${encodeURIComponent(track.remote_ref)}`,{method:'POST',body:'{}'});alert(`Добавлено в «${playlist.title}»`);}};
    shell.querySelectorAll('.remote-related button').forEach(button=>button.onclick=()=>{dialog.close();showRemoteTrack(button.dataset.ref);});
  }catch(error){dialog.querySelector('.stats-head small').textContent=error.message;}
}

async function prepareRemotePlayback(track){
  playbackFailures.clear();
  if(track.stream_available===false)throw new Error(track.availability==='revoked'?'Доверие к исходной ноде отозвано':'Исходная нода сейчас недоступна');
  track.stream_url=`/api/v1/federation/stream?ref=${encodeURIComponent(track.remote_ref)}&quality=original`;queue=[track];playTrack(0);
}

async function loadCollection(){
  currentQueueRequest='';
  const params=new URLSearchParams({sort:activeAlbum?'album':'title',queue:'1',limit:'10000',artist:activeArtist});if(activeAlbum)params.set('album',activeAlbum);
  const [{items},artistCard]=await Promise.all([api(`/api/v1/tracks?${params}`),!activeAlbum&&activeArtistId?api(`/api/v1/artists/${activeArtistId}`):Promise.resolve(null)]),seconds=items.reduce((sum,item)=>sum+Number(item.duration_seconds||0),0),cover=artistCard?.image_url||items.find(item=>item.cover_url)?.cover_url||'';
  displayedTracks=items;const kind=activeAlbum?'Альбом':'Исполнитель',subtitle=activeAlbum?`${activeArtist}${items[0]?.year?` · ${items[0].year}`:''}`:`${items.length} ${items.length===1?'трек':'треков'}`,backView=activeAlbum?'albums':'artists';
  const cardMeta=artistCard?`${artistCard.album_count} альбомов · ${artistCard.featured_count} feat. · ${artistCard.play_count} просл.`:'';
  const artistAlbums=artistCard?.albums?.length?`<div class="artist-albums">${artistCard.albums.map(album=>`<button class="secondary" data-album="${escapeHtml(album.name)}">${escapeHtml(album.name)} · ${album.track_count}</button>`).join('')}</div>`:'';
  const header=`<section class="collection-hero"><button class="collection-back">‹</button><div class="collection-cover" ${cover?`style="background-image:url('${cover}')"`:''}>${cover?'':'♫'}</div><div class="collection-info"><small>${kind}</small><h2>${escapeHtml(activeAlbum||activeArtist)}</h2><span>${escapeHtml(subtitle)} · ${longDuration(seconds)}${cardMeta?` · ${escapeHtml(cardMeta)}`:''}</span>${artistCard?.bio?`<p class="artist-bio">${escapeHtml(artistCard.bio)}</p>`:''}${artistAlbums}<div><button class="primary collection-play">▶ Слушать</button><button class="secondary collection-shuffle">Перемешать</button>${activeAlbum?'<button class="secondary collection-edit">✎ Редактировать</button>':artistCard&&sessionUser?.is_admin?'<button class="secondary artist-edit">✎ Карточка</button>':''}</div></div></section>`;
  renderTracks(items,'В этой коллекции нет треков.',header);const root=document.querySelector('#catalog-content');
  root.querySelector('.collection-back').onclick=()=>{activeArtist='';activeArtistId=0;activeAlbum='';switchView(backView);};
  root.querySelector('.collection-play').onclick=()=>{if(!items.length)return;queue=[...items];playTrack(0);};
  root.querySelector('.collection-shuffle').onclick=()=>{if(!items.length)return;queue=[...items].sort(()=>Math.random()-.5);shuffleEnabled=true;document.querySelector('#shuffle').classList.add('active');playTrack(0);};
  if(activeAlbum)root.querySelector('.collection-edit').onclick=()=>editExistingAlbum(items);
  if(artistCard&&sessionUser?.is_admin)root.querySelector('.artist-edit').onclick=()=>editArtistCard(artistCard);
  root.querySelectorAll('.artist-albums button').forEach(button=>button.onclick=()=>{activeAlbum=button.dataset.album;loadCollection();});
}

async function loadHistory(){currentQueueRequest='/api/v1/history?limit=200&offset=0';const data=await api(`/api/v1/history?limit=${pageSize}&offset=${pageIndex*pageSize}`);renderTracks(data.items,'История пока пуста.');renderPager(data,loadHistory);}

function renderPager(data,reload){
  const total=Number(data.total||0),start=total?Number(data.offset||0)+1:0,end=Number(data.offset||0)+(data.items?.length||0),pages=Math.max(1,Math.ceil(total/Number(data.limit||pageSize)));
  const pager=document.createElement('div');pager.className='catalog-pager';pager.innerHTML=`<button class="secondary pager-prev" ${pageIndex<=0?'disabled':''}>‹ Назад</button><span>${start}–${end} из ${total.toLocaleString('ru-RU')} · страница ${pageIndex+1} из ${pages}</span><button class="secondary pager-next" ${data.has_more?'':'disabled'}>Далее ›</button>`;document.querySelector('#catalog-content').append(pager);
  pager.querySelector('.pager-prev').onclick=()=>{if(pageIndex>0){pageIndex--;reload();scrollTo({top:0,behavior:'smooth'});}};pager.querySelector('.pager-next').onclick=()=>{if(data.has_more){pageIndex++;reload();scrollTo({top:0,behavior:'smooth'});}};
}

function renderTracks(items,emptyMessage,header=''){
  displayedTracks = items;
  if(!queue.length)queue=[...items];
  const root=document.querySelector('#catalog-content');
  root.innerHTML=header+'<div class="tracks" id="tracks"></div>';
  const container = document.querySelector('#tracks');
  if (!items.length) { container.innerHTML = `<div class="empty">${escapeHtml(emptyMessage)}</div>`; if(!playerRestored)restorePlayer(); return; }
  container.innerHTML = items.map(track => `<article class="track ${track.stream_available===false?'unavailable':''}" data-id="${track.id}"><button class="play artwork ${track.cover_url?'has-cover':'no-cover'}" data-id="${track.id}" ${track.cover_url ? `style="background-image:url('${track.cover_url}')"` : ''} aria-label="Воспроизвести ${escapeHtml(track.title)}" ${track.stream_available===false?'disabled':''}><span>${track.stream_available===false?'!':'▶'}</span></button><div><div class="title">${escapeHtml(track.title)}</div><div class="meta">${escapeHtml(track.artist)}${track.album ? ` · ${escapeHtml(track.album)}` : ''}${track.year ? ` · ${track.year}` : ''}${track.play_count?` · ${track.play_count} просл.`:''}${track.remote?` · ${escapeHtml(track.source_label||'другая нода')}`:''}${track.availability==='offline'?' · временно недоступна':track.availability==='revoked'?' · доступ отозван':''}</div></div><button class="like ${track.liked?'liked':''}" title="Мне нравится">${track.liked?'♥':'♡'}</button><div class="muted">${duration(track.duration_seconds)}</div><button class="edit-track" title="${track.remote?'Открыть карточку':'Редактировать'}">•••</button></article>`).join('');
  container.querySelectorAll('.play').forEach((button,index) => button.onclick = async () => {
    const player=document.querySelector('#player');
    const selected=displayedTracks[index];if(queue[currentIndex]?.id===selected.id)return player.paused?player.play():player.pause();playbackFailures.clear();
    if(currentQueueRequest){try{const data=await api(currentQueueRequest),all=data.items||[],position=all.findIndex(item=>item.id===selected.id);if(position>=0){queue=all;return playTrack(position);}}catch{}}
    queue=[...displayedTracks];playTrack(index);
  });
  container.querySelectorAll('.edit-track').forEach((button,index)=>button.onclick=async()=>{const track=displayedTracks[index];if(track.remote&&activePlaylist){if(confirm(`Убрать «${track.title}» из плейлиста?`)){await api(`/api/v1/playlists/${activePlaylist.id}/remote?ref=${encodeURIComponent(track.remote_ref)}`,{method:'DELETE'});await loadTracks();}return;}track.remote?showRemoteTrack(track.remote_ref):editTrack(track);});
  container.querySelectorAll('.like').forEach((button,index)=>button.onclick=async()=>{const track=displayedTracks[index],next=!track.liked;await api(track.remote?`/api/v1/federation/like?ref=${encodeURIComponent(track.remote_ref)}`:`/api/v1/tracks/${track.id}/like`,{method:next?'PUT':'DELETE'});track.liked=next;queue.filter(item=>item.id===track.id).forEach(item=>item.liked=next);if(queue[currentIndex]?.id===track.id)updatePlayerLike(track);if(activeView==='liked')await loadTracks();else{button.classList.toggle('liked',next);button.textContent=next?'♥':'♡';}});
  updatePlayingState();
  if(!playerRestored)restorePlayer();
}

async function loadPlaylists(){
  const data=await api(`/api/v1/playlists?limit=${pageSize}&offset=${pageIndex*pageSize}`),items=data.items;const root=document.querySelector('#catalog-content');
  root.innerHTML=`<div class="catalog-grid"><button class="catalog-card create-playlist"><div class="catalog-cover">＋</div><div class="catalog-name">Новый плейлист</div><div class="catalog-meta">Создать коллекцию</div></button>${items.map(item=>`<button class="catalog-card playlist-card" data-id="${item.id}" data-title="${escapeHtml(item.title)}"><div class="catalog-cover" ${item.cover_track_id?`style="background-image:url('/api/v1/tracks/${item.cover_track_id}/cover')"`:''}>${item.cover_track_id?'':'♫'}</div><div class="catalog-name">${escapeHtml(item.title)}</div><div class="catalog-meta">${item.track_count} треков</div></button>`).join('')}</div>`;
  root.querySelector('.create-playlist').onclick=async()=>{const title=prompt('Название плейлиста');if(!title)return;await api('/api/v1/playlists',{method:'POST',body:JSON.stringify({title})});loadPlaylists();};
  root.querySelectorAll('.playlist-card').forEach(card=>card.onclick=()=>{activePlaylist={id:card.dataset.id,title:card.dataset.title};activeView='playlist';document.querySelectorAll('.tab').forEach(tab=>tab.classList.remove('active'));loadCurrentView();});
  renderPager(data,loadPlaylists);
}

async function loadCatalog(view) {
  const data=await api(`/api/v1/catalog?view=${view}&limit=${pageSize}&offset=${pageIndex*pageSize}${searchQuery?`&q=${encodeURIComponent(searchQuery)}`:''}`);
  let items=data.items ?? [];
  const root=document.querySelector('#catalog-content');
  if(!items.length){root.innerHTML='<div class="empty">Ничего не найдено.</div>';return;}
  root.innerHTML=`<div class="catalog-grid">${items.map(item=>`<button class="catalog-card" data-id="${item.id||''}" data-name="${escapeHtml(item.name)}" data-artist="${escapeHtml(item.artist??item.name)}"><div class="catalog-cover" ${(item.image_url||item.cover_track_id)?`style="background-image:url('${item.image_url||`/api/v1/tracks/${item.cover_track_id}/cover`}')"`:''}>${item.image_url||item.cover_track_id?'':'♫'}</div><div class="catalog-name">${escapeHtml(item.name)}</div><div class="catalog-meta">${view==='albums'?`${escapeHtml(item.artist)} · `:''}${item.track_count} ${item.track_count===1?'трек':'треков'}${item.year?` · ${item.year}`:''}</div></button>`).join('')}</div>`;
  root.querySelectorAll('.catalog-card').forEach(card=>card.onclick=()=>setTrackFilter(card.dataset.artist,view==='albums'?card.dataset.name:'',view==='artists'?card.dataset.id:0));
  renderPager(data,()=>loadCatalog(view));
}

function editArtistCard(artist){
  const dialog=document.createElement('dialog');dialog.innerHTML=`<form class="edit-form"><div class="dialog-title">Карточка: ${escapeHtml(artist.name)}</div><label>Описание<textarea name="bio" maxlength="5000" rows="7" placeholder="Локальное описание исполнителя">${escapeHtml(artist.bio||'')}</textarea></label><label class="secondary artist-image-select">Выбрать фото<input name="image" type="file" accept="image/*"></label><label class="settings-check"><input name="remove_image" type="checkbox"><span><strong>Удалить фото</strong><small>Будет использована обложка одного из треков</small></span></label><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary artist-card-cancel">Отмена</button><button class="primary">Сохранить</button></div></form>`;document.body.append(dialog);dialog.showModal();dialog.querySelector('.artist-card-cancel').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,error=form.querySelector('.error'),file=form.elements.image.files[0];try{await api(`/api/v1/artists/${artist.id}`,{method:'PATCH',body:JSON.stringify({bio:form.elements.bio.value})});if(file)await api(`/api/v1/artists/${artist.id}/image`,{method:'PUT',headers:{'Content-Type':file.type},body:file});else if(form.elements.remove_image.checked)await api(`/api/v1/artists/${artist.id}/image`,{method:'DELETE'});dialog.close();await loadCollection();}catch(problem){error.textContent=problem.message;}};
}

async function editTrack(track) {
  const [playlists,creditsData,artistsData]=await Promise.all([api('/api/v1/playlists'),api(`/api/v1/tracks/${track.id}/artists`),api('/api/v1/artists?limit=500')]);
  const dialog=document.createElement('dialog');
  const creditRow=item=>`<div class="artist-credit"><input class="artist-credit-name" list="artist-options" value="${escapeHtml(item.name||'')}" placeholder="Имя исполнителя" required><select class="artist-credit-role"><option value="primary" ${item.role!=='featured'?'selected':''}>Основной</option><option value="featured" ${item.role==='featured'?'selected':''}>feat.</option></select><button type="button" class="artist-credit-remove" title="Удалить">×</button></div>`;
  dialog.innerHTML=`<form method="dialog" class="edit-form"><div class="dialog-title">Метаданные трека</div>
    <div class="cover-editor"><div class="cover-preview ${track.cover_url?'has-image':''}" ${track.cover_url?`style="background-image:url('${track.cover_url}')"`:''}><span>${track.cover_url?'':'♫'}</span></div><div class="cover-tools"><strong>Обложка</strong><small>Выберите файл или вставьте картинку через Ctrl+V</small><div><label class="secondary cover-select">Выбрать<input class="cover-input" type="file" accept="image/*"></label><button type="button" class="secondary cover-remove">Удалить</button></div><small class="cover-status"></small></div></div>
    <label>Название<input name="title" value="${escapeHtml(track.title)}" required></label><div class="artist-editor"><div class="artist-editor-head"><strong>Исполнители</strong><button type="button" class="secondary artist-credit-add">＋ Добавить исполнителя</button></div><div class="artist-credits">${(creditsData.items.length?creditsData.items:[{name:track.artist,role:'primary'}]).map(creditRow).join('')}</div><datalist id="artist-options">${artistsData.items.map(item=>`<option value="${escapeHtml(item.name)}"></option>`).join('')}</datalist><small>Основные исполнители разделяются запятой, приглашённые будут записаны после feat.</small></div>
    <label>Альбом<input name="album" value="${escapeHtml(track.album)}"></label><div class="form-row"><label>Жанр<input name="genre" value="${escapeHtml(track.genre)}"></label><label>Год<input name="year" type="number" min="1000" max="9999" value="${track.year ?? ''}"></label></div>
    ${playlists.items.length?`<div class="playlist-add"><select name="playlist_id">${playlists.items.map(item=>`<option value="${item.id}">${escapeHtml(item.title)}</option>`).join('')}</select><button value="add-playlist" class="secondary">Добавить в плейлист</button></div>`:''}
    <div class="error"></div><div class="dialog-actions"><button value="delete" class="danger">Удалить файл</button>${activePlaylist?'<button value="remove-playlist" class="secondary">Убрать из плейлиста</button>':''}<button value="play-next" class="secondary">Играть следующим</button><span class="dialog-spacer"></span><button value="cancel" class="secondary">Отмена</button><button value="save" class="primary">Сохранить</button></div></form>`;
  document.body.append(dialog); dialog.showModal();
  const credits=dialog.querySelector('.artist-credits'),bindRemove=()=>dialog.querySelectorAll('.artist-credit-remove').forEach(button=>button.onclick=()=>{if(credits.children.length>1)button.closest('.artist-credit').remove();});bindRemove();dialog.querySelector('.artist-credit-add').onclick=()=>{credits.insertAdjacentHTML('beforeend',creditRow({name:'',role:'featured'}));bindRemove();credits.lastElementChild.querySelector('input').focus();};
  let coverFile=null,removeCover=false,previewUrl='';
  const preview=dialog.querySelector('.cover-preview'),status=dialog.querySelector('.cover-status');
  const stageCover=file=>{if(!file?.type?.startsWith('image/')){status.textContent='В буфере нет изображения';return;}if(file.size>12*1024*1024){status.textContent='Обложка больше 12 МиБ';return;}if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(file);coverFile=file;removeCover=false;preview.style.backgroundImage=`url("${previewUrl}")`;preview.classList.add('has-image');preview.querySelector('span').textContent='';status.textContent='Новая обложка будет сохранена';};
  dialog.querySelector('.cover-input').onchange=event=>stageCover(event.target.files[0]);
  dialog.querySelector('.cover-remove').onclick=()=>{coverFile=null;removeCover=true;if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl='';}preview.style.backgroundImage='';preview.classList.remove('has-image');preview.querySelector('span').textContent='♫';status.textContent='Обложка будет удалена';};
  dialog.addEventListener('paste',event=>{const image=[...(event.clipboardData?.items??[])].find(item=>item.type.startsWith('image/'));if(image){event.preventDefault();stageCover(image.getAsFile());}});
  dialog.addEventListener('close',async()=>{
    if(dialog.returnValue==='play-next'){
      playNext(track);
    } else if(dialog.returnValue==='remove-playlist'){
      try{await api(`/api/v1/playlists/${activePlaylist.id}/tracks/${track.id}`,{method:'DELETE'});await loadCurrentView();}catch(error){alert(error.message);}
    } else if(dialog.returnValue==='add-playlist'){
      const playlistId=new FormData(dialog.querySelector('form')).get('playlist_id');try{await api(`/api/v1/playlists/${playlistId}/tracks`,{method:'POST',body:JSON.stringify({track_id:track.id})});}catch(error){alert(error.message);}
    } else if(dialog.returnValue==='delete'){
      if(confirm(`Удалить «${track.title}» и исходный аудиофайл?`)){ try{ const queueIndex=queue.findIndex(item=>item.id===track.id);await api(`/api/v1/tracks/${track.id}`,{method:'DELETE'});if(queueIndex>=0)removeQueueItem(queueIndex);await loadCurrentView(); }catch(error){alert(error.message);} }
    } else if(dialog.returnValue==='save'){
      const values=Object.fromEntries(new FormData(dialog.querySelector('form')));
      delete values.password;delete values.playlist_id;
      try{
        const creditItems=[...dialog.querySelectorAll('.artist-credit')].map(row=>({name:row.querySelector('.artist-credit-name').value.trim(),role:row.querySelector('.artist-credit-role').value})).filter(item=>item.name);
        const savedCredits=await api(`/api/v1/tracks/${track.id}/artists`,{method:'PUT',body:JSON.stringify({items:creditItems})});values.artist=savedCredits.artist;
        await api(`/api/v1/tracks/${track.id}`,{method:'PATCH',body:JSON.stringify(values)});
        Object.assign(track,{title:values.title,artist:values.artist,album:values.album,genre:values.genre,year:values.year?Number(values.year):null});
        queue.filter(item=>item.id===track.id).forEach(item=>Object.assign(item,track));
        displayedTracks.filter(item=>item.id===track.id).forEach(item=>Object.assign(item,track));
        if(queue[currentIndex]?.id===track.id){document.querySelector('#now-title').textContent=track.title;document.querySelector('#now-artist').textContent=track.artist||'Неизвестный исполнитель';updateMediaSession(track);}
        if(coverFile){const result=await api(`/api/v1/tracks/${track.id}/cover`,{method:'PUT',headers:{'Content-Type':coverFile.type},body:coverFile});setTrackCover(track.id,result.cover_url);}
        else if(removeCover){await api(`/api/v1/tracks/${track.id}/cover`,{method:'DELETE'});setTrackCover(track.id,null);}
        await loadCurrentView();
      }
      catch(error){ alert(error.message); }
    }
    if(previewUrl)URL.revokeObjectURL(previewUrl);
    dialog.remove();
  });
}

function setTrackCover(trackId,coverUrl){
  [...queue,...displayedTracks].filter(item=>item.id===trackId).forEach(item=>item.cover_url=coverUrl);
  if(queue[currentIndex]?.id===trackId){const cover=document.querySelector('#now-cover');cover.style.backgroundImage=coverUrl?`url("${coverUrl}")`:'';cover.textContent=coverUrl?'':'♫';updateMediaSession(queue[currentIndex]);}
  renderQueue();
}

async function waitForUpload(uploadId,onState){
  const deadline=Date.now()+30*60*1000;
  while(Date.now()<deadline){
    const state=await api(`/api/v1/uploads/${uploadId}`);
    if(state.status==='ready')return state;
    if(state.status==='duplicate')return state;
    if(state.status==='failed')throw new Error(state.error||'Обработка завершилась ошибкой');
    onState?.(state);
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error('Обработка заняла слишком много времени');
}

const audioFilePattern=/\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wave|webm)$/i;

function enqueueUploads(files){
  const known=new Set(uploadTasks.map(task=>`${task.file.name}:${task.file.size}:${task.file.lastModified}`));
  const accepted=files.filter(file=>(file.type.startsWith('audio/')||audioFilePattern.test(file.name))&&file.size>0).filter(file=>{const key=`${file.name}:${file.size}:${file.lastModified}`;if(known.has(key))return false;known.add(key);return true;});
  const batchId=++uploadTaskSequence;
  accepted.forEach(file=>{const relative=file.webkitRelativePath||file.name,parts=relative.split('/'),group=parts.length>1?parts[0]:`Выбор ${batchId}`;uploadTasks.push({localId:++uploadTaskSequence,batchId,group,file,status:'queued',progress:0,uploadId:null,trackId:null,error:''});});
  if(!accepted.length){if(files.length)alert('В выбранном наборе нет поддерживаемых аудиофайлов.');return;}
  renderUploadQueue();runUploadQueue();
}

function uploadStatus(task){
  return {queued:'В очереди',starting:'Подготовка',uploading:`Загрузка · ${Math.round(task.progress)}%`,processing:'Читаем теги и обложку',ready:'Готово',duplicate:'Уже есть в библиотеке',failed:task.error||'Ошибка'}[task.status]||task.status;
}

function renderUploadQueue(){
  const panel=document.querySelector('#progress');if(!panel)return;
  panel.classList.toggle('on',uploadTasks.length>0);
  if(!uploadTasks.length)return;
  const finished=uploadTasks.filter(task=>['ready','duplicate'].includes(task.status)).length,failed=uploadTasks.filter(task=>task.status==='failed').length,totalBytes=uploadTasks.reduce((sum,task)=>sum+task.file.size,0),loadedBytes=uploadTasks.reduce((sum,task)=>sum+task.file.size*(task.progress/100),0);
  document.querySelector('#progress-text').textContent=finished+failed===uploadTasks.length?'Загрузка завершена':`Загружаем музыку · ${finished+failed}/${uploadTasks.length}`;
  document.querySelector('#upload-summary').textContent=`${uploadTasks.length} файлов · ${bytes(totalBytes)}${failed?` · ошибок: ${failed}`:''}`;
  document.querySelector('#progress-bar').style.width=`${totalBytes?loadedBytes/totalBytes*100:0}%`;
  document.querySelector('#retry-uploads').hidden=!failed;
  document.querySelector('#clear-uploads').hidden=!finished;
  document.querySelector('#upload-list').innerHTML=uploadTasks.map(task=>`<div class="upload-row ${task.status}" data-upload-task="${task.localId}"><div class="upload-file"><strong>${escapeHtml(task.file.webkitRelativePath||task.file.name)}</strong><small>${bytes(task.file.size)}</small></div><div class="upload-row-progress"><span style="width:${task.progress}%"></span></div><div class="upload-state">${escapeHtml(uploadStatus(task))}</div>${task.status==='failed'?'<button class="secondary retry-upload">Повторить</button>':''}</div>`).join('');
  const groups=[...new Set(uploadTasks.map(task=>task.group))].map(name=>({name,tasks:uploadTasks.filter(task=>task.group===name)})).filter(group=>!group.tasks.every(task=>task.albumDone)&&group.tasks.length>=2&&group.tasks.every(task=>['ready','duplicate','failed'].includes(task.status))&&group.tasks.filter(task=>task.status==='ready'&&task.trackId).length>=2);
  let albumActions=document.querySelector('#upload-albums');if(!albumActions){albumActions=document.createElement('div');albumActions.id='upload-albums';albumActions.className='upload-albums';document.querySelector('#upload-list').before(albumActions);}albumActions.innerHTML=groups.map((group,index)=>`<button class="secondary album-import" data-group="${index}">Оформить альбом · ${escapeHtml(group.name)} (${group.tasks.filter(task=>task.status==='ready').length})</button>`).join('');
  albumActions.querySelectorAll('.album-import').forEach(button=>button.onclick=()=>editUploadedAlbum(groups[Number(button.dataset.group)]));
  document.querySelectorAll('.retry-upload').forEach(button=>button.onclick=()=>retryUpload(Number(button.closest('[data-upload-task]').dataset.uploadTask)));
}

async function uploadOne(task){
  try{
    let upload,offset=0;
    if(task.uploadId){
      try{upload=await api(`/api/v1/uploads/${task.uploadId}`);}catch{task.uploadId=null;}
      if(upload){
        if(upload.status==='ready'||upload.status==='duplicate'){task.status=upload.status;task.trackId=upload.track_id||null;task.progress=100;return;}
        if(upload.status==='processing'){task.status='processing';task.progress=100;renderUploadQueue();const result=await waitForUpload(task.uploadId);task.status=result.status;task.trackId=result.track_id||null;return;}
        if(upload.status==='uploading')offset=Number(upload.offset)||0;else task.uploadId=null;
      }
    }
    if(!task.uploadId){upload=await api('/api/v1/uploads',{method:'POST',body:JSON.stringify({filename:task.file.name,size:task.file.size,mime_type:task.file.type||'application/octet-stream'})});task.uploadId=upload.id;offset=Number(upload.offset)||0;}
    task.status='uploading';task.error='';task.progress=offset/task.file.size*100;renderUploadQueue();
    const chunkSize=4*1024*1024;
    while(offset<task.file.size){
      const end=Math.min(offset+chunkSize,task.file.size),result=await api(`/api/v1/uploads/${task.uploadId}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream','Content-Range':`bytes ${offset}-${end-1}/${task.file.size}`},body:task.file.slice(offset,end)});
      offset=Number(result.offset);task.progress=offset/task.file.size*100;renderUploadQueue();
      if(result.processing)break;
    }
    task.status='processing';task.progress=100;renderUploadQueue();
    const result=await waitForUpload(task.uploadId,()=>{task.status='processing';renderUploadQueue();});task.status=result.status;task.trackId=result.track_id||null;task.progress=100;
  }catch(error){task.status='failed';task.error=error.message;}
  finally{renderUploadQueue();}
}

function runUploadQueue(){
  while(uploadWorkers<2){const task=uploadTasks.find(item=>item.status==='queued');if(!task)break;uploadWorkers++;task.status='starting';uploadOne(task).finally(async()=>{uploadWorkers--;renderUploadQueue();if(!uploadTasks.some(item=>['queued','starting','uploading','processing'].includes(item.status)))await loadCurrentView();runUploadQueue();});}
  renderUploadQueue();
}

function retryUpload(localId){const task=uploadTasks.find(item=>item.localId===localId);if(!task)return;task.status='queued';task.error='';runUploadQueue();}
function retryFailedUploads(){uploadTasks.filter(task=>task.status==='failed').forEach(task=>{task.status='queued';task.error='';});runUploadQueue();}
function clearFinishedUploads(){uploadTasks=uploadTasks.filter(task=>!['ready','duplicate'].includes(task.status));renderUploadQueue();}

function editUploadedAlbum(group){
  const tasks=group.tasks.filter(task=>task.status==='ready'&&task.trackId).sort((a,b)=>a.discNumber&&b.discNumber?(a.discNumber-b.discNumber)||(Number(a.trackNumber||9999)-Number(b.trackNumber||9999)):(a.file.webkitRelativePath||a.file.name).localeCompare(b.file.webkitRelativePath||b.file.name,'ru',{numeric:true}));
  const rows=tasks.map((task,index)=>{const relative=task.file.webkitRelativePath||task.file.name,disc=Number(task.discNumber||relative.match(/(?:cd|disc|disk)[ _-]*(\d+)/i)?.[1]||1),tag=Number(task.trackNumber||task.file.name.match(/^(\d{1,3})[\s._-]+/)?.[1]||0);return{task,disc,track:tag||index+1};});
  const dialog=document.createElement('dialog');dialog.className='album-dialog';
  dialog.innerHTML=`<form class="edit-form"><div class="dialog-title">${group.existing?'Редактировать':'Оформить'} альбом</div><small class="album-hint">Общие поля применятся ко всем трекам. Порядок можно изменить стрелками или номерами.</small><label>Название альбома<input name="album" value="${escapeHtml(group.name.replace(/^Выбор \d+$/,''))}" required></label><label>Исполнитель альбома<input name="artist" value="${escapeHtml(group.artist||'')}" placeholder="Оставьте пустым, чтобы сохранить исполнителей"></label><div class="form-row"><label>Жанр<input name="genre" value="${escapeHtml(group.genre||'')}" placeholder="Не изменять"></label><label>Год<input name="year" type="number" min="1000" max="9999" value="${group.year||''}"></label></div><label class="secondary album-cover-select">Общая обложка<input name="cover" type="file" accept="image/*"></label><div class="album-order"></div><div class="error"></div><div class="dialog-actions"><button type="button" class="secondary album-cancel">Отмена</button><button class="primary album-save">Сохранить альбом</button></div></form>`;
  document.body.append(dialog);dialog.showModal();
  const render=()=>{dialog.querySelector('.album-order').innerHTML=rows.map((row,index)=>`<div class="album-track-row" data-index="${index}"><span title="${escapeHtml(row.task.file.name)}">${escapeHtml(row.task.file.name)}</span><label>Диск<input class="album-disc" type="number" min="1" max="99" value="${row.disc}"></label><label>№<input class="album-number" type="number" min="1" max="999" value="${row.track}"></label><button type="button" class="secondary album-up" ${index===0?'disabled':''}>↑</button><button type="button" class="secondary album-down" ${index===rows.length-1?'disabled':''}>↓</button></div>`).join('');dialog.querySelectorAll('.album-track-row').forEach((element,index)=>{element.querySelector('.album-up').onclick=()=>{[rows[index-1],rows[index]]=[rows[index],rows[index-1]];render();};element.querySelector('.album-down').onclick=()=>{[rows[index+1],rows[index]]=[rows[index],rows[index+1]];render();};});};render();
  dialog.querySelector('.album-cancel').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,error=form.querySelector('.error'),save=form.querySelector('.album-save');error.textContent='';dialog.querySelectorAll('.album-track-row').forEach((element,index)=>{rows[index].disc=Number(element.querySelector('.album-disc').value)||1;rows[index].track=Number(element.querySelector('.album-number').value)||index+1;});const values=Object.fromEntries(new FormData(form));const cover=form.elements.cover.files[0];delete values.cover;values.items=rows.map(row=>({id:row.task.trackId,disc_number:row.disc,track_number:row.track}));try{save.disabled=true;save.textContent='Сохраняем метаданные…';await api('/api/v1/tracks/batch',{method:'POST',body:JSON.stringify(values)});if(cover){save.textContent='Применяем общую обложку…';await api('/api/v1/tracks/batch-cover',{method:'PUT',headers:{'Content-Type':cover.type,'X-Track-Ids':rows.map(row=>row.task.trackId).join(',')},body:cover});}rows.forEach(row=>row.task.albumDone=true);dialog.close();if(group.onSaved)await group.onSaved(values);else renderUploadQueue();alert(`Альбом «${values.album}» сохранён: ${rows.length} треков`);}catch(problem){error.textContent=problem.message;save.disabled=false;save.textContent='Сохранить альбом';}};
}

function editExistingAlbum(items){
  if(!items.length)return;
  const same=value=>items.every(item=>(item[value]||'')===(items[0][value]||''))?(items[0][value]||''):'';
  editUploadedAlbum({existing:true,name:activeAlbum,artist:same('artist'),genre:same('genre'),year:same('year'),tasks:items.map((track,index)=>({status:'ready',trackId:track.id,file:{name:`${track.track_number||index+1}. ${track.title}`,webkitRelativePath:''},discNumber:track.disc_number||1,trackNumber:track.track_number||index+1})),onSaved:async values=>{activeAlbum=values.album;activeArtist=values.artist||activeArtist;await loadCollection();}});
}

function setupUploadDropZone(){
  const zone=document.querySelector('#drop-zone');if(!zone)return;
  let depth=0;
  const active=value=>zone.classList.toggle('dragging',value);
  zone.addEventListener('dragenter',event=>{event.preventDefault();depth++;active(true);});
  zone.addEventListener('dragover',event=>event.preventDefault());
  zone.addEventListener('dragleave',()=>{depth=Math.max(0,depth-1);if(!depth)active(false);});
  zone.addEventListener('drop',async event=>{event.preventDefault();depth=0;active(false);const items=[...event.dataTransfer.items];const entries=items.map(item=>item.webkitGetAsEntry?.()).filter(Boolean);enqueueUploads(entries.length?(await Promise.all(entries.map(filesFromEntry))).flat():[...event.dataTransfer.files]);});
}

function filesFromEntry(entry){
  if(entry.isFile)return new Promise(resolve=>entry.file(file=>resolve([file]),()=>resolve([])));
  if(!entry.isDirectory)return Promise.resolve([]);
  return new Promise(resolve=>{const reader=entry.createReader(),entries=[];const read=()=>reader.readEntries(batch=>{if(batch.length){entries.push(...batch);read();}else Promise.all(entries.map(filesFromEntry)).then(groups=>resolve(groups.flat()));},()=>resolve([]));read();});
}

start().catch(error => { app.innerHTML=`<section class="auth"><div class="card"><div class="error">${escapeHtml(error.message)}</div></div></section>`; });
