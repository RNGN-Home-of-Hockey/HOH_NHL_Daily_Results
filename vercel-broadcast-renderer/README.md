# HOH Broadcast Renderer

Dedicated stateless renderer for HOME OF HOCKEY × WINLINE broadcast cards.

It does **one job only**: JSON in → exact **820×211 PNG** out.

The existing HOH Live Center, Cloudflare Worker, D1, Winline ingest and broadcast control remain unchanged.

## Import to a new Vercel account

Import the GitHub repository:

`RNGN-Home-of-Hockey/HOH_NHL_Daily_Results`

During Vercel project setup use:

- **Project Name:** `hoh-broadcast-renderer`
- **Root Directory:** `vercel-broadcast-renderer`
- **Framework Preset:** Other
- **Build Command:** leave empty
- **Install Command:** default (`npm install`)
- **Node.js:** 20.x

No database is required.

Optional Environment Variable:

- `RENDER_SECRET` — if set, requests to the renderer must supply either
  `Authorization: Bearer <secret>` or `?token=<secret>`.

For the first deployment it can be left unset. We can add it when wiring Cloudflare to Vercel.

## Endpoints

### Health

`GET /api/health`

Expected:

```json
{
  "ok": true,
  "service": "hoh-broadcast-renderer",
  "output": { "width": 820, "height": 211 }
}
```

### Render PNG

`POST /api/render-card`

Body:

```json
{
  "team": "CAR",
  "fact": "КАРОЛИНА ЗАКРЫЛА ФОРУ +1,5 В 19 ИЗ 20 ПОСЛЕДНИХ МАТЧЕЙ",
  "market": "ФОРА +1,5 ГОЛА",
  "odds": 1.30,
  "stake": 1000
}
```

Response: `image/png`, exactly **820×211**.

For immutable CDN URLs the same endpoint supports:

`GET /api/render-card?data=<base64url(JSON)>`

The GET response uses a one-year Vercel CDN cache. Therefore Live Center does **not** need to rerender every minute. A new URL is created only when the card payload changes.

## Supported payload fields

- `team` / `team_tri` — NHL tri-code
- `team_name` — optional display override
- `team_color` — optional stripe color override
- `team_logo_url` — optional logo override; otherwise NHL asset URL is used
- `fact` — top statistical fact
- `market` — bet description
- `odds` — decimal Winline price
- `stake` — stake used for payout explanation; default 1000

## Rendering guarantees

- Output is always **820×211 PNG**
- Background/template is the approved fixed graphic
- Sofia Sans Condensed Italic is bundled locally
- Winline logo and structural UI are part of the fixed template
- Only dynamic content is rendered on top
- Preview and OBS will use the **same PNG URL**, so they cannot drift visually

## Local validation

```bash
npm install
npm test
```

After Vercel import, send the production URL back to ChatGPT. The next step is wiring Cloudflare Broadcast Control to this renderer and replacing the current HTML/CSS card with a single PNG in both Preview and Overlay.
