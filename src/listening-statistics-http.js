import {listeningPeriod} from './measured-statistics.js';

export function createListeningStatisticsHttp({ statistics,events,measured,readJson,sendJson }) {
  async function sessionSettings(value,user){
    const scope=await events.journalScope?.(user);
    return scope?{...value,journal_scope:scope}:value;
  }
  async function handle(req,res,url,user) {
    if(url.pathname==='/api/statistics/settings'){
      if(req.method==='GET'){sendJson(res,200,await sessionSettings(await events.settings(user.id),user));return true;}
      if(req.method==='PUT'){
        const body=await readJson(req,1024),result=await events.configure(user.id,body?.enabled);
        sendJson(res,result.status==='invalid'?400:200,result.status==='invalid'?{error:'Укажите enabled как true или false'}:await sessionSettings(result.settings,user));return true;
      }
    }
    if(url.pathname==='/api/statistics/listening'&&req.method==='DELETE'){
      sendJson(res,200,await sessionSettings(await events.clear(user.id),user));return true;
    }
    if(url.pathname==='/api/statistics/events'&&req.method==='POST'){
      const result=await events.record(user,await readJson(req,4096));
      if(result.status==='ok'||result.status==='disabled')sendJson(res,200,result);
      else{
        const status={invalid:400,invalid_time:400,not_found:404,limit:429,expired:410}[result.status]||409;
        sendJson(res,status,{error:'Данные учёта прослушивания не приняты',error_code:`statistics_${result.status}`});
      }
      return true;
    }
    if(req.method==='GET'&&['/api/statistics/listening','/api/admin/listening'].includes(url.pathname)){
      const admin=url.pathname==='/api/admin/listening';
      if(admin&&!user.is_admin){sendJson(res,403,{error:'Доступно только администратору'});return true;}
      const period=listeningPeriod(url.searchParams.get('period')||'7');
      if(!period){sendJson(res,400,{error:'Выберите period: 7, 30 или all'});return true;}
      const result=admin?await measured.administrative(period):await measured.personal(user.id,period);
      if(!admin&&result.settings)result.settings=await sessionSettings(result.settings,user);
      sendJson(res,200,result);return true;
    }
    if(req.method!=='GET')return false;
    if(url.pathname==='/api/statistics/me') {
      sendJson(res,200,await statistics.personal(user.id));return true;
    }
    if(url.pathname==='/api/admin/usage') {
      if(!user.is_admin)sendJson(res,403,{error:'Доступно только администратору'});
      else sendJson(res,200,await statistics.administrative());
      return true;
    }
    return false;
  }
  return { handle };
}
