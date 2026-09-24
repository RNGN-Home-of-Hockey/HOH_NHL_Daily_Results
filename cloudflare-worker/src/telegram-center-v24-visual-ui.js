export function handleTelegramCenterV24VisualUi(request, path) {
  if (path !== "/telegram-app/v24-visual.js" || request.method !== "GET") return null;
  return new Response(V24_VISUAL_JS, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

const V24_VISUAL_JS = String.raw`
(()=>{
  const BUILD="24.1.0";
  const root=document.documentElement;
  const stored=localStorage.getItem("hoh-center-theme");
  if(!stored) root.classList.add("v15Light");

  const old=document.getElementById("v24VisualCss");
  if(old) old.remove();
  const s=document.createElement("style");
  s.id="v24VisualCss";
  s.textContent=`
:root{
  --hoh-glass-light:rgba(255,255,255,.72);
  --hoh-glass-light-strong:rgba(255,255,255,.84);
  --hoh-glass-dark:rgba(14,16,24,.76);
  --hoh-glass-dark-strong:rgba(10,12,19,.86);
  --hoh-border-light:rgba(116,105,142,.24);
  --hoh-border-dark:rgba(167,154,201,.23);
  --hoh-blur:blur(16px) saturate(126%);
}
html,body{min-height:100%;background:#eceaf3!important}
body{position:relative;isolation:isolate;background:#eceaf3!important}
body:before{
  content:"";position:fixed;z-index:0;pointer-events:none;
  left:-24vw;right:-24vw;top:-18vh;bottom:-18vh;
  background-image:
    linear-gradient(135deg,rgba(190,163,234,.78),rgba(226,217,244,.60) 47%,rgba(241,237,247,.76)),
    url("/telegram-app/goalie-bg.webp?build=24.1.0");
  background-size:auto,155% auto;
  background-position:center,58% 26%;
  background-repeat:no-repeat;
  background-blend-mode:color,normal;
  filter:saturate(.62) contrast(.88) brightness(1.04);
  opacity:.31;
  transform:scale(1.08);
}
html:not(.v15Light),html:not(.v15Light) body{background:#07080d!important}
html:not(.v15Light) body:before{
  background-image:
    linear-gradient(135deg,rgba(86,60,123,.82),rgba(28,26,43,.76) 48%,rgba(8,10,17,.92)),
    url("/telegram-app/goalie-bg.webp?build=24.1.0");
  opacity:.24;filter:saturate(.52) contrast(.92) brightness(.58);
}
body>.app,.app{position:relative;z-index:1;background:transparent!important}
.app,#view,.view{background:transparent!important}

:is(
  .tabs,.toolbar,.gameCard,.nextCard,.panel,.metric,.trend,.playerRow,.teamRow,.myRow,.division,.empty,
  .v15Head,.v15Q,.v15Game,.v15RosterRow,.v15Stat,.v15Trend,.v15Theme,.v15PlayerRow,.v15MediaPic,
  .v19Broadcast,.v19Game,.v19NoVk,.v20News,.v20NewsRow,
  .v23Head,.v23Metric,.v23Last,.v23StatsHero,.v23ExtMetric,.v23Trend,.v23Season,.v23AllStatsBtn,.v23BackToPlayer
){
  -webkit-backdrop-filter:var(--hoh-blur)!important;
  backdrop-filter:var(--hoh-blur)!important;
}
.v15Light :is(
  .tabs,.toolbar,.gameCard,.nextCard,.panel,.metric,.trend,.playerRow,.teamRow,.myRow,.division,.empty,
  .v15Head,.v15Q,.v15Game,.v15RosterRow,.v15Stat,.v15Trend,.v15Theme,.v15PlayerRow,.v15MediaPic,
  .v19Broadcast,.v19Game,.v19NoVk,.v20News,.v20NewsRow,
  .v23Head,.v23Metric,.v23Last,.v23StatsHero,.v23ExtMetric,.v23Trend,.v23Season,.v23AllStatsBtn,.v23BackToPlayer
){
  background:var(--hoh-glass-light)!important;
  border-color:var(--hoh-border-light)!important;
  box-shadow:0 7px 24px rgba(63,51,88,.055)!important;
}
html:not(.v15Light) :is(
  .tabs,.toolbar,.gameCard,.nextCard,.panel,.metric,.trend,.playerRow,.teamRow,.myRow,.division,.empty,
  .v15Head,.v15Q,.v15Game,.v15RosterRow,.v15Stat,.v15Trend,.v15Theme,.v15PlayerRow,.v15MediaPic,
  .v19Broadcast,.v19Game,.v19NoVk,.v20News,.v20NewsRow,
  .v23Head,.v23Metric,.v23Last,.v23StatsHero,.v23ExtMetric,.v23Trend,.v23Season,.v23AllStatsBtn,.v23BackToPlayer
){
  background:var(--hoh-glass-dark)!important;
  border-color:var(--hoh-border-dark)!important;
}
.v15Light :is(.tab,.navBtn,.iconBtn,.calendarBtn,.select,.search,.dateBox,.v15Back,.v23Audio){
  background:rgba(255,255,255,.70)!important;
  -webkit-backdrop-filter:var(--hoh-blur)!important;backdrop-filter:var(--hoh-blur)!important;
}
html:not(.v15Light) :is(.tab,.navBtn,.iconBtn,.calendarBtn,.select,.search,.dateBox,.v15Back,.v23Audio){
  background:rgba(17,19,28,.74)!important;
  -webkit-backdrop-filter:var(--hoh-blur)!important;backdrop-filter:var(--hoh-blur)!important;
}
.v15Light .v23Rec{background:linear-gradient(135deg,rgba(255,245,237,.82),rgba(255,255,255,.72) 52%,rgba(247,240,252,.80))!important;backdrop-filter:var(--hoh-blur)!important}
html:not(.v15Light) .v23Rec{background:linear-gradient(135deg,rgba(31,19,15,.82),rgba(20,17,29,.78) 65%,rgba(21,17,32,.82))!important;backdrop-filter:var(--hoh-blur)!important}

/* Player hero: photo is always the top visual layer. */
.v23Head{position:relative!important;grid-template-columns:108px minmax(0,1fr) 54px!important}
.v23NameRow{position:static!important;padding-right:0!important}
.v23Portrait .ghost{z-index:1!important;right:-16px!important;top:23px!important}
.v23Portrait .v23Country{z-index:2!important;width:18px!important;height:41px!important;left:2px!important;top:34px!important;border-radius:19px 7px 7px 19px!important;font-size:7px!important}
.v23Portrait .person{z-index:6!important}
.v15Portrait .teamGhost{z-index:1!important}
.v15Portrait .v15Country{z-index:2!important}
.v15Portrait .person{z-index:6!important}

/* Pronunciation sits immediately left of subscribe and shares its vertical center. */
.v23Audio{
  position:absolute!important;right:74px!important;top:50%!important;
  transform:translateY(-50%)!important;width:34px!important;height:34px!important;
  z-index:8!important;margin:0!important;
}
.v23FollowWrap{position:relative;z-index:7;align-self:center!important}

/* Secondary typography. Large player name and match score intentionally excluded. */
.app small{font-size:9px!important;line-height:1.32!important}
:is(.tab,.v15Kind,.v15Section,.v23Section){font-size:11px!important}
:is(.v15MediaHead,.v15MediaTitle,.gameTop,.stage,.rowText small,.teamMini,.v15Rank,.v15Stat .rank){font-size:9px!important;line-height:1.28!important}
:is(.v15HeadInfo .en,.v23En){font-size:11px!important;line-height:1.3!important}
:is(.v15HeadInfo .meta,.v23Meta,.v23Contract){font-size:9.5px!important;line-height:1.38!important}
:is(.v15ProfileTabs button,.v15PlayerControls select,.v15PlayerControls input,.v23AllStatsBtn,.v23BackToPlayer,.v23StatCats button){font-size:10px!important}
.v15Q .label{font-size:8px!important}.v15Rank{font-size:7.6px!important}
.v23FollowWrap small{font-size:8px!important}.v23Season{font-size:12px!important}
.v23Metric small{font-size:7.5px!important;line-height:1.18!important}
.v23MetricDesc{font-size:6.8px!important;line-height:1.28!important}
.v23Trend{font-size:9.5px!important;line-height:1.3!important}
.v23RecTop>span{font-size:7.5px!important}.v23RecTop>span b{font-size:9px!important}
.v23RecLine strong{font-size:10.5px!important}.v23RecMarket{font-size:9.5px!important}
.v23LastTeams b{font-size:8.5px!important}.v23LastMeta{font-size:7.7px!important}
.v23Vk{font-size:8px!important}.v23StatsHero b{font-size:12px!important}.v23StatsHero span{font-size:8.5px!important}
.v23StatCats button{font-size:8.5px!important}
.v23ExtTop small{font-size:6.6px!important;line-height:1.22!important}
.v23ExtDesc{font-size:5.8px!important;line-height:1.25!important}
.v20NewsRow,.v20NewsRow small,.v20Comment,.v20Comment small{font-size:9px!important;line-height:1.3!important}
.v15MineMeta,.v15MineSalary{font-size:8.5px!important}
.v15WTop small,.v15WEmpty,.v15Market span{font-size:9px!important}

/* Keep light theme readable over the art. */
.v15Light{color:#171923!important}
.v15Light :is(.v23En,.v23Meta,.v23LastMeta,.v23ExtTop small,.v23ExtDesc,.rowText small,.gameTop,.stage,.teamMini,.v15Rank){color:#555d70!important}
.v15Light .v23Contract,.v15Light .v15MineSalary{color:#bf5427!important}
.v15Light .v23Portrait,.v15Light .myRow .v15Portrait.mini{background:rgba(239,240,246,.66)!important}

@media(max-width:430px){
  body:before{left:-34vw;right:-34vw;background-size:auto,178% auto;background-position:center,61% 26%;opacity:.29}
  html:not(.v15Light) body:before{opacity:.22}
  .v23Head{grid-template-columns:92px minmax(0,1fr) 48px!important}
  .v23Portrait .ghost{right:-15px!important;top:19px!important}
  .v23Portrait .v23Country{width:17px!important;height:36px!important;top:29px!important;font-size:7px!important}
  .v23Audio{right:63px!important;width:32px!important;height:32px!important}
  .v23Meta,.v23Contract{font-size:8.5px!important}
  .v23Metric small{font-size:6.8px!important}
  .v23MetricDesc{font-size:6px!important}
  .v23ExtTop small{font-size:5.8px!important}
  .v23ExtDesc{font-size:5.2px!important}
}
`;
  document.head.appendChild(s);

  function sync(){
    const mode=localStorage.getItem("hoh-center-theme")||"light";
    root.classList.toggle("v15Light",mode==="light");
  }
  sync();
  window.addEventListener("storage",e=>{if(e.key==="hoh-center-theme")sync()});
})();
`;

