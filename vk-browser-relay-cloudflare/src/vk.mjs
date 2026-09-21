import { Buffer } from "node:buffer";

const LOGIN_SELECTORS = [
  'input[name="login"]',
  'input[name="email"]',
  'input[type="password"]',
  'button:has-text("Войти")',
];

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

export async function isAuthenticated(page) {
  for (const selector of LOGIN_SELECTORS) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return false;
  }
  return true;
}

export async function composer(page) {
  return firstVisible(page, [
    '[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="сообщ" i]',
    'textarea[placeholder*="публи" i]',
    '[contenteditable="true"][data-testid*="composer" i]',
    '[contenteditable="true"]',
  ]);
}

async function fillComposer(locator, text) {
  if (!text) return;
  const tag = await locator.evaluate((node) => node.tagName.toLowerCase());
  if (tag === "textarea" || tag === "input") {
    await locator.fill(text);
  } else {
    await locator.click();
    await locator.fill(text).catch(async () => {
      await locator.pressSequentially(text, { delay: 1 });
    });
  }
}

async function mediaPayloads(media) {
  const files = [];
  for (const [index, asset] of (media || []).entries()) {
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`media ${index + 1}: HTTP ${response.status}`);
    const mimeType = asset.mimeType || (asset.type === "video" ? "video/mp4" : "image/jpeg");
    const fallback = asset.type === "video" ? `video-${index + 1}.mp4` : `image-${index + 1}.jpg`;
    const name = String(asset.fileName || fallback).replace(/[\\/:*?"<>|\r\n]+/g, "-").slice(0, 160);
    files.push({
      name: name || fallback,
      mimeType,
      buffer: Buffer.from(await response.arrayBuffer()),
    });
  }
  return files;
}

async function attach(page, media) {
  if (!media?.length) return;
  let input = page.locator('input[type="file"]').first();
  if (!(await input.count())) {
    const button = await firstVisible(page, [
      'button[aria-label*="прикреп" i]',
      'button[title*="прикреп" i]',
      'button:has-text("Фото")',
      'button:has-text("Видео")',
      'button:has-text("Добавить")',
    ]);
    if (!button) throw new Error("VK composer: attachment control not found");
    await button.click();
    await page.waitForTimeout(500);
    input = page.locator('input[type="file"]').first();
  }
  if (!(await input.count())) throw new Error("VK composer: file input not found");
  await input.setInputFiles(await mediaPayloads(media));
  await page.waitForTimeout(Math.min(15_000, 1500 + media.length * 1200));
}

async function publishButton(page) {
  return firstVisible(page, [
    'button:has-text("Опубликовать")',
    'button:has-text("Отправить")',
    'button[aria-label*="опубликов" i]',
    'button[aria-label*="отправ" i]',
    '[role="button"]:has-text("Опубликовать")',
  ]);
}

async function bestPostUrl(page, targetUrl) {
  await page.waitForTimeout(1800);
  const hrefs = await page.locator('a[href]').evaluateAll((nodes) =>
    nodes.map((node) => node.href).filter((href) => /vk\.(?:ru|com)\//i.test(href)),
  ).catch(() => []);
  return hrefs.find((href) => /(?:wall-?\d+_\d+|im\/channels\/)/i.test(href)) || targetUrl;
}

export async function publishVkChannel(page, job) {
  const payload = job.payload || {};
  const targetUrl = String(payload.targetUrl || "");
  if (!/^https:\/\/(?:www\.)?vk\.(?:ru|com)\//i.test(targetUrl)) {
    throw new Error("VK relay target URL is invalid");
  }

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1500);

  if (!(await isAuthenticated(page))) {
    const error = new Error("VK_SESSION_REQUIRED");
    error.retryable = false;
    throw error;
  }

  const editor = await composer(page);
  if (!editor) {
    const error = new Error("VK composer not found; Cloudflare Browser Run may be blocked or selectors need refresh");
    error.diagnostics = `url=${page.url()} title=${await page.title()}`;
    throw error;
  }

  await fillComposer(editor, String(payload.text || ""));
  await attach(page, payload.media || []);

  const button = await publishButton(page);
  if (!button) throw new Error("VK composer: publish button not found");
  if (await button.isDisabled().catch(() => false)) throw new Error("VK composer: publish button is disabled");
  await button.click();

  const externalPostUrl = await bestPostUrl(page, targetUrl);
  return {
    externalPostId: `cloudflare-browser:${job.id}`,
    externalPostUrl,
    diagnostics: `cloudflare_browser_run url=${externalPostUrl}`,
  };
}

export async function diagnostics(page, error) {
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
  return [
    error instanceof Error ? error.message : String(error),
    `url=${page.url()}`,
    `title=${title}`,
    `body=${body.replace(/\s+/g, " ").slice(0, 500)}`,
  ].join(" | ").slice(0, 1000);
}
