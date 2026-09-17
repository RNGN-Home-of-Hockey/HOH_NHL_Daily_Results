const API="/api/telegram-center-v15";

export async function handleTelegramCenterV15TeamData(request,env,path){
  if(!env?.DB)return null;
  const m=/^\/api\/telegram-center-v15\/teams\/([A-Za-z]{3})\/season\/(20\d{6})\/ranks$/.exec(path);
  if(!m)return null;
  if(request.method!=="GET")return json({ok:false,error:"method_not_allowed"},405);
  return teamRanks(env,m[1].toUpperCase(),m[2]);
}

async function teamRanks(env,tri,season){
  try{
    const [gamesResult,standardResult,advancedResult]=await Promise.all([
      env.DB.prepare(`
        SELECT home_tri,away_tri,home_score,away_score,period_type
        FROM games
        WHERE CAST(season_id AS TEXT)=? AND game_type=2
          AND UPPER(COALESCE(game_state,'')) IN ('FINAL','OFF');
      `).bind(season).all(),
      env.DB.prepare(`
        SELECT s.team_tri,COUNT(*) games,
          SUM(COALESCE(s.shots,0)) shots,
          SUM(COALESCE(s.blocked_shots,0)) blocks,
          SUM(COALESCE(s.hits,0)) hits,
          SUM(COALESCE(s.giveaways,0)) giveaways,
          SUM(COALESCE(s.takeaways,0)) takeaways,
          AVG(s.faceoff_pct) faceoff_pct,
          SUM(COALESCE(s.power_play_goals,0)) ppg,
          SUM(COALESCE(s.power_play_opportunities,0)) ppo
        FROM team_game_stats s
        JOIN games g ON g.game_pk=s.game_pk
        WHERE CAST(g.season_id AS TEXT)=? AND g.game_type=2
          AND UPPER(COALESCE(g.game_state,'')) IN ('FINAL','OFF')
        GROUP BY s.team_tri;
      `).bind(season).all(),
      env.DB.prepare(`
        SELECT team_tri,COUNT(*) games,
          SUM(COALESCE(toi_5v5_minutes,0)) toi,
          SUM(COALESCE(xgf_5v5,0)) xgf,SUM(COALESCE(xga_5v5,0)) xga,
          SUM(COALESCE(shots_for_5v5,0)) sf,SUM(COALESCE(shots_against_5v5,0)) sa,
          SUM(COALESCE(corsi_for_5v5,0)) cf,SUM(COALESCE(corsi_against_5v5,0)) ca,
          SUM(COALESCE(fenwick_for_5v5,0)) ff,SUM(COALESCE(fenwick_against_5v5,0)) fa,
          AVG(pdo_5v5) pdo,SUM(COALESCE(goals_saved_above_expected,0)) gsax
        FROM team_game_advanced_features
        WHERE CAST(season_id AS TEXT)=?
        GROUP BY team_tri;
      `).bind(season).all(),
    ]);

    const records=buildRecords(gamesResult.results||[]);
    const standard=(standardResult.results||[]).map(x=>{
      const g=n(x.games)||1,ppo=n(x.ppo);
      return {team_tri:up(x.team_tri),shots_pg:n(x.shots)/g,blocks_pg:n(x.blocks)/g,hits_pg:n(x.hits)/g,
        giveaways_pg:n(x.giveaways)/g,takeaways_pg:n(x.takeaways)/g,faceoff_pct:normPct(x.faceoff_pct),
        power_play_pct:ppo?n(x.ppg)*100/ppo:null};
    });
    const advanced=(advancedResult.results||[]).map(x=>{
      const xgf=n(x.xgf),xga=n(x.xga),sf=n(x.sf),sa=n(x.sa),cf=n(x.cf),ca=n(x.ca),ff=n(x.ff),fa=n(x.fa),toi=n(x.toi);
      return {team_tri:up(x.team_tri),xgf_pct:pct(xgf,xga),sf_pct:pct(sf,sa),cf_pct:pct(cf,ca),ff_pct:pct(ff,fa),
        xgf60:toi?xgf*60/toi:null,xga60:toi?xga*60/toi:null,pdo:numOrNull(x.pdo),gsax:numOrNull(x.gsax)};
    });

    const rr={wins:ranks(records,"wins"),points:ranks(records,"points"),goals_for:ranks(records,"goals_for"),goals_against:ranks(records,"goals_against",true)};
    const sr={shots_pg:ranks(standard,"shots_pg"),blocks_pg:ranks(standard,"blocks_pg"),hits_pg:ranks(standard,"hits_pg"),giveaways_pg:ranks(standard,"giveaways_pg",true),takeaways_pg:ranks(standard,"takeaways_pg"),faceoff_pct:ranks(standard,"faceoff_pct"),power_play_pct:ranks(standard,"power_play_pct")};
    const ar={xgf_pct:ranks(advanced,"xgf_pct"),sf_pct:ranks(advanced,"sf_pct"),cf_pct:ranks(advanced,"cf_pct"),ff_pct:ranks(advanced,"ff_pct"),xgf60:ranks(advanced,"xgf60"),xga60:ranks(advanced,"xga60",true),pdo:ranks(advanced,"pdo"),gsax:ranks(advanced,"gsax")};

    return json({ok:true,team_tri:tri,season,total_teams:records.length||32,
      record:{values:records.find(x=>x.team_tri===tri)||null,ranks:pick(rr,tri)},
      standard:{values:standard.find(x=>x.team_tri===tri)||null,ranks:pick(sr,tri)},
      advanced:{values:advanced.find(x=>x.team_tri===tri)||null,ranks:pick(ar,tri)}});
  }catch(error){return json({ok:false,error:"team_ranks_failed",detail:String(error?.message||error)},503)}
}

function buildRecords(games){
  const map=new Map(),row=t=>{t=up(t);if(!map.has(t))map.set(t,{team_tri:t,games:0,wins:0,losses:0,ot_losses:0,points:0,goals_for:0,goals_against:0});return map.get(t)};
  for(const g of games){const h=row(g.home_tri),a=row(g.away_tri),hs=n(g.home_score),as=n(g.away_score),ot=["OT","SO"].includes(up(g.period_type));h.games++;a.games++;h.goals_for+=hs;h.goals_against+=as;a.goals_for+=as;a.goals_against+=hs;if(hs>as){h.wins++;h.points+=2;if(ot){a.ot_losses++;a.points++}else a.losses++}else{a.wins++;a.points+=2;if(ot){h.ot_losses++;h.points++}else h.losses++}}
  return [...map.values()];
}
function ranks(rows,key,asc=false){const v=rows.filter(x=>Number.isFinite(Number(x[key]))).sort((a,b)=>asc?n(a[key])-n(b[key]):n(b[key])-n(a[key])),out={};let last=null,rank=0;v.forEach((x,i)=>{const val=n(x[key]);if(last===null||val!==last){rank=i+1;last=val}out[x.team_tri]=rank});return out}
function pick(groups,tri){const o={};for(const [k,m] of Object.entries(groups))o[k]=m[tri]||null;return o}
function normPct(v){const x=numOrNull(v);return x==null?null:(x<=1.01?x*100:x)}
function pct(a,b){return a+b?a*100/(a+b):null}
function numOrNull(v){if(v===null||v===undefined||v==="")return null;const x=Number(v);return Number.isFinite(x)?x:null}
function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
function up(v){return String(v||"").trim().toUpperCase()}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}})}
