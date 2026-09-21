# RNGN VK Relay on Cloudflare Browser Run

Primary deployment target for the first-party VK Channel browser worker.

## Why Cloudflare first

- Existing Autopost backends already run on Cloudflare.
- Browser Run provides Playwright-controlled Chrome.
- Durable Objects persist the saved VK storage state and idempotency journal.
- Live View lets an editor perform the one-time VK login manually.
- The browser only runs while logging in or posting; there is no 24/7 VM.

If VK rejects Cloudflare Browser Run traffic, keep the backend relay queue unchanged
and switch execution to the Docker worker in `../vk-browser-relay/` on Yandex Cloud.

## Secrets

- `GOTBALL_RELAY_SECRET` — GotBall backend API/relay secret.
- `BOLSHE_RELAY_SECRET` — BOLSHE backend API/relay secret.
- `ADMIN_SECRET` — protects login/status endpoints.

## One-time login

Open:

```
https://rngn-vk-browser-relay.rgfantasy.workers.dev/admin/login/start?key=<ADMIN_SECRET>
```

The page gives a Cloudflare Live View link. Log into VK there, verify that the
editor account can open the required VK Channel, then press **Сохранить VK-сессию**.

The saved Playwright `storageState` is stored only inside the Durable Object.

## Runtime

A cron runs every minute. It claims pending jobs from both Autopost backends,
opens a Browser Run session only when a job exists, publishes through VK's native
web UI, and then reports success/failure back to Autopost.
