const encoder = new TextEncoder(), decoder = new TextDecoder();
export const encode64 = value => {
  let text=''; for(const byte of new Uint8Array(value)) text+=String.fromCharCode(byte);
  return btoa(text);
};
export const decode64 = value => Uint8Array.from(atob(value), c=>c.charCodeAt(0));
export async function keyBytes(secret, purpose='browser') {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`polaris-${purpose}-v1:${secret}`)));
}
export async function seal(value, rawKey) {
  const key=await crypto.subtle.importKey('raw',rawKey,'AES-GCM',false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plain=value instanceof Uint8Array?value:encoder.encode(JSON.stringify(value));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);
  return {v:1,iv:encode64(iv),ciphertext:encode64(ciphertext)};
}
export async function unseal(envelope, rawKey, binary=false) {
  if(envelope?.v!==1)throw new Error('加密数据版本不兼容');
  const key=await crypto.subtle.importKey('raw',rawKey,'AES-GCM',false,['decrypt']);
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(envelope.iv)},key,decode64(envelope.ciphertext));
  return binary?new Uint8Array(bytes):JSON.parse(decoder.decode(bytes));
}
export async function sealPreferences(prefs, rawKey, spki) {
  const publicKey=await crypto.subtle.importKey('spki',decode64(spki),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  return {...await seal(prefs,rawKey),wrappedKey:encode64(await crypto.subtle.encrypt('RSA-OAEP',publicKey,rawKey))};
}
export async function openPreferences(envelope, pkcs8) {
  const privateKey=await crypto.subtle.importKey('pkcs8',decode64(pkcs8),{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
  const rawKey=new Uint8Array(await crypto.subtle.decrypt('RSA-OAEP',privateKey,decode64(envelope.wrappedKey)));
  return {prefs:await unseal(envelope,rawKey),rawKey};
}
