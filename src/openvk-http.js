import { Readable } from 'node:stream';

function providerErrorStatus(error, operation) {
  if (error.code === 'openvk_disabled') return 404;
  if (error.code === 'openvk_unauthorized') return 401;
  if (operation === 'stream' && error.code === 'openvk_track_unavailable') return 404;
  if (error.code === 'invalid_openvk_id' || error.code === 'invalid_openvk_range') return 400;
  if (operation === 'import' && error.code === 'openvk_too_large') return 413;
  return 502;
}

export function createOpenVkHttpController({ db, provider, readJson, sendJson, readableFromWeb = Readable.fromWeb }) {
  const reply = (res, status, value) => { sendJson(res,status,value); return true; };

  async function handle(req, res, url, user) {
    if (url.pathname === '/api/admin/openvk-settings' && req.method === 'GET') {
      if (!user.is_admin) return reply(res,403,{error:'Доступно только администратору'});
      const state=await provider.settings();
      return reply(res,200,{enabled:state.enabled,token_configured:Boolean(state.token)});
    }
    if (url.pathname === '/api/admin/openvk-settings' && req.method === 'PUT') {
      if (!user.is_admin) return reply(res,403,{error:'Доступно только администратору'});
      const body=await readJson(req),enabled=Boolean(body.enabled),token=typeof body.access_token==='string'?body.access_token.trim().replace(/^access_token=/,'').slice(0,1024):null;
      await db.transaction(async tx=>{
        await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('openvk_enabled',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(enabled?'true':'false');
        if(token!==null)await tx.prepare(`INSERT INTO app_settings(key,value,updated_at) VALUES('openvk_access_token',?,CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).run(token);
      });
      const state=await provider.settings();
      return reply(res,200,{enabled:state.enabled,token_configured:Boolean(state.token)});
    }
    if (url.pathname === '/api/openvk/search' && req.method === 'GET') {
      try {
        const result=await provider.search(url.searchParams.get('q'),url.searchParams.get('limit'),url.searchParams.get('offset'));
        const sourceIds=result.items.map(item=>item.source_id);
        const imported=sourceIds.length?await db.prepare("SELECT source_id,track_id FROM track_sources WHERE source='openvk' AND source_id=ANY(?::text[])").all(sourceIds):[];
        const bySource=new Map(imported.map(item=>[item.source_id,item.track_id]));
        return reply(res,200,{...result,items:result.items.map(item=>({...item,local_track_id:bySource.get(item.source_id)||null}))});
      } catch(error) { return reply(res,providerErrorStatus(error,'search'),{error:error.message}); }
    }
    if (url.pathname === '/api/openvk/stream' && req.method === 'GET') {
      try {
        const upstream=await provider.preview(url.searchParams.get('source_id'),req.headers.range);
        const headers={
          'Content-Type':upstream.headers.get('content-type')||'audio/mpeg',
          'Accept-Ranges':upstream.headers.get('accept-ranges')||'bytes',
          'Cache-Control':'private, no-store',
        };
        for(const name of ['content-length','content-range']){const value=upstream.headers.get(name);if(value)headers[name]=value;}
        res.writeHead(upstream.status,headers);
        const body=readableFromWeb(upstream.body);
        req.once('aborted',()=>body.destroy());
        body.on('error',()=>{if(!res.destroyed)res.destroy();});
        body.pipe(res);
        return true;
      } catch(error) { return reply(res,providerErrorStatus(error,'stream'),{error:error.message}); }
    }
    if (url.pathname === '/api/openvk/import' && req.method === 'POST') {
      try {
        const result=await provider.importTrack({sourceId:(await readJson(req)).source_id,userId:user.id});
        return reply(res,result.status==='queued'?202:200,result);
      } catch(error) { return reply(res,providerErrorStatus(error,'import'),{error:error.message}); }
    }
    return false;
  }

  return { handle };
}
