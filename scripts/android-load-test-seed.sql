\set ON_ERROR_STOP on

DO $$ BEGIN
  IF current_database() !~ '_loadtest$' THEN
    RAISE EXCEPTION 'Android load-test разрешён только для базы с суффиксом _loadtest';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE is_admin=1) THEN
    RAISE EXCEPTION 'Сначала создайте тестового администратора через мастер настройки';
  END IF;
END $$;

TRUNCATE tracks CASCADE;
TRUNCATE artists CASCADE;
TRUNCATE federation_catalog_events RESTART IDENTITY;

INSERT INTO tracks(id,owner_id,title,artist,album,filename,mime_type,size_bytes,
                   duration_seconds,storage_key,sha256,genre,year,track_number,
                   disc_number,cover_checked)
SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12),
       (SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1),
       'Трек '||lpad(g::text,5,'0'),
       'Исполнитель '||lpad((g%500)::text,3,'0'),
       'Альбом '||lpad((g%1000)::text,4,'0'),
       'track-'||g||'.mp3','audio/mpeg',:source_size,120+(g%360),
       'originals/loadtest/'||g||'/../source.mp3',md5('android-audio-'||g),
       'Жанр '||(g%24),1990+(g%36),1+(g%20),1,1
FROM (SELECT g,md5('android-track-'||g) h FROM generate_series(1,10000) g) source;

INSERT INTO track_likes(user_id,track_id)
SELECT (SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1),tracks.id
FROM tracks ORDER BY tracks.id LIMIT 2500;

INSERT INTO play_history(user_id,track_id,play_count,last_played_at)
SELECT (SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1),tracks.id,
       1+(row_number() OVER ()%40),
       CURRENT_TIMESTAMP-(row_number() OVER ()%720)*INTERVAL '1 hour'
FROM tracks ORDER BY tracks.id LIMIT 5000;

INSERT INTO playlists(id,owner_id,title,description)
SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12),
       (SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1),
       'Плейлист '||g,'Нагрузочный тест Android'
FROM (SELECT g,md5('android-playlist-'||g) h FROM generate_series(1,20) g) source;

INSERT INTO playlist_tracks(playlist_id,track_id,position)
SELECT p.id,t.id,t.position FROM playlists p
CROSS JOIN LATERAL (
  SELECT id,row_number() OVER ()-1 position
  FROM tracks ORDER BY md5(id||p.id) LIMIT 200
) t;

INSERT INTO playback_state(user_id,track_id,position_seconds,queue_json,queue_source,shuffle,repeat_mode)
SELECT (SELECT id FROM users WHERE is_admin=1 ORDER BY id LIMIT 1),min(id),0,
       json_agg(id ORDER BY md5(id||'initial-shuffle'))::text,
       'Все треки · тест 10 000',1,'all'
FROM tracks;

ANALYZE tracks;
ANALYZE track_likes;
ANALYZE play_history;
ANALYZE playlists;
ANALYZE playlist_tracks;
ANALYZE playback_state;

SELECT count(*) AS tracks FROM tracks;
SELECT count(*) AS queue_length
FROM playback_state CROSS JOIN LATERAL json_array_elements_text(queue_json::json);
