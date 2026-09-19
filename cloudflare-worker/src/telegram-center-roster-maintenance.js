import fullNames from "../../ru_full_names.json" with { type: "json" };

const NHL="https://api-web.nhle.com/v1";
const TEAMS=["ANA","BOS","BUF","CGY","CAR","CHI","COL","CBJ","DAL","DET","EDM","FLA","LAK","MIN","MTL","NSH","NJD","NYI","NYR","OTT","PHI","PIT","SJS","SEA","STL","TBL","TOR","UTA","VAN","VGK","WSH","WPG"];
const META_KEY="center_rosters_current";
const FRESH_HOURS=6;

export async function runCenterRosterMaintenance(env,{force=false}={}){
  if(!env.DB)return {ok:false,error:"missing_d1_binding"};
  const [last,physical]=await Promise.all([
    env.DB.prepare(`SELECT meta_value,updated_at FROM data_core_meta WHERE meta_key=? LIMIT 1;`).bind(META_KEY).first().catch(()=>null),
    env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN height_cm IS NOT NULL AND weight_kg IS NOT NULL THEN 1 ELSE 0 END) physical FROM player_profile_meta;`).first().catch(()=>({total:0,physical:0}))
  ]);
  const physicalReady=Number(physical?.physical||0)>=Math.min(600,Math.max(1,Number(physical?.total||0)*0.45));
  if(!force&&physicalReady&&last?.updated_at){
    const age=Date.now()-Date.parse(`${String(last.updated_at).replace(" ","T")}Z`);
    if(Number.isFinite(age)&&age>=0&&age<FRESH_HOURS*3600000){
      return {ok:true,skipped:true,reason:"fresh",updated_at:last.updated_at,physical_cached:Number(physical?.physical||0),summary:safeJson(last.meta_value)};
    }
  }

  const payloads=await Promise.all(TEAMS.map(async tri=>{
    try{
      const r=await fetch(`${NHL}/roster/${tri}/current`,{headers:{Accept:"application/json","User-Agent":"HOH-NHL-Center/7"}});
      if(!r.ok)return {tri,players:[],error:`HTTP ${r.status}`};
      const d=await r.json();
      const players=[];
      for(const [section,forced] of [["forwards",null],["defensemen","D"],["goalies","G"]]){
        for(const raw of d?.[section]||[]){const p=normalizePlayer(raw,tri,forced);if(p)players.push(p)}
      }
      return {tri,players,error:null};
    }catch(error){return {tri,players:[],error:errorText(error)}}
  }));

  const errors=payloads.filter(x=>x.error);
  const unique=new Map();
  for(const x of payloads)for(const p of x.players)unique.set(p.player_id,p);
  if(errors.length||unique.size<600){
    return {ok:false,error:"roster_source_incomplete",teams_ok:payloads.length-errors.length,teams_failed:errors.length,players_found:unique.size,source_errors:errors.map(x=>({team:x.tri,error:x.error}))};
  }

  await env.DB.prepare(`UPDATE players SET active=0 WHERE COALESCE(active,1)=1;`).run();
  let written=0;
  const rows=[...unique.values()];
  for(let i=0;i<rows.length;i+=45){
    const statements=[];
    for(const p of rows.slice(i,i+45)){
      statements.push(env.DB.prepare(`
        INSERT INTO players (player_id,first_name_en,last_name_en,full_name_en,full_name_ru,current_team_tri,position_code,sweater_number,shoots_catches,active,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
          first_name_en=excluded.first_name_en,
          last_name_en=excluded.last_name_en,
          full_name_en=excluded.full_name_en,
          full_name_ru=COALESCE(players.full_name_ru,excluded.full_name_ru),
          current_team_tri=excluded.current_team_tri,
          position_code=excluded.position_code,
          sweater_number=excluded.sweater_number,
          shoots_catches=excluded.shoots_catches,
          active=1,
          updated_at=CURRENT_TIMESTAMP;
      `).bind(p.player_id,p.first_name_en,p.last_name_en,p.full_name_en,p.full_name_ru,p.current_team_tri,p.position_code,p.sweater_number,p.shoots_catches));
      statements.push(env.DB.prepare(`
        INSERT INTO player_profile_meta (player_id,primary_country_code,countries_json,birth_date,height_cm,weight_kg,source_updated_at,updated_at)
        VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT(player_id) DO UPDATE SET
          primary_country_code=COALESCE(excluded.primary_country_code,player_profile_meta.primary_country_code),
          countries_json=COALESCE(excluded.countries_json,player_profile_meta.countries_json),
          birth_date=COALESCE(excluded.birth_date,player_profile_meta.birth_date),
          height_cm=COALESCE(excluded.height_cm,player_profile_meta.height_cm),
          weight_kg=COALESCE(excluded.weight_kg,player_profile_meta.weight_kg),
          source_updated_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP;
      `).bind(p.player_id,p.birth_country,p.birth_country?JSON.stringify([p.birth_country]):null,p.birth_date,p.height_cm,p.weight_kg));
    }
    await env.DB.batch(statements);
    written+=Math.floor(statements.length/2);
  }
  const summary={teams:payloads.length,players:unique.size,written,synced_at:new Date().toISOString()};
  await env.DB.prepare(`
    INSERT INTO data_core_meta (meta_key,meta_value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(meta_key) DO UPDATE SET meta_value=excluded.meta_value,updated_at=CURRENT_TIMESTAMP;
  `).bind(META_KEY,JSON.stringify(summary)).run();
  return {ok:true,skipped:false,...summary};
}

function normalizePlayer(p,tri,forced){
  const id=Number(p?.id),first=localized(p?.firstName),last=localized(p?.lastName);
  if(!Number.isSafeInteger(id)||id<=0||(!first&&!last))return null;
  const position=(forced||String(p?.positionCode||p?.position||"")).toUpperCase()||null;
  const number=Number(p?.sweaterNumber);
  return {
    player_id:id,
    first_name_en:first||null,
    last_name_en:last||null,
    full_name_en:[first,last].filter(Boolean).join(" "),
    full_name_ru:fullNames?.[String(id)]||transliterateName([first,last].filter(Boolean).join(" "))||null,
    current_team_tri:tri,
    position_code:position,
    sweater_number:Number.isFinite(number)?number:null,
    shoots_catches:String(p?.shootsCatches||"").trim()||null,
    birth_date:String(p?.birthDate||"").trim()||null,
    birth_country:String(p?.birthCountry||"").trim().toUpperCase()||null,
    height_cm:Number.isFinite(Number(p?.heightInInches))?Math.round(Number(p.heightInInches)*2.54):null,
    weight_kg:Number.isFinite(Number(p?.weightInPounds))?Math.round(Number(p.weightInPounds)*0.45359237):null,
  };
}
function localized(v){if(!v)return"";if(typeof v==="string")return v;return v.default||v.en||Object.values(v)[0]||""}
function errorText(e){return String(e?.message||e||"unknown_error")}
function safeJson(v){try{return JSON.parse(String(v||"{}"))}catch{return null}}

function transliterateName(value){
  const words=String(value||"").trim().split(/\s+/).filter(Boolean);
  return words.map(word=>{
    let s=word.toLowerCase();
    const pairs=[["shch","щ"],["yo","ё"],["yu","ю"],["ya","я"],["zh","ж"],["kh","х"],["ts","ц"],["ch","ч"],["sh","ш"],["ph","ф"],["th","т"],["ck","к"],["qu","кв"],["mc","мак"]];
    for(const [a,b] of pairs)s=s.split(a).join(b);
    const map={a:"а",b:"б",c:"к",d:"д",e:"е",f:"ф",g:"г",h:"х",i:"и",j:"дж",k:"к",l:"л",m:"м",n:"н",o:"о",p:"п",q:"к",r:"р",s:"с",t:"т",u:"у",v:"в",w:"в",x:"кс",y:"й",z:"з"};
    s=[...s].map(ch=>map[ch]||ch).join("");
    return s?s[0].toUpperCase()+s.slice(1):s;
  }).join(" ");
}
