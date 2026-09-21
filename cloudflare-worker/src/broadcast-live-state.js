export async function handleBroadcastLiveStateRequest(request, env, path) {
  if (path !== "/api/broadcast/state") return null;
  if (request.method !== "GET") {
    return json({ ok:false, error:"method_not_allowed" },405);
  }
  if (!env.DB) return json({ ok:false, error:"missing_d1_binding" },503);

  const url=new URL(request.url);
  const requested=Number(url.searchParams.get("game")||0);
  const gamePk=Number.isSafeInteger(requested)&&requested>0?requested:null;
  const statement=env.DB.prepare(`
    SELECT
      card_id,
      game_pk,
      headline_ru,
      stat_text_ru,
      source_note_ru,
      suggested_market_type,
      suggested_market_subject,
      manual_odds,
      odds_is_demo,
      shown_at
    FROM broadcast_cards
    WHERE status='shown'${gamePk?" AND game_pk=?":""}
    ORDER BY shown_at DESC
    LIMIT 1;
  `);
  const card=gamePk?await statement.bind(gamePk).first():await statement.first();

  return json({
    ok:true,
    scope:{game_pk:gamePk},
    on_air: card ? {
      ...card,
      odds_is_demo: Number(card.odds_is_demo || 0),
    } : null,
    server_time: new Date().toISOString(),
  });
}

function json(payload,status=200){
  return new Response(JSON.stringify(payload),{
    status,
    headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store",
    },
  });
}
