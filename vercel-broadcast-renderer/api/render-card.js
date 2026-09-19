import { createHash } from "node:crypto";
import { renderCard } from "../lib/render-card.js";

function base64UrlDecode(value){
  const normalized=String(value||"").replace(/-/g,"+").replace(/_/g,"/");
  const padded=normalized+"=".repeat((4-normalized.length%4)%4);
  return Buffer.from(padded,"base64").toString("utf8");
}

function unauthorized(req){
  const expected=String(process.env.RENDER_SECRET||"").trim();
  if(!expected)return false;
  const auth=String(req.headers.authorization||"");
  const queryToken=String(req.query?.token||"");
  return auth!==`Bearer ${expected}` && queryToken!==expected;
}

function sendJson(res,status,payload){
  res.status(status).setHeader("Content-Type","application/json; charset=utf-8");
  return res.end(JSON.stringify(payload));
}

export default async function handler(req,res){
  if(req.method==="OPTIONS"){
    res.status(204).end();
    return;
  }
  if(!["GET","POST"].includes(req.method)){
    return sendJson(res,405,{ok:false,error:"method_not_allowed"});
  }
  if(unauthorized(req)){
    return sendJson(res,401,{ok:false,error:"unauthorized"});
  }

  try{
    let payload;
    if(req.method==="GET"){
      if(!req.query?.data)return sendJson(res,400,{ok:false,error:"missing_data"});
      payload=JSON.parse(base64UrlDecode(req.query.data));
    }else{
      payload=typeof req.body==="string"?JSON.parse(req.body):req.body;
    }
    if(!payload||typeof payload!=="object")return sendJson(res,400,{ok:false,error:"invalid_payload"});

    const digest=createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0,24);
    const png=await renderCard(payload);

    res.status(200);
    res.setHeader("Content-Type","image/png");
    res.setHeader("Content-Length",String(png.length));
    res.setHeader("ETag",`"${digest}"`);
    res.setHeader("X-HOH-Render-Id",digest);
    if(req.method==="GET"){
      res.setHeader("Cache-Control","public, max-age=0, s-maxage=31536000, immutable");
      res.setHeader("Vercel-CDN-Cache-Control","public, max-age=31536000, immutable");
    }else{
      res.setHeader("Cache-Control","no-store");
    }
    res.end(png);
  }catch(error){
    console.error("render-card failed",error);
    return sendJson(res,500,{ok:false,error:"render_failed",message:String(error?.message||error)});
  }
}
