import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker,{upcoming,parseSessions,CINEMAS} from '../backend/monitor.mjs';
function dbEnv(){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../backend/schema.sql', import.meta.url),'utf8'));
  function stmt(sql,args=[]){return {bind(...v){return stmt(sql,v)},async first(){return db.prepare(sql).get(...args)||null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}}}};}
  return {DB:{prepare:stmt,async batch(stmts){db.exec('BEGIN');try{const r=await Promise.all(stmts.map(s=>s.run()));db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}},BARK_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),db};
}
const movie={id:111,nm:'测试影片',rt:'2030-10-01',globalReleased:false,img:'https://example.com/poster.jpg'};
function fixture(available=1){return {showData:{cinemaId:25769,movies:[{...movie,shows:[{showDate:'2030-09-20',plist:[{seqNo:'seq1',dt:'2030-09-20',tm:'19:00',th:'IMAX厅',tp:'IMAX',enterShowSeat:available,forbiddenTip:'',saleDate:''}]}]}]}}}
async function call(env,path,body){const r=await worker.fetch(new Request('https://radar.test/api/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env,{});return {status:r.status,data:await r.json()}}
async function setup(){const env=dbEnv();await call(env,'state');env.db.prepare('INSERT INTO radar_movies VALUES (?,?,?)').run('111',JSON.stringify(movie),1);await call(env,'star',{id:'111',active:true});env.db.prepare('INSERT INTO radar_kv VALUES (?,?)').run('coming_ids',JSON.stringify(['111']));return env}
function cooldownOff(env){env.db.prepare("DELETE FROM radar_kv WHERE key='next_request'").run()}

test('release date takes priority, premieres remain upcoming until release day',()=>{assert.equal(upcoming({...movie,globalReleased:true},'2030-09-20'),true);assert.equal(upcoming(movie,'2030-10-01'),false);assert.equal(upcoming({globalReleased:false},'2030-10-01'),true)});
test('parse verified cinema schema and reject wrong venue',()=>{const out=parseSessions(fixture(),CINEMAS[0]);assert.equal(out.rows.length,1);assert.equal(out.rows[0].available,true);assert.throws(()=>parseSessions(fixture(),CINEMAS[1]))});
test('star persists; manual stop cancels queued notifications',async()=>{const env=await setup();const r=await call(env,'state');assert.equal(r.data.movies.find(m=>m.id==='111').active,true);env.db.prepare("INSERT INTO radar_events(id,movie_id,kind,title,body,created_at) VALUES ('e','111','release','title','body',1)").run();await call(env,'star',{id:'111',active:false});assert.equal(env.db.prepare('SELECT cancelled FROM radar_events').get().cancelled,1);assert.equal((await call(env,'state')).data.movies.find(m=>m.id==='111').active,false)});
test('first sale alerts once, stable repeats dedupe, restock alerts again',async()=>{const env=await setup();const original=globalThis.fetch;let sale=1;globalThis.fetch=async(url)=>new Response(JSON.stringify(String(url).includes('39869')?{showData:{cinemaId:39869,movies:[]}}:fixture(sale)),{headers:{'Content-Type':'application/json'}});try{await call(env,'tick',{});assert.equal(env.db.prepare('SELECT count(*) n FROM radar_events').get().n,1);cooldownOff(env);env.db.prepare("DELETE FROM radar_kv WHERE key LIKE 'cinema_%'").run();await call(env,'tick',{});assert.equal(env.db.prepare('SELECT count(*) n FROM radar_events').get().n,1);sale=0;cooldownOff(env);env.db.prepare("DELETE FROM radar_kv WHERE key LIKE 'cinema_%'").run();await call(env,'tick',{});sale=1;cooldownOff(env);env.db.prepare("DELETE FROM radar_kv WHERE key LIKE 'cinema_%'").run();await call(env,'tick',{});assert.equal(env.db.prepare('SELECT count(*) n FROM radar_events').get().n,2)}finally{globalThis.fetch=original}});
test('429 pauses persistently; further ticks do not access source',async()=>{const env=await setup();const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:429})};try{await call(env,'tick',{});cooldownOff(env);const result=await call(env,'tick',{});assert.ok(result.data.paused);assert.equal(calls,1);assert.equal(env.db.prepare('SELECT count(*) n FROM radar_events').get().n,1)}finally{globalThis.fetch=original}});
test('Bark device key encrypted and excluded from state; payload uses separate group',async()=>{const env=await setup();await call(env,'bark',{key:'example_test_key_123'});const encrypted=env.db.prepare("SELECT value FROM radar_kv WHERE key='bark'").get().value;assert.ok(!encrypted.includes('example_test_key'));assert.ok(!JSON.stringify((await call(env,'state')).data).includes('example_test_key'));const original=globalThis.fetch;let payload;globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.day.app/push');payload=JSON.parse(options.body);return new Response('{"code":200}',{headers:{'Content-Type':'application/json'}})};try{assert.equal((await call(env,'bark/test',{})).status,200);assert.equal(payload.group,'电影开票');assert.equal(payload.device_key,'example_test_key_123');assert.ok(!('id' in payload))}finally{globalThis.fetch=original}});
test('cross-origin mutation rejected',async()=>{const env=dbEnv();const r=await worker.fetch(new Request('https://radar.test/api/pause',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'}),env,{});assert.equal(r.status,403)});

test('new sessions and observable sale batches notify again, while stable states and released films do not',async()=>{
  const env=await setup(),original=globalThis.fetch;let extra=false,batch='',released=false;
  globalThis.fetch=async url=>{
    const data=String(url).includes('39869')?{showData:{cinemaId:39869,movies:[]}}:fixture();
    if(data.showData.movies.length){const m=data.showData.movies[0];m.shows[0].plist[0].saleDate=batch;if(extra)m.shows[0].plist.push({...m.shows[0].plist[0],seqNo:'extra',tm:'20:00'});if(released)m.rt='2020-01-01';}
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  };
  const count=()=>env.db.prepare("SELECT count(*) n FROM radar_events WHERE kind='release'").get().n;
  try{
    await call(env,'tick',{});assert.equal(count(),1);
    cooldownOff(env);await call(env,'tick',{});assert.equal(count(),1);
    extra=true;cooldownOff(env);await call(env,'tick',{});assert.equal(count(),2);
    batch='another-sale-batch';cooldownOff(env);await call(env,'tick',{});assert.equal(count(),3);
    released=true;batch='after-release';cooldownOff(env);await call(env,'tick',{});assert.equal(count(),3);
  }finally{globalThis.fetch=original;env.db.close()}
});
