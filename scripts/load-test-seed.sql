\set ON_ERROR_STOP on

DO $$ BEGIN
  IF current_database() !~ '_loadtest$' THEN
    RAISE EXCEPTION 'Load-test seed разрешён только для базы с суффиксом _loadtest';
  END IF;
END $$;

TRUNCATE users CASCADE;

INSERT INTO users(username,display_name,password_hash,is_admin)
VALUES ('load_admin','Тестовый администратор','disabled',1),
       ('load_family','Тестовый пользователь','disabled',0);

INSERT INTO tracks(id,owner_id,title,artist,album,filename,mime_type,size_bytes,duration_seconds,storage_key,sha256,genre,year,track_number,disc_number,cover_checked)
SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12),
       (SELECT id FROM users WHERE username='load_admin'),
       'Трек '||lpad(g::text,5,'0'),'Исполнитель '||(g%500),'Альбом '||(g%1000),
       'track-'||g||'.mp3','audio/mpeg',3000000+(g%12000000),120+(g%360),
       'originals/test/'||g||'.mp3',md5('audio-'||g),'Жанр '||(g%24),1990+(g%36),1+(g%20),1,1
FROM (SELECT g,md5('track-'||g) h FROM generate_series(1,10000) g) source;

INSERT INTO track_likes(user_id,track_id)
SELECT (SELECT id FROM users WHERE username='load_admin'),tracks.id FROM tracks ORDER BY tracks.id LIMIT 2500;

INSERT INTO play_history(user_id,track_id,play_count,last_played_at)
SELECT (SELECT id FROM users WHERE username='load_admin'),id,1+(row_number() OVER ()%40),CURRENT_TIMESTAMP-(row_number() OVER ()%720)*INTERVAL '1 hour'
FROM tracks LIMIT 5000;

INSERT INTO playlists(id,owner_id,title,description)
SELECT substr(h,1,8)||'-'||substr(h,9,4)||'-'||substr(h,13,4)||'-'||substr(h,17,4)||'-'||substr(h,21,12),
       (SELECT id FROM users WHERE username='load_admin'),'Плейлист '||g,'Нагрузочный тест'
FROM (SELECT g,md5('playlist-'||g) h FROM generate_series(1,20) g) source;

INSERT INTO playlist_tracks(playlist_id,track_id,position)
SELECT p.id,t.id,t.position FROM playlists p
CROSS JOIN LATERAL (SELECT id,row_number() OVER ()-1 position FROM tracks ORDER BY md5(id||p.id) LIMIT 200) t;

INSERT INTO playback_state(user_id,track_id,position_seconds,queue_json,queue_source,shuffle,repeat_mode)
SELECT (SELECT id FROM users WHERE username='load_admin'),min(id),42,json_agg(id ORDER BY id)::text,'Все треки',1,'all' FROM tracks;

ANALYZE;
