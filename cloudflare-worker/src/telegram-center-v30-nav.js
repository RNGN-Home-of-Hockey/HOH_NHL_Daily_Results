// Live Center v30: the script of the navigation fixes (sticky tabs, back to the same card, the week calendar, …).
import { navApp } from "./telegram-center-v30-nav-ui.js";

export const SCRIPT_PATH = "/telegram-app/v30-nav.js";

export async function handleTelegramCenterV30(request, env, path) {
  if (path !== SCRIPT_PATH) return null;
  if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
  // wrapped in a function: the bundler adds a __name helper that must not collide with other layers
  const body = `(function(){const __name=(target,value)=>target;(${navApp.toString()})();})();`;
  return new Response(body, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" },
  });
}
