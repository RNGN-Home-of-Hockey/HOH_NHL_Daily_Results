#!/usr/bin/env python3
from pathlib import Path


def patch_maintenance():
    p=Path('cloudflare-worker/src/telegram-center-vk-maintenance.js')
    s=p.read_text(encoding='utf-8')
    old="""async function bulkUpsertMappings(db,mappings){\n  const payload=JSON.stringify(mappings);\n  await db.prepare(`\n    INSERT INTO game_vk_broadcasts"""
    if 'remove the stale relation first' in s:
        return
    new="""async function bulkUpsertMappings(db,mappings){\n  const payload=JSON.stringify(mappings);\n  // A source video is unique. If a later, better matcher moves it to another game,\n  // remove the stale relation first so the UNIQUE(source_key) constraint cannot block correction.\n  await db.prepare(`\n    DELETE FROM game_vk_broadcasts\n    WHERE source_key IN (SELECT json_extract(value,'$.source_key') FROM json_each(?))\n      AND game_pk NOT IN (SELECT CAST(json_extract(value,'$.game_pk') AS INTEGER) FROM json_each(?));\n  `).bind(payload,payload).run();\n  await db.prepare(`\n    INSERT INTO game_vk_broadcasts"""
    if old not in s:
        raise RuntimeError('bulkUpsertMappings anchor missing')
    p.write_text(s.replace(old,new,1),encoding='utf-8')


def patch_status():
    p=Path('cloudflare-worker/src/telegram-center-v18-vk-data.js')
    s=p.read_text(encoding='utf-8')
    start=s.index('async function vkStatus(env) {')
    end=s.index('\nasync function loadBroadcast', start)
    replacement="""async function vkStatus(env) {
  try {
    const [broadcasts,historical,seasons,rawAudit,metaRows] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) n,MAX(updated_at) updated_at FROM vk_broadcasts;`).first(),
      env.DB.prepare(`
        SELECT COUNT(*) target_games,
               SUM(CASE WHEN m.game_pk IS NOT NULL THEN 1 ELSE 0 END) mapped_games,
               SUM(CASE WHEN m.game_pk IS NULL THEN 1 ELSE 0 END) unmapped_games
        FROM games g LEFT JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk
        WHERE CAST(g.season_id AS TEXT) IN ('20242025','20252026') AND g.game_type IN (2,3);
      `).first(),
      env.DB.prepare(`
        SELECT CAST(g.season_id AS TEXT) season_id,COUNT(*) target_games,
               SUM(CASE WHEN m.game_pk IS NOT NULL THEN 1 ELSE 0 END) mapped_games
        FROM games g LEFT JOIN game_vk_broadcasts m ON m.game_pk=g.game_pk
        WHERE CAST(g.season_id AS TEXT) IN ('20242025','20252026') AND g.game_type IN (2,3)
        GROUP BY CAST(g.season_id AS TEXT) ORDER BY season_id;
      `).all(),
      env.DB.prepare(`
        SELECT COUNT(*) raw_unmapped,
               SUM(CASE WHEN b.parsed_home_tri IS NOT NULL AND b.parsed_away_tri IS NOT NULL THEN 1 ELSE 0 END) parsed_unmapped
        FROM vk_broadcasts b LEFT JOIN game_vk_broadcasts m ON m.source_key=b.source_key
        WHERE m.source_key IS NULL;
      `).first(),
      env.DB.prepare(`
        SELECT meta_key,meta_value,updated_at FROM data_core_meta
        WHERE meta_key IN ('hoh_vk_video_backfill_offset','hoh_vk_video_backfill_done','hoh_vk_video_last_sync_json','hoh_vk_video_last_error');
      `).all(),
    ]);
    const meta=Object.fromEntries((metaRows.results||[]).map(x=>[x.meta_key,{value:x.meta_value,updated_at:x.updated_at}]));
    const target=Number(historical?.target_games||0), mapped=Number(historical?.mapped_games||0);
    return json({
      ok:true,schema_ready:true,
      broadcasts:Number(broadcasts?.n||0),
      target_games:target,mapped_games:mapped,unmapped_games:Number(historical?.unmapped_games||0),
      coverage_pct:target?Math.round(mapped*10000/target)/100:0,
      seasons:(seasons.results||[]).map(x=>({season_id:x.season_id,target_games:Number(x.target_games||0),mapped_games:Number(x.mapped_games||0),coverage_pct:Number(x.target_games||0)?Math.round(Number(x.mapped_games||0)*10000/Number(x.target_games||0))/100:0})),
      raw_unmapped:Number(rawAudit?.raw_unmapped||0),parsed_unmapped:Number(rawAudit?.parsed_unmapped||0),
      backfill:{offset:Number(meta.hoh_vk_video_backfill_offset?.value||0),done:String(meta.hoh_vk_video_backfill_done?.value||'')==='1'},
      last_sync:parseMetaJson(meta.hoh_vk_video_last_sync_json?.value),
      last_error:parseMetaJson(meta.hoh_vk_video_last_error?.value),
      updated_at:broadcasts?.updated_at||null,
    });
  } catch (error) {
    if (isMissingVkSchema(error)) return json({ok:true,schema_ready:false,broadcasts:0,target_games:0,mapped_games:0,error:'vk_schema_not_applied'});
    return json({ok:false,error:'vk_status_failed',detail:errorText(error)},503);
  }
}

function parseMetaJson(value){
  const s=String(value||'').trim();
  if(!s)return null;
  try{return JSON.parse(s)}catch{return s}
}
"""
    p.write_text(s[:start]+replacement+s[end:],encoding='utf-8')


if __name__=='__main__':
    patch_maintenance()
    patch_status()
    print('VK_ARCHIVE_FINALIZATION_PATCHED')
