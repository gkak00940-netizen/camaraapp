'use strict';

// 앱 화면 파일을 휴대폰에 저장해 두어 인터넷이 약한 현장에서도 열리게 해요.
// 앱 파일을 고치면 아래 버전 숫자를 올려 주세요. 그래야 휴대폰이 새 파일을 받아요.
const CACHE = 'work-photo-app-v12';
const SHARE_INBOX = 'work-photo-share';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'relay.js', 'manifest.webmanifest',
  'pc.html', 'pc.css', 'pc.js', 'manifest-pc.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('work-photo-app-') && key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// 다른 앱에서 "공유 → 업무 사진"으로 보낸 사진을 잠시 보관했다가 앱 화면에 넘겨요.
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('photos').filter(file => file && typeof file !== 'string');
    const inbox = await caches.open(SHARE_INBOX);
    await Promise.all(files.map((file, index) => inbox.put(
      new Request(new URL(`share-inbox/${Date.now()}-${index}`, self.registration.scope)),
      new Response(file, { headers:{ 'Content-Type':file.type || 'image/jpeg', 'X-Name':encodeURIComponent(file.name || `photo-${index + 1}.jpg`), 'X-Modified':String(file.lastModified || Date.now()) } }))));
  } catch { /* 받지 못하면 앱에서 안내해요. */ }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

// 인터넷이 되면 새 파일을 받고, 안 되면 저장해 둔 파일로 열어요.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method === 'POST' && request.url.startsWith(new URL('share-target', self.registration.scope).href)) { event.respondWith(receiveShare(request)); return; }
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(fetch(request)
    .then(response => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(request, copy)); }
      return response;
    })
    .catch(() => caches.match(request, { ignoreSearch:true }).then(hit => hit || (request.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
