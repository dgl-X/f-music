// Hints only: never execute a command or publish playback state from this stream.
export class ConnectEventsClient {
  constructor({factory=typeof globalThis.EventSource==='function'?url=>new globalThis.EventSource(url):null,onHint=()=>{},now=()=>performance.now()}={}){
    this.factory=factory;this.onHint=onHint;this.now=now;this.source=null;this.url='';this.healthy=false;this.lastEvent=0;this.retryAt=0;this.failures=0;this.watchdogMs=45000;
  }
  configure(status,deviceId){
    const available=Boolean(this.factory&&status.enabled&&Array.isArray(status.transports)&&status.transports.includes('sse')&&status.events_url==='/api/v1/connect/events');
    if(!available){this.close();return;}
    const url=`${status.events_url}?device_id=${encodeURIComponent(deviceId)}`;
    this.watchdogMs=Math.max(45000,Math.min(180000,(Number(status.events_heartbeat_ms)||15000)*3));
    if(this.url!==url){this.close();this.url=url;}
    this.tick();
  }
  disconnect(){const source=this.source;this.source=null;this.healthy=false;source?.close();}
  failed(){
    this.disconnect();this.failures=Math.min(6,this.failures+1);
    this.retryAt=this.now()+Math.min(30000,1500*2**(this.failures-1));
    this.onHint(); // Polling checks authorization and reconciles missed commands.
  }
  tick(){
    if(!this.url)return;
    if(this.source&&this.now()-this.lastEvent>=this.watchdogMs)this.failed();
    if(this.source||this.now()<this.retryAt)return;
    let source;
    try{source=this.factory(this.url);this.source=source;this.lastEvent=this.now();}
    catch{this.failed();return;}
    const current=()=>this.source===source;
    source.addEventListener('open',()=>{if(current())this.onHint();});
    source.addEventListener('resync',()=>{
      if(!current())return;
      this.lastEvent=this.now();this.healthy=true;this.failures=0;this.onHint();
    });
    source.addEventListener('error',()=>{if(current())this.failed();});
  }
  close(){this.url='';this.retryAt=0;this.failures=0;this.disconnect();}
}
