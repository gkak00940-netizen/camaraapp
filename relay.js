'use strict';

// 휴대폰 → 회사 PC 중계: 사진을 Firebase(Firestore)에 잠깐 맡기고, PC 받기 앱이 가져가면 바로 지워요.
// 연결 코드(box)는 PC마다 만든 긴 무작위 값이라, 코드를 아는 휴대폰만 그 PC로 보낼 수 있어요.
window.Relay = (() => {
  const VERSION = '10.12.2';
  const CHUNK = 900000; // 한 문서에 넣는 최대 크기(Firestore 한도 1MB 아래). 큰 사진은 나눠서 보내요.
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

  // 휴대폰: 사진 한 장을 보내요. (purpose: 목적 이름 → PC에서 폴더 이름이 돼요)
  async function send(box, { id, blob, created }, purpose, name, onProgress) {
    await connect();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = Math.max(1, Math.ceil(bytes.length / CHUNK));
    for (let part = 0; part < parts; part++) {
      // 인터넷이 안 되거나 저장소가 준비되지 않으면 끝없이 기다리지 않고 30초 뒤 실패로 알려요.
      await Promise.race([
        fs.setDoc(fs.doc(items(box), `${id}_${part}`), {
          photo:id, part, parts, purpose, name, created, sent:Date.now(),
          data:fs.Bytes.fromUint8Array(bytes.subarray(part * CHUNK, (part + 1) * CHUNK)),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30000)),
      ]);
      onProgress?.(part + 1, parts);
    }
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
          if (saved) await Promise.all(parts.map(p => fs.deleteDoc(p.ref)));
        } catch (error) { onError?.(error); }
        finally { working.delete(id); }
      });
    }
    const stop = fs.onSnapshot(items(box), snapshot => { last = snapshot; process(); }, error => onError?.(error));
    return { stop, retry:process };
  }

  return { configured, send, listen };
})();
