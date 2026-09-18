import fullNames from "../../ru_full_names.json" with { type: "json" };

export async function runCenterNameMaintenance(env,{force=false}={}) {
  if (!env.DB) return {ok:false,error:"missing_d1_binding"};
  const entries=Object.entries(fullNames||{}).filter(([id,name])=>/^\d+$/.test(String(id))&&String(name||"").trim());
  if (!entries.length) return {ok:true,skipped:true,reason:"empty_name_cache",names:0};

  const version=cacheVersion(entries);
  const key="center_player_names_ru_version";
  const last=await env.DB.prepare(`SELECT meta_value FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(key).first().catch(()=>null);
  if(!force&&String(last?.meta_value||"")===version){
    return {ok:true,skipped:true,reason:"unchanged",names:entries.length,version};
  }

  let written=0;
  for(let i=0;i<entries.length;i+=60){
    const chunk=entries.slice(i,i+60);
    const statements=[];
    for(const [id,rawName] of chunk){
      const playerId=Number(id),name=String(rawName).trim();
      statements.push(env.DB.prepare(`UPDATE players SET full_name_ru=? WHERE player_id=?;`).bind(name,playerId));
      statements.push(env.DB.prepare(`
        INSERT INTO player_profile_meta (player_id,full_name_ru,source_updated_at,updated_at)
        VALUES (?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET full_name_ru=excluded.full_name_ru,source_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP;
      `).bind(playerId,name));
    }
    await env.DB.batch(statements);
    written+=chunk.length;
  }
  await env.DB.prepare(`
    INSERT INTO data_core_meta (meta_key,meta_value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
  `).bind(key,version).run();
  return {ok:true,skipped:false,names:entries.length,written,version};
}

function cacheVersion(entries){let hash=2166136261;for(const [id,name] of entries){const text=`${id}:${name}\n`;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619)}}return `fnv1a-${(hash>>>0).toString(16)}-${entries.length}`}