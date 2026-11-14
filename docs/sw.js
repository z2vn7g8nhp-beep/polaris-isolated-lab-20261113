self.addEventListener('install',event=>{event.waitUntil(self.skipWaiting())});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim())});
self.addEventListener('push',event=>{
  let data={};try{data=event.data?.json()||{}}catch{data={body:event.data?.text()||''}}
  const base=new URL('./',self.registration.scope);
  let target=new URL(data.url||'?view=events',base);
  if(target.origin!==base.origin||!target.pathname.startsWith(base.pathname))target=new URL('?view=events',base);
  event.waitUntil(self.registration.showNotification(data.title||'开票雷达',{
    body:data.body||'你关注的电影有新消息，点开查看。',icon:new URL('icon-192.png',base).href,
    badge:new URL('icon-192.png',base).href,tag:data.id?'polaris-'+data.id:undefined,
    data:{url:target.href}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const base=new URL('./',self.registration.scope);
  let target=new URL(event.notification.data?.url||'?view=events',base);
  if(target.origin!==base.origin||!target.pathname.startsWith(base.pathname))target=new URL('?view=events',base);
  event.waitUntil((async()=>{
    for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})){
      if(new URL(client.url).origin===base.origin&&new URL(client.url).pathname.startsWith(base.pathname)){
        await client.navigate(target.href);return client.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
