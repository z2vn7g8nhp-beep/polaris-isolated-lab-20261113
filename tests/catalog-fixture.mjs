export function freshCatalog(env){
  const at=Math.floor(Date.now()/1000);
  const put=env.db.prepare('INSERT INTO radar_kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const ids=env.db.prepare('SELECT id FROM radar_movies').all().map(row=>row.id);
  for(const [key,value] of Object.entries({released_ids:[],coming_updated:at,released_updated:at,catalog_next_refresh:at+300,catalog_refreshed:Object.fromEntries(ids.map(id=>[id,at]))}))put.run(key,JSON.stringify(value));
}
