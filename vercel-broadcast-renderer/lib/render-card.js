import React from "react";
import satori from "satori";
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const WIDTH = 820;
const HEIGHT = 211;
const STAKE_DEFAULT = 1000;

const templateHeadUrl = new URL("../assets/card-template-user.0.b64", import.meta.url);
const templateTailUrl = new URL("../assets/card-template-user.b64", import.meta.url);
const fontUrl = new URL("../assets/sofia-sans-condensed-italic.ttf", import.meta.url);
const TEMPLATE_GAP="VXH9MwfwHF7A0BI7RRSR8chVN8wdaoMJWB7MTYrDDnHQ8BHB+fch6hItEJ0sJXiKj";

const templatePromise = Promise.all([
  readFile(templateHeadUrl,"utf8"),
  readFile(templateTailUrl,"utf8")
]).then(([head,tail])=>Buffer.from(head.trim()+TEMPLATE_GAP+tail.trim(),"base64"));
const fontPromise = readFile(fontUrl);
const logoCache = new Map();

const TEAM = {
  ANA:["АНАХАЙМ","#FC4C02"],BOS:["БОСТОН","#FFB81C"],BUF:["БАФФАЛО","#003087"],
  CGY:["КАЛГАРИ","#D2001C"],CAR:["КАРОЛИНА","#CE1126"],CHI:["ЧИКАГО","#CF0A2C"],
  COL:["КОЛОРАДО","#6F263D"],CBJ:["КОЛАМБУС","#002654"],DAL:["ДАЛЛАС","#006847"],
  DET:["ДЕТРОЙТ","#CE1126"],EDM:["ЭДМОНТОН","#FF4C00"],FLA:["ФЛОРИДА","#041E42"],
  LAK:["ЛОС-АНДЖЕЛЕС","#A2AAAD"],MIN:["МИННЕСОТА","#154734"],MTL:["МОНРЕАЛЬ","#AF1E2D"],
  NSH:["НЭШВИЛЛ","#FFB81C"],NJD:["НЬЮ-ДЖЕРСИ","#CE1126"],NYI:["АЙЛЕНДЕРС","#00539B"],
  NYR:["РЕЙНДЖЕРС","#0038A8"],OTT:["ОТТАВА","#C52032"],PHI:["ФИЛАДЕЛЬФИЯ","#F74902"],
  PIT:["ПИТТСБУРГ","#FCB514"],SJS:["САН-ХОСЕ","#006D75"],SEA:["СИЭТЛ","#99D9D9"],
  STL:["СЕНТ-ЛУИС","#002F87"],TBL:["ТАМПА-БЭЙ","#002868"],TOR:["ТОРОНТО","#003E7E"],
  UTA:["ЮТА","#71AFE5"],VAN:["ВАНКУВЕР","#00843D"],VGK:["ВЕГАС","#B4975A"],
  WSH:["ВАШИНГТОН","#C8102E"],WPG:["ВИННИПЕГ","#041E42"]
};

const e = React.createElement;
const upper = (v) => String(v ?? "").trim().toUpperCase();
const clamp = (n,min,max) => Math.max(min,Math.min(max,n));

function normalizeDecimalText(value){
  return upper(value).replace(/([+-]?\d+)\.(\d+)/g,"$1,$2");
}

function fontSizeForFact(text){
  const n=String(text||"").length;
  if(n<=58)return 29;
  if(n<=70)return 27;
  if(n<=82)return 25;
  if(n<=94)return 23;
  return 21;
}

function fontSizeForTeam(text){
  const n=String(text||"").length;
  if(n<=9)return 49;
  if(n<=13)return 43;
  if(n<=17)return 37;
  return 32;
}

function fontSizeForMarket(text){
  const n=String(text||"").length;
  return n<=20?28:n<=28?24:21;
}

function highlightFact(text, headlineTeamName){
  const source=normalizeDecimalText(text);
  const escaped=String(headlineTeamName||"").replace(/[.*+?^${}()|[\]\\]/g,"\\  const escaped=String(teamName||"").replace(/[.*+?^${}()|[\]\\]/g,"\\$&");");
  const parts=[];
  const re=new RegExp("(" + (escaped?escaped+"|":"") + "\\d+\\s+ИЗ\\s+\\d+|\\d+\\s*\\/\\s*\\d+)","gi");
  let last=0,m;
  while((m=re.exec(source))){
    if(m.index>last)parts.push({text:source.slice(last,m.index),hot:false});
    parts.push({text:m[0],hot:true});
    last=m.index+m[0].length;
  }
  if(last<source.length)parts.push({text:source.slice(last),hot:false});
  return parts.length?parts:[{text:source,hot:false}];
}

async function asDataUri(url){
  if(!url)return null;
  if(url.startsWith("data:"))return url;
  if(logoCache.has(url))return logoCache.get(url);
  try{
    const response=await fetch(url,{signal:AbortSignal.timeout(3500),headers:{"User-Agent":"HOH-Broadcast-Renderer/1.0"}});
    if(!response.ok)throw new Error("logo HTTP "+response.status);
    const type=response.headers.get("content-type")||"image/svg+xml";
    const buf=Buffer.from(await response.arrayBuffer());
    const data="data:"+type+";base64,"+buf.toString("base64");
    logoCache.set(url,data);
    return data;
  }catch{
    return null;
  }
}

export function normalizePayload(input={}){
  const team=upper(input.team||input.team_tri);
  const meta=TEAM[team]||[upper(input.team_name)||team||"КОМАНДА","#00E6C3"];
  const teamName=upper(input.team_name)||meta[0];
  const headlineTeamName=upper(input.headline_team_name||input.fact_team_name||teamName);
  const teamColor=String((TEAM[team]&&TEAM[team][1])||input.team_color||meta[1]||"#00E6C3");
  const fact=normalizeDecimalText(input.fact||input.headline||"");
  const market=normalizeDecimalText(input.market||input.bet||"");
  const odds=Number(input.odds);
  const stake=clamp(Number(input.stake)||STAKE_DEFAULT,1,1000000);
  const priced=Number.isFinite(odds)&&odds>1;
  const profit=priced?Math.round((odds-1)*stake):null;
  const logoUrl=String(input.team_logo_url||input.logo_url||(
    team?`https://assets.nhle.com/logos/nhl/svg/${team}_light.svg`:""
  ));
  return {team,teamName,headlineTeamName,teamColor,fact,market,odds,stake,priced,profit,logoUrl};
}

export async function renderCard(input={}){
  const p=normalizePayload(input);
  const [template,font,logoData]=await Promise.all([
    templatePromise,
    fontPromise,
    asDataUri(p.logoUrl)
  ]);

  const factParts=highlightFact(p.fact,p.headlineTeamName);
  const baseStyle={
    position:"absolute",
    display:"flex",
    overflow:"hidden",
    fontFamily:"SofiaHOH",
    fontStyle:"italic",
    fontWeight:700,
    color:"#FFFFFF",
    lineHeight:1
  };

  const overlay=e("div",{style:{
    position:"relative",display:"flex",width:WIDTH,height:HEIGHT,
    background:"transparent",fontFamily:"SofiaHOH",fontStyle:"italic",fontWeight:700
  }},
    e("div",{style:{
      position:"absolute",display:"flex",left:9,top:15,width:10,height:50,
      borderRadius:4,backgroundColor:p.teamColor
    }}),
    e("div",{style:{
      ...baseStyle,left:44,top:15,width:732,height:52,alignItems:"center",
      whiteSpace:"nowrap",fontSize:fontSizeForFact(p.fact),letterSpacing:"0px"
    }},...factParts.map((part,i)=>e("span",{key:i,style:{color:part.hot&&upper(part.text)===p.headlineTeamName?"#FF641E":"#FFFFFF"}},String(part.text).replace(/ /g,"\u00A0")))),
    e("div",{style:{
      ...baseStyle,left:17,top:79,width:116,height:91,
      alignItems:"center",justifyContent:"center"
    }},logoData
      ? e("img",{src:logoData,width:98,height:98,style:{objectFit:"contain"}})
      : e("span",{style:{fontSize:24,color:"#D8D8DC"}},p.team)
    ),
    e("div",{style:{
      ...baseStyle,left:153,top:82,width:270,height:54,alignItems:"center",
      whiteSpace:"nowrap",fontSize:fontSizeForTeam(p.teamName),letterSpacing:"-0.35px"
    }},p.teamName),
    e("div",{style:{
      ...baseStyle,left:153,top:132,width:270,height:36,alignItems:"center",
      whiteSpace:"nowrap",fontSize:fontSizeForMarket(p.market),color:"#D6D6DA",letterSpacing:"-0.15px"
    }},p.market),
    e("div",{style:{
      ...baseStyle,left:648,top:82,width:148,height:76,alignItems:"center",
      justifyContent:"center",whiteSpace:"nowrap",fontSize:p.priced?64:48,
      letterSpacing:"-1.5px"
    }},p.priced?p.odds.toFixed(2):"—"),
    e("div",{style:{
      ...baseStyle,left:435,top:164,width:346,height:42,alignItems:"center",
      justifyContent:"center",whiteSpace:"nowrap",gap:14
    }},
      e("span",{style:{fontSize:p.priced?29:21,color:"#FF641E",position:"relative",top:-3}},p.priced
        ?"+"+p.profit.toLocaleString("ru-RU")+" РУБ"
        :"ЛИНИЯ НЕ НАЙДЕНА"
      ),
      e("span",{style:{fontSize:16,color:"#D4D4D8"}},p.priced
        ?"(ПРИ СТАВКЕ "+p.stake.toLocaleString("ru-RU")+" РУБ.)"
        :"WINLINE"
      )
    )
  );

  const svg=await satori(overlay,{
    width:WIDTH,height:HEIGHT,
    fonts:[{name:"SofiaHOH",data:font,weight:700,style:"italic"}]
  });

  return sharp(template)
    .ensureAlpha()
    .composite([{input:Buffer.from(svg)}])
    .png({compressionLevel:9,adaptiveFiltering:true})
    .toBuffer();
}

export const RENDER_SIZE={width:WIDTH,height:HEIGHT};
export const RENDER_VERSION="2026-09-23-layout-v12-full-team-accent";
