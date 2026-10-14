// SSE is a wake-up hint only. Durable commands, ACK and epochs stay in PostgreSQL.
export function createConnectEvents({enabled=false,authorize,heartbeatMs=15000,lifetimeMs=300000,maxConnections=128,maxPerUser=8,maxPerDevice=2}={}){
  const clients=new Set();
  function count(predicate){let total=0;for(const client of clients)if(predicate(client))total++;return total;}
  async function open(req,res,{userId,sessionId,deviceId}){
    if(!enabled)return{status:404,error_code:'connect_events_disabled'};
    if(!/^[a-zA-Z0-9_-]{16,96}$/.test(deviceId||''))return{status:400,error_code:'invalid_connect_device'};
    if(!await authorize({userId,sessionId,deviceId}))return{status:403,error_code:'connect_events_forbidden'};
    if(res.destroyed||req.aborted)return{status:499};
    const user=String(userId);
    if(clients.size>=maxConnections||count(c=>c.user===user)>=maxPerUser||count(c=>c.user===user&&c.deviceId===deviceId)>=maxPerDevice)return{status:429,error_code:'connect_events_limit'};
    const client={user,deviceId,closed:false,checking:false,dirty:false};
    let heartbeat,lifetime;
    function close(){
      if(client.closed)return;
      client.closed=true;clients.delete(client);clearInterval(heartbeat);clearTimeout(lifetime);
      req.off('aborted',close);res.off('close',close);res.off('error',close);
      if(!res.destroyed&&!res.writableEnded)res.end();
    }
    client.close=close;
    function write(frame){
      if(client.closed)return;
      // Never maintain an unbounded queue for a sleeping/slow phone.
      if(res.destroyed||res.writableEnded||res.writableLength>16384){close();return;}
      try{if(!res.write(frame)){res.destroy();close();}}catch{close();}
    }
    client.notify=()=>{
      client.dirty=true;
      if(client.checking||client.closed)return;
      client.checking=true;
      queueMicrotask(async()=>{
        try{
          // Coalesce bursts, and check session/device revocation before each hint.
          while(client.dirty&&!client.closed){
            client.dirty=false;
            if(!await authorize({userId,sessionId,deviceId})){close();break;}
            write('event: resync\ndata: {}\n\n');
          }
        }catch{close();}
        finally{client.checking=false;}
      });
    };
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store, no-transform','X-Accel-Buffering':'no','Content-Encoding':'identity'});
    res.flushHeaders?.();
    clients.add(client);req.on('aborted',close);res.on('close',close);res.on('error',close);
    write('retry: 1500\nevent: resync\ndata: {}\n\n');
    // Periodic reconciliation also discovers changes made by another API process.
    // Low-latency delivery currently requires one API process; no cross-process bus yet.
    heartbeat=setInterval(client.notify,heartbeatMs);heartbeat.unref?.();
    lifetime=setTimeout(close,lifetimeMs);lifetime.unref?.();
    if(client.closed){clearInterval(heartbeat);clearTimeout(lifetime);}
    return{status:200};
  }
  function notify(userId){for(const client of clients)if(client.user===String(userId))client.notify();}
  function close(){for(const client of [...clients])client.close();}
  return{enabled:Boolean(enabled),heartbeatMs,open,notify,close,size:()=>clients.size};
}
