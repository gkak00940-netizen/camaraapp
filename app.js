'use strict';

// 사진은 서버나 갤러리로 자동 전송하지 않고 이 휴대폰의 브라우저 보관함에 목적별로 넣어요.
const DB_NAME = 'work-photos-v1';
const PREF_KEY = 'work-photos-prefs-v1';
const MAX_SHARE = 20;
const MAX_SMS = 10;
const $ = id => document.getElementById(id);

let db;
let purposes = [];
let photos = [];
let current = '';
let stream = null;
let pendingCamera = false;
let cameraRequest = 0;
let busy = false;
let shotsThisSession = 0;
let urls = [];
let largeUrl = '';
let pendingDelete = null;
const selected = new Set();

// 보내기 버튼별 안내. 웹에서는 앱을 직접 지정할 수 없어서, 공유 화면에서 고를 앱을 크게 알려 줘요.
const TARGETS = {
  drive: { hint:'공유 화면에서 “Drive”를 눌러 주세요', withText:false },
  kakao: { hint:'공유 화면에서 “카카오톡”을 눌러 주세요', withText:false },
  email: { hint:'공유 화면에서 “Gmail” 또는 메일 앱을 눌러 주세요', withText:true },
  sms:   { hint:'공유 화면에서 “메시지”를 눌러 주세요', withText:false },
  other: { hint:'공유 화면에서 보낼 앱을 골라 주세요 (퀵 쉐어 등)', withText:false },
};

function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = error ? 'notice error' : 'notice';
}

function sizeLabel(bytes) {
  if (!bytes) return '0KB';
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('ko-KR')}KB` : `${(bytes / 1024 / 1024).toLocaleString('ko-KR', { maximumFractionDigits:1 })}MB`;
}
const pad = n => String(n).padStart(2, '0');
function dateLabel(value) { const d = new Date(value); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fileStamp(value) { const d = new Date(value); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
function safeName(text) { return text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '사진'; }

/* ---------- 보관함 ---------- */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('purposes', { keyPath:'id' });
      database.createObjectStore('photos', { keyPath:'id' }).createIndex('purpose', 'purpose');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => notice('다른 창의 업무 사진을 닫고 다시 열어 주세요.', true);
  });
}
function readAll(name) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(name).objectStore(name).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
// 저장이 끝난 것을 확인한 뒤에만 화면에 반영해요.
function write(names, operation) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(names, 'readwrite');
    operation(transaction);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('저장하지 못했어요.'));
  });
}
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ current })); } catch { /* 설정 저장 실패는 무시해요. */ } }

/* ---------- 화면 ---------- */
const currentPurpose = () => purposes.find(p => p.id === current);
const purposePhotos = id => photos.filter(photo => photo.purpose === id);
const shownPhotos = () => purposePhotos(current).sort((a, b) => b.created - a.created);
const selectedPhotos = () => shownPhotos().filter(photo => selected.has(photo.id));

function controls() {
  const count = selectedPhotos().length;
  $('selection-count').textContent = `선택 ${count}장`;
  // 보내기 버튼은 항상 누를 수 있게 두고, 사진을 안 골랐으면 버튼 바로 밑에 알려 줘요.
  document.querySelectorAll('.share').forEach(button => { button.disabled = busy; });
  $('save-photos').disabled = busy || !count;
  $('delete-selected').disabled = busy || !count;
  $('clear-selection').disabled = busy || !count;
  $('select-batch').disabled = busy || !shownPhotos().length;
  $('capture').disabled = busy || !stream || !$('camera').videoWidth;
  $('viewfinder').disabled = !db || pendingCamera;
  document.querySelectorAll('.photo input').forEach(input => { input.disabled = busy; });
}

/* ---------- 목적 상자: 누르면 저장한 목적 목록이 상자 아래로 펼쳐져요 ---------- */
let listOpen = false;
const normalize = text => text.trim().replace(/\s+/g, ' ');

function listItem(className, content, onPick, onDelete) {
  const item = document.createElement('li'); item.className = `combo-item ${className}`; item.setAttribute('role', 'option');
  const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'pick'; pick.append(...content);
  pick.addEventListener('click', onPick); item.append(pick);
  if (onDelete) {
    const del = document.createElement('button'); del.type = 'button'; del.className = 'del'; del.textContent = '×';
    del.setAttribute('aria-label', '이 목적 지우기'); del.addEventListener('click', onDelete); item.append(del);
  }
  return item;
}
const span = (className, text) => { const s = document.createElement('span'); s.className = className; s.textContent = text; return s; };

function renderList(filter = '') {
  const list = $('purposes'); list.replaceChildren();
  const typed = normalize(filter);
  const shown = [...purposes].sort((a, b) => b.used - a.used).filter(p => !typed || p.name.includes(typed));
  shown.forEach(purpose => {
    const active = purpose.id === current;
    const item = listItem(active ? 'active' : '', [span('check', active ? '✓' : ''), span('name', purpose.name), span('count', `${purposePhotos(purpose.id).length}장`)],
      () => { closeList(); selectPurpose(purpose.id); },
      () => { closeList(); askDeletePurpose(purpose); });
    item.setAttribute('aria-selected', String(active)); list.append(item);
  });
  // 입력한 글자가 목록에 없으면 새 목적으로 추가하는 줄을 맨 아래에 보여 줘요. (비슷한 목적을 먼저 고를 수 있게)
  if (typed && !purposes.some(p => p.name === typed)) {
    list.append(listItem('add', [span('check', '＋'), span('name', `“${typed}” 새 목적으로 추가`)], () => addPurpose(typed)));
  }
  if (!list.children.length) { const empty = document.createElement('li'); empty.className = 'combo-empty'; empty.textContent = '목적을 입력하면 여기에 저장돼요.'; list.append(empty); }
}

function openList() {
  listOpen = true; renderList($('purpose-name').value === (currentPurpose()?.name || '') ? '' : $('purpose-name').value);
  $('purposes').hidden = false; $('purpose-name').closest('.combo').classList.add('open');
  $('purpose-name').setAttribute('aria-expanded', 'true');
}
function closeList() {
  listOpen = false; $('purposes').hidden = true; $('purpose-name').closest('.combo').classList.remove('open');
  $('purpose-name').setAttribute('aria-expanded', 'false');
  $('purpose-name').value = currentPurpose()?.name || ''; $('purpose-name').blur();
}

$('purpose-name').addEventListener('focus', () => { openList(); $('purpose-name').select(); });
$('purpose-name').addEventListener('input', () => { if (!listOpen) openList(); else renderList($('purpose-name').value); });
$('purpose-name').addEventListener('keydown', event => { if (event.key === 'Escape') closeList(); });
$('purpose-toggle').addEventListener('click', () => { if (listOpen) closeList(); else $('purpose-name').focus(); });
// 상자 밖을 누르면 목록을 닫아요.
document.addEventListener('pointerdown', event => { if (listOpen && !event.target.closest('.combo')) closeList(); });

function renderPurposes() {
  if (!listOpen) $('purpose-name').value = currentPurpose()?.name || '';
  else renderList($('purpose-name').value);
  const purpose = currentPurpose();
  $('album-title').textContent = purpose ? `${purpose.name} 사진` : '사진';
  $('cam-purpose').textContent = purpose ? purpose.name : '';
  $('placeholder-text').textContent = purpose ? `눌러서 카메라 켜기 · ${purpose.name}` : '위에서 목적을 추가하면 카메라를 켤 수 있어요';
}

function renderPhotos() {
  urls.forEach(url => URL.revokeObjectURL(url)); urls = [];
  $('photos').replaceChildren();
  const shown = shownPhotos();
  [...selected].forEach(id => { if (!shown.some(photo => photo.id === id)) selected.delete(id); });
  $('album-count').textContent = `${shown.length}장`;
  $('empty').hidden = !!shown.length;
  $('empty').textContent = current ? '이 목적으로 찍은 사진이 없어요.' : '목적을 저장하고 사진을 찍어 보세요.';
  const total = photos.reduce((sum, photo) => sum + photo.blob.size, 0);
  $('storage-info').textContent = photos.length ? `이 휴대폰에 ${photos.length}장, ${sizeLabel(total)} 보관 중 · 보낸 사진은 지워서 공간을 비워 주세요.` : '';
  shown.forEach(photo => {
    const card = document.createElement('article'); card.className = selected.has(photo.id) ? 'photo selected' : 'photo';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'photo-open';
    open.setAttribute('aria-label', `${dateLabel(photo.created)} 사진 크게 보기`);
    const image = document.createElement('img'); const url = URL.createObjectURL(photo.blob); urls.push(url);
    image.src = url; image.alt = ''; image.loading = 'lazy'; open.append(image);
    open.addEventListener('click', () => {
      largeUrl = URL.createObjectURL(photo.blob); $('large-photo').src = largeUrl;
      $('large-caption').textContent = `${currentPurpose()?.name || ''} · ${dateLabel(photo.created)} · ${sizeLabel(photo.blob.size)}`;
      $('photo-dialog').showModal();
    });
    const label = document.createElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(photo.id);
    checkbox.setAttribute('aria-label', `${dateLabel(photo.created)} 사진 선택`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked && selected.size >= MAX_SHARE) { checkbox.checked = false; notice(`한 번에 최대 ${MAX_SHARE}장까지 고를 수 있어요.`, true); return; }
      if (checkbox.checked) selected.add(photo.id); else selected.delete(photo.id);
      card.classList.toggle('selected', checkbox.checked); controls();
    });
    label.append(checkbox);
    const time = document.createElement('p'); time.className = 'photo-time'; time.textContent = dateLabel(photo.created);
    card.append(open, label, time); $('photos').append(card);
  });
  controls();
}

function render() { renderPurposes(); renderPhotos(); }

function selectPurpose(id) {
  if (busy) return;
  current = id; selected.clear(); shotsThisSession = 0; $('shot-count').textContent = '0장';
  savePrefs(); render();
  notice(`“${currentPurpose().name}” 목적으로 찍어요.`);
}

/* ---------- 목적 저장 ---------- */
async function addPurpose(rawName) {
  if (busy || !db) return;
  const name = normalize(rawName);
  if (!name) { closeList(); return; }
  const existing = purposes.find(p => p.name === name);
  if (existing) { closeList(); selectPurpose(existing.id); return; }
  busy = true; controls();
  try {
    const purpose = { id:crypto.randomUUID(), name, created:Date.now(), used:Date.now() };
    await write('purposes', t => t.objectStore('purposes').add(purpose));
    purposes.push(purpose); busy = false; closeList(); selectPurpose(purpose.id);
    notice(`“${name}” 목적을 저장했어요. 아래 검은 칸을 누르면 카메라가 켜져요.`);
  } catch { busy = false; closeList(); notice('목적을 저장하지 못했어요. 저장 공간을 확인해 주세요.', true); controls(); }
}

// 입력하고 완료(엔터)를 누르면: 목록에 있으면 고르고, 없으면 새로 추가해요.
$('purpose-form').addEventListener('submit', event => {
  event.preventDefault();
  const typed = $('purpose-name').value;
  if (normalize(typed) === (currentPurpose()?.name || '')) { closeList(); return; }
  addPurpose(typed);
});

function askDeletePurpose(purpose) {
  if (busy) return;
  const count = purposePhotos(purpose.id).length;
  pendingDelete = { type:'purpose', purpose };
  $('delete-title').textContent = `“${purpose.name}” 목적을 지울까요?`;
  $('delete-description').textContent = count ? `이 목적의 사진 ${count}장도 함께 이 휴대폰에서 지워져요.` : '이 목적에는 사진이 없어요.';
  $('delete-dialog').showModal();
}

/* ---------- 카메라: 폰 화면 전체로 열고, 화면이나 둥근 버튼을 누르면 찍혀요 ---------- */
let toastTimer = 0;
function camToast(text, error = false) {
  clearTimeout(toastTimer);
  $('cam-toast').textContent = text; $('cam-toast').className = error ? 'cam-toast error' : 'cam-toast'; $('cam-toast').hidden = false;
  toastTimer = setTimeout(() => { $('cam-toast').hidden = true; }, error ? 4000 : 1200);
}

let lastShotUrl = '';
function stopCamera() {
  cameraRequest++; pendingCamera = false;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  $('camera').srcObject = null;
  if ($('camera-screen').hidden) { controls(); return; }
  $('camera-screen').hidden = true; document.body.style.overflow = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  // 휴대폰 뒤로 가기로 카메라를 닫을 수 있게 넣어 둔 기록을 정리해요.
  if (history.state?.camera) history.back();
  controls();
}

async function startCamera() {
  if (pendingCamera || busy) return;
  if (!current) { notice('먼저 위에 목적을 입력하고 추가를 눌러 주세요.', true); $('purpose-name').focus(); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { notice('이 화면에서는 카메라를 쓸 수 없어요. 휴대폰 크롬에서 앱 주소를 열어 주세요.', true); return; }
  // 누른 순간 바로 전체 화면으로 열어요. (전체 화면 요청은 누른 직후에만 허용돼요)
  $('camera-screen').hidden = false; document.body.style.overflow = 'hidden';
  $('camera-screen').requestFullscreen?.({ navigationUI:'hide' }).catch(() => {});
  if (!history.state?.camera) history.pushState({ camera:true }, '');
  $('cam-purpose').textContent = currentPurpose().name;
  shotsThisSession = 0; $('shot-count').textContent = '0장';
  $('last-shot').hidden = !lastShotUrl;
  const requestId = ++cameraRequest;
  pendingCamera = true; controls();
  try {
    const opened = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ ideal:'environment' }, width:{ ideal:2560 }, height:{ ideal:1920 } } });
    if (requestId !== cameraRequest || document.hidden) { opened.getTracks().forEach(track => track.stop()); return; }
    stream = opened; $('camera').srcObject = stream;
    await $('camera').play();
  } catch (error) {
    stopCamera();
    notice(error.name === 'NotAllowedError' ? '카메라 권한이 필요해요. 크롬 주소창 왼쪽 아이콘 → 권한에서 카메라를 허용해 주세요.' : error.name === 'NotFoundError' ? '카메라를 찾지 못했어요.' : '카메라를 켜지 못했어요. 다른 앱의 카메라를 닫고 다시 눌러 주세요.', true);
  } finally { pendingCamera = false; controls(); }
}

async function capture() {
  if (!stream || busy || !$('camera').videoWidth || !current) return;
  busy = true; controls();
  $('flash').classList.add('on'); requestAnimationFrame(() => requestAnimationFrame(() => $('flash').classList.remove('on')));
  try {
    const video = $('camera'); const maxEdge = 1920;
    const ratio = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(video.videoWidth * ratio); canvas.height = Math.round(video.videoHeight * ratio);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('사진을 만들지 못했어요.');
    const photo = { id:crypto.randomUUID(), purpose:current, created:Date.now(), blob, width:canvas.width, height:canvas.height };
    const purpose = { ...currentPurpose(), used:Date.now() };
    await write(['photos', 'purposes'], t => { t.objectStore('photos').add(photo); t.objectStore('purposes').put(purpose); });
    photos.push(photo); purposes = purposes.map(p => p.id === purpose.id ? purpose : p);
    shotsThisSession++; $('shot-count').textContent = `${shotsThisSession}장`;
    if (lastShotUrl) URL.revokeObjectURL(lastShotUrl);
    lastShotUrl = URL.createObjectURL(blob); $('last-shot').src = lastShotUrl; $('last-shot').hidden = false;
    camToast('저장됨');
    notice(`“${purpose.name}”에 저장했어요. (${sizeLabel(blob.size)})`);
  } catch { camToast('사진을 저장하지 못했어요. 휴대폰 저장 공간을 확인해 주세요.', true); notice('사진을 저장하지 못했어요. 휴대폰 저장 공간을 확인하고 다시 찍어 주세요.', true); }
  finally { busy = false; render(); }
}

$('viewfinder').addEventListener('click', startCamera);
$('capture').addEventListener('click', capture);
$('camera').addEventListener('click', capture);
$('camera').addEventListener('loadeddata', controls);
$('stop-camera').addEventListener('click', () => { stopCamera(); notice(`사진 ${shotsThisSession}장을 찍었어요. 다시 찍으려면 검은 칸을 눌러 주세요.`); });
// 휴대폰 뒤로 가기 또는 전체 화면이 풀리면 카메라를 닫아요.
window.addEventListener('popstate', () => { if (!$('camera-screen').hidden) stopCamera(); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !$('camera-screen').hidden && !pendingCamera) stopCamera(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', stopCamera);

/* ---------- 선택 ---------- */
$('select-batch').addEventListener('click', () => { selected.clear(); shownPhotos().slice(0, 10).forEach(photo => selected.add(photo.id)); renderPhotos(); });
$('clear-selection').addEventListener('click', () => { selected.clear(); renderPhotos(); });

/* ---------- 보내기: 휴대폰 공유 화면을 열고, 고를 앱을 위에 크게 알려 줘요 ---------- */
let hintTimer = 0;
function showHint(text) {
  clearTimeout(hintTimer); $('share-hint').textContent = text; $('share-hint').hidden = false;
  hintTimer = setTimeout(() => { $('share-hint').hidden = true; }, 6000);
}

// 보내기 결과는 버튼 바로 밑에 보여 줘요. (위쪽 안내 칸은 화면 밖이라 안 보여요)
function shareStatus(text, error = false) {
  $('share-status').textContent = text; $('share-status').hidden = false;
  $('share-status').className = error ? 'share-status error' : 'share-status';
  notice(text, error);
}

// 카카오톡·네이버 등 앱 안에서 연 화면은 사진 공유가 안 돼요. 크롬으로 다시 열게 안내해요.
const IN_APP = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\/|DaumApps|; wv\)/i.test(navigator.userAgent);
const IS_ANDROID = /Android/i.test(navigator.userAgent);

function showFallback(reason) {
  $('share-fallback').hidden = false;
  $('open-chrome').hidden = !(IN_APP && IS_ANDROID);
  shareStatus(reason, true);
}

function photoFiles(picked) {
  const name = safeName(currentPurpose()?.name || '업무사진');
  return picked.map((photo, index) => new File([photo.blob], `${name}_${fileStamp(photo.created)}_${index + 1}.jpg`, { type:'image/jpeg', lastModified:photo.created }));
}

$('open-chrome').addEventListener('click', () => {
  const url = location.href.replace(/^https?:\/\//, '').split('#')[0];
  location.href = `intent://${url}#Intent;scheme=https;package=com.android.chrome;end`;
});

// 공유가 안 될 때: 사진을 휴대폰에 저장해서 갤러리에서 보내게 해요.
$('save-photos').addEventListener('click', async () => {
  const picked = selectedPhotos(); if (!picked.length) { shareStatus('먼저 저장할 사진을 체크해 주세요.', true); return; }
  const files = photoFiles(picked);
  for (const file of files) {
    const url = URL.createObjectURL(file); const link = document.createElement('a');
    link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  shareStatus(`사진 ${files.length}장을 휴대폰에 저장했어요. 갤러리나 '내 파일 > 다운로드'에서 보낼 수 있어요.`);
});

document.querySelectorAll('.share').forEach(button => button.addEventListener('click', async () => {
  if (busy) return;
  const target = TARGETS[button.dataset.target];
  const picked = selectedPhotos();
  if (!picked.length) { shareStatus(shownPhotos().length ? '먼저 보낼 사진을 체크해 주세요. (사진 왼쪽 위 네모 칸, 또는 "최근 10장 선택")' : '보낼 사진이 없어요. 먼저 사진을 찍어 주세요.', true); return; }
  if (button.dataset.target === 'sms' && picked.length > MAX_SMS) { shareStatus(`문자는 한 번에 ${MAX_SMS}장까지 보내 주세요. 많으면 드라이브나 카카오톡이 좋아요.`, true); return; }
  const files = photoFiles(picked);
  const name = safeName(currentPurpose()?.name || '업무사진');
  if (!navigator.share) {
    showFallback(IN_APP ? '카카오톡 등 앱 안에서 연 화면이라 보내기가 안 돼요. "크롬으로 열기"를 누르거나, 사진을 휴대폰에 저장해서 보내 주세요.' : '이 브라우저는 보내기를 지원하지 않아요. 휴대폰 크롬에서 열거나, 사진을 휴대폰에 저장해서 보내 주세요.');
    return;
  }
  if (navigator.canShare && !navigator.canShare({ files })) {
    showFallback(picked.length > 1 ? '이 브라우저는 사진 여러 장을 한 번에 보낼 수 없어요. 사진 수를 줄이거나, 휴대폰에 저장해서 보내 주세요.' : '이 브라우저는 사진 보내기를 지원하지 않아요. 크롬에서 열거나, 휴대폰에 저장해서 보내 주세요.');
    return;
  }
  const data = { files };
  // 이메일은 제목과 본문을 함께 넣어요. 카카오톡·문자에는 글을 넣으면 사진이 빠지는 경우가 있어서 사진만 보내요.
  if (target.withText) {
    data.title = `[${name}] 사진 ${picked.length}장`;
    data.text = `${name} 사진 ${picked.length}장\n${picked.map((photo, i) => `${i + 1}. ${dateLabel(photo.created)}`).join('\n')}`;
  }
  busy = true; controls(); showHint(target.hint);
  try {
    await navigator.share(data);
    $('share-fallback').hidden = true;
    shareStatus('보낼 앱으로 사진을 넘겼어요. 받은 것을 확인한 뒤 지워 주세요.');
  } catch (error) {
    if (error.name === 'AbortError') shareStatus('보내기를 취소했어요.');
    else showFallback(`보내지 못했어요 (${error.name}). 사진 수를 줄여 다시 해 보거나, 휴대폰에 저장해서 보내 주세요.`);
  } finally { busy = false; $('share-hint').hidden = true; controls(); }
}));

/* ---------- 삭제 ---------- */
$('delete-selected').addEventListener('click', () => {
  const ids = selectedPhotos().map(photo => photo.id); if (!ids.length) return;
  pendingDelete = { type:'photos', ids };
  $('delete-title').textContent = '사진을 지울까요?';
  $('delete-description').textContent = `선택한 사진 ${ids.length}장을 이 휴대폰에서 지워요.`;
  $('delete-dialog').showModal();
});
$('cancel-delete').addEventListener('click', () => $('delete-dialog').close());
$('delete-dialog').addEventListener('close', () => { if (!busy) pendingDelete = null; });
$('confirm-delete').addEventListener('click', async () => {
  if (busy || !pendingDelete) return;
  const job = pendingDelete; busy = true; controls(); $('confirm-delete').disabled = true; $('cancel-delete').disabled = true;
  try {
    if (job.type === 'photos') {
      await write('photos', t => job.ids.forEach(id => t.objectStore('photos').delete(id)));
      photos = photos.filter(photo => !job.ids.includes(photo.id));
      notice(`사진 ${job.ids.length}장을 지웠어요.`);
    } else {
      const ids = purposePhotos(job.purpose.id).map(photo => photo.id);
      await write(['photos', 'purposes'], t => { ids.forEach(id => t.objectStore('photos').delete(id)); t.objectStore('purposes').delete(job.purpose.id); });
      photos = photos.filter(photo => photo.purpose !== job.purpose.id); purposes = purposes.filter(p => p.id !== job.purpose.id);
      if (current === job.purpose.id) { current = [...purposes].sort((a, b) => b.used - a.used)[0]?.id || ''; savePrefs(); if (!current) stopCamera(); }
      notice(`“${job.purpose.name}” 목적을 지웠어요.`);
    }
    selected.clear();
  } catch { notice('지우지 못했어요. 다시 시도해 주세요.', true); }
  finally { busy = false; pendingDelete = null; $('confirm-delete').disabled = false; $('cancel-delete').disabled = false; $('delete-dialog').close(); render(); }
});
$('close-photo').addEventListener('click', () => $('photo-dialog').close());
$('photo-dialog').addEventListener('close', () => { $('large-photo').removeAttribute('src'); if (largeUrl) URL.revokeObjectURL(largeUrl); largeUrl = ''; });

/* ---------- 시작 ---------- */
async function initialize() {
  controls();
  try {
    db = await openDatabase();
    db.onversionchange = () => { db.close(); notice('보관함이 바뀌었어요. 화면을 새로 고쳐 주세요.', true); };
    [purposes, photos] = await Promise.all([readAll('purposes'), readAll('photos')]);
    try { const prefs = JSON.parse(localStorage.getItem(PREF_KEY)); if (purposes.some(p => p.id === prefs?.current)) current = prefs.current; } catch { /* 설정이 없어도 괜찮아요. */ }
    if (!current && purposes.length) current = [...purposes].sort((a, b) => b.used - a.used)[0].id;
    render();
    notice(current ? `“${currentPurpose().name}” 목적이에요. 화면을 누르면 카메라가 켜져요.` : '맨 위에 촬영 목적을 입력하고 저장해 주세요.');
    if (IN_APP) { notice('카카오톡 등 앱 안에서 열었어요. 보내기가 안 될 수 있으니 크롬으로 열어 주세요. (⋮ 메뉴 → 다른 브라우저로 열기)', true); }
  } catch { db = null; controls(); notice('보관함을 열지 못했어요. 일반 크롬 창에서 다시 열어 주세요. 비공개 모드에서는 저장이 안 될 수 있어요.', true); }
}
initialize();

/* ---------- 앱 설치와 오프라인 ---------- */
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* 설치 기능이 없어도 앱은 그대로 써요. */ });
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install-app').hidden = false; });
$('install-app').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null; $('install-app').hidden = true;
  if (outcome === 'accepted') notice('설치하고 있어요. 홈 화면의 “업무 사진” 아이콘으로 열어 주세요.');
});
window.addEventListener('appinstalled', () => { $('install-app').hidden = true; });
