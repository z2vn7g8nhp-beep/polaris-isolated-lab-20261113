import {createECDH,createHash} from 'node:crypto';
import webpush from 'web-push';

export const APP_URL='https://z2vn7g8nhp-beep.github.io/polaris-isolated-lab-20261113/';
export function vapidKeys(master){
  const order=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const hash=createHash('sha256').update('polaris-vapid-v1:'+master).digest('hex');
  const privateBytes=Buffer.from((BigInt('0x'+hash)%(order-1n)+1n).toString(16).padStart(64,'0'),'hex');
  const ecdh=createECDH('prime256v1');ecdh.setPrivateKey(privateBytes);
  return {publicKey:ecdh.getPublicKey().toString('base64url'),privateKey:privateBytes.toString('base64url')};
}
export function validateSubscription(subscription){
  if(!subscription||typeof subscription.endpoint!=='string')throw new Error('通知订阅格式无效');
  const u=new URL(subscription.endpoint);
  const host=u.hostname;
  const trusted=host==='fcm.googleapis.com'||host==='web.push.apple.com'||host.endsWith('.push.apple.com')||host.endsWith('.push.services.mozilla.com')||host.endsWith('.notify.windows.com');
  if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443'||!trusted)throw new Error('通知服务地址不受支持');
  const keys=subscription.keys;
  if(!keys||!['auth','p256dh'].every(k=>typeof keys[k]==='string'&&/^[A-Za-z0-9_-]+={0,2}$/.test(keys[k])))throw new Error('通知订阅密钥无效');
  const pub=Buffer.from(keys.p256dh,'base64url'),auth=Buffer.from(keys.auth,'base64url');
  if(pub.length!==65||pub[0]!==4||auth.length!==16)throw new Error('通知订阅密钥无效');
  return {endpoint:u.href,expirationTime:subscription.expirationTime||null,keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
export async function sendPush(env,subscription,{title,body,id}){
  const valid=validateSubscription(subscription);
  if(!env.PUSH_KEYS)throw new Error('手机通知服务尚未配置');
  const sender=env.PUSH_SEND||webpush.sendNotification.bind(webpush);
  return sender(valid,JSON.stringify({title,body,id:id||crypto.randomUUID(),url:APP_URL+'?view=events'}),{
    vapidDetails:{subject:'https://github.com/z2vn7g8nhp-beep/polaris-isolated-lab-20261113',...env.PUSH_KEYS},
    TTL:3600,urgency:'high',timeout:15000
  });
}
