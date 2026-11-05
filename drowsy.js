// Copilote Route : surveillance du chauffeur (somnolence) avec la caméra avant du MÊME téléphone.
// Principe : on mesure l'ouverture des yeux (« rapport d'aspect de l'œil ») sur les 68 points du visage.
// Si les yeux restent fermés plus de 1,5 s → alarme forte jusqu'à ce qu'ils se rouvrent.
(function () {
  let faceapi = null, loading = null, video = null, stream = null, timer = null, active = false;
  let hooks = { onState() {}, onAlarm() {}, onAlarmEnd() {} };
  const st = { status: "off", ear: null, open: null, closedSince: 0, alarm: false, lastFace: 0, samples: [] };

  async function load() {
    if (faceapi) return faceapi;
    if (loading) return loading;
    loading = (async () => {
      const m = await import("./lib/face/face-api.esm-nobundle.js");
      await m.nets.tinyFaceDetector.loadFromUri("lib/face/model");
      await m.nets.faceLandmark68TinyNet.loadFromUri("lib/face/model");
      faceapi = m; return m;
    })();
    try { return await loading; } finally { loading = null; }
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function ear(p) { return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * dist(p[0], p[3]) || 1); }

  // Essaie d'ouvrir la caméra avant en plus de la caméra arrière, et vérifie que la route n'est pas coupée.
  async function openFront(roadStream, roadVideo) {
    let s = null;
    try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: "user" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } }, audio: false }); }
    catch (e) { try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 } }, audio: false }); } catch (e2) { return { ok: false, reason: e2.name || "erreur" }; } }
    // Est-ce vraiment une autre caméra ?
    const rt = roadStream && roadStream.getVideoTracks()[0], ft = s.getVideoTracks()[0];
    const same = rt && ft && rt.getSettings && ft.getSettings && rt.getSettings().deviceId && rt.getSettings().deviceId === ft.getSettings().deviceId;
    // La caméra de la route doit continuer d'envoyer des images
    const t0 = roadVideo ? roadVideo.currentTime : 0;
    await new Promise(r => setTimeout(r, 1500));
    const roadAlive = rt && rt.readyState === "live" && !rt.muted && (!roadVideo || roadVideo.currentTime > t0);
    if (same || !roadAlive) { s.getTracks().forEach(t => t.stop()); return { ok: false, reason: same ? "même caméra" : "route coupée", roadKilled: !roadAlive }; }
    return { ok: true, stream: s };
  }

  async function start(roadStream, roadVideo) {
    stop();
    st.status = "starting"; hooks.onState(st);
    try { await load(); } catch (e) { st.status = "error"; st.error = "La détection du visage n'a pas pu se charger."; hooks.onState(st); return { ok: false }; }
    const r = await openFront(roadStream, roadVideo);
    if (!r.ok) { st.status = "unsupported"; st.reason = r.reason; hooks.onState(st); return r; }
    stream = r.stream;
    video = document.createElement("video"); video.muted = true; video.playsInline = true; video.setAttribute("playsinline", "");
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0";
    document.body.appendChild(video); video.srcObject = stream; await video.play().catch(() => {});
    st.samples = []; st.open = null; st.closedSince = 0; st.alarm = false; st.lastFace = 0;
    active = true; st.status = "watching"; hooks.onState(st);
    tick();
    return { ok: true };
  }

  async function tick() {
    if (!active) return;
    const t = performance.now();
    try {
      if (video && video.readyState >= 2) {
        const res = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 })).withFaceLandmarks(true);
        const now = performance.now();
        if (res && res.landmarks) {
          const pts = res.landmarks.positions;
          const e = (ear(pts.slice(36, 42)) + ear(pts.slice(42, 48))) / 2;
          st.ear = e; st.lastFace = now;
          // valeur « yeux ouverts » propre à ce chauffeur (apprise en continu)
          st.samples.push(e); if (st.samples.length > 120) st.samples.shift();
          if (st.samples.length >= 15) { const s = st.samples.slice().sort((a, b) => a - b); st.open = s[Math.floor(s.length * 0.8)]; }
          // yeux considérés fermés sous 72 % de leur ouverture habituelle (un clignement normal dure < 0,4 s)
          const closed = st.open != null && e < st.open * 0.72;
          if (closed) { if (!st.closedSince) { st.closedSince = now; st.closedN = 0; } st.closedN++; st.openN = 0; }
          else { st.openN = (st.openN || 0) + 1; if (st.openN >= 2) { st.closedSince = 0; if (st.alarm) { st.alarm = false; hooks.onAlarmEnd(st); } } }
          if (st.closedSince && now - st.closedSince > 1500 && st.closedN >= 4 && !st.alarm) { st.alarm = true; hooks.onAlarm(st); }
          st.status = st.open == null ? "learning" : "watching";
        } else {
          st.ear = null;
          // visage invisible : on ne déclenche pas d'alarme (le chauffeur regarde peut-être ailleurs)
          if (now - st.lastFace > 2500) { st.status = "noface"; st.closedSince = 0; if (st.alarm) { st.alarm = false; hooks.onAlarmEnd(st); } }
        }
        hooks.onState(st);
      }
    } catch (e) {}
    const spent = performance.now() - t;
    timer = setTimeout(tick, Math.max(120, 300 - spent));
  }

  function stop() {
    active = false; clearTimeout(timer); timer = null;
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (video) { video.srcObject = null; video.remove(); video = null; }
    if (st.alarm) { st.alarm = false; hooks.onAlarmEnd(st); }
    st.status = "off"; hooks.onState(st);
  }

  // Test rapide depuis les réglages : ouvre la caméra arrière puis la caméra avant.
  async function testPhone() {
    let road = null, v = null;
    try {
      road = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      v = document.createElement("video"); v.muted = true; v.playsInline = true; v.srcObject = road; await v.play().catch(() => {});
      await new Promise(r => setTimeout(r, 600));
      const r = await openFront(road, v);
      if (r.ok) r.stream.getTracks().forEach(t => t.stop());
      return r;
    } catch (e) { return { ok: false, reason: e.name || "erreur" }; }
    finally { if (road) road.getTracks().forEach(t => t.stop()); if (v) v.srcObject = null; }
  }

  window.Drowsy = { load, start, stop, testPhone, ear, state: st, setHooks(h) { hooks = Object.assign(hooks, h); }, get active() { return active; } };
})();
