import { RENDER_SIZE } from "../lib/render-card.js";

export default function handler(req,res){
  res.status(200).json({
    ok:true,
    service:"hoh-broadcast-renderer",
    version:"1.0.0",
    output:RENDER_SIZE,
    template:"HOME OF HOCKEY x WINLINE",
    auth_optional:Boolean(String(process.env.RENDER_SECRET||"").trim())
  });
}
