import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {vapidKeys,validateSubscription,sendPush} from '../backend/push.mjs';
import webpush from 'web-push';
import {dbEnv,call,applyPreferences} from '../backend/storage.mjs';
const subscription={endpoint:'https://web.push.apple.com/test-only',keys:{p256dh:vapidKeys('test-device').publicKey,auth:Buffer.alloc(16,2).toString('base64url')}};
function environment(){const e=dbEnv();e.db.exec(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));return e}
test('VAPID identity is stable and subscription validation refuses non-push destinations',async()=>{
  assert.deepEqual(vapidKeys('master'),vapidKeys('master'));
  assert.notEqual(vapidKeys('master').publicKey,vapidKeys('other').publicKey);
  assert.equal(Buffer.from(vapidKeys('master').privateKey,'base64url').length,32);
  const wire=webpush.generateRequestDetails(subscription,JSON.stringify({title:'test'}),{vapidDetails:{subject:'https://example.com',...vapidKeys('master')}});
  assert.equal(wire.method,'POST');assert.match(wire.headers.Authorization,/vapid/);assert.equal(wire.headers['Content-Encoding'],'aes128gcm');
  for(const endpoint of ['https://example.org/private','http://web.push.apple.com/test','https://user:pass@web.push.apple.com/test','https://127.0.0.1/test'])assert.throws(()=>validateSubscription({...subscription,endpoint}));
  assert.throws(()=>validateSubscription({...subscription,keys:{auth:'bad',p256dh:'bad'}}));
  let payload;
  await sendPush({PUSH_KEYS:vapidKeys('master'),PUSH_SEND:async(s,data,options)=>{payload=JSON.parse(data);assert.equal(s.endpoint,subscription.endpoint);assert.equal(options.urgency,'high');return {statusCode:201}}},subscription,{title:'测试',body:'内容',id:'one'});
  assert.equal(payload.id,'one');assert.match(payload.url,/github\.io/);
});
test('phone test sends once, preserves encrypted preference replay rules, and never calls Bark',async()=>{
  const e=environment();let sends=0;
  e.PUSH_SEND=async()=>{sends++;return {statusCode:201}};
  const prefs={revision:'1',stars:[],pushSubscription:subscription,notificationMode:'push',request:{id:'test1',action:'push/test'}};
  await applyPreferences(e,prefs);await applyPreferences(e,prefs);await applyPreferences(e,{...prefs,revision:'2'});
  assert.equal(sends,1);assert.equal((await call(e,'state')).pushConfigured,true);
  await applyPreferences(e,{...prefs,revision:'3',request:{id:'test2',action:'push/test'}});
  assert.equal(sends,2);e.db.close();
});
test('expired phone subscription is cleared, queued alerts retained, and later edits cannot revive it',async()=>{
  const e=environment();await call(e,'state');
  const movie={id:111,nm:'新片',rt:'2030-10-01',globalReleased:false};
  e.db.prepare('INSERT INTO radar_movies VALUES (?,?,?)').run('111',JSON.stringify(movie),1);
  e.db.prepare('INSERT INTO radar_kv VALUES (?,?)').run('coming_ids',JSON.stringify(['111']));
  const prefs={revision:'1',stars:['111'],pushSubscription:subscription,notificationMode:'push',barkKey:'test_only_bark_key'};
  await applyPreferences(e,prefs);
  e.PUSH_SEND=async()=>{throw Object.assign(new Error('expired'),{statusCode:410})};
  const original=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.match(String(url),/^https:\/\/m\.maoyan\.com\//);
    const id=String(url).includes('39869')?39869:25769;
    return new Response(JSON.stringify({showData:{cinemaId:id,movies:id===25769?[{...movie,shows:[{plist:[{seqNo:'x',dt:'2030-09-20',tm:'19:00',th:'IMAX',enterShowSeat:1}]}]}]:[]}}),{headers:{'Content-Type':'application/json'}});
  };
  try{await call(e,'tick',{});}finally{globalThis.fetch=original}
  assert.equal((await call(e,'state')).pushConfigured,false);
  const event=e.db.prepare('SELECT sent_at,attempts FROM radar_events WHERE movie_id=?').get('111');
  assert.equal(event.sent_at,null);assert.equal(event.attempts,1);
  await applyPreferences(e,{...prefs,revision:'2'});
  const state=await call(e,'state');assert.equal(state.pushConfigured,false);assert.equal(state.notificationMode,'push');assert.match(state.pushError,/失效/);
  e.db.close();
});
