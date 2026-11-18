'use strict';

// 휴대폰 → 회사 PC 중계: 사진을 Firebase(Firestore)에 잠깐 맡기고, PC 받기 앱이 가져가면 바로 지워요.
// 연결 코드(box)는 PC마다 만든 긴 무작위 값이라, 코드를 아는 휴대폰만 그 PC로 보낼 수 있어요.
window.Relay = (() => {
  const VERSION = '10.12.2';
  const CHUNK = 900000; // 한 문서에 넣는 최대 크기(Firestore 한도 1MB 아래). 큰 사진은 나눠서 보내요.
  // PC가 7일 안에 안 받아 가면 중계 저장소에서 자동으로 지워요. (Firebase 콘솔의 TTL 설정이 expireAt을 보고 지워요)
  // 지워져도 휴대폰 원본은 그대로라 다시 보내면 돼요.
  const KEEP_DAYS = 7;
  const KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;
  let withExpiry = true; // 보안 규칙이 아직 expireAt을 모르면 한 번 실패한 뒤 빼고 보내요
  let fs = null;
  let db = null;

  const configured = () => !!(window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId);

  async function connect() {
    if (db) return;
    if (!configured()) throw new Error('not-configured');
    const [app, firestore] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-firestore.js`),
    ]);
    fs = firestore;
    db = fs.getFirestore(app.initializeApp(window.FIREBASE_CONFIG));
  }

  const items = box => fs.collection(db, 'boxes', box, 'items');
  const acks = box => fs.collection(db, 'boxes', box, 'acks'); // PC가 "받았어요"를 남기는 곳
  const expireAt = () => fs.Timestamp.fromMillis(Date.now() + KEEP_MS);
  const timeout = (promise, ms = 30000) => Promise.race([promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

  // 휴대폰: 사진 한 장을 보내요. (purpose: 목적 이름 → PC에서 폴더 이름이 돼요)
  async function send(box, { id, blob, created }, purpose, name, onProgress) {
    await connect();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let part = 0; part < parts; part++) {
      const ref = fs.doc(items(box), `${id}_${part}`);
      const value = { photo:id, part, parts, purpose, name, created, sent:Date.now(),
        data:fs.Bytes.fromUint8Array(bytes.subarray(part * CHUNK, (part + 1) * CHUNK)) };
      // 인터넷이 안 되거나 저장소가 준비되지 않으면 끝없이 기다리지 않고 30초 뒤 실패로 알려요.
      try { await timeout(fs.setDoc(ref, withExpiry ? { ...value, expireAt:expireAt() } : value)); }
      catch (error) {
        if (!withExpiry || error?.code !== 'permission-denied') throw error;
        withExpiry = false; await timeout(fs.setDoc(ref, value));
      }
      onProgress?.(part + 1, parts);
    }
    return parts;
  }

  // 휴대폰: 7일이 지나도 PC가 안 받아 간 사진은 휴대폰이 직접 중계 저장소에서 지워요. (읽지 않고 바로 지워서 비용이 거의 없어요)
  async function forget(box, id, parts) {
    await connect();
    await Promise.all(Array.from({ length:parts || 1 }, (_, part) => fs.deleteDoc(fs.doc(items(box), `${id}_${part}`))));
  }

  // 휴대폰: PC가 "받았어요"를 남기면 onAck([사진 id...])로 알려요. 이 휴대폰 사진이면(true를 돌려주면) 그 표시를 지워요.
  // 같은 PC에 여러 휴대폰이 연결돼 있어도, 다른 사람 사진의 표시는 건드리지 않아요. (그건 7일 뒤 자동으로 지워져요)
  async function watchAcks(box, onAck) {
    await connect();
    return fs.onSnapshot(acks(box), async snapshot => {
      const list = snapshot.docs.map(doc => ({ ref:doc.ref, id:doc.data().photo }));
      if (!list.length) return;
      const mine = await onAck(list.map(item => item.id));
      list.filter(item => mine?.has(item.id)).forEach(item => fs.deleteDoc(item.ref).catch(() => {}));
    }, () => { /* 연결이 끊겨도 다음에 앱을 열 때 다시 확인해요 */ });
  }

  // PC: 들어오는 사진을 지켜보다가 조각이 다 모이면 onPhoto로 넘겨요. 저장이 끝나면 중계 저장소에서 지워요.
  async function listen(box, onPhoto, onError, onWaiting) {
    await connect();
    const working = new Set();
    let last = null;
    function process() {
      if (!last) return;
      const groups = new Map();
      last.docs.forEach(doc => {
        const value = doc.data();
        if (!groups.has(value.photo)) groups.set(value.photo, []);
        groups.get(value.photo).push({ ref:doc.ref, ...value });
      });
      onWaiting?.(groups.size);
      groups.forEach(async (parts, id) => {
        if (working.has(id) || parts.length < parts[0].parts) return;
        working.add(id);
        try {
          parts.sort((a, b) => a.part - b.part);
          const ext = (parts[0].name.match(/\.(\w+)$/)?.[1] || 'jpg').toLowerCase();
          const type = { mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', png:'image/png' }[ext] || 'image/jpeg';
          const blob = new Blob(parts.map(p => p.data.toUint8Array()), { type });
          const saved = await onPhoto({ id, purpose:parts[0].purpose, name:parts[0].name, created:parts[0].created, blob });
          if (saved) {
            // 휴대폰에 "PC가 받았어요"를 알려요. (실패해도 저장은 끝났으니 그대로 지워요)
            await timeout(fs.setDoc(fs.doc(acks(box), id), { photo:id, at:Date.now(), expireAt:expireAt() }), 15000).catch(() => {});
            await Promise.all(parts.map(p => fs.deleteDoc(p.ref)));
          }
        } catch (error) { onError?.(error); }
        finally { working.delete(id); }
      });
    }
    const stop = fs.onSnapshot(items(box), snapshot => { last = snapshot; process(); }, error => onError?.(error));
    return { stop, retry:process };
  }

  return { configured, send, forget, watchAcks, listen, KEEP_DAYS, KEEP_MS };
})();
