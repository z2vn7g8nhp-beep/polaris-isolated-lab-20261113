import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dbEnv,call,applyPreferences,publicView} from '../backend/storage.mjs';
function env(){const e=dbEnv();e.db.exec(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));return e}
test('encrypted preference replay does not resume a risk pause; explicit resume is applied once',async()=>{
  const e=env();await call(e,'state');
  const insert=e.db.prepare('INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const p={revision:'1',stars:[],control:{id:'resume-1',action:'resume'}};
  await applyPreferences(e,p);
  insert.run('paused',JSON.stringify('risk control'));
  assert.equal(await applyPreferences(e,p),false);
  await applyPreferences(e,{...p,revision:'2'});
  assert.equal((await call(e,'state')).paused,'risk control');
  await applyPreferences(e,{...p,revision:'3',control:{id:'resume-2',action:'resume'}});
  assert.equal((await call(e,'state')).paused,null);e.db.close();
});
test('manual stop cancels queued notifications while new public catalogue excludes private settings',async()=>{
  const e=env();const initial=await call(e,'state');const id=initial.movies[0].id;
  await applyPreferences(e,{revision:'1',stars:[id]});
  e.db.prepare('INSERT INTO radar_events(id,movie_id,kind,title,body,created_at) VALUES (?,?,?,?,?,?)').run('event',id,'release','private title','private text',1);
  await applyPreferences(e,{revision:'2',stars:[]});
  assert.equal(e.db.prepare('SELECT cancelled FROM radar_events WHERE id=?').get('event').cancelled,1);
  const pub=publicView(await call(e,'state'));
  assert.ok(!('events'in pub));assert.ok(!('barkConfigured'in pub));assert.ok(!('active'in pub.movies[0]));e.db.close();
});
