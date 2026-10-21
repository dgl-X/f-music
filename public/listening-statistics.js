const escape = value => String(value ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const number = value => Math.max(0,Number(value)||0).toLocaleString('ru-RU');
const card = (label,value,hint='') => `<div class="stat-card"><span>${escape(label)}</span><strong>${number(value)}</strong><small>${escape(hint)}</small></div>`;
const limits = '<div class="stats-section"><h3>Старая история</h3><p>Ниже — сохранённые отметки воспроизведения локальных треков, а не полные прослушивания. Удалённые из библиотеки треки и удалённая история в эти показатели не входят. Отдельное воспроизведение на другой ноде федерации здесь не учитывается.</p><p>В старой истории нет всех дат запусков и проигранного времени. Часы и количество запусков за неделю/месяц из неё не вычисляются. Новый учёт показан отдельно и работает только после включения.</p></div>';

function top(title,items,label) {
  return `<div class="stats-section"><h3>${escape(title)}</h3>${items.length?items.map((item,index)=>`<div class="stats-lines"><span>${index+1}. ${escape(label(item))}</span><strong>${number(item.recorded_plays)}</strong></div>`).join(''):'<div class="stats-empty">Пока нет истории</div>'}</div>`;
}

export function personalStatisticsHtml(data) {
  const s=data.summary;
  return `${limits}<div class="stat-grid">${card('Отметок воспроизведения',s.recorded_plays,'За всё время в сохранённой истории')}${card('Уникальных треков',s.unique_tracks,'Локальные треки из истории')}${card('Мне нравится',s.likes,'Локальные и федеративные лайки')}${card('Плейлистов',s.playlists,'Ваши плейлисты')}${card('Треков за 7 дней',s.recent_tracks_7d,'Уникальные, по последней отметке')}${card('Треков за 30 дней',s.recent_tracks_30d,'Уникальные, по последней отметке')}</div>
    ${top('Топ треков · всё время',data.top_tracks,item=>`${item.title} — ${item.artist}`)}
    <div class="stats-two">${top('Топ исполнителей · всё время',data.top_artists,item=>item.name)}${top('Топ альбомов · всё время',data.top_albums,item=>`${item.name} — ${item.artist}`)}</div>
    <p class="settings-hint">В топе исполнителей учитываются также участники feat. Одна песня может относиться к нескольким исполнителям.</p>`;
}

export function measuredStatisticsHtml(data,admin=false){
  const seconds=Math.max(0,Number(data.listening_seconds)||0);
  const elapsed=value=>{const s=Math.max(0,Math.floor(Number(value)||0));return s<60?`${s} сек.`:s<3600?`${Math.floor(s/60)} мин. ${s%60} сек.`:`${Math.floor(s/3600)} ч. ${Math.floor(s%3600/60)} мин.`;};
  const list=(title,items,label)=>`<div class="stats-section"><h3>${escape(title)}</h3>${items.length?items.map(item=>`<div class="stats-lines"><span>${escape(label(item))}</span><strong>${elapsed(item.elapsed_ms/1000)}</strong></div>`).join(''):'<div class="stats-empty">Пока нет измеренных данных</div>'}</div>`;
  const period={7:'7 дней',30:'30 дней',all:'всё время'}[data.period]||'';
  const totals=`<div class="stats-section"><h3>Измеренное прослушивание · ${period}</h3><div class="stat-grid"><div class="stat-card"><span>Проиграно</span><strong>${elapsed(seconds)}</strong><small>По данным поддерживаемых клиентов</small></div>${card('Засчитано прослушиваний',data.qualified_plays,'30 секунд или половина короткого трека')}${card(admin?'Слушателей':'Активных дней',admin?data.listeners:data.active_days)}</div></div>`;
  const note='<p class="settings-hint">Дни считаются по UTC на момент приёма данных сервером. Время передают WEB и Android с поддержкой учёта. Паузы, буферизация, перемотка и удалённое управление не добавляют время. При удалении трека удаляется и его измеренная статистика. В версиях с офлайн-журналом доставка ограничена сутками; аварийное закрытие может потерять последние ~10 секунд. Для открытия WEB нужна связь с сервером.</p>';
  if(admin)return totals+list('Клиенты',data.sources||[],item=>item.client_type==='android'?'Android':'WEB')+note;
  return totals+`<p class="settings-hint">${data.settings.enabled?'Сбор включён':'Сбор выключен; сохранённые результаты доступны'}${data.settings.started_at?' · с '+escape(new Date(data.settings.started_at).toLocaleDateString('ru-RU')):''}. Личные результаты доступны только вашему аккаунту.</p>`+
    list('Треки · по измеренному времени',data.top_tracks,item=>`${item.title} — ${item.artist}`)+
    `<div class="stats-two">${list('Исполнители',data.top_artists,item=>item.name)}${list('Альбомы',data.top_albums,item=>`${item.name} — ${item.artist}`)}</div>`+
    list('Дни с прослушиваниями · до 30',data.daily,item=>item.day)+note;
}

export function administrativeUsageHtml(data) {
  const a=data.activity,c=data.collections,l=data.library,s=data.sessions;
  return `<div class="stat-grid">${card('Аккаунтов',c.accounts)}${card('Слушателей за 7 дней',a.listeners_7d,'С отметкой в локальной истории')}${card('Слушателей за 30 дней',a.listeners_30d,'С отметкой в локальной истории')}${card('Отметок воспроизведения',a.recorded_plays,'За всё время, все аккаунты')}${card('Добавлено за 7 дней',l.added_tracks_7d,'Из сохранившихся треков')}${card('Добавлено за 30 дней',l.added_tracks_30d,'Из сохранившихся треков')}${card('Активных сессий',s.active_sessions,'Неистёкшие сессии, не число устройств')}${card('Аккаунтов с сессиями',s.accounts_with_sessions)}${card('Сессий за сутки',s.sessions_seen_24h,'Неистёкшие, с обращениями за 24 часа')}${card('Мне нравится',Number(c.local_likes)+Number(c.remote_likes),'Сумма персональных лайков')}${card('Плейлистов',c.playlists)}${card('Треков в библиотеке',l.tracks)}</div>
    <div class="stats-section"><h3>Объём оригиналов</h3><p>${(Math.max(0,Number(l.original_bytes)||0)/1024**3).toLocaleString('ru-RU',{maximumFractionDigits:2})} ГиБ. Размер файлов в текущей библиотеке, не сетевой трафик.</p></div>
    <p class="settings-hint">Сводка агрегирована: названия личных треков, история отдельных пользователей, имена устройств и IP-адреса не выводятся. Состояние worker, хранилища и API находится в разделе «Статистика».</p>${limits}`;
}
