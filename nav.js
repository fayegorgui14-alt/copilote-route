// Copilote Route : navigation (carte OpenStreetMap, recherche d'adresse, itinéraire, guidage vocal en français).
// Les serveurs utilisés sont réglables dans config.js (NAV_*). Par défaut : serveurs publics gratuits, pour les essais.
(function () {
  const C = window.COPILOTE_CONFIG || {};
  const TILES = C.NAV_TILES || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const TILES_ATTR = C.NAV_TILES_ATTR || '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  const GEOCODER = C.NAV_GEOCODER || "https://nominatim.openstreetmap.org/search";
  const ROUTER = C.NAV_ROUTER || "https://router.project-osrm.org/route/v1/driving/";
  const COUNTRY = C.NAV_COUNTRY || "sn";

  const R = 6371000, rad = x => x * Math.PI / 180;
  function hav(a, b) { const dLa = rad(b[0] - a[0]), dLo = rad(b[1] - a[1]); const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
  // distance d'un point à un segment (mètres), en projection locale
  function segDist(p, a, b) {
    const k = Math.cos(rad(p[0])), ax = (a[1] - p[1]) * k, ay = a[0] - p[0], bx = (b[1] - p[1]) * k, by = b[0] - p[0];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy; let t = L ? -(ax * dx + ay * dy) / L : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy; return Math.sqrt(x * x + y * y) * 111320;
  }
  const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1).replace(".", ",") + " km" : (m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)) + " m";
  const sayDist = m => m >= 1000 ? (m >= 1950 ? Math.round(m / 1000) + " kilomètres" : "1 kilomètre") : (m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)) + " mètres";
  const fmtTime = s => { const m = Math.round(s / 60); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0"); };

  // ---------- Recherche d'adresse ----------
  let lastSearch = 0;
  async function search(q, near) {
    const wait = 1100 - (Date.now() - lastSearch); if (wait > 0) await new Promise(r => setTimeout(r, wait)); // 1 requête / seconde
    lastSearch = Date.now();
    const u = new URL(GEOCODER);
    u.searchParams.set("q", q); u.searchParams.set("format", "jsonv2"); u.searchParams.set("limit", "8");
    u.searchParams.set("accept-language", "fr"); u.searchParams.set("addressdetails", "1");
    if (COUNTRY) u.searchParams.set("countrycodes", COUNTRY);
    if (near) { const d = 0.6; u.searchParams.set("viewbox", [near[1] - d, near[0] + d, near[1] + d, near[0] - d].join(",")); }
    const r = await fetch(u.toString(), { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("La recherche ne répond pas (" + r.status + "). Réessayez dans un instant.");
    const js = await r.json();
    return js.map(x => {
      const a = x.address || {};
      const title = x.name || a.road || x.display_name.split(",")[0];
      const sub = [a.road && a.road !== title ? a.road : "", a.suburb || a.neighbourhood || a.quarter || "", a.city || a.town || a.village || a.county || ""].filter(Boolean).join(", ");
      return { title, sub: sub || x.display_name, lat: +x.lat, lng: +x.lon };
    });
  }

  // ---------- Itinéraire ----------
  async function route(from, to) {
    const u = ROUTER + from[1] + "," + from[0] + ";" + to[1] + "," + to[0] + "?overview=full&geometries=geojson&steps=true&alternatives=false";
    const r = await fetch(u);
    if (!r.ok) throw new Error("Le calcul d'itinéraire ne répond pas (" + r.status + ").");
    const js = await r.json();
    if (js.code !== "Ok" || !js.routes || !js.routes.length) throw new Error("Aucun itinéraire trouvé vers cette destination.");
    const rt = js.routes[0];
    const line = rt.geometry.coordinates.map(c => [c[1], c[0]]);
    const steps = [];
    for (const leg of rt.legs) for (const s of leg.steps) steps.push({ type: s.maneuver.type, mod: s.maneuver.modifier || "", exit: s.maneuver.exit, loc: [s.maneuver.location[1], s.maneuver.location[0]], name: s.name || s.ref || "", dist: s.distance });
    // position de chaque manœuvre sur le tracé (pour savoir quand elle est dépassée)
    let k0 = 0;
    for (const st of steps) { let best = 1e9, bi = k0; for (let i = k0; i < line.length; i++) { const d = hav(st.loc, line[i]); if (d < best) { best = d; bi = i; } if (best < 2) break; } st.li = bi; k0 = bi; }
    return { line, steps, distance: rt.distance, duration: rt.duration };
  }

  // ---------- Phrases en français ----------
  const MOD = { "left": "tournez à gauche", "right": "tournez à droite", "slight left": "serrez à gauche", "slight right": "serrez à droite", "sharp left": "tournez franchement à gauche", "sharp right": "tournez franchement à droite", "straight": "continuez tout droit", "uturn": "faites demi-tour" };
  const ARROW = { "left": "⬅", "right": "➡", "slight left": "↖", "slight right": "↗", "sharp left": "↰", "sharp right": "↱", "straight": "⬆", "uturn": "↩" };
  const ORD = ["première", "deuxième", "troisième", "quatrième", "cinquième", "sixième"];
  function phrase(s) {
    const sur = s.name ? " sur " + s.name : "";
    switch (s.type) {
      case "depart": return "Partez" + sur;
      case "arrive": return "Vous êtes arrivé à destination";
      case "roundabout": case "rotary": case "exit roundabout": case "exit rotary":
        return "Au rond-point, prenez la " + (s.exit && s.exit <= 6 ? ORD[s.exit - 1] : "") + " sortie" + sur;
      case "merge": return "Insérez-vous" + sur;
      case "on ramp": return "Prenez la bretelle" + (s.mod.includes("left") ? " à gauche" : s.mod.includes("right") ? " à droite" : "") + sur;
      case "off ramp": return "Prenez la sortie" + (s.mod.includes("left") ? " à gauche" : s.mod.includes("right") ? " à droite" : "") + sur;
      case "fork": return (s.mod.includes("left") ? "À l'embranchement, restez à gauche" : s.mod.includes("right") ? "À l'embranchement, restez à droite" : "À l'embranchement, continuez") + sur;
      case "end of road": return "Au bout de la route, " + (MOD[s.mod] || "continuez") + sur;
      case "continue": case "new name": return (s.mod && s.mod !== "straight" ? MOD[s.mod] : "Continuez tout droit") + sur;
      default: return (MOD[s.mod] || "Continuez") + sur;
    }
  }
  const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  const low = t => t.charAt(0).toLowerCase() + t.slice(1);
  const arrow = s => s.type === "arrive" ? "🏁" : (s.type.includes("roundabout") || s.type.includes("rotary")) ? "⟳" : (ARROW[s.mod] || "⬆");

  // ---------- Guidage ----------
  let state = null; // { dest, rt, step, said:{}, off:0, lastReroute }
  let listeners = [];
  const emit = () => listeners.forEach(f => { try { f(state); } catch (e) {} });

  function nearestOnLine(p, line, from) {
    let best = 1e9, idx = from || 0;
    const end = Math.min(line.length - 1, (from || 0) + 400);
    for (let i = Math.max(0, (from || 0) - 5); i < end; i++) { const d = segDist(p, line[i], line[i + 1]); if (d < best) { best = d; idx = i; } }
    return { d: best, i: idx };
  }

  async function start(dest, from) {
    const rt = await route(from, [dest.lat, dest.lng]);
    state = { dest, rt, step: 1, said: {}, off: 0, lastReroute: 0, lineIdx: 0, remaining: rt.distance, eta: rt.duration, arrived: false };
    emit();
    say(cap(phrase(rt.steps[0])) + ". Destination à " + sayDist(rt.distance) + ".");
    return state;
  }
  function stop() { state = null; emit(); }

  let sayFn = t => {};
  function say(t) { try { sayFn(t); } catch (e) {} }

  let busy = false;
  async function update(pos, speedMs) {
    if (!state || state.arrived || !pos || busy) return;
    busy = true;
    try { await doUpdate(pos, speedMs); } finally { busy = false; }
  }
  async function doUpdate(pos, speedMs) {
    const p = [pos.lat, pos.lng], rt = state.rt;
    // arrivée
    if (hav(p, [state.dest.lat, state.dest.lng]) < 30) { state.arrived = true; say("Vous êtes arrivé à destination."); emit(); return; }
    // hors itinéraire → nouveau calcul
    const n = nearestOnLine(p, rt.line, state.lineIdx);
    if (n.d > 45 && (pos.acc || 0) < 40) state.off++; else { state.off = 0; state.lineIdx = n.i; }
    if (state.off >= 3 && Date.now() - state.lastReroute > 20000) {
      state.lastReroute = Date.now(); state.off = 0; say("Nouvel itinéraire.");
      try { const nr = await route(p, [state.dest.lat, state.dest.lng]); state.rt = nr; state.step = 1; state.said = {}; state.lineIdx = 0; } catch (e) {}
      emit(); return;
    }
    // étape suivante
    let s = state.rt.steps[state.step];
    // au moment de la manœuvre : on l'annonce avant de passer à la suivante
    if (s && s.type !== "arrive" && hav(p, s.loc) < 35 && !state.said[state.step + "c"]) {
      state.said[state.step + "c"] = state.said[state.step + "a"] = state.said[state.step + "b"] = 1; say(cap(phrase(s)) + ".");
    }
    // manœuvre atteinte (moins de 30 m) ou déjà dépassée sur le tracé → étape suivante
    while (s && state.step < state.rt.steps.length - 1 && (hav(p, s.loc) < 30 || state.lineIdx >= s.li)) { state.step++; s = state.rt.steps[state.step]; }
    if (!s) return;
    const d = hav(p, s.loc);
    // distance restante approximative
    let rem = d; for (let i = state.step; i < state.rt.steps.length; i++) rem += state.rt.steps[i].dist;
    state.remaining = rem; state.eta = rem / Math.max(5, speedMs || 8);
    state.next = { s, d, text: cap(phrase(s)), arrow: arrow(s) };
    // annonces : à l'avance (selon la vitesse), à 100 m, puis au moment de tourner
    const v = speedMs || 8, early = Math.max(250, Math.min(800, v * 25));
    const key = state.step;
    if (d <= early && d > 150 && !state.said[key + "a"]) { state.said[key + "a"] = 1; say("Dans " + sayDist(d) + ", " + low(phrase(s)) + "."); }
    else if (d <= 120 && d > 35 && !state.said[key + "b"]) { state.said[key + "b"] = 1; state.said[key + "a"] = 1; say("Dans " + sayDist(d) + ", " + low(phrase(s)) + "."); }
    else if (d <= 35 && !state.said[key + "c"] && s.type !== "arrive") { state.said[key + "c"] = 1; state.said[key + "a"] = state.said[key + "b"] = 1; say(cap(phrase(s)) + "."); }
    emit();
  }

  // ---------- Carte ----------
  function makeMap(el, opts) {
    const map = L.map(el, Object.assign({ zoomControl: false, attributionControl: true }, opts || {}));
    L.tileLayer(TILES, { maxZoom: 19, attribution: TILES_ATTR }).addTo(map);
    return map;
  }

  window.Nav = {
    search, route, start, stop, update, makeMap, fmtDist, fmtTime, phrase, cap, arrow, hav,
    get state() { return state; }, get active() { return !!state && !state.arrived; },
    onChange(f) { listeners.push(f); }, setSay(f) { sayFn = f; }
  };
})();
