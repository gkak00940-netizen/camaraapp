'use strict';

// 사진은 서버나 갤러리로 자동 전송하지 않고 이 휴대폰의 브라우저 보관함에 목적별로 넣어요.
const DB_NAME = 'work-photos-v1';
const PREF_KEY = 'work-photos-prefs-v1';
const MAX_SHARE = 20;
const MAX_SMS = 10;
// 내보내기 용량 기준 (보내는 곳마다 한도가 달라요)
const SMS_LIMIT = 1 * 1024 * 1024;     // 문자(MMS): 통신사 기준 대략 1MB 안팎 → 사진 몇 장만, 영상은 불가
const EMAIL_LIMIT = 25 * 1024 * 1024;  // 메일 첨부: Gmail 기준 25MB (넘으면 드라이브 링크로 바뀜)
const BIG_SEND = 100 * 1024 * 1024;    // 한 번에 100MB가 넘으면 와이파이에서 보내기를 권해요
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
let view = 'purpose';          // 보관함 보기: 'purpose'(목적별) 또는 'date'(날짜별)
const openFolders = new Set(); // 펼친 목적 폴더
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ current, view })); } catch { /* 설정 저장 실패는 무시해요. */ } }

/* ---------- 화면 ---------- */
const currentPurpose = () => purposes.find(p => p.id === current);
const purposeOf = photo => purposes.find(p => p.id === photo.purpose);
const purposeName = photo => purposeOf(photo)?.name || '목적 없음';
const newestFirst = (a, b) => b.created - a.created;
const purposePhotos = id => photos.filter(photo => photo.purpose === id).sort(newestFirst);
const selectedPhotos = () => photos.filter(photo => selected.has(photo.id)).sort(newestFirst);

const totalSize = list => list.reduce((sum, item) => sum + item.blob.size, 0);

// 고른 사진·영상의 합계 용량과, 그 크기로 어디에 보내기 좋은지 한 줄로 알려 줘요.
function sizeAdvice(list) {
  const note = $('size-note'); if (!note) return;
  if (!list.length) { note.textContent = ''; return; }
  const total = totalSize(list); const hasVideo = list.some(item => item.kind === 'video');
  let text = `합계 ${sizeLabel(total)} · `; let warn = false;
  if (total > BIG_SEND) { text += '아주 커요. 와이파이에서 드라이브나 회사 PC로 보내세요.'; warn = true; }
  else if (total > EMAIL_LIMIT) { text += '메일 첨부(25MB)보다 커요. 드라이브·카톡·회사 PC가 좋아요.'; warn = true; }
  else if (hasVideo) text += '문자로는 영상을 못 보내요. 나머지는 모두 괜찮아요.';
  else if (total > SMS_LIMIT) text += '문자는 화질이 줄 수 있어요. 나머지는 모두 괜찮아요.';
  else text += '어디로든 보낼 수 있어요.';
  note.textContent = text; note.className = warn ? 'size-note warn' : 'size-note';
}

function controls() {
  const count = selectedPhotos().length;
  // 사진을 하나라도 고르면 화면 아래에 보내기·삭제 바가 바로 나와요. (스크롤 안 내려도 돼요)
  const wasHidden = $('action-bar').hidden;
  $('action-bar').hidden = !count;
  document.body.classList.toggle('has-bar', !!count);
  if (!count) { $('share-status').hidden = true; $('share-fallback').hidden = true; }
  else if (wasHidden) { $('share-status').hidden = true; $('share-fallback').hidden = true; }
  const pickedNow = selectedPhotos();
  $('selection-count').textContent = `${countLabel(pickedNow)} 선택`;
  sizeAdvice(pickedNow);
  document.querySelectorAll('.share').forEach(button => { button.disabled = busy; });
  $('save-photos').disabled = busy || !count;
  $('delete-selected').disabled = busy || !count;
  $('clear-selection').disabled = busy;
  $('import-photos').disabled = busy || !db;
  $('send-pc').disabled = busy;
  $('capture').disabled = busy || !stream || !$('camera').videoWidth;
  $('viewfinder').disabled = !db || pendingCamera;
  document.querySelectorAll('.photo input').forEach(input => { input.disabled = busy; });
}

/* ---------- 목적 상자: 누르면 저장한 목적 목록이 상자 아래로 펼쳐져요 ---------- */
let listOpen = false;
const normalize = text => text.trim().replace(/\s+/g, ' ');

function listItem(className, content, onPick, onDelete, onRename) {
  const item = document.createElement('li'); item.className = `combo-item ${className}`; item.setAttribute('role', 'option');
  const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'pick'; pick.append(...content);
  pick.addEventListener('click', onPick); item.append(pick);
  if (onRename) {
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'del edit'; edit.textContent = '✎';
    edit.setAttribute('aria-label', '이 목적 이름 바꾸기'); edit.addEventListener('click', onRename); item.append(edit);
  }
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
    const item = listItem(active ? 'active' : '', [span('check', active ? '✓' : ''), span('name', purpose.name), span('count', countLabel(purposePhotos(purpose.id)))],
      () => { closeList(); selectPurpose(purpose.id); },
      () => { closeList(); askDeletePurpose(purpose); },
      () => { closeList(); askRename(purpose); });
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
  $('cam-purpose').textContent = purpose ? purpose.name : '';
  $('placeholder-text').textContent = purpose ? `눌러서 카메라 켜기 · ${purpose.name}` : '위에서 목적을 추가하면 카메라를 켤 수 있어요';
}

/* ---------- 사진 보관함: 목적별 폴더 / 날짜별 ---------- */
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const dayKey = value => { const d = new Date(value); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const timeLabel = value => { const d = new Date(value); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dayLabel(value) {
  const d = new Date(value); const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`;
  if (diff === 0) return `오늘 · ${base}`;
  if (diff === 1) return `어제 · ${base}`;
  if (diff < 7) return `${diff}일 전 · ${base}`;
  return d.getFullYear() === today.getFullYear() ? base : `${d.getFullYear()}년 ${base}`;
}
// 목적마다 고유한 색. 추가한 순서대로 정해져서 바뀌지 않아요.
const COLORS = ['#e76f51', '#2a9d8f', '#e9c46a', '#8e7dbe', '#4895ef', '#f4a261', '#43aa8b', '#d16ba5'];
function purposeColor(id) {
  const order = [...purposes].sort((a, b) => a.created - b.created).findIndex(p => p.id === id);
  return order < 0 ? '#9aa4b2' : COLORS[order % COLORS.length];
}
function shortDay(value) { const d = new Date(value); return `${d.getMonth() + 1}/${d.getDate()}`; }
// 목록에 보일 그림: 사진은 사진 그대로, 영상은 대표 사진(첫 장면). 대표 사진이 없으면 빈 칸.
function photoUrl(photo) {
  const source = photo.kind === 'video' ? photo.poster : photo.blob;
  if (!source) return '';
  const url = URL.createObjectURL(source); urls.push(url); return url;
}
// "사진 3 · 영상 2" 처럼 세어요. 사진만 있으면 "3장".
function countLabel(list) {
  const v = list.filter(item => item.kind === 'video').length, p = list.length - v;
  return v ? (p ? `사진 ${p} · 영상 ${v}` : `영상 ${v}개`) : `${p}장`;
}

function groupByDay(list) {
  const groups = [];
  list.forEach(photo => { const key = dayKey(photo.created); const last = groups[groups.length - 1]; if (last?.key === key) last.items.push(photo); else groups.push({ key, items:[photo] }); });
  return groups;
}

function toggleSelect(photo, on, card) {
  if (on && selected.size >= MAX_SHARE) { shareStatus(`한 번에 최대 ${MAX_SHARE}장까지 고를 수 있어요.`, true); return false; }
  if (on) selected.add(photo.id); else selected.delete(photo.id);
  card?.classList.toggle('selected', on); controls(); return true;
}

// 사진 한 장: 누르면 크게 보기, 왼쪽 위 네모로 선택. 날짜별 보기에서는 어느 목적인지 이름표를 붙여요.
function photoCard(photo, { tag }) {
  const card = document.createElement('article'); card.className = selected.has(photo.id) ? 'photo selected' : 'photo';
  const open = document.createElement('button'); open.type = 'button'; open.className = 'photo-open';
  const video = photo.kind === 'video';
  open.setAttribute('aria-label', `${purposeName(photo)} ${dateLabel(photo.created)} ${video ? '영상 보기' : '사진 크게 보기'}`);
  const image = document.createElement('img'); const src = photoUrl(photo); if (src) image.src = src; image.alt = ''; image.loading = 'lazy'; open.append(image);
  if (video) { const play = document.createElement('span'); play.className = 'photo-video'; play.textContent = '▶'; card.append(play); }
  open.addEventListener('click', () => {
    largeUrl = URL.createObjectURL(photo.blob);
    $('large-photo').hidden = video; $('large-video').hidden = !video;
    if (video) { $('large-video').src = largeUrl; $('large-video').play().catch(() => {}); } else $('large-photo').src = largeUrl;
    $('large-caption').textContent = `${purposeName(photo)} · ${dayLabel(photo.created).replace(/^.* · /, '')} ${timeLabel(photo.created)}${video ? ` · ${durLabel(photo.duration || 0)}` : ''} · ${sizeLabel(photo.blob.size)}`;
    $('photo-dialog').showModal();
  });
  const label = document.createElement('label');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(photo.id);
  checkbox.setAttribute('aria-label', `${purposeName(photo)} ${dateLabel(photo.created)} 사진 선택`);
  checkbox.addEventListener('change', () => { if (!toggleSelect(photo, checkbox.checked, card)) checkbox.checked = false; });
  label.append(checkbox);
  const time = document.createElement('p'); time.className = 'photo-time';
  // 날짜별 보기: 아래 띠에 목적 이름(색 표시)과 시각을 함께 보여 줘요.
  if (tag) {
    const name = document.createElement('b'); name.className = 'photo-purpose'; name.textContent = purposeName(photo);
    name.style.setProperty('--dot', purposeColor(photo.purpose));
    time.append(name, document.createTextNode(timeLabel(photo.created)));
    card.style.setProperty('--dot', purposeColor(photo.purpose)); card.classList.add('tagged');
  } else time.textContent = timeLabel(photo.created);
  if (video) { const d = document.createElement('span'); d.className = 'photo-dur'; d.textContent = durLabel(photo.duration || 0); time.append(d); }
  card.append(open, label, time);
  if (photo.received) { const r = document.createElement('span'); r.className = 'photo-recv'; r.textContent = '받음'; card.append(r); }
  if (photo.pcSent) { const s = document.createElement('span'); s.className = 'photo-pc'; s.textContent = 'PC✓'; s.title = 'PC로 보냄'; card.append(s); }
  return card;
}

function dayGroups(list, tag) {
  const frag = document.createDocumentFragment();
  groupByDay(list).forEach(group => {
    const head = document.createElement('h3'); head.className = 'day'; head.textContent = dayLabel(group.items[0].created) + ' ';
    const n = document.createElement('span'); n.textContent = countLabel(group.items); head.append(n);
    const grid = document.createElement('div'); grid.className = 'photos';
    group.items.forEach(photo => grid.append(photoCard(photo, { tag })));
    frag.append(head, grid);
  });
  return frag;
}

function button(text, onClick, className = '') { const b = document.createElement('button'); b.type = 'button'; b.className = className; b.textContent = text; b.addEventListener('click', onClick); return b; }

// 목적별: 목적마다 폴더 하나. 이름·장수·처음~마지막 촬영 날짜·미리보기 4장. 누르면 날짜별로 펼쳐져요.
function folderView() {
  const frag = document.createDocumentFragment();
  const withPhotos = purposes.map(p => ({ purpose:p, list:purposePhotos(p.id) }))
    .sort((a, b) => (b.purpose.id === current) - (a.purpose.id === current) || (b.list[0]?.created || b.purpose.created) - (a.list[0]?.created || a.purpose.created));
  const orphans = photos.filter(photo => !purposeOf(photo)).sort(newestFirst);
  if (orphans.length) withPhotos.push({ purpose:{ id:'', name:'목적 없음' }, list:orphans });
  withPhotos.forEach(({ purpose, list }) => {
    const isOpen = openFolders.has(purpose.id);
    const folder = document.createElement('section'); folder.className = `folder${isOpen ? ' open' : ''}${purpose.id === current ? ' current' : ''}`;
    const head = document.createElement('button'); head.type = 'button'; head.className = 'folder-head'; head.setAttribute('aria-expanded', String(isOpen));
    folder.style.setProperty('--dot', purposeColor(purpose.id)); folder.dataset.id = purpose.id;
    const name = document.createElement('span'); name.className = 'folder-name'; name.textContent = purpose.name;
    if (purpose.id === current) { const now = document.createElement('span'); now.className = 'now'; now.textContent = '촬영 중'; name.append(now); }
    const count = document.createElement('span'); count.className = 'folder-count'; count.textContent = countLabel(list);
    const meta = document.createElement('span'); meta.className = 'folder-meta';
    // 예: "11/14 ~ 11/16 (오늘) · 2일 촬영"
    meta.textContent = !list.length ? '아직 사진이 없어요' : (() => {
      const first = shortDay(list[list.length - 1].created), last = shortDay(list[0].created);
      const rel = dayLabel(list[0].created).includes(' · ') ? ` (${dayLabel(list[0].created).split(' · ')[0]})` : '';
      return `${first === last ? '' : `${first} ~ `}${last}${rel} · ${groupByDay(list).length}일 촬영`;
    })();
    head.append(name, count, meta);
    head.addEventListener('click', () => { if (openFolders.has(purpose.id)) openFolders.delete(purpose.id); else openFolders.add(purpose.id); renderPhotos(); });
    // 폴더 머리 오른쪽 ✎: 접혀 있어도 바로 목적 이름을 바꿀 수 있어요.
    const top = document.createElement('div'); top.className = 'folder-top'; top.append(head);
    if (purpose.id) {
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'folder-edit';
      edit.innerHTML = '<span aria-hidden="true">✎</span><small>이름</small>';
      edit.setAttribute('aria-label', `${purpose.name} 목적 이름 바꾸기`);
      edit.addEventListener('click', () => askRename(purposes.find(p => p.id === purpose.id)));
      top.append(edit);
    }
    folder.append(top);
    if (!isOpen && list.length) {
      const peek = document.createElement('div'); peek.className = 'folder-peek';
      list.slice(0, 4).forEach(photo => { const wrap = document.createElement('span'); wrap.className = photo.kind === 'video' ? 'peek' : ''; const img = document.createElement('img'); const src = photoUrl(photo); if (src) img.src = src; img.alt = ''; img.loading = 'lazy'; wrap.append(img); peek.append(wrap); });
      peek.addEventListener('click', () => { openFolders.add(purpose.id); renderPhotos(); });
      folder.append(peek);
    }
    if (isOpen) {
      const body = document.createElement('div'); body.className = 'folder-body';
      const actions = document.createElement('div'); actions.className = 'folder-actions';
      if (list.length) actions.append(button(`이 목적 ${Math.min(list.length, MAX_SHARE)}장 선택`, () => {
        const ids = list.slice(0, MAX_SHARE).map(p => p.id);
        selected.clear(); ids.forEach(id => selected.add(id)); renderPhotos();
        shareStatus(`“${purpose.name}” 사진 ${ids.length}장을 골랐어요. 아래 보내기에서 앱을 누르세요.`);
      }));
      if (purpose.id) actions.append(button('＋ 가져오기', () => pickImport(purpose.id)));
      if (purpose.id && purpose.id !== current) actions.append(button('이 목적으로 찍기', () => selectPurpose(purpose.id), 'accent'));
      if (actions.children.length) body.append(actions);
      if (list.length) body.append(dayGroups(list, false));
      else { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '이 목적으로 찍은 사진이 없어요.'; body.append(p); }
      folder.append(body);
    }
    frag.append(folder);
  });
  return frag;
}

// 날짜별: 모든 사진을 날짜순으로. 사진마다 어느 목적인지 이름표가 붙어요.
function dateView() {
  const wrap = document.createElement('div'); wrap.className = 'date-group';
  wrap.append(dayGroups([...photos].sort(newestFirst), true));
  return wrap;
}

function renderPhotos() {
  urls.forEach(url => URL.revokeObjectURL(url)); urls = [];
  [...selected].forEach(id => { if (!photos.some(photo => photo.id === id)) selected.delete(id); });
  document.querySelectorAll('.view-tab').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.view === view)));
  $('album-count').textContent = `전체 ${countLabel(photos)}`;
  $('empty').hidden = view === 'purpose' ? purposes.length > 0 || photos.length > 0 : photos.length > 0;
  $('empty').textContent = purposes.length ? '아직 찍은 사진이 없어요.' : '맨 위에 목적을 입력하고 사진을 찍어 보세요.';
  $('album').replaceChildren(view === 'purpose' ? folderView() : dateView());
  const total = photos.reduce((sum, photo) => sum + photo.blob.size, 0);
  $('storage-info').textContent = photos.length ? `이 휴대폰에 ${countLabel(photos)}, ${sizeLabel(total)} 보관 중 · 보낸 사진은 지워서 공간을 비워 주세요.` : '';
  controls();
}

document.querySelectorAll('.view-tab').forEach(tab => tab.addEventListener('click', () => { view = tab.dataset.view; savePrefs(); renderPhotos(); }));

function render() { renderPurposes(); renderPhotos(); }

function selectPurpose(id) {
  if (busy) return;
  current = id; shotsThisSession = 0; $('shot-count').textContent = '0장';
  openFolders.add(id);
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
  // 녹화 중에 닫히면(뒤로 가기·전화 등) 그때까지 찍은 영상을 저장해요.
  if (recorder?.state === 'recording') stopRecording();
  audioStream?.getTracks().forEach(track => track.stop()); audioStream = null;
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
  shotsThisSession = 0; videosThisSession = 0; updateShotCount(); setMode(camMode, false);
  $('last-shot').hidden = !lastShotUrl;
  const requestId = ++cameraRequest;
  pendingCamera = true; controls();
  try {
    const opened = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ ideal:'environment' }, width:{ ideal:2560 }, height:{ ideal:1920 } } });
    if (requestId !== cameraRequest || document.hidden) { opened.getTracks().forEach(track => track.stop()); return; }
    stream = opened; $('camera').srcObject = stream;
    await $('camera').play();
    if (camMode === 'video') applyModeConstraints();
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
    shotsThisSession++; updateShotCount();
    if (lastShotUrl) URL.revokeObjectURL(lastShotUrl);
    lastShotUrl = URL.createObjectURL(blob); $('last-shot').src = lastShotUrl; $('last-shot').hidden = false;
    camToast('저장됨');
    notice(`“${purpose.name}”에 저장했어요. (${sizeLabel(blob.size)})`);
  } catch { camToast('사진을 저장하지 못했어요. 휴대폰 저장 공간을 확인해 주세요.', true); notice('사진을 저장하지 못했어요. 휴대폰 저장 공간을 확인하고 다시 찍어 주세요.', true); }
  finally { busy = false; render(); }
}

/* ---------- 동영상: 카메라 화면에서 "동영상"으로 바꾸고 빨간 버튼으로 녹화 시작/멈춤 ---------- */
// 용량 기준: 720p(1280×720) · 영상 약 2.5Mbps + 소리 96kbps → 1분에 약 19MB. 한 번에 최대 5분(약 95MB).
const VIDEO_BPS = 2_500_000;
const AUDIO_BPS = 96_000;
const MAX_RECORD_SEC = 300;
let camMode = 'photo';
let recorder = null;
let audioStream = null;
let recChunks = [];
let recStarted = 0;
let recTimer = 0;
let videosThisSession = 0;

const isVideo = item => item.kind === 'video';
const durLabel = sec => `${Math.floor(sec / 60)}:${pad(Math.round(sec % 60))}`;
function updateShotCount() {
  $('shot-count').textContent = videosThisSession ? `사진 ${shotsThisSession} · 영상 ${videosThisSession}` : `${shotsThisSession}장`;
}

// 휴대폰이 지원하는 녹화 형식 중 PC·카톡에서 잘 열리는 MP4를 먼저 골라요. 안 되면 WebM.
function pickVideoType() {
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(type => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

function applyModeConstraints() {
  const track = stream?.getVideoTracks()[0]; if (!track?.applyConstraints) return;
  const wanted = camMode === 'video'
    ? { facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 }, frameRate:{ ideal:30 } }
    : { facingMode:{ ideal:'environment' }, width:{ ideal:2560 }, height:{ ideal:1920 } };
  track.applyConstraints(wanted).catch(() => { /* 안 되면 지금 화질 그대로 찍어요 */ });
}

function setMode(mode, apply = true) {
  if (recorder) return;
  camMode = mode;
  document.querySelectorAll('.cam-mode').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  $('camera-screen').classList.toggle('video-mode', mode === 'video');
  $('capture').setAttribute('aria-label', mode === 'video' ? '녹화 시작' : '사진 찍기');
  if (apply) { applyModeConstraints(); camToast(mode === 'video' ? '동영상 · 빨간 버튼으로 녹화 시작' : '사진'); }
}
document.querySelectorAll('.cam-mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

async function startRecording() {
  if (!stream || recorder || busy || !current) return;
  if (!window.MediaRecorder) { camToast('이 휴대폰 브라우저는 동영상 녹화를 지원하지 않아요.', true); return; }
  // 소리: 처음 한 번 마이크 허락을 물어봐요. 거절하면 소리 없이 녹화해요.
  if (!audioStream) {
    try { audioStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true } }); }
    catch { audioStream = null; camToast('마이크 허락이 없어 소리 없이 녹화해요.', true); }
  }
  if (!stream) return;
  const type = pickVideoType();
  const mixed = new MediaStream([...stream.getVideoTracks(), ...(audioStream?.getAudioTracks() || [])]);
  try { recorder = new MediaRecorder(mixed, { mimeType:type || undefined, videoBitsPerSecond:VIDEO_BPS, audioBitsPerSecond:AUDIO_BPS }); }
  catch { camToast('녹화를 시작하지 못했어요. 카메라를 껐다 켜 주세요.', true); return; }
  recChunks = []; let bytes = 0;
  const purposeId = current;
  recorder.ondataavailable = event => { if (event.data.size) { recChunks.push(event.data); bytes += event.data.size; $('rec-size').textContent = sizeLabel(bytes); } };
  recorder.onstop = () => saveVideo(recChunks, recorder?.mimeType || type || 'video/webm', (Date.now() - recStarted) / 1000, purposeId);
  recorder.start(1000);
  recStarted = Date.now();
  $('camera-screen').classList.add('recording'); $('rec-timer').hidden = false; $('rec-size').textContent = '';
  $('capture').setAttribute('aria-label', '녹화 멈추기');
  const tick = () => {
    const sec = (Date.now() - recStarted) / 1000;
    $('rec-time').textContent = `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;
    if (sec >= MAX_RECORD_SEC) { stopRecording(); camToast('5분이 넘어 녹화를 멈추고 저장했어요. 이어서 찍으려면 다시 누르세요.'); }
  };
  tick(); recTimer = setInterval(tick, 500);
}

function stopRecording() {
  if (!recorder) return;
  clearInterval(recTimer);
  if (recorder.state !== 'inactive') recorder.stop();
  $('camera-screen').classList.remove('recording'); $('rec-timer').hidden = true;
  $('capture').setAttribute('aria-label', '녹화 시작');
}

// 영상에서 대표 사진(첫 장면)과 길이·크기를 뽑아요. 목록에서 미리보기로 써요.
function videoInfo(blob, fallbackSec = 0) {
  return new Promise(resolve => {
    const v = document.createElement('video'); const url = URL.createObjectURL(blob);
    let done = false;
    const finish = async () => {
      if (done) return; done = true;
      let poster = null;
      try {
        if (v.videoWidth) {
          const ratio = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
          const canvas = document.createElement('canvas'); canvas.width = Math.round(v.videoWidth * ratio); canvas.height = Math.round(v.videoHeight * ratio);
          canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
          poster = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.75));
        }
      } catch { poster = null; }
      const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : fallbackSec;
      resolve({ poster, duration, width:v.videoWidth || 0, height:v.videoHeight || 0 });
      URL.revokeObjectURL(url);
    };
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.addEventListener('loadeddata', () => { try { v.currentTime = Math.min(0.3, (Number.isFinite(v.duration) ? v.duration : 1) / 2); } catch { finish(); } });
    v.addEventListener('seeked', finish);
    v.addEventListener('error', finish);
    setTimeout(finish, 4000);
    v.src = url;
  });
}

async function saveVideo(chunks, type, seconds, purposeId) {
  recorder = null;
  const blob = new Blob(chunks, { type:type.split(';')[0] });
  if (!blob.size) { camToast('영상이 비어 있어서 저장하지 않았어요.', true); return; }
  try {
    const info = await videoInfo(blob, seconds);
    const item = { id:crypto.randomUUID(), kind:'video', purpose:purposeId, created:Date.now() - Math.round(seconds * 1000), blob, mime:blob.type,
      poster:info.poster, duration:info.duration || seconds, width:info.width, height:info.height };
    const purpose = { ...purposes.find(p => p.id === purposeId), used:Date.now() };
    await write(['photos', 'purposes'], t => { t.objectStore('photos').add(item); t.objectStore('purposes').put(purpose); });
    photos.push(item); purposes = purposes.map(p => p.id === purpose.id ? purpose : p);
    navigator.storage?.persist?.().catch(() => {}); // 휴대폰이 공간 부족할 때 앱 자료를 함부로 지우지 않게 부탁해요
    videosThisSession++; updateShotCount();
    if (info.poster) { if (lastShotUrl) URL.revokeObjectURL(lastShotUrl); lastShotUrl = URL.createObjectURL(info.poster); $('last-shot').src = lastShotUrl; $('last-shot').hidden = false; }
    camToast(`영상 저장됨 · ${durLabel(item.duration)} · ${sizeLabel(blob.size)}`);
    notice(`“${purpose.name}”에 영상을 저장했어요. (${durLabel(item.duration)}, ${sizeLabel(blob.size)})`);
  } catch { camToast('영상을 저장하지 못했어요. 휴대폰 저장 공간을 확인해 주세요.', true); notice('영상을 저장하지 못했어요. 휴대폰 저장 공간을 확인해 주세요.', true); }
  finally { render(); }
}

function shutter() {
  if (camMode === 'video') { if (recorder) stopRecording(); else startRecording(); }
  else capture();
}

$('viewfinder').addEventListener('click', startCamera);
$('capture').addEventListener('click', shutter);
// 화면 터치로 찍기는 사진일 때만. (녹화 중 실수로 멈추지 않게)
$('camera').addEventListener('click', () => { if (camMode === 'photo') capture(); });
$('camera').addEventListener('loadeddata', controls);
$('stop-camera').addEventListener('click', () => {
  stopCamera();
  notice(`${videosThisSession ? `사진 ${shotsThisSession}장, 영상 ${videosThisSession}개` : `사진 ${shotsThisSession}장`}을 찍었어요. 다시 찍으려면 검은 칸을 눌러 주세요.`);
});
// 휴대폰 뒤로 가기 또는 전체 화면이 풀리면 카메라를 닫아요.
window.addEventListener('popstate', () => { if (!$('camera-screen').hidden) stopCamera(); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && !$('camera-screen').hidden && !pendingCamera) stopCamera(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', stopCamera);

/* ---------- 회사 PC로 보내기: PC 받기 앱과 연결해 두면 PC에 목적별 폴더로 저장돼요 ---------- */
const PC_KEY = 'work-photos-pc-v1';
function pcLink() { try { return JSON.parse(localStorage.getItem(PC_KEY)) || null; } catch { return null; } }

// PC 받기 화면의 QR을 휴대폰 카메라로 찍으면 "?pair=연결코드"로 이 앱이 열려요. 그 코드를 기억해요.
function receivePairing() {
  const params = new URLSearchParams(location.search);
  const box = params.get('pair');
  if (!box) return;
  history.replaceState(null, '', location.pathname);
  if (!/^[a-f0-9]{32,}$/.test(box)) { notice('연결 코드가 올바르지 않아요. PC 받기 화면의 QR을 다시 찍어 주세요.', true); return; }
  try { localStorage.setItem(PC_KEY, JSON.stringify({ box, name:params.get('pc') || '회사 PC', at:Date.now() })); } catch { /* 저장 못 하면 아래에서 안내 */ }
  notice(`“${params.get('pc') || '회사 PC'}”와 연결했어요. 사진을 고르고 “회사 PC로 보내기”를 누르면 PC에 목적별 폴더로 저장돼요.`);
}

function renderPcButton() {
  const on = window.Relay?.configured();
  $('send-pc').hidden = !on; $('pc-link').hidden = !on;
  const link = pcLink();
  $('send-pc-label').textContent = link ? `${link.name}로 보내기` : '회사 PC로 보내기';
}

$('send-pc').addEventListener('click', async () => {
  if (busy) return;
  const picked = selectedPhotos(); if (!picked.length) return;
  const link = pcLink();
  if (!link) { shareStatus('먼저 회사 PC와 연결해 주세요. PC에서 “PC 받기” 화면을 열고, 화면의 QR을 휴대폰 카메라로 찍으면 연결돼요.', true); return; }
  busy = true; controls();
  let done = 0;
  try {
    for (const photo of picked) {
      shareStatus(`${link.name}로 보내는 중… ${done + 1} / ${picked.length}`);
      await Relay.send(link.box, photo, purposeName(photo), photoFiles([photo])[0].name.replace(/_1(\.\w+)$/, '$1'),
        (part, parts) => { if (parts > 1) shareStatus(`${link.name}로 보내는 중… ${done + 1} / ${picked.length} (${Math.round(part / parts * 100)}%)`); });
      done++;
      const updated = { ...photo, pcSent:Date.now() };
      await write('photos', t => t.objectStore('photos').put(updated));
      photos = photos.map(p => p.id === updated.id ? updated : p);
    }
    renderPhotos();
    // 선택은 그대로 둬서, PC에서 확인한 뒤 바로 아래 "삭제"로 휴대폰 공간을 비울 수 있게 해요.
    shareStatus(`${link.name}로 ${done}개를 보냈어요. PC 받기 앱이 켜져 있으면 바로 목적별 폴더에 저장돼요. (꺼져 있으면 다음에 켤 때 저장돼요)`);
  } catch (error) {
    shareStatus(`${done ? `${done}장은 보냈지만, ` : ''}PC로 보내지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.${error?.message === 'not-configured' ? ' (중계 설정 없음)' : ''}`, true);
  } finally { busy = false; controls(); renderPhotos(); }
});

/* ---------- 목적 이름 바꾸기 (사진은 그대로, 이름만 바뀌어요) ---------- */
let renaming = null;
function askRename(purpose) {
  if (busy || !purpose) return;
  renaming = purpose;
  $('rename-old').textContent = `지금 이름: ${purpose.name} · ${countLabel(purposePhotos(purpose.id))}`;
  $('rename-input').value = purpose.name; $('rename-status').textContent = '';
  $('rename-dialog').showModal(); $('rename-input').select();
}
$('cancel-rename').addEventListener('click', () => $('rename-dialog').close());
$('rename-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !renaming) return;
  const name = normalize($('rename-input').value);
  if (!name) { $('rename-status').textContent = '새 이름을 적어 주세요.'; return; }
  if (name === renaming.name) { $('rename-dialog').close(); return; }
  if (purposes.some(p => p.name === name && p.id !== renaming.id)) { $('rename-status').textContent = '같은 이름의 목적이 이미 있어요. 다른 이름을 적어 주세요.'; return; }
  busy = true;
  try {
    const updated = { ...renaming, name };
    await write('purposes', t => t.objectStore('purposes').put(updated));
    purposes = purposes.map(p => p.id === updated.id ? updated : p);
    $('rename-dialog').close();
    notice(`목적 이름을 “${renaming.name}” → “${name}”(으)로 바꿨어요. 사진은 그대로예요.`);
  } catch { $('rename-status').textContent = '이름을 바꾸지 못했어요. 다시 해 주세요.'; }
  finally { busy = false; render(); }
});

/* ---------- 받은 사진 가져오기: 갤러리·카톡에서 저장한 사진, 다른 앱의 공유 ---------- */
let importFiles = [];
let importTarget = '';
let importUrls = [];

function pickImport(purposeId = '') {
  if (busy || !db) return;
  importTarget = purposeId;
  $('import-input').value = '';
  $('import-input').click();
}
$('import-photos').addEventListener('click', () => pickImport(''));
$('import-input').addEventListener('change', () => {
  const files = [...$('import-input').files];
  if (files.length) openImportDialog(files);
});

function openImportDialog(files) {
  importFiles = files;
  importUrls.forEach(url => URL.revokeObjectURL(url)); importUrls = [];
  $('import-preview').replaceChildren(...files.slice(0, 12).map(file => {
    const isVid = file.type.startsWith('video/');
    const el = document.createElement(isVid ? 'video' : 'img'); const url = URL.createObjectURL(file); importUrls.push(url);
    el.src = url; if (isVid) { el.muted = true; el.preload = 'metadata'; el.className = 'import-vid'; } else el.alt = ''; return el;
  }));
  $('import-title').textContent = `받은 ${files.length}개를 어느 목적에 넣을까요?`;
  const pick = importTarget || current;
  const list = [...purposes].sort((a, b) => b.used - a.used);
  $('import-purposes').replaceChildren(...list.map(purpose => {
    const label = document.createElement('label');
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'import-purpose'; radio.value = purpose.id; radio.checked = purpose.id === pick;
    radio.addEventListener('change', () => { $('import-new-name').value = ''; });
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = purposeColor(purpose.id);
    const n = document.createElement('span'); n.className = 'n'; n.textContent = countLabel(purposePhotos(purpose.id));
    label.append(radio, dot, document.createTextNode(purpose.name), n); return label;
  }));
  $('import-new-name').value = '';
  $('import-status').textContent = list.length ? '' : '먼저 새 목적 이름을 적어 주세요.';
  $('confirm-import').disabled = false; $('cancel-import').disabled = false;
  $('import-dialog').showModal();
  if (!list.length) $('import-new-name').focus();
}
// 새 목적 칸에 적으면 위의 선택은 풀어요.
$('import-new-name').addEventListener('input', () => {
  if ($('import-new-name').value.trim()) document.querySelectorAll('[name="import-purpose"]').forEach(r => { r.checked = false; });
});
$('cancel-import').addEventListener('click', () => $('import-dialog').close());
$('import-dialog').addEventListener('close', () => { importUrls.forEach(url => URL.revokeObjectURL(url)); importUrls = []; $('import-preview').replaceChildren(); });

// 큰 사진은 카메라로 찍은 것과 같은 크기(긴 변 1920)로 줄여서 휴대폰 공간을 아껴요. 사진 방향도 맞춰요.
async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation:'from-image' });
    const ratio = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * ratio); canvas.height = Math.round(bitmap.height * ratio);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (blob) return { blob, width:canvas.width, height:canvas.height };
  } catch { /* 아래에서 원본으로 시도해요. */ }
  if (/^image\/(jpeg|png|webp|gif)$/.test(file.type)) return { blob:file, width:0, height:0 };
  return null;
}

$('confirm-import').addEventListener('click', async () => {
  if (busy) return;
  const newName = normalize($('import-new-name').value);
  let purposeId = document.querySelector('[name="import-purpose"]:checked')?.value || '';
  if (!newName && !purposeId) { $('import-status').textContent = '넣을 목적을 고르거나 새 목적 이름을 적어 주세요.'; return; }
  busy = true; controls(); $('confirm-import').disabled = true; $('cancel-import').disabled = true;
  try {
    if (newName) {
      const existing = purposes.find(p => p.name === newName);
      if (existing) purposeId = existing.id;
      else {
        const purpose = { id:crypto.randomUUID(), name:newName, created:Date.now(), used:Date.now() };
        await write('purposes', t => t.objectStore('purposes').add(purpose)); purposes.push(purpose); purposeId = purpose.id;
      }
    }
    const added = []; let skipped = 0; const received = Date.now();
    for (const [index, file] of importFiles.entries()) {
      $('import-status').textContent = `사진 넣는 중… ${index + 1} / ${importFiles.length}`;
      // 영상은 그대로 넣고 대표 사진만 뽑아요. 사진은 큰 것만 줄여요.
      if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|3gp)$/i.test(file.name)) {
        const info = await videoInfo(file);
        added.push({ id:crypto.randomUUID(), kind:'video', purpose:purposeId, created:file.lastModified || received, received, blob:file, mime:file.type || 'video/mp4',
          poster:info.poster, duration:info.duration, width:info.width, height:info.height });
        continue;
      }
      const image = await shrinkImage(file);
      if (!image) { skipped++; continue; }
      added.push({ id:crypto.randomUUID(), purpose:purposeId, created:file.lastModified || received, received, blob:image.blob, width:image.width, height:image.height });
    }
    const purpose = { ...purposes.find(p => p.id === purposeId), used:Date.now() };
    await write(['photos', 'purposes'], t => { added.forEach(photo => t.objectStore('photos').add(photo)); t.objectStore('purposes').put(purpose); });
    photos.push(...added); purposes = purposes.map(p => p.id === purpose.id ? purpose : p);
    $('import-dialog').close();
    openFolders.add(purposeId); view = 'purpose'; savePrefs();
    notice(`“${purpose.name}”에 받은 ${countLabel(added)}을 넣었어요.${skipped ? ` (${skipped}장은 열 수 없는 형식이라 뺐어요)` : ''}`, !added.length);
    busy = false; render();
    // 넣은 목적 폴더로 화면을 옮겨서 바로 보이게 해요.
    document.querySelector(`.folder[data-id="${purposeId}"]`)?.scrollIntoView({ behavior:'smooth', block:'start' });
  } catch { $('import-status').textContent = '사진을 넣지 못했어요. 휴대폰 저장 공간을 확인하고 다시 해 주세요.'; }
  finally { if (busy) { busy = false; render(); } $('confirm-import').disabled = false; $('cancel-import').disabled = false; }
});

// 다른 앱(카카오톡·갤러리 등)에서 "공유 → 업무 사진"으로 보낸 사진을 받아요. (휴대폰에 앱을 설치한 경우)
async function receiveSharedPhotos() {
  if (!new URLSearchParams(location.search).has('shared')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('work-photo-share');
    const requests = await cache.keys(); const files = [];
    for (const request of requests) {
      const response = await cache.match(request); const blob = await response.blob();
      files.push(new File([blob], decodeURIComponent(response.headers.get('X-Name') || 'photo.jpg'), { type:blob.type || 'image/jpeg', lastModified:Number(response.headers.get('X-Modified')) || Date.now() }));
      await cache.delete(request);
    }
    if (files.length) { importTarget = ''; openImportDialog(files); }
    else notice('공유한 사진을 찾지 못했어요. "받은 사진 가져오기"로 다시 넣어 주세요.', true);
  } catch { notice('공유한 사진을 받지 못했어요. "받은 사진 가져오기"로 넣어 주세요.', true); }
}

/* ---------- 선택 ---------- */
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

// 파일 이름에 사진마다 자기 목적 이름을 붙여요. 받은 쪽(드라이브·PC)에서도 어느 목적 사진인지 바로 보여요.
function fileExt(item) {
  if (item.kind !== 'video') return '.jpg';
  const type = item.blob.type || item.mime || '';
  return type.includes('mp4') ? '.mp4' : type.includes('quicktime') ? '.mov' : '.webm';
}
function photoFiles(picked) {
  return picked.map((photo, index) => new File([photo.blob], `${safeName(purposeName(photo))}_${fileStamp(photo.created)}_${index + 1}${fileExt(photo)}`, { type:photo.blob.type || (photo.kind === 'video' ? 'video/mp4' : 'image/jpeg'), lastModified:photo.created }));
}
function pickedSummary(picked) {
  const names = [...new Set(picked.map(purposeName))];
  return names.length === 1 ? names[0] : `${names[0]} 외 ${names.length - 1}개 목적`;
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
  if (!picked.length) { shareStatus(photos.length ? '먼저 보낼 사진을 체크해 주세요. (사진 왼쪽 위 네모 칸, 또는 목적 폴더를 펼쳐 "이 목적 선택")' : '보낼 사진이 없어요. 먼저 사진을 찍어 주세요.', true); return; }
  if (button.dataset.target === 'sms' && picked.some(isVideo)) { shareStatus('문자(MMS)는 용량 한도가 작아서 동영상을 보낼 수 없어요. 카카오톡·드라이브·회사 PC로 보내 주세요.', true); return; }
  if (button.dataset.target === 'email' && totalSize(picked) > EMAIL_LIMIT) { shareStatus(`합계 ${sizeLabel(totalSize(picked))}라 메일 첨부 한도(약 25MB)를 넘어요. Gmail이면 드라이브 링크로 바뀌어 보내져요. 공유 화면을 열게요.`); }
  if (button.dataset.target === 'sms' && picked.length > MAX_SMS) { shareStatus(`문자는 한 번에 ${MAX_SMS}장까지 보내 주세요. 많으면 드라이브나 카카오톡이 좋아요.`, true); return; }
  const files = photoFiles(picked);
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
    data.title = `[${pickedSummary(picked)}] 사진 ${picked.length}장`;
    data.text = [...new Set(picked.map(purposeName))].map(name => {
      const mine = picked.filter(photo => purposeName(photo) === name);
      return `■ ${name} (${mine.length}장)\n${mine.map(photo => `- ${dayLabel(photo.created).replace(/^.* · /, '')} ${timeLabel(photo.created)}`).join('\n')}`;
    }).join('\n\n');
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
$('photo-dialog').addEventListener('close', () => { $('large-video').pause(); $('large-video').removeAttribute('src'); $('large-video').load(); $('large-photo').removeAttribute('src'); if (largeUrl) URL.revokeObjectURL(largeUrl); largeUrl = ''; });

/* ---------- 시작 ---------- */
async function initialize() {
  controls();
  try {
    db = await openDatabase();
    db.onversionchange = () => { db.close(); notice('보관함이 바뀌었어요. 화면을 새로 고쳐 주세요.', true); };
    [purposes, photos] = await Promise.all([readAll('purposes'), readAll('photos')]);
    try {
      const prefs = JSON.parse(localStorage.getItem(PREF_KEY));
      if (purposes.some(p => p.id === prefs?.current)) current = prefs.current;
      if (prefs?.view === 'date') view = 'date';
    } catch { /* 설정이 없어도 괜찮아요. */ }
    if (!current && purposes.length) current = [...purposes].sort((a, b) => b.used - a.used)[0].id;
    if (current) openFolders.add(current);
    render();
    notice(current ? `“${currentPurpose().name}” 목적이에요. 화면을 누르면 카메라가 켜져요.` : '맨 위에 촬영 목적을 입력하고 저장해 주세요.');
    if (IN_APP) { notice('카카오톡 등 앱 안에서 열었어요. 보내기가 안 될 수 있으니 크롬으로 열어 주세요. (⋮ 메뉴 → 다른 브라우저로 열기)', true); }
    await receiveSharedPhotos();
    receivePairing(); renderPcButton();
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
