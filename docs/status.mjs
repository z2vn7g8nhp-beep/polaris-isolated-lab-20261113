const runtimeFields=['movies','cinemas','checks','cadence','lastSuccess','lastError','snapshotAt','lastRunOutcome','schedulerHeartbeat','catalogUpdated','catalogCompleted','catalogNextRefresh','catalogPending','comingUpdated','releasedUpdated','comingTotal','comingSourceReady'];
const personalFields=['events','pushConfigured','pushError','notificationMode','barkConfigured','barkError','paused','nextRequest','processedRevision','requestResult'];
export function snapshotTime(data){
  if(Number.isFinite(data?.snapshotAt))return data.snapshotAt;
  return Math.max(0,...['lastSuccess','catalogUpdated','catalogCompleted','catalogNextRefresh','catalogPending','comingUpdated','releasedUpdated','schedulerHeartbeat'].map(key=>Number(data?.[key])||0));
}
export function newerPublic(first,second){return second&&snapshotTime(second)>=snapshotTime(first)?second:first}
export function mergeStatus(publicData,personalData){
  const result={...publicData};
  if(personalData){
    if(snapshotTime(personalData)>snapshotTime(publicData))for(const key of runtimeFields)if(Object.hasOwn(personalData,key))result[key]=personalData[key];
    for(const key of personalFields)if(Object.hasOwn(personalData,key))result[key]=personalData[key];
    // The deployed workflow's plan is authoritative; a legacy private null is not.
    result.schedule=publicData.schedule||personalData.schedule||null;
    if(snapshotTime(publicData)>snapshotTime(personalData)&&publicData.lastRunOutcome==='checked')result.paused=null;
  }
  if(result.lastRunOutcome==='paused'&&!result.paused)result.paused='后台监测已暂停，刷新个人状态后可查看原因。';
  return result;
}
export function checkHealth(data,at=Date.now()/1000){
  if(data.paused||data.lastRunOutcome==='paused')return {kind:'paused',message:'监测已暂停'};
  if(data.lastError)return {kind:'error',message:String(data.lastError)};
  if(!data.lastSuccess)return {kind:'unknown',message:'尚未完成第一次成功检查'};
  const minutes=Math.max(0,Math.floor((at-data.lastSuccess)/60));
  const threshold=Math.max(6,(Number(data.cadence?.cinemaMinutes)||Number(data.schedule?.intervalMinutes)||5)*3);
  if(minutes>=threshold)return {kind:'delayed',minutes,message:`已 ${minutes} 分钟未成功检查，后台没有按计划完成更新；可立即提交一次检查。`};
  return {kind:'recent',minutes,message:'最近检查成功'};
}
