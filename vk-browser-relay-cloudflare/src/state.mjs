import { DurableObject } from "cloudflare:workers";
import { connect, launch } from "@cloudflare/playwright";
import { endpoints, claim, complete, fail, heartbeat } from "./api.mjs";
import { diagnostics, isAuthenticated, publishVkChannel } from "./vk.mjs";

const STATE_KEY = "vkStorageState";
const LOGIN_SESSION_KEY = "loginSessionId";
const LOGIN_SAVE_TOKEN_KEY = "loginSaveToken";
const LOGIN_LIVE_VIEW_KEY = "loginLiveViewUrl";
const JOURNAL_PREFIX = "journal:";

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function adminAuthorized(request, env) {
  const url = new URL(request.url);
  const supplied = url.searchParams.get("key") || request.headers.get("x-admin-secret") || "";
  return supplied && supplied === env.ADMIN_SECRET;
}

export class VkRelayState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async storageState() {
    return this.ctx.storage.get(STATE_KEY);
  }

  async setStorageState(value) {
    await this.ctx.storage.put(STATE_KEY, value);
  }

  async notifyHeartbeats(authenticated) {
    await Promise.all(endpoints(this.env).map((endpoint) =>
      heartbeat(endpoint, authenticated).catch(() => null)
    ));
  }

  async startLogin(request) {
    if (!adminAuthorized(request, this.env)) return json({ ok: false, error: "unauthorized" }, 401);

    let browser;
    try {
      const previousSessionId = await this.ctx.storage.get(LOGIN_SESSION_KEY);
      if (previousSessionId) {
        try {
          const previous = await connect(this.env.BROWSER, previousSessionId);
          await previous.close();
        } catch {
          // Stale Browser Run sessions are expected after idle timeout.
        }
        await this.ctx.storage.delete(LOGIN_SESSION_KEY);
        await this.ctx.storage.delete(LOGIN_SAVE_TOKEN_KEY);
        await this.ctx.storage.delete(LOGIN_LIVE_VIEW_KEY);
      }

      browser = await launch(this.env.BROWSER, { keep_alive: 600000, recording: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto("https://vk.ru/", { waitUntil: "domcontentloaded", timeout: 45_000 });

      const cdp = await context.newCDPSession(page);
      const { devtoolsFrontendUrl } = await cdp.send("Cloudflare.getLiveView", {
        mode: "tab",
        expiresInMs: 600000,
      });

      const sessionId = browser.sessionId();
      const saveToken = crypto.randomUUID();
      await this.ctx.storage.put(LOGIN_SESSION_KEY, sessionId);
      await this.ctx.storage.put(LOGIN_SAVE_TOKEN_KEY, saveToken);
      await this.ctx.storage.put(LOGIN_LIVE_VIEW_KEY, devtoolsFrontendUrl);

      const url = new URL(request.url);
      const viewerUrl = `${url.origin}/admin/login/view?token=${encodeURIComponent(saveToken)}`;
      const statusUrl = `${url.origin}/admin/login/status?token=${encodeURIComponent(saveToken)}`;

      await this.ctx.storage.put("loginStatus", {
        status: "waiting",
        startedAt: new Date().toISOString(),
      });

      // Keep this exact browser/context alive while the human logs in. Once VK reaches
      // an authenticated page, persist storageState from the same context.
      this.ctx.waitUntil((async () => {
        try {
          const deadline = Date.now() + 9 * 60 * 1000;
          let consecutiveAuthenticated = 0;
          while (Date.now() < deadline) {
            await page.waitForTimeout(2000);
            const currentUrl = page.url();
            const authenticated = await isAuthenticated(page).catch(() => false);
            const profileNavVisible = await page.getByText("Профиль", { exact: true }).first().isVisible().catch(() => false);
            const messengerNavVisible = await page.getByText("Мессенджер", { exact: true }).first().isVisible().catch(() => false);
            const communitiesNavVisible = await page.getByText("Сообщества", { exact: true }).first().isVisible().catch(() => false);
            const friendsNavVisible = await page.getByText("Друзья", { exact: true }).first().isVisible().catch(() => false);
            const feedNavVisible = await page.getByText("Лента", { exact: true }).first().isVisible().catch(() => false);
            const visibleAuthenticatedNav = [
              profileNavVisible,
              messengerNavVisible,
              communitiesNavVisible,
              friendsNavVisible,
              feedNavVisible,
            ].filter(Boolean).length;
            const strongAuthenticatedUi = visibleAuthenticatedNav >= 2;
            const looksReady = authenticated
              && strongAuthenticatedUi
              && /^https:\/\/(?:www\.)?vk\.(?:ru|com)\//i.test(currentUrl)
              && !/(?:login|join|restore|auth)/i.test(currentUrl);

            await this.ctx.storage.put("loginProbe", {
              checkedAt: new Date().toISOString(),
              url: currentUrl,
              authenticated,
              visibleAuthenticatedNav,
              profileNavVisible,
              messengerNavVisible,
              communitiesNavVisible,
              friendsNavVisible,
              feedNavVisible,
            });

            if (looksReady) consecutiveAuthenticated += 1;
            else consecutiveAuthenticated = 0;

            if (consecutiveAuthenticated >= 2) {
              await this.ctx.storage.put("loginStatus", {
                status: "saving",
                detectedAt: new Date().toISOString(),
                url: currentUrl,
                visibleAuthenticatedNav,
              });
              const storageState = await context.storageState();
              await this.setStorageState(storageState);
              await this.ctx.storage.put("loginStatus", {
                status: "saved",
                savedAt: new Date().toISOString(),
                url: currentUrl,
                strongAuthenticatedUi: true,
                visibleAuthenticatedNav,
              });
              await this.notifyHeartbeats(true);
              // Keep the one-time viewer token and Live View URL valid for the rest
              // of this browser session so the human page does not suddenly turn 410.
              return;
            }
          }

          await this.ctx.storage.put("loginStatus", {
            status: "timeout",
            savedAt: new Date().toISOString(),
          });
        } catch (error) {
          await this.ctx.storage.put("loginStatus", {
            status: "error",
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
            savedAt: new Date().toISOString(),
          });
        } finally {
          // Give the user a short window to see the successful channel page before
          // closing Live View, then clean up ephemeral login handles.
          await page.waitForTimeout(15000).catch(() => undefined);
          await browser?.close().catch(() => undefined);
          await this.ctx.storage.delete(LOGIN_SESSION_KEY);
          await this.ctx.storage.delete(LOGIN_LIVE_VIEW_KEY);
          await this.ctx.storage.delete(LOGIN_SAVE_TOKEN_KEY);
        }
      })());

      const wantsJson = request.headers.get("accept")?.includes("application/json");
      if (wantsJson) {
        return json({ ok: true, viewerUrl, statusUrl, sessionId });
      }

      return html(`<!doctype html><html><meta charset="utf-8"><title>VK login</title>
        <style>body{font-family:Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 20px}a{font-size:18px}.box{padding:20px;border:1px solid #ddd;border-radius:16px;margin:20px 0}</style>
        <h1>VK Browser Run — вход</h1>
        <div class="box"><p>Открой Live View и войди в редакционный VK-аккаунт.</p>
        <p><a href="${viewerUrl}" target="_blank" rel="noopener">Открыть VK Live View</a></p></div>
        <p>После успешного входа сессия сохранится автоматически. Никакую отдельную кнопку Save нажимать не нужно.</p>
        <p><a href="${statusUrl}">Проверить статус сохранения</a></p></html>`);
    } catch (error) {
      await browser?.close().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      return json({
        ok: false,
        error: "browser_launch_failed",
        message: message.slice(0, 700),
      }, 503);
    }
  }

  async viewLogin(request) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    const storedToken = await this.ctx.storage.get(LOGIN_SAVE_TOKEN_KEY);
    const liveViewUrl = await this.ctx.storage.get(LOGIN_LIVE_VIEW_KEY);
    if (!token || token !== storedToken || !liveViewUrl) {
      const status = await this.ctx.storage.get("loginStatus");
      if (status && status.status === "saved") {
        return html("<h2>VK-сессия уже сохранена.</h2><p>Live View больше не нужен — можно закрыть вкладку.</p>");
      }
      return html("<h2>Эта ссылка входа уже недействительна. Запусти новую VK login-сессию.</h2>", 410);
    }
    return Response.redirect(liveViewUrl, 302);
  }

  async loginStatus(request) {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    const storedToken = await this.ctx.storage.get(LOGIN_SAVE_TOKEN_KEY);
    // If token was removed after successful auto-save, admins can still inspect status.
    if (!adminAuthorized(request, this.env) && storedToken && token !== storedToken) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    const status = await this.ctx.storage.get("loginStatus");
    const probe = await this.ctx.storage.get("loginProbe");
    const configured = Boolean(await this.storageState());
    return json({ ok: true, configured, status: status ?? { status: "unknown" }, probe: probe ?? null });
  }

  async saveLogin(request) {
    const url = new URL(request.url);
    const oneTimeToken = url.searchParams.get("token") || "";
    const storedSaveToken = await this.ctx.storage.get(LOGIN_SAVE_TOKEN_KEY);
    const allowed = adminAuthorized(request, this.env) || (oneTimeToken && storedSaveToken === oneTimeToken);
    if (!allowed) return json({ ok: false, error: "unauthorized" }, 401);
    const requested = url.searchParams.get("sessionId");
    const stored = await this.ctx.storage.get(LOGIN_SESSION_KEY);
    const sessionId = requested || stored;
    if (!sessionId) return json({ ok: false, error: "login_session_missing" }, 409);

    let browser;
    try {
      browser = await connect(this.env.BROWSER, sessionId);
      const contexts = browser.contexts();
      const context = contexts[0];
      if (!context) throw new Error("VK login browser context disappeared");
      const pages = context.pages();
      const page = pages[0] || await context.newPage();
      if (!(await isAuthenticated(page))) {
        return html("<h2>VK всё ещё показывает форму входа. Вернись в Live View и заверши авторизацию.</h2>", 409);
      }
      const storageState = await context.storageState();
      await this.setStorageState(storageState);
      await this.ctx.storage.delete(LOGIN_SESSION_KEY);
      await this.ctx.storage.delete(LOGIN_SAVE_TOKEN_KEY);
      await this.ctx.storage.delete(LOGIN_LIVE_VIEW_KEY);
      await this.notifyHeartbeats(true);
      return html("<h2>VK-сессия сохранена. Browser Relay готов.</h2><p>Можно закрыть эту вкладку.</p>");
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async status(request) {
    if (!adminAuthorized(request, this.env)) return json({ ok: false, error: "unauthorized" }, 401);
    const state = await this.storageState();
    const loginSessionId = await this.ctx.storage.get(LOGIN_SESSION_KEY);
    return json({
      ok: true,
      configured: Boolean(state),
      loginSessionActive: Boolean(loginSessionId),
      endpoints: endpoints(this.env).map((item) => item.key),
    });
  }

  async processOne(endpoint) {
    const claimed = await claim(endpoint);
    const job = claimed.job;
    if (!job) return false;

    const journalKey = JOURNAL_PREFIX + endpoint.key + ":" + job.id;
    const journaled = await this.ctx.storage.get(journalKey);
    if (journaled) {
      await complete(endpoint, {
        jobId: job.id,
        lockToken: job.lockToken,
        ...journaled,
        diagnostics: "Recovered from Durable Object idempotency journal",
      });
      return true;
    }

    const storedState = await this.storageState();
    if (!storedState) {
      await fail(endpoint, {
        jobId: job.id,
        lockToken: job.lockToken,
        error: "VK Browser Run session is not configured",
        retryable: false,
        diagnostics: "Run /admin/login/start and save the VK session",
      });
      await this.notifyHeartbeats(false);
      return true;
    }

    let browser;
    let page;
    try {
      browser = await launch(this.env.BROWSER, { recording: true });
      const context = await browser.newContext({ storageState: storedState });
      page = await context.newPage();
      const result = await publishVkChannel(page, job);
      const nextState = await context.storageState();
      await this.setStorageState(nextState);
      await this.ctx.storage.put(journalKey, result);

      await complete(endpoint, {
        jobId: job.id,
        lockToken: job.lockToken,
        ...result,
      });
      await this.notifyHeartbeats(true);
      return true;
    } catch (error) {
      const details = page ? await diagnostics(page, error) : String(error).slice(0, 1000);
      const authFailure = String(error?.message || error).includes("VK_SESSION_REQUIRED");
      if (authFailure) {
        await this.ctx.storage.delete(STATE_KEY);
        await this.notifyHeartbeats(false);
      }
      await fail(endpoint, {
        jobId: job.id,
        lockToken: job.lockToken,
        error: error instanceof Error ? error.message : String(error),
        retryable: !authFailure,
        diagnostics: details,
      });
      return true;
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  async drain(request) {
    if (request.method !== "POST" && request.method !== "GET") return json({ ok: false }, 405);
    let processed = 0;
    for (let round = 0; round < 4; round++) {
      let didWork = false;
      for (const endpoint of endpoints(this.env)) {
        if (await this.processOne(endpoint)) {
          processed++;
          didWork = true;
        }
      }
      if (!didWork) break;
    }
    return json({ ok: true, processed });
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/admin/login/start") return this.startLogin(request);
    if (path === "/admin/login/view") return this.viewLogin(request);
    if (path === "/admin/login/status") return this.loginStatus(request);
    if (path === "/admin/login/save") return this.saveLogin(request);
    if (path === "/admin/status") return this.status(request);
    if (path === "/drain") return this.drain(request);
    return json({ ok: false, error: "not_found" }, 404);
  }
}
