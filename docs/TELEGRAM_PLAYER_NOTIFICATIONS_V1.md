# Home of Hockey Live Center — Player notifications V1

## Product contract

First-wave notifications for users who follow NHL players:

1. **Local evening digest** — one combined message around 20:00 in the user's browser/Telegram Mini App timezone. It lists followed players who have an NHL game in the coming night.
2. **Injury/availability context** — the digest checks ESPN's league-wide NHL injury feed. A confirmed out/IR/LTIR-style status is rendered as **«травмирован, не сыграет»**. Questionable/day-to-day statuses are rendered as participation uncertain. If no confirmed injury record exists but the player is outside the current NHL roster snapshot, the copy stays conservative: **«вне активного состава»**.
3. **Optional match reminder** — a user can explicitly enable **«Напомнить за 15 минут»** on a game. This creates a reminder-only game subscription and does not turn on goals, period events, final score, or any legacy event firehose.
4. **Postgame player report** — after NHL marks the game final and the official NHL boxscore exposes player game stats, the Center sends followed-player stats. Skaters include G+A=P, shots, hits, blocks, +/- and TOI. Goalies include saves, shots against, save percentage and goals against.
5. **No betting odds in V1.**

## Delivery and idempotency

The notification engine runs from the existing Cloudflare Worker cron every minute.

- Every event/user pair has a deterministic notification key in D1, so retries do not duplicate a delivered message.
- If NHL marks a game final before the full player boxscore is available, the engine does not reserve the report and retries on the next eligible tick.
- Evening digests retry during the first 30 minutes of the configured digest hour if a tick is temporarily capacity-limited.
- The old goal/start/period notification stream remains disabled behind `TELEGRAM_CENTER_EVENT_STREAM_ENABLED=0`.

## 100-user burst handling

V1 deliberately avoids a single 100-message fan-out in one Worker invocation.

- Users are split into **5 deterministic delivery shards** by Telegram user ID.
- A 100-user reminder burst is therefore about **20 recipients per minute**.
- Postgame reports use the same sharding and are delivered within a few minutes of the official boxscore becoming available.
- The engine also enforces a hard ceiling of **30 Telegram sends per Worker tick**. Deferred messages are not reserved as sent and remain eligible for a later tick.
- D1 lookups are chunked to fewer than 100 bound parameters, so growth beyond 100 users does not hit D1's bound-parameter ceiling.

This keeps the first-wave design inside the normal free Telegram Bot API broadcast limit and below Cloudflare Worker per-invocation subrequest pressure at the 100-user scale.

## Hosting / upgrade decision

No separate VM or application server is required for the first 100 users. The workload stays on the existing stack:

- Cloudflare Worker = scheduler/orchestrator
- Cloudflare D1 = subscriptions, preferences, idempotency log
- Telegram Bot API = delivery
- NHL API = schedule + official boxscore
- ESPN NHL injury feed = injury status context

Current public platform limits to watch:

- Cloudflare Workers Free: 100,000 Worker requests/day and 50 external subrequests/request.
- Cloudflare D1 Free: 5 million rows read/day, 100,000 rows written/day; Free also has per-invocation query limits.
- Telegram Bot API: about 30 broadcast messages/second by default.

Official references:
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://core.telegram.org/bots/faq

For **100 users**, V1 is intentionally designed not to require a paid server. Upgrade to **Workers Paid** when aggregate HOH traffic begins approaching the Free daily request/D1 quotas, or before a public launch where hitting a daily free-tier ceiling would be unacceptable. The first upgrade should be the Cloudflare Workers plan, not a separate VPS.
