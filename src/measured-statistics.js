export const listeningPeriod=value=>['7','30','all'].includes(String(value))?String(value):null;
const numeric=row=>Object.fromEntries(Object.entries(row||{}).map(([key,value])=>[key,Number(value)||0]));
const cutoff="(@days::int IS NULL OR d.day>=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date-(@days::int-1))";

export function createMeasuredStatistics({db,events,now=()=>new Date()}) {
  async function personal(userId,period='7') {
    const params={user_id:userId,days:period==='all'?null:Number(period)};
    const where=`d.user_id=@user_id AND ${cutoff}`;
    const [settings,summary,tracks,artists,albums,daily]=await Promise.all([
      events.settings(userId),
      db.prepare(`SELECT COALESCE(sum(d.elapsed_ms),0) AS elapsed_ms,COALESCE(sum(d.plays),0) AS plays,
        count(DISTINCT d.day) FILTER(WHERE d.elapsed_ms>0) AS active_days FROM listening_daily d WHERE ${where}`).get(params),
      db.prepare(`SELECT t.id,t.title,t.artist,COALESCE(sum(d.elapsed_ms),0) AS elapsed_ms,COALESCE(sum(d.plays),0) AS plays
        FROM listening_daily d JOIN tracks t ON t.id=d.track_id WHERE ${where}
        GROUP BY t.id,t.title,t.artist ORDER BY elapsed_ms DESC,t.id LIMIT 10`).all(params),
      db.prepare(`SELECT a.id,a.name,COALESCE(sum(d.elapsed_ms),0) AS elapsed_ms,COALESCE(sum(d.plays),0) AS plays
        FROM listening_daily d JOIN track_artists credit ON credit.track_id=d.track_id JOIN artists a ON a.id=credit.artist_id
        WHERE ${where} GROUP BY a.id,a.name ORDER BY elapsed_ms DESC,a.id LIMIT 10`).all(params),
      db.prepare(`SELECT a.id,a.name,a.artist,COALESCE(sum(d.elapsed_ms),0) AS elapsed_ms,COALESCE(sum(d.plays),0) AS plays
        FROM listening_daily d JOIN tracks t ON t.id=d.track_id JOIN albums a ON a.id=t.album_id
        WHERE ${where} GROUP BY a.id,a.name,a.artist ORDER BY elapsed_ms DESC,a.id LIMIT 10`).all(params),
      db.prepare(`SELECT to_char(d.day,'YYYY-MM-DD') AS day,COALESCE(sum(d.elapsed_ms),0) AS elapsed_ms,COALESCE(sum(d.plays),0) AS plays
        FROM listening_daily d WHERE ${where} GROUP BY d.day ORDER BY d.day DESC LIMIT 30`).all(params),
    ]);
    const totals=numeric(summary);
    const rows=items=>items.map(row=>({...row,elapsed_ms:Number(row.elapsed_ms),plays:Number(row.plays)}));
    return{generated_at:now().toISOString(),period,timezone:'UTC',settings,
      scope:'reported_local_playback',listening_seconds:totals.elapsed_ms/1000,
      qualified_plays:totals.plays,active_days:totals.active_days,
      top_tracks:rows(tracks),top_artists:rows(artists),top_albums:rows(albums),daily:rows(daily).reverse()};
  }
  async function administrative(period='7') {
    const params={days:period==='all'?null:Number(period)};
    const [summary,sources]=await Promise.all([
      db.prepare(`SELECT COALESCE(sum(d.elapsed_ms),0) AS elapsed_ms,COALESCE(sum(d.plays),0) AS plays,
        count(DISTINCT d.user_id) FILTER(WHERE d.elapsed_ms>0) AS listeners
        FROM listening_daily d WHERE ${cutoff}`).get(params),
      db.prepare(`SELECT d.client_type,COALESCE(sum(d.elapsed_ms),0) AS elapsed_ms,COALESCE(sum(d.plays),0) AS plays
        FROM listening_daily d WHERE ${cutoff} GROUP BY d.client_type ORDER BY d.client_type`).all(params),
    ]);
    const totals=numeric(summary);
    return{generated_at:now().toISOString(),period,timezone:'UTC',scope:'reported_local_playback',
      listening_seconds:totals.elapsed_ms/1000,qualified_plays:totals.plays,listeners:totals.listeners,
      sources:sources.map(row=>({client_type:row.client_type,elapsed_ms:Number(row.elapsed_ms),plays:Number(row.plays)}))};
  }
  return{personal,administrative};
}
