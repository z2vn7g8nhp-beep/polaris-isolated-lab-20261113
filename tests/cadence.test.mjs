import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dbEnv} from '../backend/storage.mjs';
import {updateCatalog,CADENCE} from '../backend/monitor.mjs';
function setup(){const e=dbEnv();e.db.exec(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));return e}
function put(e,key,value){e.db.prepare('INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value))}
function get(e,key){return JSON.parse(e.db.prepare('SELECT value FROM radar_kv WHERE key=?').get(key).value)}
function movie(id,wish=100){return {id:Number(id),nm:'电影'+id,rt:'2030-12-01',wish}}
const response=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});

test('list clocks are independent, both overdue lists get a turn, and catalogue requests stay within budget',async()=>{
  const e=setup(),at=1800000000,original=globalThis.fetch,calls=[];
  for(const id of ['111','222','333'])e.db.prepare('INSERT INTO radar_movies VALUES (?,?,?)').run(id,JSON.stringify(movie(id)),at);
  put(e,'coming_ids',['111','333']);put(e,'released_ids',['222']);
  put(e,'coming_updated',at-31*60);put(e,'released_updated',at-121*60);put(e,'catalog_job',{which:'upcoming',remaining:[111]});
  globalThis.fetch=async url=>{
    const u=new URL(url);calls.push(u);
    if(u.pathname.endsWith('/comingList'))return response({movieIds:[111,333,444],coming:[movie(111,999)]});
    if(u.pathname.endsWith('/movieOnInfoList'))return response({movieIds:[222],movieList:[movie(222)]});
    return response({coming:u.searchParams.get('movieIds').split(',').map(id=>movie(id))});
  };
  try{
    const first=await updateCatalog(e,at);assert.equal(first.requests,2);assert.deepEqual(first.lists,['upcoming']);assert.equal(first.movies,4);
    assert.deepEqual(get(e,'coming_ids'),['111','333','444']);assert.equal(get(e,'coming_updated'),at);assert.equal(get(e,'catalog_job'),null);
    const second=await updateCatalog(e,at+300);assert.equal(second.requests,1);assert.deepEqual(second.lists,['released']);
    const third=await updateCatalog(e,at+600);assert.equal(third.requests,0);
    const fourth=await updateCatalog(e,at+31*60);assert.equal(fourth.requests,1);assert.deepEqual(fourth.lists,['upcoming']);
    const fifth=await updateCatalog(e,at+61*60);assert.equal(fifth.requests,2);assert.deepEqual(fifth.lists,['upcoming']);
    assert.equal(get(e,'catalog_refreshed')['333'],at+61*60);
    for(const result of [first,second,third,fourth,fifth])assert.ok(result.requests<=CADENCE.maxCatalogRequests);
    assert.ok(calls.every(u=>u.hostname==='m.maoyan.com'));
  }finally{globalThis.fetch=original;e.db.close()}
});

test('detail rotation is limited to twelve films and ignores cinema-only modification times',async()=>{
  const e=setup(),at=1800000000,ids=Array.from({length:25},(_,i)=>String(100+i)),original=globalThis.fetch,batches=[];
  for(const id of ids)e.db.prepare('INSERT INTO radar_movies VALUES (?,?,?)').run(id,JSON.stringify(movie(id)),at+1000);
  put(e,'coming_ids',ids);put(e,'released_ids',[]);put(e,'coming_updated',at);put(e,'released_updated',at);
  globalThis.fetch=async url=>{const batch=new URL(url).searchParams.get('movieIds').split(',');batches.push(batch);return response({coming:batch.map(id=>movie(id,200))})};
  try{
    assert.equal((await updateCatalog(e,at)).requests,1);assert.equal(batches[0].length,12);
    await updateCatalog(e,at+300);assert.equal(batches[1].length,12);assert.equal(new Set([...batches[0],...batches[1]]).size,24);
    await updateCatalog(e,at+600);assert.equal(batches[2].length,1);
    const idle=await updateCatalog(e,at+900);assert.equal(idle.requests,0);
    assert.equal(get(e,'catalog_refreshed')[ids[0]],at);
  }finally{globalThis.fetch=original;e.db.close()}
});
