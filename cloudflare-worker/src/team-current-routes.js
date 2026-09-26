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
import { handleTelegramCenterV9Polish } from "./telegram-center-v9-polish.js";
import { handleTelegramCenterV11Polish } from "./telegram-center-v11-polish.js";
import { handleTelegramCenterV12Polish } from "./telegram-center-v12-polish.js";
import { handleTelegramCenterV13Teams } from "./telegram-center-v13-teams.js";
import { handleTelegramCenterV15TeamData } from "./telegram-center-v15-team-data.js";
import { handleTelegramCenterV15PlayerData } from "./telegram-center-v15-player-data.js";
import { handleTelegramCenterV15CoreUi } from "./telegram-center-v15-core-ui.js";
import { handleTelegramCenterV15TeamUi } from "./telegram-center-v15-team-ui.js";
import { handleTelegramCenterV15PlayerUi } from "./telegram-center-v15-player-ui.js";
import { handleTelegramCenterV16Hotfix } from "./telegram-center-v16-hotfix.js";
import { handleTelegramCenterV17PlayerData } from "./telegram-center-v17-player-data.js";
import { handleTelegramCenterV17Hotfix } from "./telegram-center-v17-hotfix.js";
import { handleTelegramCenterV18PlayerLastGame } from "./telegram-center-v18-player-lastgame.js";
import { handleTelegramCenterV18VkData } from "./telegram-center-v18-vk-data.js";
import { handleTelegramCenterV18VkUi } from "./telegram-center-v18-vk-ui.js";
import { handleTelegramCenterV19ProductData } from "./telegram-center-v19-product-data.js";
import { handleTelegramCenterV19Ui } from "./telegram-center-v19-ui.js";
import { handleTelegramCenterV20News } from "./telegram-center-v20-news.js";
import { handleTelegramCenterV20Ui } from "./telegram-center-v20-ui.js";
import { handleTelegramCenterV21SpoilersUi } from "./telegram-center-v21-spoilers-ui.js";
import { handleTelegramCenterV22Profiles } from "./telegram-center-v22-profiles.js";
import { handleTelegramCenterV22Ui } from "./telegram-center-v22-ui.js";
import { handleTelegramCenterV23PlayerUi } from "./telegram-center-v23-player-ui.js";
import { handleTelegramCenterV24VisualUi } from "./telegram-center-v24-visual-ui.js";
import { handleWinlineCenterIngest } from "./winline-center-ingest.js";
import { handleWinlineFeedProbe } from "./winline-feed-probe.js";
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
  if (path === "/telegram-app/goalie-bg.webp" && request.method === "GET" && env.ASSETS?.fetch) {
    return env.ASSETS.fetch(request);
  }

  const healthResponse = await handleDataCoreHealthV2(request, env, path);
  if (healthResponse) return healthResponse;

  const controlLowReadResponse = await handleControlLowReadRequest(request, env, path);
  if (controlLowReadResponse) return controlLowReadResponse;

  const winlineCenterResponse = await handleWinlineCenterIngest(request.clone(), env, path);
  if (winlineCenterResponse) return winlineCenterResponse;
  const winlineFeedProbeResponse = await handleWinlineFeedProbe(request.clone(), path);
  if (winlineFeedProbeResponse) return winlineFeedProbeResponse;

  const centerV9Response = await handleTelegramCenterV9Enhancer(request.clone(), env, path);
  if (centerV9Response) return centerV9Response;

  const centerV9PolishResponse = handleTelegramCenterV9Polish(request, path);
  if (centerV9PolishResponse) return centerV9PolishResponse;

  const centerV11PolishResponse = handleTelegramCenterV11Polish(request, path);
  if (centerV11PolishResponse) return centerV11PolishResponse;

  const centerV12PolishResponse = await handleTelegramCenterV12Polish(request, env, path);
  if (centerV12PolishResponse) return centerV12PolishResponse;

  const centerV13Response = await handleTelegramCenterV13Teams(request, env, path);
  if (centerV13Response) return centerV13Response;

  const centerV15TeamDataResponse = await handleTelegramCenterV15TeamData(request.clone(), env, path);
  if (centerV15TeamDataResponse) return centerV15TeamDataResponse;

  const centerV15PlayerDataResponse = await handleTelegramCenterV15PlayerData(request.clone(), env, path);
  if (centerV15PlayerDataResponse) return centerV15PlayerDataResponse;

  const centerV15CoreUiResponse = handleTelegramCenterV15CoreUi(request, path);
  if (centerV15CoreUiResponse) return centerV15CoreUiResponse;
  const centerV15TeamUiResponse = handleTelegramCenterV15TeamUi(request, path);
  if (centerV15TeamUiResponse) return centerV15TeamUiResponse;
  const centerV15PlayerUiResponse = handleTelegramCenterV15PlayerUi(request, path);
  if (centerV15PlayerUiResponse) return centerV15PlayerUiResponse;

  const centerV16HotfixResponse = handleTelegramCenterV16Hotfix(request, path);
  if (centerV16HotfixResponse) return centerV16HotfixResponse;

  const centerV17PlayerDataResponse = await handleTelegramCenterV17PlayerData(request.clone(), env, path);
  if (centerV17PlayerDataResponse) return centerV17PlayerDataResponse;
  const centerV17HotfixResponse = handleTelegramCenterV17Hotfix(request, path);
  if (centerV17HotfixResponse) return centerV17HotfixResponse;

  const centerV19DataResponse = await handleTelegramCenterV19ProductData(request.clone(), env, path);
  if (centerV19DataResponse) return centerV19DataResponse;
  const centerV19UiResponse = handleTelegramCenterV19Ui(request, path);
  if (centerV19UiResponse) return centerV19UiResponse;
  const centerV20NewsResponse = await handleTelegramCenterV20News(request.clone(), env, path);
  if (centerV20NewsResponse) return centerV20NewsResponse;
  const centerV20UiResponse = handleTelegramCenterV20Ui(request, path);
  if (centerV20UiResponse) return centerV20UiResponse;
  const centerV21SpoilersUiResponse = handleTelegramCenterV21SpoilersUi(request, path);
  if (centerV21SpoilersUiResponse) return centerV21SpoilersUiResponse;
  const centerV22ProfilesResponse = await handleTelegramCenterV22Profiles(request.clone(), env, path);
  if (centerV22ProfilesResponse) return centerV22ProfilesResponse;
  const centerV22UiResponse = handleTelegramCenterV22Ui(request, path);
  if (centerV22UiResponse) return centerV22UiResponse;
  const centerV23PlayerUiResponse = handleTelegramCenterV23PlayerUi(request, path);
  if (centerV23PlayerUiResponse) return centerV23PlayerUiResponse;
  const centerV24VisualUiResponse = handleTelegramCenterV24VisualUi(request, path);
  if (centerV24VisualUiResponse) return centerV24VisualUiResponse;
  const centerV18PlayerLastGameResponse = await handleTelegramCenterV18PlayerLastGame(request.clone(), env, path);
  if (centerV18PlayerLastGameResponse) return centerV18PlayerLastGameResponse;
  const centerV18VkDataResponse = await handleTelegramCenterV18VkData(request.clone(), env, path);
  if (centerV18VkDataResponse) return centerV18VkDataResponse;
  const centerV18VkUiResponse = handleTelegramCenterV18VkUi(request, path);
  if (centerV18VkUiResponse) return centerV18VkUiResponse;

  const centerV8BrandResponse = handleTelegramCenterV8BrandAssets(request, path);
  if (centerV8BrandResponse) return centerV8BrandResponse;

  if ((path === "/telegram-app-v24" || path === "/telegram-app") && request.method === "GET") {
    const cleanBaseResponse = handleTelegramCenterV8Ui(request, "/telegram-app");
    if (!cleanBaseResponse) return new Response("mini_app_shell_unavailable", { status: 503 });
    let body = await cleanBaseResponse.text();
    body = body.replace('data-tab="mine">Мои</button>', 'data-tab="follows">Мои</button>');
    body = body.replace('<span class="v8">V8</span>', '<span class="v8">V24.6.0</span>');
    if (!body.includes('/telegram-app/v8-brand.css')) body = body.replace('</head>', '<link rel="stylesheet" href="/telegram-app/v8-brand.css?build=24.6.0"></head>');
    if (!body.includes('/telegram-app/v9.css')) body = body.replace('</head>', '<link rel="stylesheet" href="/telegram-app/v9.css?build=24.6.0"></head>');
    body = body.replace('</body>', '<script>window.HOH_CANONICAL_PLAYER_UI="V24";window.HOH_MINI_APP_BUILD="24.6.0";</script></body>');
    for (const src of [
      "/telegram-app/v9.js?build=24.6.0",
      "/telegram-app/v15-core.js?build=24.6.0",
      "/telegram-app/v15-team.js?build=24.6.0",
      "/telegram-app/v19.js?build=24.6.0",
      "/telegram-app/v20.js?build=24.6.0",
      "/telegram-app/v21.js?build=24.6.0",
      "/telegram-app/v22.js?build=24.6.0",
      "/telegram-app/v23-player.js?build=24.6.0",
      "/telegram-app/v24-visual.js?build=24.6.0"
    ]) body = body.replace('</body>', '<script src="'+src+'"></script></body>');
    return new Response(body, {status:200,headers:{
      "Content-Type":"text/html; charset=utf-8",
      "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0",
      "Pragma":"no-cache",
      "Expires":"0",
      "X-HOH-Mini-App-Build":"24.6.0",
      "X-HOH-Player-UI":"V24-canonical",
      "X-Content-Type-Options":"nosniff"
    }});
  }

  const centerV8Response = handleTelegramCenterV8Ui(request, path);
  if (centerV8Response) {
    if (path === "/telegram-app" && request.method === "GET") {
      let body = await centerV8Response.text();
      body = body.replace('data-tab="mine">Мои</button>', 'data-tab="follows">Мои</button>');
      if (!body.includes('/telegram-app/v8-brand.css')) body = body.replace('</head>', '<link rel="stylesheet" href="/telegram-app/v8-brand.css"></head>');
      if (!body.includes('/telegram-app/v9.css')) body = body.replace('</head>', '<link rel="stylesheet" href="/telegram-app/v9.css"></head>');
      if (!body.includes('/telegram-app/v9.js')) body = body.replace('</body>', '<script src="/telegram-app/v9.js"></script></body>');
      if (!body.includes('/telegram-app/v9-polish.js')) body = body.replace('</body>', '<script src="/telegram-app/v9-polish.js"></script></body>');
      if (!body.includes('/telegram-app/v11.js')) body = body.replace('</body>', '<script src="/telegram-app/v11.js"></script></body>');
      if (!body.includes('/telegram-app/v12.js')) body = body.replace('</body>', '<script src="/telegram-app/v12.js?build=22.2"></script></body>');
      if (!body.includes('/telegram-app/v13.js')) body = body.replace('</body>', '<script src="/telegram-app/v13.js"></script></body>');
      if (!body.includes('/telegram-app/v15-core.js')) body = body.replace('</body>', '<script src="/telegram-app/v15-core.js?build=22.2"></script></body>');
      if (!body.includes('/telegram-app/v15-team.js')) body = body.replace('</body>', '<script src="/telegram-app/v15-team.js"></script></body>');
      if (!body.includes('/telegram-app/v15-player.js')) body = body.replace('</body>', '<script src="/telegram-app/v15-player.js"></script></body>');
      if (!body.includes('/telegram-app/v16.js')) body = body.replace('</body>', '<script src="/telegram-app/v16.js?build=22.1"></script></body>');
      if (!body.includes('/telegram-app/v17.js')) body = body.replace('</body>', '<script src="/telegram-app/v17.js?build=22.1"></script></body>');
      if (!body.includes('/telegram-app/v18.js')) body = body.replace('</body>', '<script src="/telegram-app/v18.js?build=22.1"></script></body>');
      if (!body.includes('/telegram-app/v19.js')) body = body.replace('</body>', '<script src="/telegram-app/v19.js?build=22.2"></script></body>');
      if (!body.includes('/telegram-app/v20.js')) body = body.replace('</body>', '<script src="/telegram-app/v20.js?build=22.1"></script></body>');
      if (!body.includes('/telegram-app/v21.js')) body = body.replace('</body>', '<script src="/telegram-app/v21.js?build=22.1"></script></body>');
      if (!body.includes('/telegram-app/v22.js')) body = body.replace('</body>', '<script src="/telegram-app/v22.js?build=22.2"></script></body>');
      if (!body.includes('/telegram-app/v23-player.js')) body = body.replace('</body>', '<script src="/telegram-app/v23-player.js?build=23.0.1"></script></body>');
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