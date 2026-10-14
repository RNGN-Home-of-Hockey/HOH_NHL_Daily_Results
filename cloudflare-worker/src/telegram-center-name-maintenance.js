import { NAMES_ALGO, loadNameOverrides, mergedNames, legacyTransliterate, transliterateName } from "./telegram-center-player-names.js";

// Writes the Russian names (Sports.ru + the admins' corrections on top) into players and player_profile_meta whenever they change.
// A name for a player who is not in `players` yet is skipped: before, the profile insert broke on the foreign key and the whole
// job failed every minute from 21 September 2026, so 191 players kept the letter-by-letter names ("Масон Лохреи").
export async function runCenterNameMaintenance(env,{force=false}={}) {
  if (!env.DB) return {ok:false,error:"missing_d1_binding"};
  const overrides=await loadNameOverrides(env.DB);
  const entries=Object.entries(mergedNames(overrides));
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
        SELECT ?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP WHERE EXISTS (SELECT 1 FROM players WHERE player_id=?)
        ON CONFLICT(player_id) DO UPDATE SET full_name_ru=excluded.full_name_ru,source_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP;
      `).bind(playerId,name,playerId));
    }
    await env.DB.batch(statements);
    written+=chunk.length;
  }

  // players Sports.ru does not know: the old letter-by-letter name gives way to the careful transliteration
  const known=new Set(entries.map(([id])=>id));
  const rows=await env.DB.prepare(`SELECT player_id,full_name_en,full_name_ru FROM players WHERE full_name_ru IS NOT NULL;`).all().catch(()=>({results:[]}));
  const retranslit=[];
  for(const r of rows.results||[]){
    const id=String(r.player_id);
    if(known.has(id)||!r.full_name_en)continue;
    if(String(r.full_name_ru)!==legacyTransliterate(r.full_name_en))continue;
    const better=transliterateName(r.full_name_en);
    if(better&&better!==r.full_name_ru)retranslit.push([Number(id),better]);
  }
  for(let i=0;i<retranslit.length;i+=80){
    await env.DB.batch(retranslit.slice(i,i+80).map(([id,name])=>env.DB.prepare(`UPDATE players SET full_name_ru=? WHERE player_id=?;`).bind(name,id)));
  }

  await env.DB.prepare(`
    INSERT INTO data_core_meta (meta_key,meta_value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
  `).bind(key,version).run();
  return {ok:true,skipped:false,names:entries.length,written,retransliterated:retranslit.length,overrides:overrides.size,version};
}

function cacheVersion(entries){let hash=2166136261;const head=`${NAMES_ALGO}\n`;for(let i=0;i<head.length;i++){hash^=head.charCodeAt(i);hash=Math.imul(hash,16777619)}for(const [id,name] of entries){const text=`${id}:${name}\n`;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619)}}return `fnv1a-${(hash>>>0).toString(16)}-${entries.length}`}
