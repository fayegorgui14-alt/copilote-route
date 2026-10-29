// Copilote Route : enregistrement vidéo automatique (comme une dashcam).
// Les vidéos restent DANS le téléphone (base IndexedDB du navigateur). Rien n'est envoyé sur internet.
(function () {
  const DB_NAME = "copilote-videos", STORE = "clips";
  const SETTINGS_KEY = "copilote-rec";
  const MIMES = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

  // ---------- Réglages ----------
  function loadSettings() {
    try { return Object.assign({ mode: "dangers", maxMb: 500 }, JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")); }
    catch (e) { return { mode: "dangers", maxMb: 500 }; }
  }
  let settings = loadSettings();
  function saveSettings(s) { settings = Object.assign(settings, s); try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

  // ---------- Base de données locale ----------
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { const s = r.result.createObjectStore(STORE, { keyPath: "id" }); s.createIndex("start", "start"); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => { const t = d.transaction(STORE, mode); const out = fn(t.objectStore(STORE)); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); });
  }
  const putClip = c => tx("readwrite", s => s.put(c));
  const delClip = id => tx("readwrite", s => s.delete(id));
  async function allMeta() {
    const d = await db();
    return new Promise((res, rej) => {
      const out = []; const t = d.transaction(STORE, "readonly"); const c = t.objectStore(STORE).openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { const { blob, ...m } = cur.value; out.push(m); cur.continue(); } else res(out); };
      c.onerror = () => rej(c.error);
    });
  }
  async function getBlob(id) { const d = await db(); return new Promise((res, rej) => { const r = d.transaction(STORE, "readonly").objectStore(STORE).get(id); r.onsuccess = () => res(r.result ? r.result.blob : null); r.onerror = () => rej(r.error); }); }

  // Respecte l'espace maximum : on efface d'abord les plus anciens trajets, puis les plus anciens dangers.
  async function enforceLimit() {
    const max = settings.maxMb * 1024 * 1024;
    let items = await allMeta(); let total = items.reduce((s, x) => s + x.size, 0);
    if (total <= max) return;
    items.sort((a, b) => (a.kind === b.kind ? a.start - b.start : a.kind === "trajet" ? -1 : 1));
    for (const it of items) { if (total <= max) break; await delClip(it.id); total -= it.size; }
  }

  // ---------- Enregistrement par segments ----------
  // Chaque segment est un fichier vidéo complet (lisible seul).
  let stream = null, rec = null, mime = "", chunks = [], segStart = 0, segTimer = null, active = false;
  let lastSeg = null;           // dernier segment terminé (gardé en mémoire, pour avoir les secondes AVANT un danger)
  let dangerPending = null;     // { eventId, object, keepNext }
  let tripEventId = null;
  // Incrustation : date, heure, vitesse et position GPS dessinées sur la vidéo
  let canvas = null, cctx = null, drawTimer = null, srcVideo = null, infoFn = null;
  function two(n) { return String(n).padStart(2, "0"); }
  function drawFrame() {
    if (!srcVideo || !cctx || srcVideo.readyState < 2) return;
    const W = canvas.width, H = canvas.height;
    try { cctx.drawImage(srcVideo, 0, 0, W, H); } catch (e) { return; }
    const d = new Date(), inf = (infoFn && infoFn()) || {};
    const txt = `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
      + (inf.speed != null ? `  ·  ${inf.speed} km/h` : "")
      + (inf.lat != null ? `  ·  ${inf.lat.toFixed(5)}, ${inf.lng.toFixed(5)}` : "  ·  GPS…");
    const fs = Math.max(14, Math.round(H / 26)), pad = Math.round(fs * 0.45);
    cctx.font = `700 ${fs}px system-ui, sans-serif`;
    cctx.fillStyle = "rgba(0,0,0,.55)"; cctx.fillRect(0, H - fs - pad * 2, W, fs + pad * 2);
    cctx.fillStyle = "#fff"; cctx.textBaseline = "middle"; cctx.fillText(txt, pad, H - pad - fs / 2);
    const brand = "Copilote Route"; const bw = cctx.measureText(brand).width;
    if (bw + cctx.measureText(txt).width + pad * 4 < W) { cctx.fillStyle = "#ffb23d"; cctx.fillText(brand, W - bw - pad, H - pad - fs / 2); }
  }
  function overlayStream(camStream) {
    try {
      if (!srcVideo || !HTMLCanvasElement.prototype.captureStream) return camStream;
      const tr = camStream.getVideoTracks()[0], st = tr && tr.getSettings ? tr.getSettings() : {};
      const w = st.width || srcVideo.videoWidth || 1280, h = st.height || srcVideo.videoHeight || 720;
      const scale = Math.min(1, 720 / Math.max(w, h));
      canvas = document.createElement("canvas"); canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      cctx = canvas.getContext("2d"); drawFrame();
      drawTimer = setInterval(drawFrame, 1000 / 10);
      return canvas.captureStream(10);
    } catch (e) { return camStream; }
  }
  const SEG_MS = () => (settings.mode === "trajet" ? 60000 : 12000);

  function pickMime() { for (const m of MIMES) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} } return ""; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function startSegment() {
    if (!active || !stream) return;
    chunks = []; segStart = Date.now();
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : { videoBitsPerSecond: 2500000 }); }
    catch (e) { active = false; onState(); return; }
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => finishSegment(new Blob(chunks, { type: (rec && rec.mimeType) || mime || "video/webm" }), segStart, Date.now());
    rec.start(1000);
    segTimer = setTimeout(() => { try { rec.state !== "inactive" && rec.stop(); } catch (e) {} }, SEG_MS());
  }

  async function saveSeg(seg, eventId, kind, object) {
    if (!seg || !seg.blob.size) return;
    await putClip({ id: uid(), eventId, kind, object: object || "", start: seg.start, end: seg.end, size: seg.blob.size, mime: seg.blob.type, blob: seg.blob });
    await enforceLimit(); onState();
  }

  async function finishSegment(blob, start, end) {
    const seg = { blob, start, end };
    try {
      if (settings.mode === "trajet") {
        await saveSeg(seg, tripEventId, "trajet");
      } else if (dangerPending) {
        // segment pendant lequel le danger a eu lieu (+ le suivant si le danger était en toute fin de segment)
        await saveSeg(seg, dangerPending.eventId, "danger", dangerPending.object);
        if (dangerPending.keepNext) dangerPending.keepNext = false; else dangerPending = null;
      }
    } catch (e) {}
    lastSeg = seg;
    if (active) startSegment();
  }

  // Appelé par l'application quand l'alerte « FREINEZ » se déclenche
  async function markDanger(object) {
    if (!active || settings.mode !== "dangers") return;
    if (dangerPending) return; // déjà en cours d'enregistrement d'un danger
    const eventId = uid();
    const elapsed = Date.now() - segStart;
    dangerPending = { eventId, object, keepNext: elapsed > SEG_MS() - 5000 };
    // on garde aussi les secondes d'AVANT le danger
    if (lastSeg && Date.now() - lastSeg.end < 15000) { try { await saveSeg(lastSeg, eventId, "danger", object); } catch (e) {} }
  }

  function start(mediaStream, opts) {
    stop();
    if (settings.mode === "off" || !window.MediaRecorder || !mediaStream) { onState(); return false; }
    srcVideo = opts && opts.video || null; infoFn = opts && opts.info || null;
    stream = overlayStream(mediaStream); mime = pickMime(); active = true; lastSeg = null; dangerPending = null; tripEventId = uid();
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    startSegment(); onState(); return true;
  }
  function stop() {
    active = false; clearTimeout(segTimer);
    try { rec && rec.state !== "inactive" && rec.stop(); } catch (e) {} // le dernier segment est sauvegardé dans onstop
    rec = null; clearInterval(drawTimer); drawTimer = null;
    // le canvas reste vivant 1 seconde pour finir le dernier morceau
    setTimeout(() => { if (!active) { canvas = null; cctx = null; srcVideo = null; } }, 1500);
    onState();
  }

  // ---------- Liste des vidéos (regroupées par événement) ----------
  async function events() {
    const items = await allMeta(); const map = new Map();
    for (const it of items) {
      const e = map.get(it.eventId) || { eventId: it.eventId, kind: it.kind, object: it.object, start: it.start, end: it.end, size: 0, parts: [] };
      e.start = Math.min(e.start, it.start); e.end = Math.max(e.end, it.end); e.size += it.size; e.parts.push(it);
      if (it.object) e.object = it.object; map.set(it.eventId, e);
    }
    const list = [...map.values()]; list.forEach(e => e.parts.sort((a, b) => a.start - b.start));
    return list.sort((a, b) => b.start - a.start);
  }
  async function deleteEvent(eventId) { const items = await allMeta(); for (const it of items) if (it.eventId === eventId) await delClip(it.id); onState(); }
  async function usage() { const items = await allMeta(); return items.reduce((s, x) => s + x.size, 0); }

  let listeners = [];
  function onState() { listeners.forEach(f => { try { f(); } catch (e) {} }); }

  window.DashRec = {
    get settings() { return settings; }, saveSettings, start, stop, markDanger, events, deleteEvent, getBlob, usage,
    get recording() { return active; }, supported: !!window.MediaRecorder,
    onChange(f) { listeners.push(f); }
  };
})();
