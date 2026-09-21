import sharp from "sharp";
import { fileURLToPath } from "node:url";

const WIDTH = 820;
const HEIGHT = 211;
const STAKE_DEFAULT = 1000;
const fontUrl = new URL("../assets/sofia-sans-condensed-italic.woff2", import.meta.url);
const fontPath = fileURLToPath(fontUrl);
const logoCache = new Map();

const TEAM = {
  ANA:["АНАХАЙМ","#FC4C02"],BOS:["БОСТОН","#FFB81C"],BUF:["БАФФАЛО","#003087"],
  CGY:["КАЛГАРИ","#D2001C"],CAR:["КАРОЛИНА","#CE1126"],CHI:["ЧИКАГО","#CF0A2C"],
  COL:["КОЛОРАДО","#6F263D"],CBJ:["КОЛАМБУС","#002654"],DAL:["ДАЛЛАС","#006847"],
  DET:["ДЕТРОЙТ","#CE1126"],EDM:["ЭДМОНТОН","#FF4C00"],FLA:["ФЛОРИДА","#C8102E"],
  LAK:["ЛОС-АНДЖЕЛЕС","#A2AAAD"],MIN:["МИННЕСОТА","#154734"],MTL:["МОНРЕАЛЬ","#AF1E2D"],
  NSH:["НЭШВИЛЛ","#FFB81C"],NJD:["НЬЮ-ДЖЕРСИ","#CE1126"],NYI:["АЙЛЕНДЕРС","#00539B"],
  NYR:["РЕЙНДЖЕРС","#0038A8"],OTT:["ОТТАВА","#C52032"],PHI:["ФИЛАДЕЛЬФИЯ","#F74902"],
  PIT:["ПИТТСБУРГ","#FCB514"],SJS:["САН-ХОСЕ","#006D75"],SEA:["СИЭТЛ","#99D9D9"],
  STL:["СЕНТ-ЛУИС","#002F87"],TBL:["ТАМПА-БЭЙ","#002868"],TOR:["ТОРОНТО","#003E7E"],
  UTA:["ЮТА","#71AFE5"],VAN:["ВАНКУВЕР","#00843D"],VGK:["ВЕГАС","#B4975A"],
  WSH:["ВАШИНГТОН","#C8102E"],WPG:["ВИННИПЕГ","#041E42"]
};

const upper=v=>String(v??"").trim().toUpperCase();
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

function escapeMarkup(value){
  return String(value??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&apos;");
}
function normalizeDecimalText(value){return upper(value).replace(/([+-]?\d+)\.(\d+)/g,"$1,$2")}
function highlight(text,teamName){
  const source=normalizeDecimalText(text);
  const escaped=String(teamName||"").replace(/[.*+?^$()|[\]\\{}]/g,"\\$&");
  const re=new RegExp("("+(escaped?escaped+"|":"")+"\\d+\\s+ИЗ\\s+\\d+|\\d+\\s*\\/\\s*\\d+)","gi");
  let out="",last=0,m;
  while((m=re.exec(source))){
    out+=escapeMarkup(source.slice(last,m.index));
    out+=`<span foreground="#FF641E">${escapeMarkup(m[0])}</span>`;
    last=m.index+m[0].length;
  }
  out+=escapeMarkup(source.slice(last));
  return out||escapeMarkup(source);
}

function baseTemplateSvg(teamColor){
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="820" height="211" viewBox="0 0 820 211">
    <defs>
      <linearGradient id="g" x1="0" x2="1"><stop stop-color="#0a0a0c"/><stop offset=".55" stop-color="#121215"/><stop offset="1" stop-color="#09090b"/></linearGradient>
      <linearGradient id="b" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#236aff"/><stop offset="1" stop-color="#0647ea"/></linearGradient>
    </defs>
    <rect width="820" height="211" fill="none"/>
    <rect x="2" y="4" width="816" height="56" rx="12" fill="url(#g)" stroke="#606067" stroke-width="1.2"/>
    <rect x="10" y="12" width="7" height="40" rx="3.5" fill="${teamColor}"/>
    <path d="M2 72 Q2 64 12 64 H672 L650 153 H12 Q2 153 2 143Z" fill="url(#g)" stroke="#606067" stroke-width="1.2"/>
    <path d="M650 64 H806 Q818 64 816 77 L803 142 Q801 153 789 153 H630Z" fill="url(#b)" stroke="#606067" stroke-width="1.2"/>
    <path d="M430 153 H803 Q813 153 813 163 V197 Q813 207 803 207 H420 Q410 207 412 197 L419 164 Q421 153 430 153Z" fill="url(#g)" stroke="#606067" stroke-width="1.2"/>
    <line x1="141" y1="65" x2="141" y2="153" stroke="#44444b"/>
    <rect x="425" y="84" width="184" height="54" rx="27" fill="#080808" stroke="#ff641e" stroke-width="5"/>
    <text x="440" y="120" fill="#fff" font-family="Arial,Helvetica,sans-serif" font-size="28" font-weight="900" font-style="italic">WINLINE</text>
    <circle cx="578" cy="111" r="18" fill="#ff641e"/>
  </svg>`);
}

async function textLayer({markup,width,height,size,color="#FFFFFF",align="left"}){
  return sharp({
    text:{
      text:`<span foreground="${color}">${markup}</span>`,
      font:`Sofia Sans Condensed ${size}`,
      fontfile:fontPath,
      width,height,align,justify:false,rgba:true,wrap:"none"
    }
  }).png().toBuffer();
}

async function fetchLogo(url){
  if(!url)return null;
  if(logoCache.has(url))return logoCache.get(url);
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(3500),headers:{"User-Agent":"HOH-Broadcast-Renderer/1.0"}});
    if(!response.ok)throw new Error("logo HTTP "+response.status);
    const source=Buffer.from(await response.arrayBuffer());
    const png=await sharp(source,{density:240}).resize(82,82,{fit:"contain",background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    logoCache.set(url,png);return png;
  }catch{return null}
}

export function normalizePayload(input={}){
  const team=upper(input.team||input.team_tri);
  const meta=TEAM[team]||[upper(input.team_name)||team||"КОМАНДА","#00E6C3"];
  const teamName=upper(input.team_name)||meta[0];
  const teamColor=String(input.team_color||meta[1]||"#00E6C3");
  const fact=normalizeDecimalText(input.fact||input.headline||"");
  const market=normalizeDecimalText(input.market||input.bet||"");
  const odds=Number(input.odds);
  const stake=clamp(Number(input.stake)||STAKE_DEFAULT,1,1000000);
  const priced=Number.isFinite(odds)&&odds>1;
  const profit=priced?Math.round((odds-1)*stake):null;
  const logoUrl=String(input.team_logo_url||input.logo_url||(team?`https://assets.nhle.com/logos/nhl/svg/${team}_light.svg`:""));
  return {team,teamName,teamColor,fact,market,odds,stake,priced,profit,logoUrl};
}

export async function renderCard(input={}){
  const p=normalizePayload(input);
  const logo=await fetchLogo(p.logoUrl);
  const base=await sharp(baseTemplateSvg(p.teamColor)).png().toBuffer();
  const profitMainText=p.priced
    ?`+${p.profit.toLocaleString("ru-RU")} РУБ`
    :"ЛИНИЯ НЕ НАЙДЕНА";
  const profitNoteText=p.priced
    ?`(ПРИ СТАВКЕ ${p.stake.toLocaleString("ru-RU")} РУБ.)`
    :"WINLINE";
  const [fact,teamName,market,odds,profitMain,profitNote]=await Promise.all([
    textLayer({markup:highlight(p.fact,p.teamName),width:720,height:44,size:22}),
    textLayer({markup:escapeMarkup(p.teamName),width:255,height:36,size:36}),
    textLayer({markup:escapeMarkup(p.market),width:255,height:23,size:20,color:"#D6D6DA"}),
    textLayer({markup:escapeMarkup(p.priced?p.odds.toFixed(2):"—"),width:156,height:64,size:p.priced?58:46,align:"center"}),
    textLayer({
      markup:escapeMarkup(profitMainText),
      width:160,height:30,size:p.priced?(profitMainText.length>12?19:22):17,
      color:"#FF641E",align:"center"
    }),
    textLayer({
      markup:escapeMarkup(profitNoteText),
      width:210,height:22,size:p.priced?13:13,
      color:"#D4D4D8",align:"center"
    })
  ]);
  const composites=[
    {input:fact,left:45,top:18},
    {input:teamName,left:152,top:84},
    {input:market,left:152,top:128},
    {input:odds,left:647,top:90},
    {input:profitMain,left:430,top:169},
    {input:profitNote,left:590,top:175}
  ];
  if(logo) composites.push({input:logo,left:31,top:86});
  else composites.push({input:await textLayer({markup:escapeMarkup(p.team),width:82,height:82,size:28,color:"#D8D8DC",align:"center"}),left:31,top:86});
  const full=await sharp(base).ensureAlpha().composite(composites).png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();
  return sharp(full).resize(574,148,{fit:"fill"}).png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();
}
export const RENDER_SIZE={width:574,height:148};
export const RENDER_VERSION="2026-09-21-layout-v4";
