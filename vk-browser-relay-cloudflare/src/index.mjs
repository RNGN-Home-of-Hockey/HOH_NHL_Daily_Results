export { VkRelayState } from "./state.mjs";

function state(env) {
  return env.RELAY_STATE.get(env.RELAY_STATE.idFromName("main"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "rngn-vk-browser-relay", runtime: "cloudflare-browser-run" });
    }
    if (url.pathname.startsWith("/admin/") || url.pathname === "/drain") {
      return state(env).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      state(env).fetch("https://relay.internal/drain", { method: "POST" })
        .catch((error) => console.error("VK relay scheduled drain failed", error)),
    );
  },
};
