import {keyBytes,sealPreferences,unseal} from './crypto.mjs';
import {newerPublic,mergeStatus} from './status.mjs?v=fast-five-1';
const REPO='z2vn7g8nhp-beep/polaris-isolated-lab-20261113';
const API=`https://api.github.com/repos/${REPO}`;
const storageKey='polaris.github-token.v1';
const publicCacheKey='polaris.public-cache.v1',personalCacheKey='polaris.encrypted-cache.v1';
function readCache(key){try{return JSON.parse(localStorage.getItem(key))}catch{return null}}
function writeCache(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}
let token=localStorage.getItem(storageKey)||'',rawKey=null,prefs=null,latest=null;
let base=readCache(publicCacheKey),envelopes={},hydrated=false,epoch=0,flight=null,syncing=false,syncError=null;
if(!Array.isArray(base?.movies))base=null;
const observers=new Set();
export const connected=()=>Boolean(token);
export const pending=()=>Boolean(prefs&&latest?.processedRevision!==prefs.revision);
export const repository=REPO;
async function request(path,{method='GET',body,optional=false}={}) {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try{
  const response=await fetch(API+path,{signal:controller.signal,method,redirect:'error',cache:'no-store',headers:{Accept:'application/vnd.github+json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
  if(optional&&response.status===404)return null;
  if(!response.ok){
    const text=response.status===401?'GitHub 密钥无效或已到期':response.status===403?'GitHub 权限不足：请检查新仓库的 Contents 和 Actions 读写权限':response.status===409?'同步冲突，请稍后再试':`GitHub 请求失败（${response.status}）`;
    throw new Error(text);
  }
  if(response.status===204)return null;
  return await response.json();
  }catch(error){if(error.name==='AbortError')throw new Error('GitHub 连接超时，暂时显示上次保存的私人数据');throw error}
  finally{clearTimeout(timeout)}
}
function decodeContent(value) {return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.content.replace(/\s/g,'')),c=>c.charCodeAt(0))))}
function encodeContent(value) {const bytes=new TextEncoder().encode(JSON.stringify(value));let text='';for(const c of bytes)text+=String.fromCharCode(c);return btoa(text)}
async function file(path,branch,optional=false){const r=await request(`/contents/${path}?ref=${branch}`,{optional});return r?{value:decodeContent(r),sha:r.sha}:null}
async function readPreferences(){
  rawKey=rawKey||await keyBytes(token);
  const saved=await file('preferences.enc.json','preferences',true);
  if(!saved)return {value:{revision:'',stars:[]},sha:null};
  try{return {value:await unseal(saved.value,rawKey),sha:saved.sha}}
  catch{throw new Error('同步密钥与现有配置不匹配。请使用最初连接时的同一个 GitHub 密钥；不要覆盖原配置。')}
}
export async function connect(value){
  const previous={token,rawKey,prefs,latest,envelopes,hydrated};token=value.trim();rawKey=null;prefs=null;latest=null;envelopes={};hydrated=true;epoch++;
  try{
    if(!token)throw new Error('请填写新仓库的 GitHub 密钥');
    const repo=await request('');if(!repo.permissions?.push)throw new Error('这个密钥没有新仓库的写入权限');
    await readPreferences();
    await update(value=>value);localStorage.setItem(storageKey,token);
  }catch(error){({token,rawKey,prefs,latest,envelopes,hydrated}=previous);epoch++;throw error}
}
export function disconnect(){token='';rawKey=null;prefs=null;latest=null;envelopes={};hydrated=false;epoch++;localStorage.removeItem(storageKey);localStorage.removeItem(personalCacheKey)}
async function trigger(){await request('/actions/workflows/scheduled-watch.yml/dispatches',{method:'POST',body:{ref:'main',inputs:{mode:'check'}}})}
async function update(change){
  if(!token)throw new Error('先到「监测与推送」连接 GitHub；只需设置一次');
  epoch++;
  const main=await request('/git/ref/heads/main');
  if(!await request('/git/ref/heads/preferences',{optional:true})){
    try{await request('/git/refs',{method:'POST',body:{ref:'refs/heads/preferences',sha:main.object.sha}})}catch(error){if(!await request('/git/ref/heads/preferences',{optional:true}))throw error}
  }
  const saved=await readPreferences();
  const changed=change(structuredClone(saved.value));changed.revision=crypto.randomUUID();
  const publicKey=await (await fetch('./data/public-key.json',{cache:'no-store'})).json();
  const envelope=await sealPreferences(changed,rawKey,publicKey.spki);
  await request('/contents/preferences.enc.json',{method:'PUT',body:{message:'Update encrypted preferences',branch:'preferences',content:encodeContent(envelope),...(saved.sha?{sha:saved.sha}:{})}});
  epoch++;prefs=changed;envelopes.preferences=envelope;writeCache(personalCacheKey,envelopes);
  try{await trigger()}catch{window.dispatchEvent(new CustomEvent('polaris-notice',{detail:'配置已加密保存；立即触发未成功，定时任务会在下一轮处理。'}))}
  return {queued:true};
}
function currentState(){
  if(!base)return null;
  const starred=new Set(prefs?.stars||[]);
  const combined=mergeStatus(base,latest);
  return {...combined,syncError,syncing,personalReady:!token||prefs!==null,movies:combined.movies.map(m=>({...m,active:starred.has(m.id)})),
    events:latest?.events||[],pushConfigured:latest?.processedRevision===prefs?.revision?Boolean(latest?.pushConfigured):Boolean(prefs?.pushSubscription||latest?.pushConfigured),
    notificationMode:prefs?.notificationMode||latest?.notificationMode||'off',
    barkConfigured:Object.hasOwn(prefs||{},'barkKey')?Boolean(prefs.barkKey):Boolean(latest?.barkConfigured),
    paused:prefs?.control?.action==='pause'&&pending()?'暂停请求待后台处理':combined.paused||null,
    connected:Boolean(token),pending:pending(),requestResult:latest?.requestResult};
}
function publish(){const state=currentState();if(state)for(const observer of observers)observer(state)}
function acceptPublic(value){if(!Array.isArray(value?.movies))throw new Error('片库数据无效');base=newerPublic(base,value);writeCache(publicCacheKey,base);publish()}
async function restorePersonal(secret,version){
  if(hydrated)return;hydrated=true;
  const cached=readCache(personalCacheKey);if(!cached)return;
  try{
    const key=await keyBytes(secret);
    const [saved,personal]=await Promise.all([cached.preferences?unseal(cached.preferences,key):null,cached.private?unseal(cached.private,key):null]);
    if(secret!==token||version!==epoch)return;
    rawKey=key;envelopes=cached;prefs=saved;latest=personal;publish();
  }catch{/* A cache encrypted for another connection must never replace its data. */}
}
async function refresh(){
  syncing=true;syncError=null;publish();
  const secret=token,version=epoch,errors=[];
  const page=(async()=>{
    const response=await fetch('./data/state.json',{cache:'no-cache',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('片库暂时无法更新，正在显示上次保存的数据');
    acceptPublic(await response.json());
  })();
  const personal=(async()=>{
    if(!secret)return;
    await restorePersonal(secret,version);
    const key=await keyBytes(secret),current=()=>secret===token&&version===epoch;
    const remember=(name,value)=>{if(value)envelopes[name]=value;else delete envelopes[name];writeCache(personalCacheKey,envelopes)};
    const results=await Promise.allSettled([
      file('public.json','monitor-state',true).then(remote=>{if(remote)acceptPublic(remote.value)}),
      file('preferences.enc.json','preferences',true).then(async saved=>{
        let value;try{value=saved?await unseal(saved.value,key):{revision:'',stars:[]}}catch{throw new Error('同步密钥与现有配置不匹配，请使用最初连接时的同一个 GitHub 密钥。')}
        if(current()){rawKey=key;prefs=value;remember('preferences',saved?.value);publish()}
      }),
      file('private.enc.json','monitor-state',true).then(async saved=>{
        const value=saved?await unseal(saved.value,key):null;
        if(current()){latest=value;remember('private',saved?.value);publish()}
      })
    ]);
    if(current())for(const result of results)if(result.status==='rejected')errors.push(result.reason.message);
  })();
  const results=await Promise.allSettled([page,personal]);
  for(const result of results)if(result.status==='rejected')errors.push(result.reason.message||'连接暂时失败');
  syncing=false;syncError=errors[0]||null;
  if(!base)throw new Error(syncError||'片库暂时无法连接');
  publish();
}
export async function load({onUpdate}={}){
  if(onUpdate){observers.add(onUpdate);const cached=currentState();if(cached)onUpdate(cached)}
  if(!flight)flight=refresh().finally(()=>{flight=null});
  try{await flight;return currentState()}finally{if(onUpdate)observers.delete(onUpdate)}
}
export async function api(path,body){
  if(path==='state')return load(body);
  if(path==='star')return update(p=>{const stars=new Set(p.stars);body.active?stars.add(body.id):stars.delete(body.id);p.stars=[...stars];return p});
  if(path==='bark')return update(p=>{if(!/^[A-Za-z0-9_-]{8,200}$/.test(body.key))throw new Error('请输入 Bark 设备 Key，而不是完整网址');p.barkKey=body.key;p.notificationMode='bark';return p});
  if(path==='bark/remove')return update(p=>{p.barkKey=null;return p});
  if(path==='pause'||path==='resume')return update(p=>{p.control={id:crypto.randomUUID(),action:path};return p});
  if(path==='push')return update(p=>{p.pushSubscription=body.subscription;p.notificationMode='push';return p});
  if(path==='push/remove')return update(p=>{p.pushSubscription=null;p.notificationMode='off';return p});
  if(path==='push/test')return update(p=>{p.request={id:crypto.randomUUID(),action:path};return p});
  if(path==='bark/test')return update(p=>{p.request={id:crypto.randomUUID(),action:path};return p});
  if(path==='tick'){if(!token)throw new Error('请先连接 GitHub');await trigger();return {queued:true}}
  throw new Error('不支持的操作');
}
