import test from 'node:test';
import assert from 'node:assert/strict';
import {keyBytes,seal} from '../docs/crypto.mjs';
const publicState={snapshotAt:2000,lastSuccess:1990,schedule:{intervalMinutes:2},movies:[{id:'111',name:'测试电影'}],checks:[],cinemas:[]};
const contents=value=>new Response(JSON.stringify({content:Buffer.from(JSON.stringify(value)).toString('base64'),sha:'fixture-sha'}),{headers:{'Content-Type':'application/json'}});
async function until(condition){for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5))}throw new Error('Timed out waiting for isolated request')}
async function setup(t,{cache=false}={}){
  const secret='local-test-token',key=await keyBytes(secret),prefs={revision:'r1',stars:['111']};
  const personal={snapshotAt:2000,processedRevision:'r1',events:[{title:'private fixture'}]};
  const encrypted={preferences:await seal(prefs,key),private:await seal(personal,key)};
  const store=new Map([['polaris.github-token.v1',secret]]);
  if(cache){store.set('polaris.public-cache.v1',JSON.stringify(publicState));store.set('polaris.encrypted-cache.v1',JSON.stringify(encrypted))}
  const previous={fetch:globalThis.fetch,localStorage:globalThis.localStorage,window:globalThis.window};
  const waiting=new Map(),calls=[];
  globalThis.localStorage={getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,String(value)),removeItem:key=>store.delete(key)};
  globalThis.window=new EventTarget();
  globalThis.fetch=(url,options={})=>{
    assert.equal(options.method||'GET','GET');
    if(String(url).includes('ref=watchdog-state'))return Promise.resolve(new Response('{}',{status:404}));
    const name=String(url).startsWith('./')?'page':new URL(url).pathname.split('/').at(-1);
    assert.ok(['page','public.json','preferences.enc.json','private.enc.json'].includes(name));
    calls.push(name);return new Promise(resolve=>waiting.set(name,resolve));
  };
  t.after(()=>Object.assign(globalThis,previous));
  const client=await import('../docs/client.mjs?test='+crypto.randomUUID());
  function finish(){waiting.get('page')(new Response(JSON.stringify(publicState)));waiting.get('public.json')(contents(publicState));waiting.get('preferences.enc.json')(contents(encrypted.preferences));waiting.get('private.enc.json')(contents(encrypted.private))}
  return {client,store,waiting,calls,finish};
}
test('cached catalogue and encrypted stars render before network completion, with GitHub reads in parallel',async t=>{
  const {client,store,calls,finish}=await setup(t,{cache:true}),updates=[];
  const loaded=client.load({onUpdate:state=>updates.push(state)});
  assert.equal(updates[0].movies.length,1);
  await until(()=>calls.length===4);
  assert.ok(updates.some(state=>state.movies[0].active));
  assert.equal(updates.at(-1).syncing,true);
  finish();const state=await loaded;assert.equal(state.movies[0].active,true);assert.equal(state.syncing,false);
  assert.ok(!store.get('polaris.encrypted-cache.v1').includes('private fixture'));
  assert.ok(!store.get('polaris.public-cache.v1').includes('stars'));
});
test('first visit displays the public catalogue while personal requests are still pending',async t=>{
  const {client,waiting,calls}=await setup(t),updates=[];
  const loaded=client.load({onUpdate:state=>updates.push(state)});
  await until(()=>calls.length===4);
  waiting.get('page')(new Response(JSON.stringify(publicState)));
  await until(()=>updates.length>0);
  assert.equal(updates.at(-1).personalReady,false);assert.equal(updates.at(-1).movies.length,1);
  waiting.get('public.json')(contents(publicState));waiting.get('preferences.enc.json')(new Response('{}',{status:503}));waiting.get('private.enc.json')(new Response('{}',{status:503}));
  const state=await loaded;assert.match(state.syncError,/503/);assert.equal(state.movies.length,1);
});
test('disconnect during a slow refresh prevents late private data from reappearing or being cached',async t=>{
  const {client,store,calls,finish}=await setup(t,{cache:true});
  const loaded=client.load();await until(()=>calls.length===4);client.disconnect();finish();
  const state=await loaded;assert.equal(state.connected,false);assert.equal(state.movies[0].active,false);assert.deepEqual(state.events,[]);
  assert.equal(store.has('polaris.encrypted-cache.v1'),false);
});
