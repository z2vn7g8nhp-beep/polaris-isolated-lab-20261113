import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRuntime,processRun} from '../backend/storage.mjs';
import {keyBytes,seal,unseal,sealPreferences,encode64} from '../docs/crypto.mjs';

test('independent runner retains stars, deduplication and queued alerts across encrypted SQLite snapshots',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'polaris-test-'));
  const originalFetch=globalThis.fetch;
  try{
    const master='a-test-master-secret-that-is-never-published';
    const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
    const privateKey=encode64(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
    const spki=encode64(await crypto.subtle.exportKey('spki',pair.publicKey));
    const identity=await seal({privateKey,kv:[]},await keyBytes(master,'server'));
    const clientKey=await keyBytes('test-only-github-token');
    const runtime=await createRuntime({master,identity,path:join(dir,'first.sqlite')});
    const movie={id:111,nm:'测试未上映片',rt:'2030-10-01',globalReleased:false};
    runtime.env.db.prepare('INSERT INTO radar_movies VALUES (?,?,?)').run('111',JSON.stringify(movie),1);
    let calls=0;
    globalThis.fetch=async url=>{
      assert.match(String(url),/^https:\/\/m\.maoyan\.com\/ajax\//);
      calls++;const id=String(url).includes('39869')?39869:25769;
      return new Response(JSON.stringify({showData:{cinemaId:id,movies:id===25769?[{...movie,shows:[{plist:[{seqNo:'one',dt:'2030-09-20',tm:'19:00',th:'IMAX',enterShowSeat:1}]}]}]:[]}}),{headers:{'Content-Type':'application/json'}});
    };
    const firstPrefs=await sealPreferences({revision:'first',stars:['111']},clientKey,spki);
    const first=await processRun(runtime,firstPrefs);
    assert.equal(calls,2);assert.equal(first.result.checks.length,2);
    const personal=await unseal(first.privateData,clientKey);
    assert.equal(personal.movies.find(m=>m.id==='111').active,true);
    assert.equal(personal.events.length,1);
    assert.equal(personal.events[0].sent_at,null);
    const restored=await createRuntime({master,identity,snapshot:first.snapshot,path:join(dir,'second.sqlite')});
    const second=await processRun(restored,firstPrefs,{mode:'status'});
    assert.equal(calls,2);
    assert.equal((await unseal(second.privateData,clientKey)).events.length,1);
    const stopped=await createRuntime({master,identity,snapshot:second.snapshot,path:join(dir,'third.sqlite')});
    const nextPrefs=await sealPreferences({revision:'stopped',stars:[]},clientKey,spki);
    const third=await processRun(stopped,nextPrefs,{mode:'status'});
    assert.equal((await unseal(third.privateData,clientKey)).events[0].cancelled,1);
    assert.ok(!JSON.stringify(third.publicData).includes('测试未上映片 · 开票了'));
    await assert.rejects(createRuntime({master:'incorrect-master-key',identity,snapshot:third.snapshot,path:join(dir,'wrong.sqlite')}));
  }finally{globalThis.fetch=originalFetch;rmSync(dir,{recursive:true,force:true})}
});
