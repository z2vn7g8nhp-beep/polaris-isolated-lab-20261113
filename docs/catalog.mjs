export const isComing=movie=>movie.coming??movie.upcoming;
export function sortComing(movies){
  const date=m=>/^\d{4}-\d{2}-\d{2}$/.test(m.release||'')?m.release:'9999-99-99';
  return [...movies].sort((a,b)=>date(a).localeCompare(date(b))||(a.comingOrder??99999)-(b.comingOrder??99999));
}
export function groupComing(movies){
  const groups=[];
  for(const movie of sortComing(movies)){
    const date=/^\d{4}-\d{2}-\d{2}$/.test(movie.release||'')?movie.release:'undated';
    if(groups.at(-1)?.date!==date)groups.push({date,title:date==='undated'?'档期待定':heading(date),movies:[]});
    groups.at(-1).movies.push(movie);
  }
  return groups;
}
function heading(date){
  const value=new Date(date+'T12:00:00+08:00');
  if(Number.isNaN(value.getTime()))return '档期待定';
  const current=new Date(Date.now()+8*3600e3).getUTCFullYear();
  return new Intl.DateTimeFormat('zh-CN',{...(Number(date.slice(0,4))!==current?{year:'numeric'}:{}),month:'long',day:'numeric',weekday:'short',timeZone:'Asia/Shanghai'}).format(value);
}
