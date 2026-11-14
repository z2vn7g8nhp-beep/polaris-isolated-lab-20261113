import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {keyBytes,seal,unseal,openPreferences} from '../docs/crypto.mjs';
import worker from './monitor.mjs';
import {vapidKeys} from './push.mjs';

export function dbEnv(path=':memory:', master='test-only') {
  const db=new DatabaseSync(path);
  function stmt(sql,args=[]) {return {
    bind(...v){return stmt(sql,v)},
    async first(){return db.prepare(sql).get(...args)||null},
    async all(){return {results:db.prepare(sql).all(...args)}},
    async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}}}
  };}
  return {db,DB:{prepare:stmt,async batch(stmts){db.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}},
    PUSH_KEYS:vapidKeys(master),
    BARK_ENCRYPTION_KEY:createHash('sha256').update('polaris-bark:'+master).digest('base64')};
}
export async function call(env,path,body) {
  const r=await worker.fetch(new Request('https://local.invalid/api/'+path,{method:body===undefined?'GET':'POST',
    headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,{});
  const result=await r.json();if(!r.ok||result.error)throw new Error(result.error||'监测操作失败');return result;
}
const value=(env,key,defaultValue=null)=>{const r=env.db.prepare('SELECT value FROM radar_kv WHERE key=?').get(key);return r?JSON.parse(r.value):defaultValue;};
const set=(env,key,v)=>env.db.prepare('INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(v));

export async function applyPreferences(env,prefs) {
  if(!prefs||typeof prefs.revision!=='string'||!Array.isArray(prefs.stars)||prefs.stars.length>2000||prefs.stars.some(id=>!/^\d+$/.test(id)))throw new Error('偏好数据格式无效');
  if(value(env,'preferences_revision')===prefs.revision)return false;
  const current=await call(env,'state');
  const wanted=new Set(prefs.stars);
  for(const movie of current.movies)if(Boolean(movie.active)!==wanted.has(movie.id))await call(env,'star',{id:movie.id,active:wanted.has(movie.id)});
  const signature=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  if(Object.hasOwn(prefs,'barkKey')&&signature(prefs.barkKey)!==value(env,'bark_signature')) {
    if(prefs.barkKey===null)await call(env,'bark/remove',{});
    else if(typeof prefs.barkKey==='string')await call(env,'bark',{key:prefs.barkKey});
    else throw new Error('Bark 配置格式无效');
    set(env,'bark_signature',signature(prefs.barkKey));
  }
  if(Object.hasOwn(prefs,'pushSubscription')&&signature(prefs.pushSubscription)!==value(env,'push_signature')){
    await call(env,prefs.pushSubscription===null?'push/remove':'push',prefs.pushSubscription===null?{}:{subscription:prefs.pushSubscription});
    set(env,'push_signature',signature(prefs.pushSubscription));
  }
  if(['push','bark','off'].includes(prefs.notificationMode))set(env,'notification_mode',prefs.notificationMode);
  const control=prefs.control;
  if(control&&control.id!==value(env,'last_control')&&['pause','resume'].includes(control.action)) {
    await call(env,control.action,{});set(env,'last_control',control.id);
  }
  const request=prefs.request;
  if(request?.id&&request.id!==value(env,'last_request')&&['bark/test','push/test'].includes(request.action)) {
    try{await call(env,request.action,{});set(env,'request_result',{id:request.id,ok:true})}
    catch{set(env,'request_result',{id:request.id,ok:false,message:'测试推送失败，请检查通知权限、连接或推送服务状态。'})}
    set(env,'last_request',request.id);
  }
  set(env,'preferences_revision',prefs.revision);return true;
}
export function publicView(state) {
  return {snapshotAt:state.snapshotAt,lastRunOutcome:state.lastRunOutcome,schedulerHeartbeat:state.schedulerHeartbeat,cadence:state.cadence,releasedUpdated:state.releasedUpdated,movies:state.movies.map(({active,...movie})=>movie),cinemas:state.cinemas,
    lastSuccess:state.lastSuccess,lastError:state.lastError,checks:state.checks,
    catalogUpdated:state.catalogUpdated,comingTotal:state.comingTotal,comingSourceReady:state.comingSourceReady,comingUpdated:state.comingUpdated,schedule:{provider:'github-actions',frequency:'two_minutes',intervalMinutes:2,fallbackMinutes:5}};
}
export async function createRuntime({master,identity,snapshot,path}) {
  const masterKey=await keyBytes(master,'server');
  const secrets=await unseal(identity,masterKey);
  mkdirSync(new URL('../.runtime/',import.meta.url),{recursive:true});
  if(snapshot)writeFileSync(path,await unseal(snapshot,masterKey,true));
  const env=dbEnv(path,master);
  if(!snapshot){
    env.db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
    for(const row of secrets.kv||[])if(!['schedule','scheduler_heartbeat','seed_count','seeded'].includes(row.key))set(env,row.key,JSON.parse(row.value));
  }
  return {env,masterKey,secrets,path};
}
export async function processRun(runtime,envelope,{mode='check'}={}) {
  const {env,secrets,masterKey}=runtime;let personalKey=null;
  if(envelope){const opened=await openPreferences(envelope,secrets.privateKey);personalKey=opened.rawKey;await applyPreferences(env,opened.prefs);}
  let result={status:true};
  if(mode!=='status')try{result=await call(env,'tick',{source:'github-actions'})}catch(error){result={error:error.message}}
  const state=await call(env,'state');
  state.snapshotAt=Math.floor(Date.now()/1000);
  state.lastRunOutcome=result.paused?'paused':result.cooldown?'cooldown':result.error?'error':result.busy?'busy':mode==='status'?'status':'checked';
  const personal={...state,processedRevision:value(env,'preferences_revision'),requestResult:value(env,'request_result')};
  const publicData=publicView(state);
  const privateData=personalKey?await seal(personal,personalKey):null;
  env.db.close();
  const snapshot=await seal(new Uint8Array(readFileSync(runtime.path)),masterKey);
  return {snapshot,publicData,privateData,result};
}
