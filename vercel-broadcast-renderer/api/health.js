import { RENDER_SIZE, RENDER_VERSION } from "../lib/render-card.js";

export default function handler(req,res){
  res.status(200).json({
    ok:true,
    service:"hoh-broadcast-renderer",
    version:RENDER_VERSION,
    output:RENDER_SIZE,
    template:"HOME OF HOCKEY x WINLINE",
    auth_optional:Boolean(String(process.env.RENDER_SECRET||"").trim())
  });
}
