import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {vapidKeys} from './push.mjs';
import {createRuntime,processRun} from './storage.mjs';

const repo=process.env.GITHUB_REPOSITORY;
const token=process.env.GITHUB_TOKEN;
const master=process.env.STATE_MASTER_KEY;
if(!/^[\w.-]+\/[\w.-]+$/.test(repo||'')||!token||!master)throw new Error('Repository runtime secrets are not configured.');
async function api(path,body,raw=false,missing=false) {
  const r=await fetch(`https://api.github.com/repos/${repo}${path}`,{method:body===undefined?'GET':'POST',redirect:'error',
    headers:{Authorization:`Bearer ${token}`,Accept:raw?'application/vnd.github.raw+json':'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  if(missing&&r.status===404)return null;
  if(!r.ok)throw new Error(`GitHub storage HTTP ${r.status}`);
  return r.json();
}
async function content(path,branch){return api(`/contents/${path}?ref=${branch}`,undefined,true,true)}
async function persist(files) {
  const entries=[];
  for(const [path,obj] of Object.entries(files)){const blob=await api('/git/blobs',{content:JSON.stringify(obj),encoding:'utf-8'});entries.push({path,mode:'100644',type:'blob',sha:blob.sha});}
  const tree=await api('/git/trees',{tree:entries});
  // The generated state branch is a replaceable snapshot, never the source branch.
  const commit=await api('/git/commits',{message:'Update encrypted monitor snapshot',tree:tree.sha,parents:[]});
  const ref=await api('/git/ref/heads/monitor-state',undefined,false,true);
  if(!ref)await api('/git/refs',{ref:'refs/heads/monitor-state',sha:commit.sha});
  else{
    const r=await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/monitor-state`,{method:'PATCH',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({sha:commit.sha,force:true}),signal:AbortSignal.timeout(45000)});
    if(!r.ok)throw new Error(`State save HTTP ${r.status}`);
  }
}
mkdirSync('docs/data',{recursive:true});writeFileSync('docs/data/push-key.json',JSON.stringify({publicKey:vapidKeys(master).publicKey}));
const snapshot=await content('backend.enc.json','monitor-state');
// Existing state must never be treated as first-run when GitHub is unavailable.
if(!snapshot){const ref=await api('/git/ref/heads/monitor-state',undefined,false,true);if(ref)throw new Error('Existing monitor state is incomplete; refusing a clean start.');}
const envelope=await content('preferences.enc.json','preferences');
const runtime=await createRuntime({master,identity:JSON.parse(readFileSync('bootstrap/identity.enc.json','utf8')),snapshot,path:'.runtime/monitor.sqlite'});
runtime.path='.runtime/monitor.sqlite';
const output=await processRun(runtime,envelope,{mode:process.env.WATCH_MODE||'check'});
const files={'backend.enc.json':output.snapshot,'public.json':output.publicData};
if(output.privateData)files['private.enc.json']=output.privateData;
await persist(files);
mkdirSync('docs/data',{recursive:true});writeFileSync('docs/data/state.json',JSON.stringify(output.publicData));
const report={cinemasChecked:output.result.checks?.length||0,catalogRequests:output.result.catalog?.requests||0,catalogLists:output.result.catalog?.lists||[],catalogMoviesUpdated:output.result.catalog?.movies||0,catalogComplete:!!output.result.catalog?.complete,catalogPending:output.publicData.catalogPending,outcome:output.result.paused?'paused':output.result.cooldown?'cooldown':output.result.error?'error':output.result.busy?'busy':'checked',movies:output.publicData.movies.length,lastSuccess:output.publicData.lastSuccess,storageSaved:true};
console.log(JSON.stringify(report));
if(process.env.GITHUB_STEP_SUMMARY)writeFileSync(process.env.GITHUB_STEP_SUMMARY,'### Independent monitor\n\n```json\n'+JSON.stringify(report,null,2)+'\n```\n');
if(output.result.error)process.exitCode=1;
