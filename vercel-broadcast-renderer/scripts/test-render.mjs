import sharp from "sharp";
import { renderCard } from "../lib/render-card.js";

const sample={
  team:"CAR",
  fact:"КАРОЛИНА ЗАКРЫЛА ФОРУ +1,5 В 19 ИЗ 20 ПОСЛЕДНИХ МАТЧЕЙ",
  market:"ФОРА +1,5 ГОЛА",
  odds:1.30,
  stake:1000,
  team_logo_url:""
};

const png=await renderCard(sample);
const meta=await sharp(png).metadata();
if(meta.width!==820||meta.height!==211||meta.format!=="png"){
  throw new Error("Bad renderer output: "+JSON.stringify(meta));
}
console.log(JSON.stringify({ok:true,width:meta.width,height:meta.height,format:meta.format,bytes:png.length}));
