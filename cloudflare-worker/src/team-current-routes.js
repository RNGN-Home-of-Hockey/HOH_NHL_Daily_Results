import { loadTeamDetail, loadTeamRankings } from "./team-current-data.js";
import { handleTeamCurrentUiRequest } from "./team-current-ui.js";

export async function handleTeamCurrentRequest(request, env, path) {
  const uiResponse = await handleTeamCurrentUiRequest(request, path);
  if (uiResponse) return uiResponse;

  if (!["GET"].includes(request.method)) return null;
  if (!env.DB) {
    if (path.startsWith("/api/control/teams") || path.startsWith("/api/telegram-app/teams")) {
      return json({ ok:false,error:"missing_d1_binding" },503);
    }
    return null;
  }

  if (path === "/api/control/teams" || path === "/api/telegram-app/teams") {
    const window = normalizeWindow(new URL(request.url).searchParams.get("window"));
    try {
      const teams = await loadTeamRankings(env.DB, window);
      return json({ ok:true,window,teams });
    } catch (error) {
      console.error("current team rankings failed", error);
      return json({ ok:false,error:"current_team_layer_not_ready",teams:[] },503);
    }
  }

  const match = /^\/api\/(?:control|telegram-app)\/teams\/([A-Za-z]{3})$/.exec(path);
  if (match) {
    const tri = match[1].toUpperCase();
    try {
      const detail = await loadTeamDetail(env.DB, tri);
      if (!detail) return json({ ok:false,error:"team_not_found" },404);
      return json({ ok:true,...detail });
    } catch (error) {
      console.error("current team detail failed", error);
      return json({ ok:false,error:"current_team_layer_not_ready" },503);
    }
  }

  return null;
}

function normalizeWindow(value) {
  const n=Number(value);
  return [5,10,20].includes(n)?n:20;
}

function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}})}
