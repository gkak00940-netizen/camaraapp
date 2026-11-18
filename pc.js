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
  ready(); renderAlbum();
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

// 같은 이름 파일이 있으면: 크기까지 같으면 이미 받은 사진으로 보고 넘어가고(isNew:false), 다르면 (2), (3)을 붙여요.
async function saveFile(folderName, fileName, blob) {
  const folder = await root.getDirectoryHandle(safeName(folderName), { create:true });
  const dot = fileName.lastIndexOf('.'); const base = dot > 0 ? fileName.slice(0, dot) : fileName; const ext = dot > 0 ? fileName.slice(dot) : '.jpg';
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    try {
      const existing = await (await folder.getFileHandle(name)).getFile();
      if (existing.size === blob.size) return { name, isNew:false }; // 이미 저장된 같은 사진
    } catch {
      const writable = await (await folder.getFileHandle(name, { create:true })).createWritable();
      await writable.write(blob); await writable.close();
      return { name, isNew:true };
    }
  }
  throw new Error('같은 이름이 너무 많아요.');
}

/* ---------- 받은 사진 보기: 저장 폴더 안을 휴대폰처럼 목적별 폴더로 ---------- */
const MEDIA = /\.(jpe?g|png|webp|gif|mp4|webm|mov)$/i;
const VIDEO = /\.(mp4|webm|mov)$/i;
const COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8e7dbe', '#4895ef', '#f4a261', '#43aa8b', '#d16ba5'];
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const openFolders = new Set();
let galleryUrls = [];
let galleryTimer = 0;
let viewerUrl = '';

// 파일 이름 속 날짜(예: _20261118_073259)로 찍은 시각을 알아내요. 없으면 파일이 저장된 시각.
function shotTime(file) {
  const m = file.name.match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : file.lastModified;
}
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function dayLabel(t) {
  const d = new Date(t); const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0); const diff = Math.round((today - that) / 86400000);
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
  return diff === 0 ? `오늘 · ${base}` : diff === 1 ? `어제 · ${base}` : diff < 7 ? `${diff}일 전 · ${base}` : base;
}
const shortDay = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
const timeOf = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function countLabel(list) {
  const v = list.filter(f => f.video).length, p = list.length - v;
  return v ? (p ? `사진 ${p} · 영상 ${v}` : `영상 ${v}개`) : `${p}장`;
}
const sizeLabel = b => b < 1048576 ? `${Math.max(1, Math.round(b / 1024))}KB` : `${(b / 1048576).toFixed(1)}MB`;
function el(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text != null) e.textContent = text; return e; }
function urlOf(file) { const url = URL.createObjectURL(file); galleryUrls.push(url); return url; }

async function readAlbum() {
  const folders = [];
  for await (const [name, handle] of root.entries()) {
    if (handle.kind !== 'directory') continue;
    const files = [];
    for await (const [fileName, fileHandle] of handle.entries()) {
      if (fileHandle.kind !== 'file' || !MEDIA.test(fileName)) continue;
      const file = await fileHandle.getFile();
      files.push({ name:fileName, file, video:VIDEO.test(fileName), at:shotTime(file) });
    }
    files.sort((a, b) => b.at - a.at);
    folders.push({ name, files });
  }
  // 색은 이름 순서로 정해서 늘 같게, 보여 주는 순서는 최근에 받은 목적부터
  [...folders].sort((a, b) => a.name.localeCompare(b.name, 'ko')).forEach((f, i) => { f.color = COLORS[i % COLORS.length]; });
  return folders.sort((a, b) => (b.files[0]?.at || 0) - (a.files[0]?.at || 0));
}

function thumb(item, withTime) {
  const card = el('article', 'photo');
  const open = el('button', 'photo-open'); open.type = 'button'; open.setAttribute('aria-label', `${item.name} 크게 보기`);
  if (item.video) {
    const v = el('video'); v.muted = true; v.preload = 'metadata'; v.src = `${urlOf(item.file)}#t=0.3`; open.append(v);
    card.append(open, el('span', 'photo-video', '▶'));
  } else {
    const img = el('img'); img.loading = 'lazy'; img.alt = ''; img.src = urlOf(item.file); open.append(img); card.append(open);
  }
  open.addEventListener('click', () => showViewer(item));
  if (withTime) card.append(el('p', 'photo-time', timeOf(item.at)));
  return card;
}

function showViewer(item) {
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(item.file);
  $('viewer-img').hidden = item.video; $('viewer-video').hidden = !item.video;
  if (item.video) { $('viewer-video').src = viewerUrl; $('viewer-video').play().catch(() => {}); } else $('viewer-img').src = viewerUrl;
  $('viewer-caption').textContent = `${item.folder} / ${item.name} · ${sizeLabel(item.file.size)}`;
  $('viewer').showModal();
}
$('close-viewer').addEventListener('click', () => $('viewer').close());
$('viewer').addEventListener('close', () => { $('viewer-video').pause(); $('viewer-video').removeAttribute('src'); $('viewer-img').removeAttribute('src'); if (viewerUrl) URL.revokeObjectURL(viewerUrl); viewerUrl = ''; });

async function renderAlbum() {
  galleryUrls.forEach(url => URL.revokeObjectURL(url)); galleryUrls = [];
  if (!root) { $('album').replaceChildren(); $('album-empty').hidden = false; $('album-empty').textContent = '저장할 폴더를 고르면 받은 사진이 목적별로 보여요.'; $('recv-count').textContent = ''; return; }
  let folders;
  try { folders = await readAlbum(); }
  catch { $('album-empty').hidden = false; $('album-empty').textContent = '저장 폴더를 읽지 못했어요. “폴더 다시 연결”을 눌러 주세요.'; return; }
  // 목록에서 뺀 것은 이 화면에서만 숨겨요. (저장 폴더의 파일은 그대로) 그 뒤에 새로 받은 사진은 다시 보여요.
  const hidden = hiddenState();
  const totalAll = folders.reduce((n, f) => n + f.files.length, 0);
  folders.forEach(f => {
    const after = Math.max(hidden.all || 0, hidden.folders[f.name] || 0);
    f.files = f.files.filter(item => item.file.lastModified > after);
  });
  const all = folders.flatMap(f => f.files);
  const hiddenCount = totalAll - all.length;
  $('recv-count').textContent = all.length ? `목록 ${countLabel(all)}` : '';
  $('show-hidden').hidden = !hiddenCount;
  $('show-hidden').textContent = `숨긴 것 다시 보기 (${hiddenCount}개)`;
  $('clear-list').hidden = !all.length;
  $('album-empty').hidden = folders.some(f => f.files.length);
  $('album-empty').textContent = hiddenCount
    ? '목록을 비웠어요. 새로 받은 사진만 여기 보여요. (저장 폴더의 파일은 그대로 있어요)'
    : '아직 받은 사진이 없어요. 휴대폰에서 “회사 PC로 보내기”를 눌러 보세요.';
  const frag = document.createDocumentFragment();
  folders.filter(f => f.files.length).forEach(folder => {
    folder.files.forEach(item => { item.folder = folder.name; });
    const isOpen = openFolders.has(folder.name);
    const box = el('section', `folder${isOpen ? ' open' : ''}`); box.style.setProperty('--dot', folder.color);
    const head = el('button', 'folder-head'); head.type = 'button'; head.setAttribute('aria-expanded', String(isOpen));
    const list = folder.files;
    const first = shortDay(list[list.length - 1].at), last = shortDay(list[0].at);
    const rel = dayLabel(list[0].at).includes(' · ') ? ` (${dayLabel(list[0].at).split(' · ')[0]})` : '';
    const days = new Set(list.map(f => dayKey(f.at))).size;
    head.append(el('span', 'folder-name', `📁 ${folder.name}`), el('span', 'folder-count', countLabel(list)),
      el('span', 'folder-meta', `${first === last ? '' : `${first} ~ `}${last}${rel} · ${days}일 · ${root.name}\\${folder.name}`));
    head.addEventListener('click', () => { if (openFolders.has(folder.name)) openFolders.delete(folder.name); else openFolders.add(folder.name); renderAlbum(); });
    // 폴더 머리 오른쪽 "✕ 빼기": 이 목적만 목록에서 빼요. (파일은 그대로)
    const top = el('div', 'folder-top'); top.append(head);
    const hide = el('button', 'folder-edit folder-hide'); hide.type = 'button';
    hide.innerHTML = '<span aria-hidden="true">✕</span><small>빼기</small>';
    hide.setAttribute('aria-label', `${folder.name}을 목록에서 빼기 (파일은 그대로)`);
    hide.title = '목록에서만 빼요. 저장 폴더의 파일은 그대로예요.';
    hide.addEventListener('click', () => { const h = hiddenState(); h.folders[folder.name] = Date.now(); saveHidden(h); openFolders.delete(folder.name); renderAlbum(); });
    top.append(hide);
    box.append(top);
    if (!isOpen) {
      const peek = el('div', 'folder-peek pc-peek');
      list.slice(0, 6).forEach(item => peek.append(thumb(item, false)));
      box.append(peek);
    } else {
      const body = el('div', 'folder-body');
      let group = null, grid = null;
      list.forEach(item => {
        const key = dayKey(item.at);
        if (key !== group) {
          group = key; const n = list.filter(f => dayKey(f.at) === key);
          const h = el('h3', 'day', `${dayLabel(item.at)} `); h.append(el('span', '', countLabel(n)));
          grid = el('div', 'photos'); body.append(h, grid);
        }
        grid.append(thumb(item, false)); // 사진 위에 시각은 표시하지 않아요 (크게 볼 때 위쪽에 나와요)
      });
      box.append(body);
    }
    frag.append(box);
  });
  $('album').replaceChildren(frag);
}
// 여러 장이 연달아 들어올 때는 잠깐 모았다가 한 번에 다시 그려요.
function refreshSoon() { clearTimeout(galleryTimer); galleryTimer = setTimeout(renderAlbum, 700); }
$('refresh-album').addEventListener('click', renderAlbum);

/* ---------- 목록 정리: 목록에서만 숨기기 (파일은 지우지 않아요) ---------- */
const HIDE_KEY = 'work-photos-pclist-hide-v1';
function hiddenState() { try { const h = JSON.parse(localStorage.getItem(HIDE_KEY)); return { all:h?.all || 0, folders:h?.folders || {} }; } catch { return { all:0, folders:{} }; } }
function saveHidden(h) { try { localStorage.setItem(HIDE_KEY, JSON.stringify(h)); } catch { /* 무시 */ } }
$('clear-list').addEventListener('click', () => {
  if (!confirm('받은 사진 목록을 비울까요?\n\n이 화면의 목록에서만 사라지고, 저장 폴더의 파일은 그대로 있어요.\n앞으로 새로 받는 사진은 다시 목록에 보여요.')) return;
  saveHidden({ all:Date.now(), folders:{} }); openFolders.clear(); renderAlbum();
});
$('show-hidden').addEventListener('click', () => { saveHidden({ all:0, folders:{} }); renderAlbum(); });
// 탐색기에서 파일을 옮기거나 지운 뒤 이 창으로 돌아오면 다시 읽어요.
window.addEventListener('focus', () => { if (root) refreshSoon(); });

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
        const { name, isNew } = await saveFile(photo.purpose, photo.name, photo.blob);
        if (isNew) {
          received++; openFolders.add(safeName(photo.purpose));
          status(`저장했어요 (이번에 ${received}개): ${safeName(photo.purpose)} / ${name}`, 'ok');
          refreshSoon();
        }
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
  drawQr(); renderAlbum();
  await restoreFolder();
  if (!Relay.configured()) { status('아직 중계 저장소(Firebase) 설정이 없어요. 앱 관리자가 config.js를 채우면 사용할 수 있어요.', 'error'); return; }
  await startListening();
})();
