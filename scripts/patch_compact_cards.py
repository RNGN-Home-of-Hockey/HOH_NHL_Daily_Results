from pathlib import Path

p=Path('cloudflare-worker/src/broadcast-dashboard-v2.js')
s=p.read_text()

imp='import { WINLINE_LOGO_PNG_BASE64 } from "./winline-logo.js";\n'
if imp not in s:
    s=s.replace('import { buildBettingInsights } from "./betting-insight-engine.js";\n', 'import { buildBettingInsights } from "./betting-insight-engine.js";\n'+imp, 1)

route_anchor='export async function handleBroadcastRequest(request, env, path) {\n'
route='''export async function handleBroadcastRequest(request, env, path) {\n  if (path === "/broadcast/winline-logo.png") {\n    if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);\n    return pngResponse(WINLINE_LOGO_PNG_BASE64);\n  }\n'''
if 'path === "/broadcast/winline-logo.png"' not in s:
    if route_anchor not in s: raise SystemExit('route anchor missing')
    s=s.replace(route_anchor,route,1)

js_line='function jsResponse(js){return new Response(js,{status:200,headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}\n'
png_fn='''function pngResponse(base64){const raw=atob(base64);const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i+=1)bytes[i]=raw.charCodeAt(i);return new Response(bytes,{status:200,headers:{"Content-Type":"image/png","Cache-Control":"public, max-age=31536000, immutable","X-Content-Type-Options":"nosniff"}})}\n'''
if 'function pngResponse(base64)' not in s:
    if js_line not in s: raise SystemExit('jsResponse anchor missing')
    s=s.replace(js_line,js_line+'\n'+png_fn,1)

start=s.index('function renderCards(cards){')
end=s.index('function renderPlayers(rows){',start)
replacement=r'''function broadcastCardHtml(c,large=false){const odds=Number(c.market?.odds),market=c.market?.label||'Рынок Winline',demo=c.market?.odds_is_demo===true;return `<div class="aircard ${large?'large':''}"><div class="factrow"><div class="signaleyebrow">${esc(c.eyebrow||'HOH INSIGHT')}${demo?'<span class="demotag">DEMO</span>':''}</div><div class="signaltitle">${esc(c.title||c.value||'')}</div></div><div class="betline"><div class="winlinebrand"><img src="/broadcast/winline-logo.png" alt="Winline"></div><div class="betmarket">${esc(market)}</div><div class="oddsbox">${Number.isFinite(odds)?odds.toFixed(2):'—'}</div></div></div>`}
function renderCards(cards){currentCards=cards;$('#cards').innerHTML=cards.length?cards.map((c,i)=>`<article class="card">${broadcastCardHtml(c)}<div class="actions"><button class="act previewbtn" data-i="${i}">PREVIEW</button><button class="act show" disabled title="Подключим защищённый эфир следующим шагом">ПОКАЗАТЬ</button></div></article>`).join(''):'<div class="empty">Пока нет карточек</div>';document.querySelectorAll('.previewbtn').forEach(b=>b.onclick=()=>previewCard(Number(b.dataset.i)))}
function previewCard(i){const c=currentCards[i];if(!c)return;$('#previewcard').innerHTML=broadcastCardHtml(c,true);$('#drawer').classList.add('open')}
'''
s=s[:start]+replacement+s[end:]

old_preview='<div class="preview"><div class="pvbrand">HOME OF HOCKEY × BROADCAST</div><div class="pveyebrow" id="pveyebrow"></div><div class="pvvalue" id="pvvalue"></div><div class="pvtitle" id="pvtitle"></div><div class="pvnote" id="pvnote"></div></div><div class="dfoot">PREVIEW уже работает локально. Кнопка «ПОКАЗАТЬ» намеренно пока заблокирована: в следующем шаге подключим защищённое состояние эфира и прозрачный overlay для vMix/OBS, чтобы интерфейс не притворялся рабочим раньше времени.</div>'
new_preview='<div class="preview" id="previewcard"></div><div class="dfoot">Компактный эфирный формат. Длинные пояснения не выводятся. Кнопка «ПОКАЗАТЬ» подключим к защищённому overlay следующим шагом.</div>'
if old_preview in s:
    s=s.replace(old_preview,new_preview,1)
elif 'id="previewcard"' not in s:
    raise SystemExit('preview anchor missing')

css=r'''
/* Compact 1920x1080 broadcast-card language */
.cards{padding:10px;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.card{border:1px solid #303036;border-radius:12px;background:#111113;overflow:hidden;position:relative}.card:before,.card.lav:before,.kind,.cardbody{display:none}.aircard{height:124px;display:grid;grid-template-rows:minmax(0,1fr) 42px;background:linear-gradient(135deg,#151518,#0d0d0f);overflow:hidden}.factrow{padding:12px 14px 9px;min-width:0}.signaleyebrow{display:flex;align-items:center;gap:7px;font-size:8px;color:#8b8b94;font-weight:900;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.demotag{flex:0 0 auto;font-size:7px;letter-spacing:.08em;color:#ff8b62;border:1px solid rgba(255,90,31,.45);border-radius:4px;padding:2px 4px}.signaltitle{margin-top:7px;font-size:14px;line-height:1.08;font-weight:950;letter-spacing:-.025em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.betline{display:grid;grid-template-columns:94px minmax(0,1fr) 86px;align-items:stretch;border-top:1px solid #2a2a2f;background:#0b0b0d;min-width:0}.winlinebrand{display:grid;place-items:center;padding:0 10px;border-right:1px solid #2b2b30}.winlinebrand img{display:block;width:76px;max-height:23px;object-fit:contain}.betmarket{align-self:center;padding:0 10px;font-size:9px;line-height:1.1;font-weight:900;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.oddsbox{height:100%;min-width:86px;background:#1761ff;color:#fff;clip-path:polygon(11% 0,100% 0,89% 100%,0 100%);display:grid;place-items:center;padding:0 10px;font-size:23px;line-height:1;font-weight:950;font-style:italic;letter-spacing:-.04em}.actions{height:30px;display:grid;grid-template-columns:1fr 1.2fr;border-top:1px solid #29292e}.act{padding:6px 8px;font-size:8px}.preview{margin:auto 0;background:transparent;border:0;border-radius:0;padding:0}.preview .aircard{width:100%;height:154px;border:1px solid #34343a;border-radius:14px}.preview .factrow{padding:17px 18px 12px}.preview .signaleyebrow{font-size:9px}.preview .signaltitle{font-size:20px;line-height:1.05}.preview .betline{grid-template-columns:116px minmax(0,1fr) 112px}.preview .winlinebrand img{width:92px;max-height:28px}.preview .betmarket{font-size:11px;padding:0 14px}.preview .oddsbox{font-size:31px;min-width:112px}
'''
marker='@media(max-width:1100px)'
if '/* Compact 1920x1080 broadcast-card language */' not in s:
    if marker not in s: raise SystemExit('css marker missing')
    s=s.replace(marker,css+'\n'+marker,1)

p.write_text(s)
