const NAME = "case-reader";
const VERSION = 1;

function complete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) {
        db.createObjectStore("docs", { keyPath: "id", autoIncrement: true })
          .createIndex("created", "created");
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function metaGet(key) {
  const db = await openDb();
  return result(db.transaction("meta").objectStore("meta").get(key));
}

export async function metaSet(key, value) {
  const db = await openDb();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(value, key);
  await complete(tx);
}

export async function listDocs() {
  const db = await openDb();
  const rows = await result(db.transaction("docs").objectStore("docs").getAll());
  return rows.sort((a, b) => b.created - a.created);
}

export async function getDoc(id) {
  const db = await openDb();
  return result(db.transaction("docs").objectStore("docs").get(id));
}

export async function saveDoc(doc) {
  const db = await openDb();
  const tx = db.transaction("docs", "readwrite");
  const payload = {
    title: doc.title,
    created: doc.created ?? Date.now() / 1000,
    position: doc.position ?? 0,
    sentences: doc.sentences,
    pages: doc.pages || null,
    file: doc.file || null,
  };
  if (doc.id) payload.id = doc.id;
  const id = await result(tx.objectStore("docs").put(payload));
  await complete(tx);
  return { ...payload, id };
}

export async function deleteDoc(id) {
  const db = await openDb();
  const tx = db.transaction("docs", "readwrite");
  tx.objectStore("docs").delete(id);
  await complete(tx);
}

export async function savePosition(id, sentence) {
  const doc = await getDoc(id);
  if (!doc) return;
  doc.position = sentence;
  await saveDoc(doc);
}
