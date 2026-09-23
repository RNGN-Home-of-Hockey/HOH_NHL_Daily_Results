import { strict as assert } from 'node:assert';
import { handleBroadcastOperatorRequest } from '../cloudflare-worker/src/broadcast-operator.js';

const cards = new Map([
  ['other-card', {
    card_id:'other-card',
    game_pk:2026020002,
    headline_ru:'OTHER GAME CARD',
    stat_text_ru:'ПОБЕДА',
    source_note_ru:'fixture',
    suggested_market_type:'moneyline',
    suggested_market_subject:'BOS',
    manual_odds:1.80,
    odds_is_demo:0,
    payload_json:'{}',
    status:'shown',
    shown_at:new Date().toISOString(),
    render_hash:'other-hash',
    render_png_base64:'iVBORw0KGgo=',
    render_bytes:8,
    rendered_at:new Date().toISOString(),
  }],
  ['insight-2026020001-fixture', {
    card_id:'insight-2026020001-fixture',
    game_pk:2026020001,
    headline_ru:'КАРОЛИНА ЗАКРЫЛА ФОРУ +1,5 В 19 ИЗ 20 ПОСЛЕДНИХ МАТЧЕЙ',
    stat_text_ru:'ФОРА +1,5 ГОЛА',
    source_note_ru:'fixture',
    suggested_market_type:'handicap',
    suggested_market_subject:'CAR',
    manual_odds:1.30,
    odds_is_demo:0,
    payload_json:JSON.stringify({
      id:'fixture',
      title:'CAR ЗАКРЫЛА ФОРУ +1.5 В 19 ИЗ 20 ПОСЛЕДНИХ МАТЧЕЙ',
      market:{type:'handicap',subject:'CAR',side:'home',line:1.5,label:'CAR +1.5',odds:1.30,odds_is_demo:false,odds_source:'provider_live'}
    }),
    status:'draft',
    shown_at:null,
    render_hash:null,
    render_png_base64:null,
    render_bytes:null,
    rendered_at:null,
  }],
]);

let renderCalls=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=async (url,options={})=>{
  if(String(url)==='https://renderer.test/api/render-card'){
    renderCalls+=1;
    assert.equal(options.method,'POST');
    const payload=JSON.parse(options.body);
    assert.equal(payload.team,'CAR');
    assert.equal(payload.team_name,'КАРОЛИНА');
    assert.equal(payload.market,'ФОРА +1,5 ГОЛА');
    if(renderCalls===1){
      assert.equal(payload.odds,1.30);
      assert.equal(payload.fact,'КАРОЛИНА ЗАКРЫЛА ФОРУ +1,5 В 19 ИЗ 20 ПОСЛЕДНИХ МАТЧЕЙ');
    }
    if(renderCalls===2){
      assert.equal(payload.odds,2.27);
      assert.equal(payload.fact,'БЕЗ ПОРАЖЕНИЯ В 2+ ШАЙБЫ — 74% МАТЧЕЙ · 80 ИГР','renderer must use operator-visible broadcast headline, not raw payload title');
    }
    const bytes=new Uint8Array(256);
    bytes.set([137,80,78,71,13,10,26,10]);
    return new Response(bytes,{status:200,headers:{'content-type':'image/png'}});
  }
  return originalFetch(url,options);
};

const db = {
  prepare(sql) { return statement(sql); },
  async batch(statements) {
    const results=[];
    for (const st of statements) results.push(await st.__run());
    return results;
  },
};
const env={
  DB:db,
  MANAGEMENT_API_SECRET:'operator-secret',
  BROADCAST_RENDERER_URL:'https://renderer.test',
};

let r=await handleBroadcastOperatorRequest(new Request('https://example.test/broadcast/operator'),{},'/broadcast/operator');
assert.equal(r.status,200);assert.match(await r.text(),/BROADCAST OPERATOR/);
r=await handleBroadcastOperatorRequest(new Request('https://example.test/broadcast/overlay'),{},'/broadcast/overlay');
assert.equal(r.status,200);assert.match(await r.text(),/HOME OF HOCKEY × WINLINE/);

r=await callStatus('shown',false);
assert.equal(r.status,401,'operator mutations must reject missing auth');
assert.equal(cards.get('insight-2026020001-fixture').status,'draft');

r=await callStatus('shown',true);
assert.equal(r.status,200,'one click SHOW should render and go on air');
assert.equal(cards.get('insight-2026020001-fixture').status,'shown');
assert.equal(cards.get('other-card').status,'shown','SHOW must not hide a card from another game');
assert.ok(cards.get('insight-2026020001-fixture').shown_at,'shown card must receive shown_at');
assert.ok(cards.get('insight-2026020001-fixture').render_hash,'shown card must receive render hash');
assert.ok(cards.get('insight-2026020001-fixture').render_png_base64,'shown card must cache the rendered PNG');
assert.equal(renderCalls,1,'first SHOW should call Vercel renderer once');

r=await handleBroadcastOperatorRequest(
  new Request('https://example.test/api/broadcast/rendered/insight-2026020001-fixture.png'),
  env,
  '/api/broadcast/rendered/insight-2026020001-fixture.png'
);
assert.equal(r.status,200,'stored PNG must be publicly readable by overlay');
assert.match(r.headers.get('content-type')||'',/image\/png/);
assert.equal((await r.arrayBuffer()).byteLength,256);

r=await handleBroadcastOperatorRequest(new Request('https://example.test/api/broadcast/operator/cards/insight-2026020001-fixture',{
  method:'PATCH',headers:authHeaders(),body:JSON.stringify({headline_ru:'Changed'}),
}),env,'/api/broadcast/operator/cards/insight-2026020001-fixture');
assert.equal(r.status,409,'shown card must be locked against live editing');

r=await callStatus('hidden',true);
assert.equal(r.status,200);assert.equal(cards.get('insight-2026020001-fixture').status,'hidden');
assert.equal(cards.get('insight-2026020001-fixture').shown_at,null);

r=await callStatus('shown',true);
assert.equal(r.status,200,'cached card can return on air in one click');
assert.equal(cards.get('insight-2026020001-fixture').status,'shown');
assert.equal(renderCalls,1,'unchanged card must reuse stored PNG instead of rerendering');

// Regression: UI can have a fresher Winline price than an old persisted draft.
// SHOW must render the exact price the operator sees, not stale payload_json/manual_odds.
r=await callStatus('hidden',true);
assert.equal(r.status,200);
const visible={
  id:'fixture',
  title:'CAR ЗАКРЫЛА ФОРУ +1.5 В 59 ИЗ ПОСЛЕДНИХ 80 МАТЧЕЙ',
  broadcast_title:'БЕЗ ПОРАЖЕНИЯ В 2+ ШАЙБЫ — 74% МАТЧЕЙ · 80 ИГР',
  broadcast_detail:'Точная выборка: 59 из 80',
  broadcast_subtitle:'59 из 80 · текущая серия 4',
  operator_narrative:{
    headline:'CAR: ПОЛНАЯ СТАТИСТИКА ДЛЯ КОММЕНТАТОРА',
    details:['Почему выбрана эта эфирная подача: точная частота линии.','Динамика этой же точной линии: 10 матчей 8/10 · 20 матчей 15/20.']
  },
  market:{type:'handicap',subject:'CAR',side:'home',line:1.5,label:'CAR +1.5',odds:2.27,odds_is_demo:false,odds_source:'provider_live'}
};
r=await callStatus('shown',true,visible);
assert.equal(r.status,200,'SHOW with visible snapshot should succeed');
assert.equal(cards.get('insight-2026020001-fixture').manual_odds,2.27,'persisted odds must match visible UI price');
assert.equal(cards.get('insight-2026020001-fixture').headline_ru,visible.broadcast_title,'persisted broadcast headline must match visible UI copy');
assert.match(cards.get('insight-2026020001-fixture').stat_text_ru,/CAR \+1\.5 · 59 из 80 · текущая серия 4/,'SHOW must preserve market label plus TV subtitle');
assert.match(cards.get('insight-2026020001-fixture').source_note_ru,/ПОЛНАЯ СТАТИСТИКА ДЛЯ КОММЕНТАТОРА/,'SHOW must preserve expanded operator narrative');
assert.match(cards.get('insight-2026020001-fixture').source_note_ru,/20 матчей 15\/20/,'SHOW must not truncate the useful operator context');
assert.equal(JSON.parse(cards.get('insight-2026020001-fixture').payload_json).market.odds,2.27,'payload odds must match visible UI price');
assert.equal(renderCalls,2,'changed visible price must invalidate old rendered PNG');

// 15 separate matches must be able to stay ON AIR simultaneously.
for(let i=0;i<15;i++){
  const id='parallel-'+i;
  cards.set(id,{
    card_id:id,
    game_pk:2026020100+i,
    headline_ru:'CAR TEST '+i,
    stat_text_ru:'ФОРА +1,5 ГОЛА',
    source_note_ru:'parallel fixture',
    suggested_market_type:'handicap',
    suggested_market_subject:'CAR',
    manual_odds:1.30,
    odds_is_demo:0,
    payload_json:JSON.stringify({
      id:'parallel-'+i,
      title:'CAR ЗАКРЫЛА ФОРУ +1.5',
      market:{type:'handicap',subject:'CAR',side:'home',line:1.5,label:'CAR +1.5',odds:1.30,odds_is_demo:false,odds_source:'provider_live'}
    }),
    status:'draft',
    shown_at:null,
    render_hash:null,
    render_png_base64:null,
    render_bytes:null,
    rendered_at:null,
  });
}
for(let i=0;i<15;i++){
  const id='parallel-'+i;
  const response=await callCardStatus(id,'shown',true);
  assert.equal(response.status,200,'parallel match '+i+' must enter ON AIR');
}
for(let i=0;i<15;i++)assert.equal(cards.get('parallel-'+i).status,'shown','parallel match '+i+' must remain ON AIR');
assert.equal(cards.get('insight-2026020001-fixture').status,'shown','existing game must remain ON AIR after 15 other rooms change');
assert.equal(cards.get('other-card').status,'shown','second existing game must remain ON AIR after 15 other rooms change');
assert.equal(renderCalls,17,'15 parallel cards render once each after the stale-price regression rerender');

console.log('BROADCAST_OPERATOR_ON_DEMAND_RENDER_OK');
console.log('BROADCAST_15_GAME_CONCURRENCY_OK');

globalThis.fetch=originalFetch;

function callStatus(status,authorized,card=null){
  return callCardStatus('insight-2026020001-fixture',status,authorized,card);
}
function callCardStatus(cardId,status,authorized,card=null){
  return handleBroadcastOperatorRequest(new Request('https://example.test/api/broadcast/operator/cards/'+encodeURIComponent(cardId)+'/status',{
    method:'POST',headers:authorized?authHeaders():{'content-type':'application/json'},body:JSON.stringify({status,...(card?{card}: {})}),
  }),env,'/api/broadcast/operator/cards/'+cardId+'/status');
}
function authHeaders(){return {'authorization':'Bearer operator-secret','content-type':'application/json'};}

function statement(sql){
  return {
    bind(...args){
      return {
        async first(){
          if (/FROM broadcast_cards bc/.test(sql) && /WHERE bc\.card_id=\?/.test(sql)) {
            const c=clone(cards.get(String(args[0]))||null);
            return c?{...c,home_tri:'CAR',away_tri:'FLA',home_name_ru:'Каролина',home_name:'Carolina Hurricanes',home_logo:'',away_name_ru:'Флорида',away_name:'Florida Panthers',away_logo:''}:null;
          }
          if (/SELECT card_id,render_hash,render_png_base64/.test(sql)) return clone(cards.get(String(args[0]))||null);
          if (/FROM broadcast_cards WHERE card_id=\?/.test(sql)) return clone(cards.get(String(args[0]))||null);
          if (/FROM broadcast_operator_leases/.test(sql)) return null;
          throw new Error('Unhandled first SQL: '+sql);
        },
        async run(){ return execute(sql,args); },
        async __run(){ return execute(sql,args); },
      };
    },
  };
}
function execute(sql,args){
  if (/INSERT INTO broadcast_operator_actions/.test(sql)) return changes(1);
  if (/UPDATE broadcast_cards/.test(sql) && /payload_json=\?/.test(sql) && /render_hash=NULL/.test(sql)) {
    const [headline,stat,source,type,subject,odds,payload,id,gamePk]=args;
    const c=cards.get(String(id));
    if(c&&Number(c.game_pk)===Number(gamePk)){
      c.headline_ru=String(headline);c.stat_text_ru=String(stat);c.source_note_ru=String(source);
      c.suggested_market_type=String(type);c.suggested_market_subject=String(subject);
      c.manual_odds=Number(odds);c.odds_is_demo=0;c.payload_json=String(payload);
      c.render_hash=null;c.render_png_base64=null;c.render_bytes=null;c.rendered_at=null;
      return changes(1);
    }
    return changes(0);
  }
  if (/SET render_hash=\?/.test(sql) && /render_png_base64=\?/.test(sql)) {
    const [hash,png,bytes,id]=args;
    const c=cards.get(String(id));
    if(c){
      c.render_hash=String(hash);
      c.render_png_base64=String(png);
      c.render_bytes=Number(bytes);
      c.rendered_at=new Date().toISOString();
    }
    return changes(c?1:0);
  }
  if (/SET status='draft'/.test(sql) && /status='preview'/.test(sql)) {
    const [gamePk,exceptRaw]=args;const except=String(exceptRaw);
    for(const c of cards.values())if(c.status==='preview'&&Number(c.game_pk)===Number(gamePk)&&c.card_id!==except)c.status='draft';
    return changes(1);
  }
  if (/SET status='preview'/.test(sql)) {
    const c=cards.get(String(args[0]));if(c){c.status='preview';c.shown_at=null;}return changes(c?1:0);
  }
  if (/SET status='hidden'/.test(sql) && /status='shown'/.test(sql)) {
    const [gamePk,exceptRaw]=args;const except=String(exceptRaw);
    for(const c of cards.values())if(c.status==='shown'&&Number(c.game_pk)===Number(gamePk)&&c.card_id!==except){c.status='hidden';c.shown_at=null;}
    return changes(1);
  }
  if (/SET status='shown'/.test(sql)) {
    const c=cards.get(String(args[0]));if(c){c.status='shown';c.shown_at=new Date().toISOString();return changes(1);}return changes(0);
  }
  if (/UPDATE broadcast_cards SET status=\?/.test(sql)) {
    const [status,id]=args;const c=cards.get(String(id));if(c){c.status=String(status);c.shown_at=null;}return changes(c?1:0);
  }
  throw new Error('Unhandled run SQL: '+sql);
}
function changes(n){return {meta:{changes:n},changes:n};}
function clone(v){return v?JSON.parse(JSON.stringify(v)):null;}
