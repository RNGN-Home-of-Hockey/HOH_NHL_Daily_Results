// Live Center v28: the script of the backdrop and the silhouettes it uses (public/telegram-app/bg/<name>.webp).
import { backdropApp } from "./telegram-center-v28-backdrop-ui.js";

export const SCRIPT_PATH = "/telegram-app/v28-backdrop.js";
// the names are the files of public/telegram-app/bg and the keys of the pool in the script
export const SILHOUETTES = ["kaprizov", "ovechkin", "kucherov", "panarin", "malkin", "sergachev", "shesterkin", "svechnikov", "michkov", "crosby", "mackinnon", "matthews"];
const BG_PATH = /^\/telegram-app\/bg\/([a-z]{3,20})\.webp$/;

export async function handleTelegramCenterV28(request, env, path) {
  if (path === SCRIPT_PATH) {
    if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
    // wrapped in a function: the bundler adds a __name helper that must not collide with other layers
    const body = `(function(){const __name=(target,value)=>target;(${backdropApp.toString()})();})();`;
    return new Response(body, {
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "X-Content-Type-Options": "nosniff" },
    });
  }
  const match = BG_PATH.exec(path);
  if (!match) return null;
  if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
  if (!SILHOUETTES.includes(match[1])) return new Response("not_found", { status: 404 });
  if (!env?.ASSETS?.fetch) return new Response("assets_binding_missing", { status: 503 });
  const asset = await env.ASSETS.fetch(request);
  if (!asset.ok) return asset;
  return new Response(asset.body, {
    status: 200,
    headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=604800", "X-Content-Type-Options": "nosniff" },
  });
}
