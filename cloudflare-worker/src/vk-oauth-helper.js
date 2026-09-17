const APP_ID = 54776626;
const START_PATH = "/vk-oauth";
const CALLBACK_PATH = "/vk-oauth/callback";

export function handleVkOauthHelper(request, path) {
  if (path !== START_PATH && path !== CALLBACK_PATH) return null;
  if (request.method !== "GET") return new Response("method_not_allowed", { status: 405 });
  const origin = new URL(request.url).origin;
  const redirectUrl = `${origin}${CALLBACK_PATH}`;
  return new Response(page(redirectUrl), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function page(redirectUrl) {
  const redirect = JSON.stringify(redirectUrl);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HOH · VK authorization</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#08090d;color:#f6f7fb;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(620px,100%);background:#11131a;border:1px solid #292d39;border-radius:22px;padding:26px;box-shadow:0 18px 70px #0008}h1{font-size:25px;margin:0 0 10px}p{color:#aeb5c5}.note{font-size:13px;color:#8c94a6;margin-top:18px}.ok{display:none}.token{width:100%;min-height:110px;resize:none;background:#090a0f;color:#d9f8dd;border:1px solid #394053;border-radius:14px;padding:14px;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.token.small{min-height:54px}.field{font-size:12px;font-weight:800;margin:16px 0 6px;color:#c9d0df}.btn{width:100%;margin-top:12px;padding:14px 18px;border:0;border-radius:13px;font-weight:700;cursor:pointer}.copy{background:#fff;color:#111}.status{margin:14px 0;color:#9da6b8}.error{color:#ff8d8d;white-space:pre-wrap}</style>
</head>
<body><main class="card">
<h1>HOH · доступ к архиву VK Video</h1>
<p>Авторизуйся тем VK-аккаунтом, у которого есть доступ к Home of Hockey. Токены остаются только в этом браузере — страница не отправляет их на наш сервер.</p>
<div id="auth"><div id="VkIdSdkOneTap"></div><div class="status" id="status">Загружаю VK ID…</div></div>
<div class="ok" id="ok"><p><b>VK ID авторизация получена.</b> Для постоянной автоматической синхронизации нужны refresh token и device ID.</p><div class="field">Access token</div><textarea class="token" id="token" readonly></textarea><button class="btn copy" id="copy">Скопировать access token</button><div class="field">Refresh token</div><textarea class="token" id="refresh" readonly></textarea><button class="btn copy" id="copyRefresh">Скопировать refresh token</button><div class="field">Device ID</div><textarea class="token small" id="device" readonly></textarea><button class="btn copy" id="copyDevice">Скопировать device ID</button><div class="note">Не отправляй эти значения в чат, почту или Telegram. Refresh token нужен Worker только для автоматического обновления короткоживущего access token.</div></div>
<div class="error" id="error"></div>
</main>
<script>
(function(){
  const status = document.getElementById('status');
  const error = document.getElementById('error');
  const urls = [
    'https://unpkg.com/@vkid/sdk@2.6.8/dist-sdk/umd/index.js',
    'https://cdn.jsdelivr.net/npm/@vkid/sdk@2.6.8/dist-sdk/umd/index.js'
  ];
  let index = 0;

  function loadSdk(){
    if(window.VKIDSDK){ return start(); }
    if(index >= urls.length){
      error.textContent='VK ID SDK не загрузился ни с одного CDN. Проверь блокировщик рекламы/контента и обнови страницу.';
      status.textContent='';
      return;
    }
    const script=document.createElement('script');
    script.src=urls[index++];
    script.async=true;
    script.onload=function(){
      if(window.VKIDSDK) start();
      else loadSdk();
    };
    script.onerror=loadSdk;
    document.head.appendChild(script);
  }

  function start(){
    const VKID = window.VKIDSDK;
    if(!VKID){ return loadSdk(); }
    status.textContent='Ожидаю авторизацию…';
    try{
      VKID.Config.init({
        app:${APP_ID},
        redirectUrl:${redirect},
        responseMode:VKID.ConfigResponseMode.Callback,
        source:VKID.ConfigSource && VKID.ConfigSource.LOWCODE ? VKID.ConfigSource.LOWCODE : undefined,
        scope:'video'
      });
      const oneTap = new VKID.OneTap();
      oneTap.render({container:document.getElementById('VkIdSdkOneTap'),showAlternativeLogin:true})
        .on(VKID.WidgetEvents.ERROR,function(e){error.textContent='Ошибка VK ID: '+JSON.stringify(e);})
        .on(VKID.OneTapInternalEvents.LOGIN_SUCCESS,function(payload){
          status.textContent='Получаю access и refresh token…';
          VKID.Auth.exchangeCode(payload.code,payload.device_id).then(function(data){
            const token = data && data.access_token;
            const refresh = data && data.refresh_token;
            const device = payload.device_id || (data && data.device_id) || '';
            if(!token) throw new Error('VK ID не вернул access_token');
            if(!refresh) throw new Error('VK ID не вернул refresh_token');
            if(!device) throw new Error('VK ID не вернул device_id');
            document.getElementById('auth').style.display='none';
            document.getElementById('ok').style.display='block';
            document.getElementById('token').value=token;
            document.getElementById('refresh').value=refresh;
            document.getElementById('device').value=device;
          }).catch(function(e){error.textContent='Не удалось обменять код на токены: '+(e && e.message ? e.message : JSON.stringify(e));});
        });
    }catch(e){
      error.textContent='Ошибка запуска VK ID: '+(e && e.message ? e.message : String(e));
    }
  }

  function bindCopy(buttonId,valueId){
    document.getElementById(buttonId).onclick=async function(){
      const value=document.getElementById(valueId).value;
      await navigator.clipboard.writeText(value);
      this.textContent='Скопировано';
    };
  }
  bindCopy('copy','token');
  bindCopy('copyRefresh','refresh');
  bindCopy('copyDevice','device');
  loadSdk();
})();
</script></body></html>`;
}
