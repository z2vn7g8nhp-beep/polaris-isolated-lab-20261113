import test from 'node:test';
import assert from 'node:assert/strict';
import {newerPublic,mergeStatus,checkHealth} from '../docs/status.mjs';
test('old repository or private data cannot roll back a newer Pages check or erase its schedule',()=>{
  const pages={snapshotAt:2000,lastSuccess:1990,schedule:{frequency:'five_minutes'},lastRunOutcome:'checked'};
  const repository={snapshotAt:1000,lastSuccess:990};
  const privateData={snapshotAt:1000,lastSuccess:990,schedule:null,paused:'obsolete pause',events:[{id:'private'}]};
  const combined=mergeStatus(newerPublic(pages,repository),privateData);
  assert.equal(combined.lastSuccess,1990);assert.equal(combined.schedule.frequency,'five_minutes');assert.equal(combined.paused,null);assert.equal(combined.events[0].id,'private');
});
test('newer encrypted runtime data is used, with legacy schedule null still ignored',()=>{
  const combined=mergeStatus({snapshotAt:1000,lastSuccess:990,schedule:{frequency:'five_minutes'}},{snapshotAt:2000,lastSuccess:1990,schedule:null,events:[]});
  assert.equal(combined.lastSuccess,1990);assert.equal(combined.schedule.frequency,'five_minutes');
});
test('an hour-old check must show delayed rather than ready; a recent task snapshot cannot conceal it',()=>{
  assert.equal(checkHealth({snapshotAt:5000,lastSuccess:1000},4600).kind,'delayed');
  assert.match(checkHealth({lastSuccess:1000},4600).message,/60 分钟/);
  assert.equal(checkHealth({lastSuccess:4500},4600).kind,'recent');
  assert.equal(checkHealth({},4600).kind,'unknown');
  assert.equal(checkHealth({lastSuccess:4500,lastError:'source failed'},4600).kind,'error');
  assert.equal(checkHealth({lastSuccess:4500,lastRunOutcome:'paused'},4600).kind,'paused');
});
test('two-minute monitoring warns after three missed checks, including cooldown-only snapshots',()=>{
  const state={lastSuccess:1000,snapshotAt:1360,lastRunOutcome:'cooldown',cadence:{cinemaMinutes:2}};
  assert.equal(checkHealth(state,1359).kind,'recent');
  assert.equal(checkHealth(state,1360).kind,'delayed');
  assert.equal(checkHealth({lastSuccess:1000,schedule:{intervalMinutes:2}},1360).kind,'delayed');
  assert.equal(checkHealth({lastSuccess:1000,cadence:{cinemaMinutes:5}},1360).kind,'recent');
});
