'use strict';

// PC 받기: 휴대폰 업무 사진 앱에서 "회사 PC로 보내기"한 사진을 고른 폴더 안의 목적별 폴더에 저장해요.
const $ = id => document.getElementById(id);
const BOX_KEY = 'work-photos-pcbox-v1';
const NAME_KEY = 'work-photos-pcname-v1';
const LOG_KEY = 'work-photos-pclog-v1';

let root = null;        // 저장할 폴더
let listener = null;    // 중계 저장소 지켜보기
let received = 0;

function status(text, kind = '') { $('pc-status').textContent = text; $('pc-status').className = `pc-status ${kind}`; }
const safeName = text => String(text || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim() || '목적 없음';
const pad = n => String(n).padStart(2, '0');
const clock = value => { const d = new Date(value); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* ---------- 폴더 기억하기 (브라우저 보관함에 폴더 손잡이를 저장) ---------- */
function db() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('work-photos-pc', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function kv(key, value) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const t = database.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const request = value === undefined ? t.objectStore('kv').get(key) : t.objectStore('kv').put(value, key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

/* ---------- 연결 코드와 QR ---------- */
function box() {
  let value = localStorage.getItem(BOX_KEY);
  if (!value) { value = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, ''); localStorage.setItem(BOX_KEY, value); }
  return value;
}
function pairUrl() {
  const url = new URL('./', location.href);
  url.searchParams.set('pair', box());
  url.searchParams.set('pc', $('pc-name').value.trim() || '회사 PC');
  return url.href;
}
function drawQr() {
  $('qr').replaceChildren();
  if (window.QRCode) new QRCode($('qr'), { text:pairUrl(), width:180, height:180, correctLevel:QRCode.CorrectLevel.M });
  else $('qr').textContent = 'QR을 불러오지 못했어요. “연결 주소 복사”를 눌러 휴대폰으로 보내 주세요.';
}
$('pc-name').value = localStorage.getItem(NAME_KEY) || '회사 PC';
$('pc-name').addEventListener('change', () => { localStorage.setItem(NAME_KEY, $('pc-name').value.trim() || '회사 PC'); drawQr(); });
$('copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(pairUrl()); status('연결 주소를 복사했어요. 카톡 “나와의 채팅” 등으로 휴대폰에 보내서 휴대폰 크롬에서 열어 주세요.', 'ok'); }
  catch { prompt('이 주소를 복사해서 휴대폰에서 열어 주세요.', pairUrl()); }
});
$('new-code').addEventListener('click', () => {
  if (!confirm('연결 코드를 새로 만들면, 지금 연결된 휴대폰은 다시 QR을 찍어야 해요. 새로 만들까요?')) return;
  localStorage.removeItem(BOX_KEY); drawQr(); startListening();
  status('새 연결 코드를 만들었어요. 휴대폰으로 QR을 다시 찍어 주세요.');
});

/* ---------- 저장할 폴더 ---------- */
async function setFolder(handle) {
  root = handle; await kv('dir', handle);
  $('folder-name').textContent = `📁 ${handle.name}  (안에 목적별 폴더가 생겨요)`;
  $('regrant-folder').hidden = true; $('pick-folder').textContent = '다른 폴더 고르기';
  listener?.retry();
  ready();
}
$('pick-folder').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) { status('이 브라우저는 폴더 저장을 지원하지 않아요. PC의 크롬(또는 엣지)에서 열어 주세요.', 'error'); return; }
  try { await setFolder(await showDirectoryPicker({ id:'work-photos', mode:'readwrite', startIn:'desktop' })); }
  catch (error) { if (error.name !== 'AbortError') status('폴더를 고르지 못했어요. 다시 눌러 주세요.', 'error'); }
});
$('regrant-folder').addEventListener('click', async () => {
  const handle = await kv('dir');
  if (handle && await handle.requestPermission({ mode:'readwrite' }) === 'granted') setFolder(handle);
});

async function restoreFolder() {
  const handle = await kv('dir').catch(() => null);
  if (!handle) return;
  $('folder-name').textContent = `📁 ${handle.name}`;
  if (await handle.queryPermission({ mode:'readwrite' }) === 'granted') setFolder(handle);
  else { $('regrant-folder').hidden = false; status('저장 폴더 사용을 다시 허락해 주세요. “폴더 다시 연결”을 누르면 돼요.', 'error'); }
}

// 같은 이름 파일이 있으면: 크기까지 같으면 이미 받은 사진으로 보고 넘어가고, 다르면 (2), (3)을 붙여요.
async function saveFile(folderName, fileName, blob) {
  const folder = await root.getDirectoryHandle(safeName(folderName), { create:true });
  const dot = fileName.lastIndexOf('.'); const base = dot > 0 ? fileName.slice(0, dot) : fileName; const ext = dot > 0 ? fileName.slice(dot) : '.jpg';
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    try {
      const existing = await (await folder.getFileHandle(name)).getFile();
      if (existing.size === blob.size) return name; // 이미 저장된 같은 사진
    } catch {
      const writable = await (await folder.getFileHandle(name, { create:true })).createWritable();
      await writable.write(blob); await writable.close();
      return name;
    }
  }
  throw new Error('같은 이름이 너무 많아요.');
}

/* ---------- 받은 사진 기록 ---------- */
function log(entry) {
  let list = []; try { list = JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { /* 새로 시작 */ }
  list.unshift(entry); list = list.slice(0, 100);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(list)); } catch { /* 기록 저장 실패는 무시 */ }
  renderLog(list);
}
function renderLog(list) {
  if (!list) { try { list = JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { list = []; } }
  $('recv-log').replaceChildren(...list.map(item => {
    const li = document.createElement('li'); if (item.error) li.className = 'err';
    const where = document.createElement('b'); where.textContent = item.folder;
    const time = document.createElement('span'); time.textContent = clock(item.at);
    li.append(where, document.createTextNode(` / ${item.name}`), time); return li;
  }));
  if (!list.length) { const li = document.createElement('li'); li.textContent = '아직 받은 사진이 없어요.'; $('recv-log').append(li); }
}

/* ---------- 지켜보다가 저장하기 ---------- */
function ready() {
  if (!root) status('① 저장할 폴더를 골라 주세요.');
  else if (!listener) status('중계 저장소에 연결하고 있어요…');
  else status(`받을 준비가 됐어요. 이 창을 켜 두면 휴대폰에서 보낸 사진이 “${root.name}” 폴더에 목적별로 저장돼요.`, 'ok');
}

async function startListening() {
  listener?.stop(); listener = null;
  try {
    listener = await Relay.listen(box(), async photo => {
      if (!root) return false; // 폴더를 고르면 다시 저장해요
      try {
        const name = await saveFile(photo.purpose, photo.name, photo.blob);
        received++; $('recv-count').textContent = `이번에 ${received}장`;
        log({ folder:safeName(photo.purpose), name, at:Date.now() });
        status(`저장했어요: ${safeName(photo.purpose)} / ${name}`, 'ok');
        return true;
      } catch (error) {
        if (error.name === 'NotAllowedError') { $('regrant-folder').hidden = false; status('저장 폴더 사용 허락이 풀렸어요. “폴더 다시 연결”을 눌러 주세요.', 'error'); }
        else status(`저장하지 못했어요 (${error.name || error.message}). 폴더를 확인해 주세요.`, 'error');
        return false;
      }
    }, () => status('중계 저장소 연결이 끊겼어요. 인터넷을 확인하고 이 화면을 새로 고쳐 주세요.', 'error'),
    waiting => { if (waiting && !root) status(`휴대폰에서 보낸 사진 ${waiting}장이 기다리고 있어요. 저장할 폴더를 골라 주세요.`, 'error'); });
    ready();
  } catch (error) {
    status(error?.message === 'not-configured'
      ? '아직 중계 저장소(Firebase) 설정이 없어요. 앱 관리자가 config.js를 채워야 해요.'
      : '중계 저장소에 연결하지 못했어요. 인터넷을 확인하고 새로 고쳐 주세요.', 'error');
  }
}

/* ---------- 설치 ---------- */
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
let installPrompt = null;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install-app').hidden = false; });
$('install-app').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('install-app').hidden = true; });

(async () => {
  drawQr(); renderLog();
  await restoreFolder();
  if (!Relay.configured()) { status('아직 중계 저장소(Firebase) 설정이 없어요. 앱 관리자가 config.js를 채우면 사용할 수 있어요.', 'error'); return; }
  await startListening();
})();
