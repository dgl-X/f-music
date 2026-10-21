import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require=createRequire('/opt/family-music/package.json');
const {Client}=require('pg');
const [mode,stateFile]=process.argv.slice(2);
assert.ok(['seed','verify'].includes(mode)&&stateFile,'Expected seed|verify and a temporary state file');
const db=new Client({connectionString:process.env.DATABASE_URL});
const base='http://127.0.0.1:8095';
const files=['originals/package-fixture.mp3','covers/package-fixture.png','albums/package-fixture.png','federation/replicas/package-fixture.mp3','derived/normalized_flac/package-fixture.flac'];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function snapshot(){
  const result={};
  for(const table of ['users','tracks','track_likes','playlists','playlist_tracks'])result[table]=(await db.query(`SELECT to_jsonb(t)-'password_hash' AS row FROM (SELECT * FROM ${table} ORDER BY 1) t`)).rows.map(row=>row.row);
  return {...result,environment:hash('/opt/family-music/.env'),files:Object.fromEntries(files.map(file=>[file,hash('/opt/family-music/storage/'+file)]))};
}
try{
  await db.connect();
  const role=(await db.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(role,{rolsuper:false,rolcreatedb:false,rolcreaterole:false});
  if(mode==='seed'){
    assert.equal(Number((await db.query('SELECT count(*) FROM users')).rows[0].count),0,'Refusing non-empty package fixture');
    const response=await fetch(base+'/api/v1/setup',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({username:'package-test',display_name:'Package fixture',password:crypto.randomBytes(24).toString('base64url')})});
    assert.equal(response.status,201);
    const id=(await db.query("SELECT id FROM users WHERE username='package-test'")).rows[0].id;
    const track='44444444-4444-4444-8444-444444444444';
    for(const file of files){fs.mkdirSync('/opt/family-music/storage/'+file.substring(0,file.lastIndexOf('/')),{recursive:true});fs.writeFileSync('/opt/family-music/storage/'+file,'synthetic-package-marker:'+file);}
    await db.query("INSERT INTO tracks(id,owner_id,title,filename,mime_type,size_bytes,storage_key) VALUES($1,$2,'Package fixture','fixture.mp3','audio/mpeg',1,'originals/package-fixture.mp3')",[track,id]);
    await db.query('INSERT INTO track_likes(user_id,track_id) VALUES($1,$2)',[id,track]);
    await db.query("INSERT INTO playlists(id,owner_id,title) VALUES('package-fixture',$1,'Package playlist')",[id]);
    await db.query("INSERT INTO playlist_tracks(playlist_id,track_id,position) VALUES('package-fixture',$1,0)",[track]);
    fs.writeFileSync(stateFile,JSON.stringify(await snapshot()),{mode:0o600});
  }else assert.deepEqual(await snapshot(),JSON.parse(fs.readFileSync(stateFile,'utf8')));
  console.log(`Package data ${mode}: users, tracks, likes, playlists, config and original/artwork markers OK`);
}finally{await db.end();}
