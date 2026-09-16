import { loadTeamDetail, loadTeamRankings } from "./team-current-data.js";
import { handleTeamCurrentUiRequest } from "./team-current-ui.js";
import { handleTelegramMiniAppV2Ui } from "./telegram-mini-app-v2-ui.js";
import { handleTelegramCenterUi } from "./telegram-center-ui.js";
import { handleTelegramCenterDataRequest } from "./telegram-center-data.js";
import { handleTelegramCenterInteractiveRequest } from "./telegram-center-interactive.js";
import { handleTelegramCenterProfilesV2 } from "./telegram-center-profiles-v2.js";
import { handleTelegramCenterHistoryV3 } from "./telegram-center-history-v3.js";
import { handleCurrentSeasonTeamGuard } from "./telegram-center-current-season-guard.js";
import { handleTelegramCenterCatalogAdmin } from "./telegram-center-catalog-admin.js";
import { handleTelegramCenterRosterAdmin } from "./telegram-center-roster-admin.js";
import { handleTelegramCenterSubscriptionsV4 } from "./telegram-center-subscriptions-v4.js";
import { handleTelegramCenterNotificationRoutes } from "./telegram-center-notification-routes.js";
import { handleTelegramCenterProfileUiV5 } from "./telegram-center-profile-ui-v5.js";
import { handleTelegramCenterProductV6 } from "./telegram-center-product-v6.js";
import { handleTelegramCenterV7 } from "./telegram-center-v7.js";
import { handleTelegramCenterV8Ui } from "./telegram-center-v8-ui.js";
import { handleTelegramCenterV8BrandAssets } from "./telegram-center-v8-brand-assets.js";
import { handleTelegramCenterV9Enhancer } from "./telegram-center-v9-enhancer.js";
import { handleWinlineCenterIngest } from "./winline-center-ingest.js";
import { handleDataCoreHealthV2 } from "./data-core-health-v2.js";
import { handleControlLowReadRequest } from "./control-low-read-routes.js";
import { handleControlCenterV2Ui } from "./control-center-v2-ui.js";
import { handleControlNavEnhancer } from "./control-nav-enhancer.js";
import { handleTelegramGameSubscriptionRequest } from "./telegram-game-subscriptions.js";
import { handleTelegramGameFollowUi } from "./telegram-game-follow-ui.js";
import { handleTelegramNotificationPreferencesUi } from "./telegram-notification-preferences-ui.js";
import { handleTelegramMatchupPreviewUi } from "./telegram-matchup-preview-ui.js";
import { handleMatchupCenterRequest } from "./matchup-center.js";
import { handleBroadcastOperatorRequest } from "./broadcast-operator.js";

export async function handleTeamCurrentRequest(request, env, path) {
  const healthResponse = await handleDataCoreHealthV2(request, env, path);
  if (healthResponse) return healthResponse;

  const controlLowReadResponse = await handleControlLowReadRequest(request, env, path);
  if (controlLowReadResponse) return controlLowReadResponse;

  const winlineCenterResponse = await handleWinlineCenterIngest(request.clone(), env, path);
  if (winlineCenterResponse) return winlineCenterResponse;

  const centerV9Response = await handleTelegramCenterV9Enhancer(request.clone(), env, path);
  if (centerV9Response) return centerV9Response;

  const centerV8BrandResponse = handleTelegramCenterV8BrandAssets(request, path);
  if (centerV8BrandResponse) return centerV8BrandResponse;

  const centerV8Response = handleTelegramCenterV8Ui(request, path);
  if (centerV8Response) {
    if (path === "/telegram-app" && request.method === "GET") {
      let body = await centerV8Response.text();
      body = body.replace('data-tab="mine">Мои</button>', 'data-tab="follows">Мои</button>');
      if (!body.includes('/telegram-app/v8-brand.css')) body = body.replace('</head>', '<link rel="stylesheet" href="/telegram-app/v8-brand.css"></head>');
      if (!body.includes('/telegram-app/v9.css')) body = body.replace('</head>', '<link rel="stylesheet" href="/telegram-app/v9.css"></head>');
      if (!body.includes('/telegram-app/v9.js')) body = body.replace('</body>', '<script src="/telegram-app/v9.js"></script></body>');
      return new Response(body, {status:centerV8Response.status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","Pragma":"no-cache","X-Content-Type-Options":"nosniff"}});
    }
    return centerV8Response;
  }

  const centerV7Response = await handleTelegramCenterV7(request.clone(), env, path);
  if (centerV7Response) {
    if (path === "/telegram-app" && request.method === "GET") {
      let body = await centerV7Response.text();
      body = body.replace('data-tab="mine">Мои</button>', 'data-tab="follows">Мои</button>');
      return new Response(body, {status:centerV7Response.status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","Pragma":"no-cache","X-Content-Type-Options":"nosniff"}});
    }
    return centerV7Response;
  }

  const centerProductV6Response = await handleTelegramCenterProductV6(request.clone(), env, path);
  if (centerProductV6Response) return centerProductV6Response;

  const centerProfileV5Response = handleTelegramCenterProfileUiV5(request, path);
  if (centerProfileV5Response) return centerProfileV5Response;

  const centerNotificationResponse = await handleTelegramCenterNotificationRoutes(request.clone(), env, path);
  if (centerNotificationResponse) return centerNotificationResponse;

  const centerRosterAdminResponse = await handleTelegramCenterRosterAdmin(request.clone(), env, path);
  if (centerRosterAdminResponse) return centerRosterAdminResponse;

  const centerCatalogAdminResponse = await handleTelegramCenterCatalogAdmin(request.clone(), env, path);
  if (centerCatalogAdminResponse) return centerCatalogAdminResponse;

  const centerSubscriptionsV4Response = await handleTelegramCenterSubscriptionsV4(request.clone(), env, path);
  if (centerSubscriptionsV4Response) return centerSubscriptionsV4Response;

  const currentSeasonGuardResponse = await handleCurrentSeasonTeamGuard(request.clone(), env, path);
  if (currentSeasonGuardResponse) return currentSeasonGuardResponse;

  const centerHistoryV3Response = await handleTelegramCenterHistoryV3(request.clone(), env, path);
  if (centerHistoryV3Response) return centerHistoryV3Response;

  const centerProfilesV2Response = await handleTelegramCenterProfilesV2(request.clone(), env, path);
  if (centerProfilesV2Response) return centerProfilesV2Response;

  const centerInteractiveResponse = await handleTelegramCenterInteractiveRequest(request.clone(), env, path);
  if (centerInteractiveResponse) return centerInteractiveResponse;

  const centerDataResponse = await handleTelegramCenterDataRequest(request.clone(), env, path);
  if (centerDataResponse) return centerDataResponse;

  const gameSubscriptionResponse = await handleTelegramGameSubscriptionRequest(request.clone(), env, path);
  if (gameSubscriptionResponse) return gameSubscriptionResponse;

  const gameFollowUiResponse = handleTelegramGameFollowUi(request, path);
  if (gameFollowUiResponse) return gameFollowUiResponse;

  const preferenceUiResponse = handleTelegramNotificationPreferencesUi(request, path);
  if (preferenceUiResponse) return preferenceUiResponse;

  const matchupPreviewUiResponse = handleTelegramMatchupPreviewUi(request, path);
  if (matchupPreviewUiResponse) return matchupPreviewUiResponse;

  const controlNavResponse = handleControlNavEnhancer(request,path);
  if (controlNavResponse) return controlNavResponse;

  const broadcastOperatorResponse = await handleBroadcastOperatorRequest(request.clone(), env, path);
  if (broadcastOperatorResponse) return broadcastOperatorResponse;

  const matchupResponse = await handleMatchupCenterRequest(request, env, path);
  if (matchupResponse) return matchupResponse;

  const controlV2Response = handleControlCenterV2Ui(request, path);
  if (controlV2Response) {
    if(path==="/control"&&request.method==="GET"){
      let body=await controlV2Response.text();
      if(!body.includes("/control/nav.js"))body=body.replace("</body>",'<script src="/control/nav.js"></script></body>');
      return new Response(body,{status:controlV2Response.status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=120","X-Content-Type-Options":"nosniff"}});
    }
    return controlV2Response;
  }

  const centerUiResponse = handleTelegramCenterUi(request, path, env);
  if (centerUiResponse) {
    if (path === "/telegram-app" && request.method === "GET") {
      let body = await centerUiResponse.text();
      if (!body.includes("/telegram-app/profiles-v2.js")) body = body.replace("</body>", '<script src="/telegram-app/profiles-v2.js"></script></body>');
      if (!body.includes("/telegram-app/history-v3.js")) body = body.replace("</body>", '<script src="/telegram-app/history-v3.js"></script></body>');
      if (!body.includes("/telegram-app/subscriptions-v4.js")) body = body.replace("</body>", '<script src="/telegram-app/subscriptions-v4.js"></script></body>');
      if (!body.includes("/telegram-app/profile-v6.js")) body = body.replace("</body>", '<script src="/telegram-app/profile-v6.js"></script></body>');
      return new Response(body, {status:centerUiResponse.status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store, no-cache, must-revalidate","Pragma":"no-cache","X-Content-Type-Options":"nosniff"}});
    }
    return centerUiResponse;
  }

  const miniAppV2Response = handleTelegramMiniAppV2Ui(request, path);
  if (miniAppV2Response) {
    if (path === "/telegram-app" && request.method === "GET") {
      let enhanced = await miniAppV2Response.text();
      for (const src of ["/telegram-app/game-follow.js","/telegram-app/preferences.js","/telegram-app/matchup.js"]) if (!enhanced.includes(src)) enhanced = enhanced.replace("</body>", `<script src="${src}"></script></body>`);
      return new Response(enhanced, {status:miniAppV2Response.status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"public, max-age=120","X-Content-Type-Options":"nosniff"}});
    }
    return miniAppV2Response;
  }

  const uiResponse = await handleTeamCurrentUiRequest(request, path);
  if (uiResponse) return uiResponse;

  if (!["GET"].includes(request.method)) return null;
  if (!env.DB) {
    if (path.startsWith("/api/control/teams") || path.startsWith("/api/telegram-app/teams")) return json({ ok:false,error:"missing_d1_binding" },503);
    return null;
  }

  if (path === "/api/control/teams" || path === "/api/telegram-app/teams") {
    const window = normalizeWindow(new URL(request.url).searchParams.get("window"));
    try { return json({ ok:true,window,teams:await loadTeamRankings(env.DB, window) }); }
    catch (error) { console.error("current team rankings failed", error); return json({ ok:false,error:"current_team_layer_not_ready",teams:[] },503); }
  }

  const match = /^\/api\/(?:control|telegram-app)\/teams\/([A-Za-z]{3})$/.exec(path);
  if (match) {
    const tri = match[1].toUpperCase();
    try { const detail = await loadTeamDetail(env.DB, tri); if (!detail) return json({ ok:false,error:"team_not_found" },404); return json({ ok:true,...detail }); }
    catch (error) { console.error("current team detail failed", error); return json({ ok:false,error:"current_team_layer_not_ready" },503); }
  }

  return null;
}

function normalizeWindow(value) { const n=Number(value); return [5,10,20].includes(n)?n:20; }
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}