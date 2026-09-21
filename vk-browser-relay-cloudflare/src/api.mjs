async function request(baseUrl, secret, path, body) {
  const response = await fetch(baseUrl.replace(/\/$/, "") + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status} ${payload.error || "request failed"}`);
  }
  return payload;
}

export function endpoints(env) {
  return [
    {
      key: "gotball",
      baseUrl: env.GOTBALL_BASE_URL,
      secret: env.GOTBALL_RELAY_SECRET,
      channelIds: [env.GOTBALL_CHANNEL_ID],
    },
    {
      key: "bolshe",
      baseUrl: env.BOLSHE_BASE_URL,
      secret: env.BOLSHE_RELAY_SECRET,
      channelIds: [env.BOLSHE_CHANNEL_ID],
    },
  ].filter((item) => item.baseUrl && item.secret && item.channelIds[0]);
}

export function claim(endpoint) {
  return request(endpoint.baseUrl, endpoint.secret, "/vk/browser-relay/claim", {
    workerId: "rngn-cloudflare-browser-run",
  });
}

export function complete(endpoint, body) {
  return request(endpoint.baseUrl, endpoint.secret, "/vk/browser-relay/complete", body);
}

export function fail(endpoint, body) {
  return request(endpoint.baseUrl, endpoint.secret, "/vk/browser-relay/fail", body);
}

export function heartbeat(endpoint, sessionAuthenticated) {
  return request(endpoint.baseUrl, endpoint.secret, "/vk/browser-relay/heartbeat", {
    workerId: "rngn-cloudflare-browser-run",
    channelIds: endpoint.channelIds,
    sessionAuthenticated,
  });
}
