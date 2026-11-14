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

test('five-minute cycle refreshes both lists, all film details and new releases rather than only twelve films',async()=>{
  const e=setup(),at=1800000000,original=globalThis.fetch,ids=Array.from({length:185},(_,i)=>String(100+i));let wish=100,calls=[];
  for(const id of ids)e.db.prepare('INSERT INTO radar_movies VALUES (?,?,?)').run(id,JSON.stringify(movie(id,1)),at+1000);
  globalThis.fetch=async url=>{
    const u=new URL(url);calls.push(u);
    if(u.pathname.endsWith('/comingList'))return response({movieIds:[...ids.slice(12),'999'],coming:ids.slice(12,24).map(id=>movie(id,wish))});
    if(u.pathname.endsWith('/movieOnInfoList'))return response({movieIds:ids.slice(0,12),movieList:ids.slice(0,12).map(id=>movie(id,wish))});
    const batch=u.searchParams.get('movieIds').split(',');assert.ok(batch.length<=12);
    return response({coming:batch.map(id=>movie(id,wish))});
  };
  try{
    const first=await updateCatalog(e,at);assert.deepEqual(first.lists,['upcoming','released']);assert.equal(first.complete,true);
    assert.equal(first.movies,186);assert.ok(first.requests<=CADENCE.maxCatalogRequests);
    assert.equal(get(e,'catalog_completed'),at);assert.equal(get(e,'catalog_next_refresh'),at+300);
    assert.equal(get(e,'catalog_refreshed')['999'],at);assert.equal(get(e,'catalog_refreshed')[ids[0]],at);
    const count=calls.length;assert.equal((await updateCatalog(e,at+120)).requests,0);assert.equal(calls.length,count);
    wish=200;const second=await updateCatalog(e,at+300);assert.equal(second.complete,true);assert.equal(second.movies,186);
    assert.ok(e.db.prepare('SELECT data FROM radar_movies').all().every(row=>JSON.parse(row.data).wish===200));
    assert.ok(calls.every(u=>u.hostname==='m.maoyan.com'));
  }finally{globalThis.fetch=original;e.db.close()}
});

test('two-minute trigger jitter does not turn the five-minute catalogue clock into a six-minute clock',async()=>{
  const e=setup(),at=1800000000,original=globalThis.fetch;
  globalThis.fetch=async url=>new URL(url).pathname.endsWith('/comingList')?response({movieIds:[111],coming:[movie(111)]}):response({movieIds:[],movieList:[]});
  try{
    await updateCatalog(e,at);await updateCatalog(e,at+360);
    assert.equal(get(e,'catalog_next_refresh'),at+600);
    assert.equal((await updateCatalog(e,at+599)).requests,0);
    assert.equal((await updateCatalog(e,at+600)).complete,true);
  }finally{globalThis.fetch=original;e.db.close()}
});

test('request cap retains a partial catalogue queue and resumes it without fetching completed batches again',async()=>{
  const e=setup(),at=1800000000,ids=Array.from({length:245},(_,i)=>String(100+i)),original=globalThis.fetch,seen=[];
  for(const id of ids)e.db.prepare('INSERT INTO radar_movies VALUES (?,?,?)').run(id,JSON.stringify(movie(id)),at+1000);
  put(e,'catalog_cycle',{scheduled:at,phase:'details',remaining:ids});
  globalThis.fetch=async url=>{const batch=new URL(url).searchParams.get('movieIds').split(',');seen.push(...batch);return response({coming:batch.map(id=>movie(id,200))})};
  try{
    const first=await updateCatalog(e,at);assert.equal(first.requests,20);assert.equal(first.complete,false);assert.equal(first.pending,5);
    const second=await updateCatalog(e,at+120);assert.equal(second.requests,1);assert.equal(second.complete,true);
    assert.equal(seen.length,245);assert.equal(new Set(seen).size,245);assert.equal(get(e,'catalog_cycle'),null);
  }finally{globalThis.fetch=original;e.db.close()}
});
