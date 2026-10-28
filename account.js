// Comptes Copilote Route : numéro de téléphone + code secret à 6 chiffres.
(function () {
  const C = window.COPILOTE_CONFIG;
  const configured = C && C.SUPABASE_URL && C.SUPABASE_URL.startsWith("http");
  const sb = configured ? supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "copilote-auth" }
  }) : null;

  // "77 123 45 67" -> "221771234567"
  function normPhone(raw) {
    let d = String(raw || "").replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.length === 9) d = "221" + d;
    return d;
  }
  function validPhone(p) { return /^\d{11,15}$/.test(p); }
  function emailOf(p) { return p + "@" + C.EMAIL_DOMAIN; }

  function frError(e) {
    const m = (e && (e.message || e.error_description || String(e))) || "";
    if (/Invalid login credentials/i.test(m)) return "Numéro ou code secret incorrect.";
    if (/already registered|already exists/i.test(m)) return "Ce numéro a déjà un compte. Touchez « J'ai déjà un compte ».";
    if (/Password should be at least/i.test(m)) return "Le code secret doit avoir 6 chiffres.";
    if (/fetch|network|Failed to fetch/i.test(m)) return "Pas de connexion internet. Réessayez.";
    if (/rate limit/i.test(m)) return "Trop d'essais. Patientez une minute.";
    return "Une erreur est survenue : " + m;
  }

  const CACHE_KEY = "copilote-access";
  function saveAccess(a) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ...a, checked_at: Date.now() })); } catch (e) {} }
  function cachedAccess() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (e) { return null; } }

  async function signUp(phone, pin, name) {
    const p = normPhone(phone);
    if (!validPhone(p)) throw new Error("Numéro de téléphone invalide.");
    if (!/^\d{6}$/.test(pin)) throw new Error("Le code secret doit avoir exactement 6 chiffres.");
    const { error } = await sb.auth.signUp({ email: emailOf(p), password: pin, options: { data: { phone: p, full_name: (name || "").trim() } } });
    if (error) throw new Error(frError(error));
    const { data } = await sb.auth.getSession();
    if (!data.session) await signIn(p, pin);
  }
  async function signIn(phone, pin) {
    const p = normPhone(phone);
    if (!validPhone(p)) throw new Error("Numéro de téléphone invalide.");
    const { error } = await sb.auth.signInWithPassword({ email: emailOf(p), password: pin });
    if (error) throw new Error(frError(error));
  }
  async function signOut() { try { await sb.auth.signOut(); } catch (e) {} try { localStorage.removeItem(CACHE_KEY); } catch (e) {} }
  async function session() { if (!sb) return null; const { data } = await sb.auth.getSession(); return data.session; }

  // Statut d'accès. Hors ligne : on garde le dernier statut connu jusqu'à sa date de fin.
  async function access() {
    try {
      const { data, error } = await sb.rpc("my_access");
      if (error) throw error;
      saveAccess(data);
      return { ...data, offline: false };
    } catch (e) {
      const c = cachedAccess();
      if (c && (c.status === "trial" || c.status === "active") && c.ends_at && new Date(c.ends_at) > new Date())
        return { ...c, offline: true };
      if (c) return { ...c, status: c.status === "blocked" ? "blocked" : "expired", offline: true };
      throw new Error(frError(e));
    }
  }
  async function declarePayment(method, reference, months) {
    const { error } = await sb.rpc("declare_payment", { p_method: method, p_reference: reference, p_months: months });
    if (error) throw new Error(frError(error));
  }

  async function joinCompany(code) {
    const { data, error } = await sb.rpc("join_company", { p_code: code });
    if (error) throw new Error(/inconnu/i.test(error.message) ? "Code entreprise inconnu. Vérifiez-le auprès de votre responsable." : /maximum/i.test(error.message) ? "Cette entreprise a atteint son nombre maximum de chauffeurs. Contactez votre responsable." : frError(error));
    return data;
  }
  async function leaveCompany() { const { error } = await sb.rpc("leave_company"); if (error) throw new Error(frError(error)); }

  // File d'attente des alertes et trajets : gardée sur le téléphone, envoyée dès qu'il y a internet.
  const QKEY = "copilote-queue";
  function q() { try { return JSON.parse(localStorage.getItem(QKEY) || '{"alerts":[],"trips":[]}'); } catch (e) { return { alerts: [], trips: [] }; } }
  function qSave(v) { try { localStorage.setItem(QKEY, JSON.stringify(v)); } catch (e) {} }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function queueAlert(a) { const v = q(); v.alerts.push({ id: uid(), at: new Date().toISOString(), ...a }); if (v.alerts.length > 2000) v.alerts.splice(0, v.alerts.length - 2000); qSave(v); }
  function queueTrip(t) { const v = q(); const i = v.trips.findIndex(x => x.id === t.id); if (i >= 0) v.trips[i] = t; else v.trips.push(t); qSave(v); }
  let flushing = false;
  async function flush() {
    if (!sb || flushing) return; const s = await session(); if (!s) return;
    const v = q(); if (!v.alerts.length && !v.trips.length) return;
    flushing = true;
    try {
      const { error } = await sb.rpc("log_events", { p_alerts: v.alerts, p_trips: v.trips });
      if (!error) {
        const now = q();
        const sentA = new Set(v.alerts.map(a => a.id));
        now.alerts = now.alerts.filter(a => !sentA.has(a.id));
        // un trajet terminé et envoyé est retiré ; un trajet en cours reste pour être mis à jour
        now.trips = now.trips.filter(t => !(t.done && v.trips.some(x => x.id === t.id && x.end === t.end)));
        qSave(now);
      }
    } catch (e) {}
    flushing = false;
  }

  function daysLeft(iso) { return Math.max(0, Math.ceil((new Date(iso) - new Date()) / 86400000)); }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "—"; }
  function fmtPhone(p) { p = String(p || ""); return p.startsWith("221") && p.length === 12 ? "+221 " + p.slice(3, 5) + " " + p.slice(5, 8) + " " + p.slice(8, 10) + " " + p.slice(10) : "+" + p; }
  function fcfa(n) { return Number(n || 0).toLocaleString("fr-FR").replace(/ | /g, " ") + " FCFA"; }

  window.Account = { sb, configured, normPhone, signUp, signIn, signOut, session, access, declarePayment, joinCompany, leaveCompany, queueAlert, queueTrip, flush, uid, daysLeft, fmtDate, fmtPhone, fcfa, frError };
})();
