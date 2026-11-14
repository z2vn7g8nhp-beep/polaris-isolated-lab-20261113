import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dbEnv,call} from '../backend/storage.mjs';
import {updateCatalog} from '../backend/monitor.mjs';
import {sortComing,groupComing,isComing} from '../docs/catalog.mjs';
test('coming classification uses Maoyan membership rather than only a future release date',async()=>{
  const e=dbEnv();e.db.exec(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));await call(e,'state');
  e.db.prepare('INSERT INTO radar_movies VALUES (?,?,?)').run('991',JSON.stringify({id:991,nm:'未在猫眼待映的未来电影',rt:'2040-01-01'}),1);
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({coming:[{id:992,nm:'猫眼待映',rt:'2030-12-01',wish:5}],movieIds:[992]}),{headers:{'Content-Type':'application/json'}});
  try{await updateCatalog(e)}finally{globalThis.fetch=original}
  const state=await call(e,'state');
  assert.equal(state.comingSourceReady,true);assert.equal(state.comingTotal,1);
  assert.equal(state.movies.find(m=>m.id==='991').upcoming,true);
  assert.equal(state.movies.find(m=>m.id==='991').coming,false);
  assert.equal(state.movies.find(m=>m.id==='992').coming,true);
  assert.equal(state.movies.find(m=>m.id==='992').comingOrder,0);e.db.close();
});
test('date groups preserve source ordering within a date and put undated movies last',()=>{
  const movies=[{id:'a',release:'档期待定',coming:true},{id:'b',release:'2030-02-01',comingOrder:2,coming:true},{id:'c',release:'2030-01-01',coming:true},{id:'d',release:'2030-02-01',comingOrder:1,coming:true}];
  assert.deepEqual(sortComing(movies).map(m=>m.id),['c','d','b','a']);
  const groups=groupComing(movies);assert.equal(groups.length,3);assert.deepEqual(groups[1].movies.map(m=>m.id),['d','b']);assert.equal(groups[2].title,'档期待定');assert.equal(isComing({coming:false,upcoming:true}),false);
});
