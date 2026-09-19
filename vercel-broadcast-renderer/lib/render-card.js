import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const WIDTH = 820;
const HEIGHT = 211;
const STAKE_DEFAULT = 1000;

const templateUrl = new URL("../assets/card-template.webp", import.meta.url);
const fontUrl = new URL("../assets/sofia-sans-condensed-italic.woff2", import.meta.url);
const fontPath = fileURLToPath(fontUrl);

const templatePromise = readFile(templateUrl);
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

const upper = (v) => String(v ?? "").trim().toUpperCase();
const clamp = (n,min,max) => Math.max(min,Math.min(max,n));

function escapeMarkup(value){
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&apos;");
}

function normalizeDecimalText(value){
  return upper(value).replace(/([+-]?\d+)\.(\d+)/g,"$1,$2");
}

function highlightedFactMarkup(text, teamName){
  const source=normalizeDecimalText(text);
  const escapedTeam=String(teamName||"").replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const re=new RegExp("("+(escapedTeam?escapedTeam+"|":"")+"\\d+\\s+ИЗ\\s+\\d+|\\d+\\s*\\/\\s*\\d+)","gi");
  let out="",last=0,m;
  while((m=re.exec(source))){
    out+=escapeMarkup(source.slice(last,m.index));
    out+=`<span foreground="#FF641E">${escapeMarkup(m[0])}</span>`;
    last=m.index+m[0].length;
  }
  out+=escapeMarkup(source.slice(last));
  return out||escapeMarkup(source);
}

async function textLayer({
  markup,
  width,
  height,
  size,
  color="#FFFFFF",
  align="left"
}){
  return sharp({
    text:{
      text:`<span foreground="${color}">${markup}</span>`,
      font:`Sofia Sans Condensed ${size}`,
      fontfile:fontPath,
      width,
      height,
      align,
      justify:false,
      rgba:true,
      wrap:"none"
    }
  }).png().toBuffer();
}

async function fetchLogo(url){
  if(!url)return null;
  if(logoCache.has(url))return logoCache.get(url);
  try{
    const response=await fetch(url,{
      signal:AbortSignal.timeout(3500),
      headers:{"User-Agent":"HOH-Broadcast-Renderer/1.0"}
    });
    if(!response.ok)throw new Error("logo HTTP "+response.status);
    const source=Buffer.from(await response.arrayBuffer());
    const png=await sharp(source,{density:240})
      .resize(88,88,{fit:"contain",background:{r:0,g:0,b:0,alpha:0}})
      .png()
      .toBuffer();
    logoCache.set(url,png);
    return png;
  }catch{
    return null;
  }
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
  const logoUrl=String(input.team_logo_url||input.logo_url||(
    team?`https://assets.nhle.com/logos/nhl/svg/${team}_light.svg`:""
  ));
  return {team,teamName,teamColor,fact,market,odds,stake,priced,profit,logoUrl};
}

export async function renderCard(input={}){
  const p=normalizePayload(input);
  const template=await templatePromise;
  const logo=await fetchLogo(p.logoUrl);

  const fact=await textLayer({
    markup:highlightedFactMarkup(p.fact,p.teamName),
    width:724,height:48,size:22,align:"left"
  });
  const teamName=await textLayer({
    markup:escapeMarkup(p.teamName),
    width:235,height:38,size:38,align:"left"
  });
  const market=await textLayer({
    markup:escapeMarkup(p.market),
    width:235,height:29,size:22,color:"#D6D6DA",align:"left"
  });
  const odds=await textLayer({
    markup:escapeMarkup(p.priced?p.odds.toFixed(2):"—"),
    width:136,height:68,size:p.priced?58:46,align:"center"
  });
  const profitMarkup=p.priced
    ? `<span foreground="#FF641E">+${escapeMarkup(p.profit.toLocaleString("ru-RU"))} РУБ</span>  <span foreground="#D4D4D8">(ПРИ СТАВКЕ ${escapeMarkup(p.stake.toLocaleString("ru-RU"))} РУБ.)</span>`
    : `<span foreground="#FF641E">ЛИНИЯ НЕ НАЙДЕНА</span>  <span foreground="#D4D4D8">WINLINE</span>`;
  const profit=await textLayer({
    markup:profitMarkup,
    width:346,height:39,size:p.priced?22:18,align:"center"
  });

  const composites=[
    {input:{create:{width:7,height:43,channels:4,background:p.teamColor}},left:8,top:14},
    {input:fact,left:44,top:12},
    {input:teamName,left:153,top:94},
    {input:market,left:153,top:134},
    {input:odds,left:656,top:83},
    {input:profit,left:435,top:164}
  ];

  if(logo){
    composites.push({input:logo,left:31,top:92});
  }else{
    const fallback=await textLayer({
      markup:escapeMarkup(p.team),
      width:88,height:88,size:28,color:"#D8D8DC",align:"center"
    });
    composites.push({input:fallback,left:31,top:92});
  }

  return sharp(template)
    .ensureAlpha()
    .composite(composites)
    .png({compressionLevel:9,adaptiveFiltering:true})
    .toBuffer();
}

export const RENDER_SIZE={width:WIDTH,height:HEIGHT};
