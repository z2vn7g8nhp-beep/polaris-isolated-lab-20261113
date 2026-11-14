import test from 'node:test';
import assert from 'node:assert/strict';
import {keyBytes,seal,unseal,sealPreferences,openPreferences,encode64} from '../docs/crypto.mjs';
test('preferences can be opened by the same browser token and independent backend; token is never stored',async()=>{
  const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const spki=encode64(await crypto.subtle.exportKey('spki',pair.publicKey));
  const pkcs8=encode64(await crypto.subtle.exportKey('pkcs8',pair.privateKey));
  const key=await keyBytes('github-pat-not-for-publication');
  const prefs={revision:'a',stars:['111'],barkKey:'a-secret-device-key'};
  const envelope=await sealPreferences(prefs,key,spki);
  assert.deepEqual(await unseal(envelope,key),prefs);
  assert.deepEqual((await openPreferences(envelope,pkcs8)).prefs,prefs);
  assert.ok(!JSON.stringify(envelope).includes(prefs.barkKey));
  assert.ok(!JSON.stringify(envelope).includes('github-pat'));
  await assert.rejects(unseal(envelope,await keyBytes('another-token')));
});
test('encrypted database integrity detects tampering and never leaks a movie star',async()=>{
  const key=await keyBytes('server-secret','server');
  const encrypted=await seal({privateStar:'sample-movie',barkKey:'sample-secret'},key);
  assert.ok(!JSON.stringify(encrypted).includes('sample'));
  const bytes=encrypted.ciphertext;encrypted.ciphertext=(bytes[0]==='A'?'B':'A')+bytes.slice(1);
  await assert.rejects(unseal(encrypted,key));
});
