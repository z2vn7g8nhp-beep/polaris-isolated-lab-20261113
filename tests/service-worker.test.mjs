import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('system notification displays payload, uses stable event tags, and opens only the app path',async()=>{
  const handlers={},shown=[],opened=[];let closed=false,promise;
  const scope='https://owner.github.io/application/';
  const self={addEventListener:(name,handler)=>handlers[name]=handler,registration:{scope,showNotification:async(title,options)=>shown.push({title,...options})},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
  runInNewContext(readFileSync(new URL('../docs/sw.js',import.meta.url),'utf8'),{self,URL});
  handlers.push({data:{json:()=>({title:'新开票',body:'新增两场',id:'event-1',url:'https://other.example/steal'})},waitUntil:p=>promise=p});await promise;
  assert.equal(shown[0].title,'新开票');assert.equal(shown[0].body,'新增两场');assert.equal(shown[0].tag,'polaris-event-1');assert.equal(shown[0].data.url,scope+'?view=events');
  handlers.notificationclick({notification:{data:{url:'https://owner.github.io/another-app/'},close:()=>closed=true},waitUntil:p=>promise=p});await promise;
  assert.equal(closed,true);assert.deepEqual(opened,[scope+'?view=events']);
});
