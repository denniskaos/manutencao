// =====================================================================
//  Manutenção de Condomínios — aplicação (Supabase + PWA)
// =====================================================================
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const norm = s => String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const hit = (txt, ql) => { const t = norm(txt); return norm(ql).split(/\s+/).filter(Boolean).every(w => t.includes(w)); };
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const nowIso = () => new Date().toISOString();
const addDays = (s, n) => { const [y,m,d] = s.split("-").map(Number); return iso(new Date(y, m-1, d+n)); };
const diffDays = (a, b) => { const p = s => { const [y,m,d] = s.split("-").map(Number); return Date.UTC(y,m-1,d); }; return Math.round((p(a)-p(b))/86400000); };
const fmtDate = s => { if(!s) return "—"; const [y,m,d] = String(s).slice(0,10).split("-"); return `${d}/${m}/${y}`; };
const fmtDT = s => { if(!s) return ""; const d = new Date(s); return `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.remove("show"),2800); }
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

const TIPOS_EQ = ["Elevador","Portão de garagem","Porta de entrada / fechadura","Intercomunicador / videoporteiro","Iluminação de áreas comuns","Quadro elétrico","Hidropressor / bombas de água","Bomba de esgoto / drenagem","Ventilação / desenfumagem da garagem","Extintores / SADI / incêndio","Antena / ITED","Piscina","Jardim / rega","Caldeira / AQS","Outro"];
const PRIOR = {alta:["Alta","b-red","red"], media:["Média","b-amber","amber"], baixa:["Baixa","b-blue","blue"]};
const ESTADOS = {aberta:"Aberta", curso:"Em curso", concluida:"Concluída"};
const TIPOS_OT = {corretiva:"Corretiva / avaria", preventiva:"Preventiva", inspecao:"Inspeção / ronda", pedido:"Pedido de condómino", externa:"Avaria — empresa externa"};
const isExt = o => o && o.tipo === "externa";
const PERIODOS = [[7,"Semanal"],[14,"Quinzenal"],[30,"Mensal"],[90,"Trimestral"],[180,"Semestral"],[365,"Anual"]];

/* ---------- ligação ao Supabase ---------- */
const CFG = window.APP_CONFIG || {};
const configured = /^https:\/\//.test(CFG.SUPABASE_URL || "") && CFG.SUPABASE_ANON_KEY && !/COLE_AQUI/.test(CFG.SUPABASE_ANON_KEY);
const sb = configured ? createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

// Tabelas e colunas (a aplicação usa nomes camelCase; a base de dados snake_case)
const TABLES = { condos: "condominios", equip: "equipamentos", plans: "planos", ots: "ordens", cdm: "condominos" };
const COLS = {
  condominios: ["id","codigo","nome","morada","nif","fracoes","admin","contacto","notas","lat","lon","geoFonte"],
  condominos: ["id","condoId","fracao","nome","telefone","email","notas"],
  equipamentos: ["id","condoId","nome","tipo","local","marca","modelo","serie","empresa","notas"],
  planos: ["id","titulo","condoId","equipId","zona","tecnico","periodo","inicio","ultima","checklist"],
  ordens: ["id","titulo","condoId","equipId","zona","tecnico","tipo","prioridade","estado","data","solicitante","descricao","checklist","pecas","fotos","notas","tempo","planId","criada","criadaEm","criadoPor","deFolha","atribuida","atribuidaEm","atribuidoPor","concluida","concluidaEm","concluidoPor","deslocacoes","soMaterial","empresa","contactada","refExterna","extra","origemStock","dias","falta"],
};
const NULLABLE = new Set(["origemStock","equipId","tecnico","planId","data","inicio","ultima","criada","criadaEm","criadoPor","atribuida","atribuidaEm","atribuidoPor","concluida","concluidaEm","concluidoPor","contactada"]);
const snake = k => k.replace(/[A-Z]/g, m => "_" + m.toLowerCase());
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function toRow(table, o){ const r = {}; for(const k of COLS[table]){ if(!(k in o)) continue; let v = o[k]; if(NULLABLE.has(k) && (v === "" || v === undefined)) v = null; if(k === "periodo" || k === "tempo") v = Number(v) || 0; if(k === "deslocacoes") v = (v === "" || v === undefined) ? 1 : (Number(v) || 0); if(k === "soMaterial") v = v === true; r[snake(k)] = v; } return r; }
function fromRow(r){ const o = {}; for(const k in r){ const v = r[k]; o[camel(k)] = v === null ? "" : v; } return o; }

/* ---------- estado ---------- */
const S = { cdm:{}, condos:{}, equip:{}, plans:{}, ots:{}, equipa:{}, notifs:[], mat:{}, precos:{}, tarifas:{ deslocacao: 0, hora: 0, extraA: 50, extraE: 75 }, tarTec:{}, stk:{ locais:{}, art:{}, mov:[] } };
const EXTRAS = { A: "Manutenção A", E: "Manutenção E" };
const extraVal = k => k === "A" ? S.tarifas.extraA : k === "E" ? S.tarifas.extraE : 0;
let ME = null, IS_ADMIN = false, mode = "loading";
const chains = {};

// Depois de atribuída a alguém, a nota "Responsável no Gecond: …" já não é precisa
const semNotaGecond = n => (n || "").replace(/^\s*Responsável no Gecond:[^\n]*\n?/m, "").replace(/^\n+/, "").replace(/\n+$/, "");
async function put(col, obj, quiet){
  if(col === "ots" && obj.tecnico && /Responsável no Gecond:/.test(obj.notas || "")) obj = { ...obj, notas: semNotaGecond(obj.notas) };
  S[col][obj.id] = obj; if(!quiet) render();
  const table = TABLES[col]; const key = col + "/" + obj.id;
  const row = toRow(table, obj);
  chains[key] = (chains[key] || Promise.resolve()).then(async () => {
    const q = sb.from(table).upsert(row);
    const { data, error } = col === "ots" ? await q.select("numero").maybeSingle() : await q;
    if(error){ writeErr(error); await reloadRow(col, obj.id); }
    else if(col === "ots"){ if(data && data.numero && S.ots[obj.id] && S.ots[obj.id].numero !== data.numero){ S.ots[obj.id] = { ...S.ots[obj.id], numero: data.numero }; render(); } flushPush(); }
  });
  return chains[key];
}
async function del(col, id){
  delete S[col][id]; render();
  const { error } = await sb.from(TABLES[col]).delete().eq("id", id);
  if(error){ writeErr(error); await reloadRow(col, id); }
}
async function reloadRow(col, id){
  const { data } = await sb.from(TABLES[col]).select("*").eq("id", id).maybeSingle();
  if(data) S[col][id] = fromRow(data); else delete S[col][id];
  render();
}
function writeErr(e){
  console.error(e);
  const m = String(e.message || e);
  if(/row-level security|permission/i.test(m)) toast("Não tem permissão para esta alteração.");
  else if(/foreign key/i.test(m)) toast("Não é possível: existem registos associados.");
  else if(/fetch|network/i.test(m)) toast("Sem ligação à internet. Tente de novo.");
  else toast("Não foi possível guardar: " + m);
}
let pushTimer = null;
function flushPush(){ clearTimeout(pushTimer); pushTimer = setTimeout(() => sb.functions.invoke("enviar-push").catch(() => {}), 800); }

/* ---------- arranque e sessão ---------- */
// iPhone: impedir zoom com dois dedos e com duplo toque (a app fica do tamanho do ecrã).
for(const ev of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
// iPhone (app no ecrã principal): o sistema desconta a barra das horas à altura e deixa um vazio em baixo.
// Usamos a altura real do ecrã.
function alturaApp(){
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (!isIOS || !standalone) { document.documentElement.style.removeProperty("--apph"); return; }
  const retrato = matchMedia("(orientation: portrait)").matches;
  const ecra = retrato ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const h = Math.max(window.innerHeight, document.documentElement.clientHeight, ecra);
  document.documentElement.style.setProperty("--apph", h + "px");
}
alturaApp();
addEventListener("resize", alturaApp);
addEventListener("orientationchange", () => setTimeout(alturaApp, 300));
addEventListener("pageshow", alturaApp);
const scroller = () => document.getElementById("app") || document.scrollingElement;
let lastTouchEnd = 0;
if(isIOS) document.addEventListener("touchend", e => { const n = Date.now(); if(n - lastTouchEnd < 300 && !e.target.closest("input,textarea,select,canvas")) e.preventDefault(); lastTouchEnd = n; }, { passive: false });
async function start(){
  if(!configured){ mode = "config"; render(); return; }
  if("serviceWorker" in navigator){
    try{
      const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
      reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") reg.update().catch(() => {}); });
      // Quando chega uma versão nova da aplicação, recarrega uma vez para a usar
      let reloaded = false; const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if(reloaded || !hadController || !navigator.serviceWorker.controller) return; reloaded = true; if(!$("#scrim").classList.contains("open")) location.reload(); });
    }catch(e){ console.warn(e); }
  }
  const { data: { session } } = await sb.auth.getSession();
  sb.auth.onAuthStateChange((ev, s) => {
    if(ev === "SIGNED_OUT"){ location.reload(); }
    if(ev === "SIGNED_IN" && !ME && s) loadAll(s.user.id);
  });
  if(session) await loadAll(session.user.id);
  else { mode = "login"; render(); }
}

// Cópia local dos dados: a app abre logo com o que tinha da última vez e atualiza por trás.
const SNAP_KEYS = ["equipa","condos","equip","plans","ots","cdm","mat","notifs","precos","tarifas","tarTec","empresa","zonas","zonasOk","matGrupoCol","diasCol","faltaCol","stk"];
function guardarSnap(){ try{ const o = { v: 1, t: Date.now() }; for(const k of SNAP_KEYS) o[k] = S[k]; localStorage.setItem("snap:" + ME, JSON.stringify(o)); }catch(_){ try{ localStorage.removeItem("snap:" + ME); }catch(__){} } }
function lerSnap(uid){ try{ const o = JSON.parse(localStorage.getItem("snap:" + uid) || "null"); if(!o || o.v !== 1 || Date.now() - o.t > 7 * 86400e3) return null; return o; }catch(_){ return null; } }
let snapTimer = null; const snapDepois = () => { clearTimeout(snapTimer); snapTimer = setTimeout(guardarSnap, 3000); };

async function loadAll(uid){
  ME = uid;
  const snap = lerSnap(uid);
  if(snap && snap.equipa && snap.equipa[uid] && snap.equipa[uid].ativo){
    for(const k of SNAP_KEYS) if(snap[k] !== undefined) S[k] = snap[k];
    IS_ADMIN = S.equipa[uid].papel === "admin"; mode = "ok"; render();
    const sy = $("#sync"); if(sy) sy.textContent = "A atualizar…";
  } else { mode = "loading"; render(); }
  const all = async (table, q = x => x) => {
    const out = []; let from = 0;
    for(;;){ const { data, error } = await q(sb.from(table).select("*")).range(from, from + 999); if(error) throw error; out.push(...data); if(data.length < 1000) break; from += 1000; }
    return out;
  };
  const opc = p => p.then(r => r, () => ({ data: null, error: true }));
  try{
    // tudo em paralelo (antes era em fila, um pedido de cada vez)
    const [perfis, condos, equip, plans, ots, notifs, matsR, cdms, prR, tfR, ttR, emR, zrR] = await Promise.all([
      all("perfis"), all("condominios"), all("equipamentos"), all("planos"), all("ordens"),
      sb.from("notificacoes").select("*").order("id", { ascending: false }).limit(80).then(r => r.data || []),
      opc(sb.from("materiais").select("*")), all("condominos"),
      opc(sb.from("materiais_precos").select("*")), opc(sb.from("tarifas").select("*").eq("id", 1).maybeSingle()), opc(sb.from("tarifas_tecnico").select("*")),
      opc(sb.from("empresa").select("*").maybeSingle()), opc(sb.from("zonas_resp").select("*")),
    ]);
    const mats = matsR.data;
    S.mat = Object.fromEntries((mats || []).map(m => [m.codigo, m]));
    S.matGrupoCol = (mats || []).some(m => "grupo" in m); S.matFornCol = (mats || []).some(m => "fornecedor" in m);
    S.equipa = Object.fromEntries(perfis.map(p => [p.id, fromRow(p)]));
    S.condos = Object.fromEntries(condos.map(r => [r.id, fromRow(r)]));
    S.equip = Object.fromEntries(equip.map(r => [r.id, fromRow(r)]));
    S.plans = Object.fromEntries(plans.map(r => [r.id, fromRow(r)]));
    S.cdm = Object.fromEntries(cdms.map(r => [r.id, fromRow(r)]));
    S.ots = Object.fromEntries(ots.map(r => [r.id, fromRow(r)])); S.diasCol = ots.some(r => "dias" in r); S.faltaCol = ots.some(r => "falta" in r); S.folhaCol = ots.some(r => "de_folha" in r);
    S.notifs = notifs.map(fromRow);
    S.empresa = (emR && emR.data) || {};
    S.zonasOk = !!(zrR && !zrR.error); S.zonas = Object.fromEntries(((zrR && zrR.data) || []).map(r => [r.zona, r.tecnico]));
    window.__adm = { pr: prR.data, tf: tfR.data, tt: ttR.data };
  }catch(e){ console.error(e); if(mode !== "ok"){ mode = "error"; render(); } else { const sy = $("#sync"); if(sy) sy.textContent = "Sem ligação"; } return; }
  const me = S.equipa[ME];
  if(!me){ mode = "noprofile"; render(); return; }
  if(!me.ativo){ mode = "inactive"; render(); return; }
  IS_ADMIN = me.papel === "admin";
  if(IS_ADMIN){
    const { pr, tf } = window.__adm;
    S.precos = Object.fromEntries((pr || []).map(x => [x.codigo, Number(x.preco)]));
    if(tf) S.tarifas = { deslocacao: Number(tf.deslocacao) || 0, hora: Number(tf.hora) || 0, extraA: tf.extra_a != null ? Number(tf.extra_a) : 50, extraE: tf.extra_e != null ? Number(tf.extra_e) : 75, novas: "extra_a" in tf };
    const tt = window.__adm.tt;
    S.tarTec = Object.fromEntries((tt || []).map(x => [x.user_id, { hora1: Number(x.hora1), hora: Number(x.hora) }]));
  }
  await loadStock();
  const sy = $("#sync"); if(sy && sy.textContent === "A atualizar…") sy.textContent = "";
  loadMeteo(); setInterval(() => loadMeteo(), 30 * 60 * 1000);
  mode = "ok";
  subscribeRealtime();
  render(); guardarSnap();
  registarAcesso();
  autoReadNotifs();
  const q = new URLSearchParams(location.search).get("ordem");
  if(q && S.ots[q]){ history.replaceState(null, "", location.pathname); openOt(q); }
  checkPushState();
}

let rdTimer = null;
function renderDepois(){ clearTimeout(rdTimer); rdTimer = setTimeout(() => { const y = scroller().scrollTop; render(); scroller().scrollTop = y; snapDepois(); }, 250); }
function subscribeRealtime(){
  const ch = sb.channel("dados");
  const map = { perfis: "equipa", condominios: "condos", equipamentos: "equip", planos: "plans", ordens: "ots", condominos: "cdm" };
  for(const [table, col] of Object.entries(map)){
    ch.on("postgres_changes", { event: "*", schema: "public", table }, p => {
      if(p.eventType === "DELETE"){ if(p.old && p.old.id) delete S[col][p.old.id]; }
      else { const o = fromRow(p.new); S[col][o.id] = o; if(col === "equipa" && o.id === ME){ IS_ADMIN = o.papel === "admin"; if(!o.ativo) location.reload(); } }
      renderDepois();
    });
  }
  if(VE_STOCK()) for(const t of ["stock_mov", "stock_locais", "stock_artigos"]) ch.on("postgres_changes", { event: "*", schema: "public", table: t }, stockChanged);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "materiais" }, p => {
    if(p.eventType === "DELETE"){ if(p.old && p.old.codigo) delete S.mat[p.old.codigo]; } else S.mat[p.new.codigo] = p.new;
    render();
  });
  ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "notificacoes", filter: `user_id=eq.${ME}` }, p => {
    const n = fromRow(p.new); S.notifs.unshift(n);
    if(sheetRefresh && document.visibilityState === "visible" && $("#sheet .top h4") && S.ots[n.ordemId] && $("#sheet .top h4").textContent.endsWith(S.ots[n.ordemId].titulo)) setTimeout(() => readNotifsForOrder(n.ordemId), 500);
    toast(n.titulo + ": " + n.corpo);
    try{ navigator.vibrate && navigator.vibrate([150,80,150]); }catch(e){}
    render();
  });
  ch.on("postgres_changes", { event: "UPDATE", schema: "public", table: "notificacoes", filter: `user_id=eq.${ME}` }, p => {
    const n = fromRow(p.new); const i = S.notifs.findIndex(x => x.id === n.id); if(i >= 0) S.notifs[i] = n; render();
  });
  ch.subscribe(status => { $("#sync").textContent = status === "SUBSCRIBED" ? "" : (status === "CHANNEL_ERROR" || status === "TIMED_OUT") ? "Sem ligação" : ""; });
  window.addEventListener("online", () => { $("#sync").textContent = ""; });
  window.addEventListener("offline", () => { $("#sync").textContent = "Sem internet"; });
  document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") refreshQuiet(); });
}
let refreshing = false;
async function refreshQuiet(){
  if(refreshing || mode !== "ok") return; refreshing = true;
  try{
    const [{ data: ots }, { data: notifs }] = await Promise.all([
      sb.from("ordens").select("*").range(0, 9999),
      sb.from("notificacoes").select("*").order("id", { ascending: false }).limit(80),
    ]);
    if(ots) S.ots = Object.fromEntries(ots.map(r => [r.id, fromRow(r)])); if(ots && ots.length) S.diasCol = ots.some(r => "dias" in r); if(ots && ots.length){ S.faltaCol = ots.some(r => "falta" in r); S.folhaCol = ots.some(r => "de_folha" in r); }
    if(notifs) S.notifs = notifs.map(fromRow);
    render(); autoReadNotifs();
  } finally { refreshing = false; }
}

/* ---------- login ---------- */
function viewLogin(){
  return `<div class="login"><div class="logo"><span class="dot"></span>Manutenção</div>
    <p style="color:var(--muted);margin-top:0">Entre com o e-mail e a palavra-passe que o escritório lhe deu.</p>
    <form onsubmit="event.preventDefault();doLogin()">
      <label class="f"><span>E-mail</span><input id="l_email" type="email" autocomplete="username" required></label>
      <label class="f"><span>Palavra-passe</span><input id="l_pass" type="password" autocomplete="current-password" required></label>
      <button class="btn pri" style="width:100%;padding:12px" id="l_btn">Entrar</button>
    </form>
    <p style="font-size:13px;color:var(--muted);margin-top:16px">Esqueceu-se da palavra-passe? Peça ao escritório para a repor.</p></div>`;
}
async function doLogin(){
  const btn = $("#l_btn"); btn.disabled = true; btn.textContent = "A entrar…";
  const { error } = await sb.auth.signInWithPassword({ email: $("#l_email").value.trim(), password: $("#l_pass").value });
  if(error){ btn.disabled = false; btn.textContent = "Entrar"; toast(/invalid/i.test(error.message) ? "E-mail ou palavra-passe errados." : /banned/i.test(error.message) ? "Esta conta está desativada." : error.message); }
}
async function logout(){
  try{ localStorage.removeItem("snap:" + ME); }catch(_){}
  try{ const reg = await navigator.serviceWorker?.ready; const s = await reg?.pushManager?.getSubscription(); if(s){ await sb.from("push_subscricoes").delete().eq("endpoint", s.endpoint); await s.unsubscribe(); } }catch(e){}
  await sb.auth.signOut(); location.reload();
}

/* ---------- notificações push ---------- */
let pushOn = null;
async function checkPushState(){
  pushOn = false;
  try{
    if("serviceWorker" in navigator && "PushManager" in window && Notification.permission === "granted"){
      const reg = await navigator.serviceWorker.ready; const s = await reg.pushManager.getSubscription();
      if(s){ pushOn = true; saveSub(s); }
    }
  }catch(e){}
  render();
}
function b64ToBytes(b64){ const p = "=".repeat((4 - b64.length % 4) % 4); const s = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function saveSub(s){ const j = s.toJSON(); await sb.from("push_subscricoes").upsert({ endpoint: j.endpoint, user_id: ME, p256dh: j.keys.p256dh, auth: j.keys.auth }); }
async function enablePush(){
  if(isIOS && !isStandalone){ showInstallHelp(); return; }
  // Navegadores dentro de outras apps (WhatsApp, Facebook, Gmail…) não têm notificações
  if(typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)){ ajudaNotificacoes("semsuporte"); return; }
  if(Notification.permission === "denied"){ ajudaNotificacoes("bloqueadas"); return; }
  toast("A pedir autorização…");
  let perm;
  try{ perm = await Promise.race([Notification.requestPermission(), new Promise(r => setTimeout(() => r("tempo"), 20000))]); }
  catch(e){ perm = "erro"; }
  if(perm === "denied"){ ajudaNotificacoes("bloqueadas"); return; }
  if(perm !== "granted"){ ajudaNotificacoes("semresposta"); return; }
  try{
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, j) => setTimeout(() => j(new Error("a aplicação ainda não terminou de carregar — feche-a, volte a abrir e tente de novo")), 10000))]);
    let s = await reg.pushManager.getSubscription();
    if(!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.VAPID_PUBLIC_KEY) });
    await saveSub(s); pushOn = true; render(); toast("Notificações ativadas neste telemóvel.");
  }catch(e){ console.error(e); toast("Não foi possível ativar as notificações: " + e.message); }
}
function ajudaNotificacoes(caso){
  const passosChrome = `<ol style="line-height:1.7;padding-left:20px;margin-top:0"><li>Abra o <b>Chrome</b> (não o WhatsApp nem outra app).</li><li>Escreva o endereço <b>${esc(location.host + location.pathname)}</b> e entre.</li><li>Toque nos <b>três pontos</b> (⋮) → <b>Instalar aplicação</b> (ou <b>Adicionar ao ecrã principal</b>).</li><li>Abra a app pelo ícone novo e carregue em <b>Ativar</b>.</li></ol>`;
  const txt = {
    semsuporte: `<p style="margin-top:0">Este navegador não permite notificações. Acontece quando a app é aberta a partir de um link no WhatsApp, Facebook ou outra aplicação.</p>${passosChrome}`,
    bloqueadas: `<p style="margin-top:0">As notificações desta app foram bloqueadas neste telemóvel. Para as desbloquear:</p><ol style="line-height:1.7;padding-left:20px"><li>Mantenha o dedo no ícone da app (ou, no Chrome, toque no <b>cadeado</b> ao lado do endereço).</li><li>Escolha <b>Informações da app</b> / <b>Definições do site</b> → <b>Notificações</b>.</li><li>Escolha <b>Permitir</b>, volte à app e carregue em <b>Ativar</b>.</li></ol>`,
    semresposta: `<p style="margin-top:0">O telemóvel não mostrou o pedido de autorização (ou foi fechado sem resposta).</p><p>Se a app estiver aberta dentro de outra aplicação ou num navegador sem notificações, faça assim:</p>${passosChrome}<p style="font-size:13px;color:var(--muted)">Se já estiver no Chrome, veja se apareceu um <b>sino riscado</b> na barra do endereço: toque nele e escolha <b>Permitir</b>.</p>`
  }[caso];
  openSheet("Ativar notificações", txt + `<div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Fechar</button></div>`);
}
function showInstallHelp(){
  openSheet("Instalar no iPhone", `<p style="margin-top:0">No iPhone, as notificações só funcionam com a aplicação instalada no ecrã principal:</p>
  <ol style="line-height:1.7;padding-left:20px"><li>Abra esta página no <b>Safari</b>.</li><li>Toque no botão <b>Partilhar</b> (quadrado com seta para cima).</li><li>Escolha <b>Adicionar ao ecrã principal</b> e confirme.</li><li>Abra a aplicação pelo novo ícone <b>Manutenção</b>, entre, e toque em <b>Ativar notificações</b>.</li></ol>
  <p style="font-size:13px;color:var(--muted)">Requer iOS 16.4 ou mais recente.</p>`);
}
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; if(mode === "ok") render(); });
window.addEventListener("appinstalled", () => { installEvt = null; toast("Aplicação instalada."); });
async function instalarApp(){ if(!installEvt){ openSheet("Instalar no Android", `<ol style="line-height:1.7;padding-left:20px;margin-top:0"><li>Abra esta página no <b>Chrome</b>.</li><li>Toque nos <b>três pontos</b> (⋮) em cima à direita.</li><li>Escolha <b>Instalar aplicação</b> (ou <b>Adicionar ao ecrã principal</b>).</li></ol><p>Depois abra a <b>Manutenção</b> pelo ícone no ecrã principal.</p>`); return; } installEvt.prompt(); try{ await installEvt.userChoice; }catch(e){} installEvt = null; render(); }
const installBanner = () => (!isIOS && !isStandalone && installEvt) ? `<div class="note" style="display:flex;gap:10px;align-items:center;justify-content:space-between"><span>Instale a aplicação no telemóvel para a abrir como as outras e receber notificações.</span><button class="btn sm pri" onclick="instalarApp()"><i class=ico-install></i>Instalar</button></div>` : "";
const pushBanner = () => {
  if(pushOn !== false) return "";
  if(typeof Notification !== "undefined" && Notification.permission === "denied") return `<div class="note">As notificações estão bloqueadas neste telemóvel. Ative-as nas definições do telemóvel (Notificações → Manutenção / navegador).</div>`;
  return `<div class="note" style="display:flex;gap:10px;align-items:center;justify-content:space-between"><span>${isIOS && !isStandalone ? "Instale a aplicação no ecrã principal para receber notificações." : "Ative as notificações para ser avisado " + (IS_ADMIN ? "quando os técnicos concluem ordens." : "quando lhe atribuem ordens.")}</span><button class="btn sm pri" onclick="enablePush()">${isIOS && !isStandalone ? "Como?" : "Ativar"}</button></div>`;
};

/* ---------- derivados ---------- */
const cLabel = c => (c.codigo ? c.codigo + " — " : "") + c.nome;
const cName = id => S.condos[id] ? cLabel(S.condos[id]) : "Sem condomínio";
const eqName = id => S.equip[id] ? S.equip[id].nome : "";
const condoOf = x => x.condoId || (S.equip[x.equipId] || {}).condoId || "";
const whereTxt = x => [eqName(x.equipId), x.zona || (S.equip[x.equipId] || {}).local].filter(Boolean).join(" · ");
const nm = id => !id ? "Por atribuir" : ((S.equipa[id] || {}).nome || "Sem nome");
const phoneOf = id => ((S.equipa[id] || {}).telefone || "");
function lastExec(p){ let d = p.ultima || ""; for(const o of Object.values(S.ots)) if(o.planId === p.id && o.estado === "concluida" && (o.concluida||"") > d) d = o.concluida; return d; }
const planNext = p => { const l = lastExec(p); return l ? addDays(l, Number(p.periodo)||30) : (p.inicio || today()); };
function planStatus(p){
  const d = diffDays(planNext(p), today());
  if(d < 0) return ["Atrasada " + (-d) + "d", "b-red", "red", d];
  if(d <= 7) return [d === 0 ? "Hoje" : "Em " + d + "d", "b-amber", "amber", d];
  return ["Em dia", "b-green", "green", d];
}
const perLabel = p => (PERIODOS.find(x=>x[0]==p.periodo)||[0,"A cada "+p.periodo+" dias"])[1];
const openOtForPlan = pid => Object.values(S.ots).find(o => o.planId === pid && o.estado !== "concluida");
const myOts = () => Object.values(S.ots).filter(o => IS_ADMIN || o.tecnico === ME);
const sortOts = arr => arr.sort((a,b) => {
  const r = {curso:0, aberta:1, concluida:2};
  if(r[a.estado] !== r[b.estado]) return r[a.estado] - r[b.estado];
  if(a.estado === "concluida") return (b.concluida||"").localeCompare(a.concluida||"");
  const pr = {alta:0, media:1, baixa:2};
  return (a.data||"9999").localeCompare(b.data||"9999") || (pr[a.prioridade]??1) - (pr[b.prioridade]??1);
});
const otsSorted = () => sortOts(myOts());
const condosSorted = () => Object.values(S.condos).sort((a,b) => (a.codigo||"~").localeCompare(b.codigo||"~", "pt", {numeric:true}) || a.nome.localeCompare(b.nome, "pt"));
const pessoas = () => Object.values(S.equipa).filter(p => !p.oculto || VE_STOCK() || p.id === ME).sort((a,b) => (a.papel === b.papel ? (a.nome||"").localeCompare(b.nome||"", "pt") : a.papel === "tec" ? -1 : 1));
const tecnicos = () => pessoas().filter(p => p.ativo);
const matList = () => Object.values(S.mat).filter(m => m.ativo !== false).sort((a,b) => (a.ordem||0) - (b.ordem||0) || a.nome.localeCompare(b.nome, "pt"));
const partLabel = x => x.n + (x.c ? " (" + x.c + ")" : "");
// Material comprado com fatura (não sai do stock — aviso só para o dono): campos f (true) e fn (nº da fatura)
const fatTag = x => x.f ? `<span class="badge fat"><i class=ico-clip></i>Fatura${x.fn ? " " + esc(x.fn) : ""}${x.fo ? " · " + esc(x.fo) : ""}</span>` : "";
const fatTxt = x => x.f ? " (comprado c/ fatura" + (x.fn ? " nº " + x.fn : "") + ")" : "";
const fatTxtCurto = x => x.f ? " (fatura" + (x.fn ? " nº " + x.fn : "") + ")" : "";
const fatCampos = pre => `<label class="fatchk"><input type="checkbox" id="${pre}_fat" onchange="document.getElementById('${pre}_fatn').style.display=this.checked?'':'none'"> Comprado com fatura${VE_STOCK() ? ` <span style="color:var(--muted);font-size:12.5px">(não sai do stock)</span>` : ""}</label><span id="${pre}_fatn" class="fatn2" style="display:none"><input id="${pre}_fatf" class="fatn" placeholder="Comprado em (fornecedor)" list="dl_mforn"><input id="${pre}_fatnn" class="fatn" placeholder="Nº da fatura (opcional)">${dlForn()}</span>`;
const lerFat = pre => { const c = $("#" + pre + "_fat"); if(!c || !c.checked) return {}; const n = val(pre + "_fatnn"), fo = val(pre + "_fatf"); c.checked = false; const i = $("#" + pre + "_fatn"); if(i) i.style.display = "none"; for(const k of ["_fatnn", "_fatf"]){ const e = $("#" + pre + k); if(e) e.value = ""; } return { f: true, ...(n ? { fn: n } : {}), ...(fo ? { fo } : {}) }; };
// fornecedor de uma linha de material: o da fatura, senão o definido no material
const fornLinha = x => (x && (x.fo || (x.c && (S.mat[x.c] || {}).fornecedor))) || "";
const dlForn = () => document.getElementById("dl_mforn") ? "" : `<datalist id="dl_mforn">${[...new Set(Object.values(S.mat).map(m => m.fornecedor).filter(Boolean))].sort().map(f => `<option value="${esc(f)}">`).join("")}</datalist>`;
// Escolha de material sem a lista nativa do Android (que ocupa o ecrã todo):
// um campo que abre por baixo uma lista curta, com procura e por grupos.
function matPicker(id, onch, comCod){
  const ops = matList().map(m => `<option value="${esc(m.codigo)}">${esc(m.nome)}${comCod ? " · " + esc(m.codigo) : ""}</option>`).join("");
  // no iPhone a lista nativa é boa (roda por baixo), por isso fica a normal
  if(isIOS) return `<select id="${id}" class="search" style="margin:8px 0 0" onchange="${onch}"><option value="">— Escolher material —</option>${ops}<option value="__outro">Outro material (escrever)…</option></select>`;
  return `<select id="${id}" style="display:none" onchange="${onch}"><option value="">— Escolher material —</option>${ops}<option value="__outro">Outro material (escrever)…</option></select>
    <div class="mpk" id="${id}_pk"><button type="button" class="mpk-b" onclick="mpkAbrir('${id}')"><span id="${id}_lbl">— Escolher material —</span><span class="mpk-c">▾</span></button>
    <div class="mpk-p" id="${id}_pp" style="display:none" onclick="if(event.target===this)mpkAbrir('${id}')"><div class="mpk-m"><input class="search" id="${id}_q" placeholder="Procurar…" autocomplete="off" oninput="mpkLista('${id}')"><div class="mpk-l" id="${id}_l"></div></div></div></div>`;
}
function mpkAbrir(id){ const p = document.getElementById(id + "_pp"); if(!p) return; const ab = p.style.display === "none"; p.style.display = ab ? "" : "none"; if(ab){ mpkLista(id); const q = document.getElementById(id + "_q"); if(q){ q.value = ""; mpkLista(id); } } }
function mpkLista(id){
  const l = document.getElementById(id + "_l"); if(!l) return; const qq = val(id + "_q");
  const ms = matList().filter(m => !qq || hit(m.nome + " " + m.codigo + " " + (m.grupo || ""), qq));
  const g = {}; for(const m of ms){ const k = m.grupo || "Outros"; (g[k] ||= []).push(m); }
  const cur = (document.getElementById(id) || {}).value || "";
  const op = (v, t, cls) => `<button type="button" class="${cls || ""}${cur === v ? " on" : ""}" onclick="mpkEscolher('${id}','${esc(v)}')"><span class="ck">${cur === v ? "✓" : ""}</span>${t}</button>`;
  l.innerHTML = (qq ? "" : op("", "— Escolher material —")) + Object.entries(g).map(([k, a]) => (Object.keys(g).length > 1 ? `<div class="mpk-g">${esc(k)}</div>` : "") + a.map(m => op(m.codigo, esc(m.nome))).join("")).join("")
    + op("__outro", "Outro material (escrever)…", "mpk-o");
}
function mpkEscolher(id, v){
  const s = document.getElementById(id); if(!s) return; s.value = v; s.dispatchEvent(new Event("change"));
  const lb = document.getElementById(id + "_lbl"); if(lb) lb.textContent = v === "__outro" ? "Outro material (escrever)…" : (S.mat[v] || {}).nome || "— Escolher material —";
  const p = document.getElementById(id + "_pp"); if(p) p.style.display = "none";
  if(v === "__outro"){ const n = document.getElementById(id === "p_sel" ? "p_nome" : "tw_nome"); if(n){ n.style.display = ""; n.focus(); } }
  else { const q = document.getElementById(id === "p_sel" ? "p_qtd" : "tw_qtd"); if(q){ if(!q.value) q.value = 1; } }
}
// quando o estado do formulário é reposto (ou limpo), o rótulo acompanha o valor escondido
function mpkSync(){ for(const id of ["p_sel", "tw_sel"]){ const s = document.getElementById(id), lb = document.getElementById(id + "_lbl"); if(s && lb) lb.textContent = !s.value ? "— Escolher material —" : s.value === "__outro" ? "Outro material (escrever)…" : (S.mat[s.value] || {}).nome || s.value; } }
function pendingPart(){
  const sel = document.getElementById("p_sel"); const qt = parseFloat(val("p_qtd")) || 1;
  if(sel && sel.value && sel.value !== "__outro"){ const m = S.mat[sel.value]; if(m) return {n: m.nome, c: m.codigo, q: qt, ...lerFat("p")}; }
  const n = val("p_nome"); return n ? {n, q: qt, ...lerFat("p")} : null;
}
function clearPart(){ const sel = $("#p_sel"), a = $("#p_nome"), b = $("#p_qtd"); if(sel){ sel.value = ""; setTimeout(mpkSync); } if(a){ a.value = ""; a.style.display = matList().length ? "none" : ""; } if(b) b.value = ""; }
function onPartSel(v){ const a = $("#p_nome"); if(!a) return; a.style.display = v === "__outro" ? "" : "none"; if(v === "__outro") a.focus(); else if(v) { const q = $("#p_qtd"); if(q && !q.value) q.value = 1; } }
const EUR = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" });
const eur = v => EUR.format(Number(v) || 0);
const unitPrice = x => (x.p !== undefined && x.p !== "" && x.p !== null) ? Number(x.p) : (x.c && S.precos[x.c] !== undefined ? S.precos[x.c] : null);
const lineTotal = x => { const u = unitPrice(x); return u === null ? null : u * (Number(x.q) || 0); };
const partsTotal = pc => pc.reduce((t, x) => t + (lineTotal(x) || 0), 0);
const parsePrice = v => { const n = parseFloat(String(v).replace(/\s|€/g, "").replace(",", ".")); return isNaN(n) ? null : Math.round(n * 100) / 100; };
const nDesloc = o => (o.deslocacoes === "" || o.deslocacoes === undefined || o.deslocacoes === null) ? 1 : Number(o.deslocacoes) || 0;
const r2 = v => Math.round(v * 100) / 100;
// Tempo por dias: o.dias = [{d:"AAAA-MM-DD", m:minutos}]. Sem dias, conta como um só dia com o.tempo.
const diasDe = o => Array.isArray(o.dias) && o.dias.length ? o.dias : (Number(o.tempo) ? [{ d: o.concluida || o.data || "", m: Number(o.tempo) }] : []);
const nDias = o => Array.isArray(o.dias) ? new Set(o.dias.filter(x => Number(x.m) > 0).map(x => x.d || "")).size : 0;
const diaTxt = x => (x.d ? fmtDate(x.d).slice(0, 5) + " " : "") + (x.i && x.f ? x.i + "–" + x.f : fmtTempo(x.m));
const tempoTxt = o => fmtTempo(o.tempo) + (nDias(o) > 1 ? ` em ${nDias(o)} dias` : "");
const diasTxt = o => { const l = Array.isArray(o.dias) ? o.dias.filter(x => Number(x.m) > 0) : []; if(!(l.length > 1 || l.some(x => x.i))) return "";
  // vários períodos no mesmo dia ficam juntos: "18/11 09:00–12:00 e 14:00–17:00"
  const g = []; for(const x of l){ const u = g[g.length - 1]; if(u && u.d === (x.d || "")) u.p.push(x); else g.push({ d: x.d || "", p: [x] }); }
  return g.map(z => (z.d ? fmtDate(z.d).slice(0, 5) + " " : "") + z.p.map(x => x.i && x.f ? x.i + "–" + x.f : fmtTempo(x.m)).join(" e ")).join(" · "); };
const smOt = o => !!(S.equipa[o.tecnico] || {}).soRegistaMaterial;
// texto para documentos que saem para fora: só o tempo, nunca o preço/hora
const moTxtFora = o => tempoTxt(o);
const deslTxtFora = v => v.tt ? "incluída" : v.nd + (v.nd === 1 ? " deslocação" : " deslocações");
const moTxt = (o, v) => v.tt ? `${tempoTxt(o)} · ${eur(v.tt.hora1)} 1.ª hora + ${eur(v.tt.hora)}/h seguintes` : `${tempoTxt(o)} × ${eur(S.tarifas.hora)}/h`;
function valores(o){
  if(isExt(o)) return { mat: 0, mo: 0, nd: 0, desl: 0, so: false, ext: true, ex: 0, exTipo: "", total: 0 };
  const mat = r2(partsTotal(o.pecas || []));
  const horas = (Number(o.tempo) || 0) / 60;
  const so = o.soMaterial === true || smOt(o);   // técnicos que só registam material: mão de obra vem noutra folha
  const tt = S.tarTec[o.tecnico]; const min = Number(o.tempo) || 0;
  // tarifa própria: 1.ª hora só uma vez por ordem, mesmo com vários dias na mesma folha
  const mo = so ? 0 : tt ? r2(min > 0 ? tt.hora1 + Math.max(0, min - 60) / 60 * tt.hora : 0) : r2(horas * S.tarifas.hora);
  const nd = so || tt ? 0 : nDesloc(o); const desl = r2(nd * S.tarifas.deslocacao);
  const ex = so ? 0 : r2(extraVal(o.extra));
  return { mat, mo, nd, desl, so, ex, exTipo: so ? "" : (o.extra || ""), tt, total: r2(mat + mo + desl + ex) };
}
const fmtTempo = t => `${Math.floor((t||0)/60)} h ${pad((t||0)%60)} min`;
const numOt = o => o && o.numero ? String(o.numero).padStart(4, "0") : "";
const numLabel = o => numOt(o) ? "Nº " + numOt(o) : "Nova";
const canEditOt = o => IS_ADMIN || o.criadoPor === ME;

/* ---------- WhatsApp ---------- */
const APP_URL = location.origin + location.pathname;
// Separa um campo com vários números ("912 345 678 / 934 567 890") em números individuais.
function splitTels(t){
  const out = [];
  for(const part of String(t || "").split(/[\/,;|\n]+|\s+(?:e|ou)\s+/i)){
    let d = part.replace(/[^0-9+]/g, ""); if(!d) continue;
    const plus = d.startsWith("+") ? "+" : ""; d = d.replace(/\+/g, "");
    if(!plus && !d.startsWith("00") && d.length > 9 && d.length % 9 === 0){ for(let i = 0; i < d.length; i += 9) out.push(d.slice(i, i + 9)); }
    else out.push(plus + d);
  }
  return [...new Set(out)].filter(x => x.replace(/\D/g, "").length >= 6);
}
const fmtTel = n => /^\d{9}$/.test(n) ? n.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3") : n;
const telBtns = t => { const ns = splitTels(t); return ns.map(n => `<a class="btn sm" href="tel:${esc(n)}"><i class=ico-phone></i>${esc(fmtTel(n))}</a>${waNum(n).length >= 11 && /^(\+?351)?9/.test(n.replace(/^00/, "+")) ? `<a class="btn sm wa" href="https://wa.me/${waNum(n)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}`).join(""); };
function waNum(t){ let d = String(t||"").replace(/\D/g, ""); if(d.startsWith("00")) d = d.slice(2); if(d.length === 9) d = "351" + d; return d; }
const waLink = (tel, text) => `https://wa.me/${waNum(tel)}?text=${encodeURIComponent(text)}`;
function waOrdem(o){
  const c = S.condos[condoOf(o)] || {};
  return [`🔧 Nova ordem de trabalho ${numLabel(o)}`, `*${o.titulo}*`, c.nome ? cLabel(c) : "", c.morada || "", whereTxt(o), `Prioridade: ${(PRIOR[o.prioridade]||PRIOR.media)[0]} · Prevista: ${fmtDate(o.data)}`, o.descricao ? "\n" + o.descricao : "", `\nAbrir: ${APP_URL}?ordem=${o.id}`].filter(Boolean).join("\n");
}
function waConcl(o){ return [`✅ Ordem ${numLabel(o)} concluída`, `*${o.titulo}*`, cName(condoOf(o)), o.notas ? "\n" + o.notas : "", `\nVer: ${APP_URL}?ordem=${o.id}`].filter(Boolean).join("\n"); }
const waBtn = (tel, text, label) => `<a class="btn wa" href="${esc(waLink(tel, text))}" target="_blank" rel="noopener"><i class=ico-mobile></i>${esc(label)}</a>`;

/* ---------- navegação ---------- */
let tab = "inicio", otFilter = "ativas", condoF = "", techF = "", q = "";
const ICONS = {
  apagar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  editar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
  inicio:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  ordens:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  prev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/></svg>',
  condos:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M2 21h20M8 8h3M8 12h3M8 16h3"/></svg>',
  stock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
  equipa:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>'
};
const tabsFor = () => IS_ADMIN
  ? [["inicio","Início"],["ordens","Ordens"],["prev","Preventiva"],["condos","Condomínios"],...(VE_STOCK() ? [["stock","Stock"]] : []),["equipa","Equipa"]]
  : [["inicio","Hoje"],["ordens","As minhas"],["condos","Condomínios"]];
function go(t){
  if(t !== "inicio" && !tabHist){ try{ history.pushState({ tab: 1 }, ""); tabHist = true; }catch(e){} }
  else if(t === "inicio" && tabHist){ tabHist = false; histBack(); }
  tab = t; q = ""; listMax = 50; render(); scroller().scrollTop = 0;
}
function renderNav(){
  if(mode !== "ok"){ $("#nav").innerHTML = ""; return; }
  $("#nav").classList.toggle("many", tabsFor().length > 5);
  $("#nav").innerHTML = tabsFor().map(([k,l]) => `<button class="${tab===k?"on":""}" onclick="go('${k}')">${ICONS[k]}${esc(l)}</button>`).join("");
}
/* ---------- meteorologia (IPMA, dados abertos) ---------- */
const WX = { 1:"☀️", 2:"🌤️", 3:"⛅", 4:"☁️", 5:"🌥️", 6:"🌦️", 7:"🌦️", 8:"🌧️", 9:"🌧️", 10:"🌦️", 11:"🌧️", 12:"🌧️", 13:"🌦️", 14:"🌧️", 15:"🌦️", 16:"🌫️", 17:"🌫️", 18:"🌨️", 19:"⛈️", 20:"⛈️", 21:"🌨️", 22:"❄️", 23:"⛈️", 24:"☁️", 25:"🌥️", 26:"🌫️", 27:"☁️", 28:"🌨️", 29:"🌨️", 30:"🌨️" };
let meteo = null, meteoPos = null, meteoNegado = false;
const lsGet = k => { try{ return JSON.parse(localStorage.getItem(k) || "null"); }catch(e){ return null; } };
const lsSet = (k, v) => { try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} };
function obterPosicao(){
  return new Promise(res => {
    if(!navigator.geolocation){ res(null); return; }
    navigator.geolocation.getCurrentPosition(
      p => { meteoNegado = false; res({ lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100 }); },
      e => { meteoNegado = e && e.code === 1; res(null); },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 30 * 60 * 1000 });
  });
}
async function loadMeteo(force){
  const c = lsGet("meteo2");
  if(!force && c && Date.now() - c.t < 30 * 60 * 1000){ meteo = c.d; meteoPos = c.pos; renderWho(); return; }
  if(c && !meteo){ meteo = c.d; meteoPos = c.pos; renderWho(); }
  const fixo = lsGet("meteoLocal"); // localidade escolhida à mão neste aparelho
  const pos = fixo ? null : await obterPosicao(); meteoPos = pos || null;
  try{
    const { data, error } = await sb.functions.invoke("meteo", { body: fixo ? { local: fixo.id } : (pos || {}) });
    if(error || !data || data.erro || !data.dias) throw (error || new Error(data && data.erro));
    meteo = data; lsSet("meteo2", { t: Date.now(), d: data, pos: meteoPos });
    renderWho(); if(sheetRefresh && document.getElementById("wxSheet")) sheetRefresh();
    if(tab === "inicio" && mode === "ok" && !$("#scrim").classList.contains("open")){ const y = scroller().scrollTop; render(); scroller().scrollTop = y; }
  }catch(e){ console.warn("meteo", e); }
}
let METEO_LOCS = null;
async function mudarLocalMeteo(){
  const w = document.getElementById("wxLocal"); if(!w) return;
  w.innerHTML = `<div class="muted" style="font-size:13px">A carregar as localidades…</div>`;
  try{
    if(!METEO_LOCS){ const { data, error } = await sb.functions.invoke("meteo", { body: { lista: true } }); if(error || !Array.isArray(data)) throw error || new Error("lista"); METEO_LOCS = data; }
    w.innerHTML = `<label class="f" style="margin:0"><span>Escolha o concelho (ex.: Freamunde → Paços de Ferreira)</span><input id="wx_q" class="search" placeholder="Escreva o nome…" autocomplete="off" oninput="procLocalMeteo(this.value)"></label><div class="cres" id="wx_res"></div>`;
    setTimeout(() => { const i = document.getElementById("wx_q"); if(i) i.focus(); }, 50);
  }catch(e){ w.innerHTML = `<div class="muted" style="font-size:13px">Não foi possível carregar a lista. Tente mais tarde.</div>`; }
}
function procLocalMeteo(v){
  const r = document.getElementById("wx_res"); if(!r || !METEO_LOCS) return; const qq = (v || "").trim();
  if(qq.length < 2){ r.innerHTML = ""; return; }
  const l = METEO_LOCS.filter(x => hit(x.local, qq)).slice(0, 10);
  r.innerHTML = l.length ? l.map(x => `<button type="button" onclick="escolherLocalMeteo('${esc(x.id)}', this.textContent)">${esc(x.local)}</button>`).join("") : `<div class="mais">Nenhuma localidade com esse nome.</div>`;
}
function escolherLocalMeteo(id, nome){ lsSet("meteoLocal", { id, local: nome }); lsSet("meteo2", null); meteo = null; if(sheetRefresh) sheetRefresh(); loadMeteo(true); toast("Meteorologia de " + nome + " neste aparelho."); }
function usarLocalizacaoMeteo(){ lsSet("meteoLocal", null); lsSet("meteo2", null); meteo = null; if(sheetRefresh) sheetRefresh(); loadMeteo(true); }
function meteoHoje(){ if(!meteo || !meteo.dias) return null; const t = today(); return meteo.dias.find(d => d.data === t) || meteo.dias[0]; }
function meteoChip(){
  const d = meteoHoje(); if(!d) return "";
  const a = meteo.agora; const tipo = a ? a.tipo : d.tipo; const temp = a ? a.temp : d.tMax; const prob = a ? a.prob : d.prob;
  return `<button class="wx" onclick="openMeteo()" aria-label="Meteorologia" title="${esc(a ? a.desc : d.desc)} · ${esc(meteo.local)}">${WX[tipo] || "🌡️"}<b>${Math.round(temp)}°</b>${prob >= 50 ? `<small>💧${Math.round(prob)}%</small>` : ""}</button>`;
}
const DIAS_SEM = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
function openMeteo(){
  const draw = () => {
    if(!meteo) return `<div id="wxSheet">${emptyBox("A carregar a previsão…")}</div>`;
    const t = today(); const am = addDays(t, 1); const a = meteo.agora;
    const fixo = lsGet("meteoLocal");
    const ondeTxt = fixo ? `<i class=ico-pin></i>Localidade escolhida neste aparelho · <a href="#" onclick="event.preventDefault();usarLocalizacaoMeteo()">usar a localização</a>` : meteoPos ? `<i class=ico-pin></i>Pela sua localização${meteo.km != null ? ` (estação de previsão a ~${meteo.km} km)` : ""}` : meteoNegado ? "<i class=ico-pin></i>A localização não está autorizada — a mostrar o Porto. Para usar a sua zona, autorize a localização para esta app nas definições do telemóvel." : "<i class=ico-pin></i>Sem localização — a mostrar o Porto.";
    return `<div id="wxSheet">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><span style="font-size:44px;line-height:1">${WX[a ? a.tipo : meteoHoje().tipo] || "🌡️"}</span><div><div style="font-size:22px;font-weight:700">${esc(meteo.local)}${a ? ` · ${Math.round(a.temp)}°` : ""}</div><div style="color:var(--muted);font-size:14px">${esc(a ? a.desc : meteoHoje().desc)}${a && a.prob >= 0 ? ` · 💧 ${Math.round(a.prob)}%` : ""}</div></div></div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px">${ondeTxt} <button class="btn sm" onclick="loadMeteo(true)" style="margin-left:4px">Atualizar</button> <button class="btn sm" onclick="mudarLocalMeteo()">Mudar localidade</button></div>
      <div id="wxLocal" style="margin-bottom:10px"></div>
      <div class="plist" style="border:1px solid var(--line);border-radius:var(--r);margin:0;background:var(--card)">${meteo.dias.map(d => { const nome = d.data === t ? "Hoje" : d.data === am ? "Amanhã" : DIAS_SEM[new Date(d.data + "T12:00:00").getDay()];
        return `<div class="prow" style="cursor:default"><span style="font-size:28px;line-height:1">${WX[d.tipo] || "🌡️"}</span><span class="pn"><b>${nome}</b> <span style="color:var(--muted);font-size:13px">${fmtDate(d.data).slice(0, 5)}</span><small>${esc(d.desc)}${d.vento ? " · vento " + esc(d.vento) : ""}</small></span><span style="text-align:right;white-space:nowrap"><b>${Math.round(d.tMax)}°</b> <span style="color:var(--muted)">${Math.round(d.tMin)}°</span><br><span style="font-size:13px;color:${d.prob >= 50 ? "var(--blue)" : "var(--muted)"}">💧 ${Math.round(d.prob)}%</span></span></div>`; }).join("")}</div>
      <p style="font-size:12px;color:var(--muted);margin-top:10px">Fonte: ${esc(meteo.fonte || "IPMA")}. A localização serve só para escolher o concelho mais próximo; não fica guardada.${meteo.atualizado ? " Atualizado: " + esc(String(meteo.atualizado).replace("T", " ").slice(0, 16)) + "." : ""}</p></div>`;
  };
  openSheet("Meteorologia", draw(), () => { const b = document.querySelector("#sheet .body"); if(b && document.getElementById("wxSheet")) b.innerHTML = draw(); });
}
function renderWho(){
  const el = $("#who");
  if(mode !== "ok"){ el.innerHTML = ""; document.title = "Manutenção"; return; }
  const nu = S.notifs.filter(n => !n.lida).length;
  document.title = (nu ? "(" + nu + ") " : "") + "Manutenção";
  try{ if(navigator.setAppBadge) nu ? navigator.setAppBadge(nu) : navigator.clearAppBadge(); }catch(e){}
  el.innerHTML = `${meteoChip()}<button class="bell" onclick="openNotifs()" aria-label="Notificações"><i class=ico-bell></i>${nu?`<i>${nu>99?"99+":nu}</i>`:""}</button><span class="who-n" onclick="openPerfil()" style="cursor:pointer"></span><span class="badge ${IS_ADMIN?"b-amber":"b-blue"}" onclick="openPerfil()" style="cursor:pointer"><span class="lg-only">${IS_ADMIN?"Administrativo":"Técnico"}</span><span class="sm-only">${IS_ADMIN?"Admin.":"Técnico"}</span></span><button class="bell" onclick="openPerfil()" aria-label="O meu perfil" title="O meu perfil (palavra-passe e assinatura)"><i class=ico-user></i></button>`;
  el.querySelector(".who-n").textContent = (S.equipa[ME] || {}).nome || "";
}

/* ---------- itens de lista ---------- */
function otRow(o, hideCondo){
  const late = o.estado !== "concluida" && o.data && o.data < today();
  const est = o.estado === "concluida" ? '<span class="badge b-green">Concluída</span>' : o.estado === "curso" ? '<span class="badge b-blue">Em curso</span>' : "";
  const sub = [hideCondo ? "" : cName(condoOf(o)), IS_ADMIN ? (o.tecnico ? nm(o.tecnico) : (gecResp(o) ? "Gecond: " + gecResp(o) : "Por atribuir")) : ""].filter(Boolean).join(" · ");
  const pr = o.prioridade === "alta" ? '<b style="color:var(--red)"><i class=ico-alert></i></b>' : "";
  return `<div class="prow" onclick="openOt('${o.id}')"><span class="mono pd">${esc(numOt(o) || "")}</span><span class="pn">${pr}${isTrab(o) ? "<i class=ico-wrench></i>" : ""}${esc(o.titulo)}${isExt(o) ? " <i class=ico-lift></i>" : ""}<small>${esc(sub)}</small></span>${est}<span class="badge ${late ? "b-red" : ""}" style="white-space:nowrap">${o.estado==="concluida" ? fmtDate(o.concluida) : fmtDate(o.data)}</span></div>`;
}
let grpOpen = new Set(), listMax = 50;
function grpBlock(key, label, sub, items, extra){
  const aberto = grpOpen.has(key);
  return `<details class="pgrp" ${aberto ? "open" : ""} ontoggle="grpToggle('${esc(key)}', this.open)"><summary><span class="pg-t">${label}</span><span class="badge">${items.length}</span>${sub ? `<span class="pg-s">${sub}</span>` : ""}</summary>${aberto ? `${extra || ""}<div class="plist">${items.map(o => otRow(o)).join("")}</div>` : ""}</details>`;
}
function grpToggle(k, open){ if(open){ if(!grpOpen.has(k)){ grpOpen.add(k); const y = scroller().scrollTop; render(); scroller().scrollTop = y; } } else { grpOpen.delete(k); } }
async function assignMany(key, tec){
  if(!tec) return;
  const ids = (window.__grp || {})[key] || [];
  for(const id of ids){ const o = S.ots[id]; if(o && !o.tecnico) updOt(id, {tecnico: tec, atribuida: today(), atribuidaEm: nowIso(), atribuidoPor: ME}); }
  toast(ids.length + " ordens atribuídas a " + nm(tec) + "."); render();
}
function otItem(o, hideCondo){
  const p = PRIOR[o.prioridade] || PRIOR.media;
  const late = o.estado !== "concluida" && o.data && o.data < today();
  const ck = o.checklist || []; const done = ck.filter(c => c.ok).length;
  const est = o.estado === "concluida" ? '<span class="badge b-green">Concluída</span>' : o.estado === "curso" ? '<span class="badge b-blue">Em curso</span>' : '<span class="badge">Aberta</span>';
  const sub = [hideCondo ? "" : cName(condoOf(o)), whereTxt(o)].filter(Boolean).join(" · ");
  const who = IS_ADMIN ? `<div class="s"><i class=ico-worker></i><span class="${o.tecnico?"":"warnTxt"}">${esc(nm(o.tecnico))}</span></div>` : "";
  const nf = (o.fotos||[]).length;
  return `<div class="item" onclick="openOt('${o.id}')"><div class="bar ${o.estado==="concluida"?"green":p[2]}"></div>
    <div class="main"><div class="t">${numOt(o)?`<span class="mono" style="color:var(--muted);font-weight:500;margin-right:6px">${numOt(o)}</span>`:""}${esc(o.titulo)}</div><div class="s">${esc(sub)}</div>${who}
    ${ck.length||nf?`<div class="s mono">${ck.length?`${done}/${ck.length} verificações`:""}${ck.length&&nf?" · ":""}${nf?`<i class=ico-camera></i>${nf}`:""}</div>`:""}</div>
    <div class="r">${est}<span class="${late?"badge b-red":""}">${o.estado==="concluida"?fmtDate(o.concluida):fmtDate(o.data)}</span>${o.tipo==="preventiva"?'<span class="badge">Preventiva</span>':o.tipo==="pedido"?'<span class="badge">Pedido</span>':""}</div></div>`;
}
function planItem(p, hideCondo){
  const st = planStatus(p); const open = openOtForPlan(p.id);
  const sub = [hideCondo ? "" : cName(condoOf(p)), whereTxt(p), perLabel(p)].filter(Boolean).join(" · ");
  return `<div class="item" onclick="openPlan('${p.id}')"><div class="bar ${st[2]}"></div>
    <div class="main"><div class="t">${esc(p.titulo)}</div><div class="s">${esc(sub)}</div>
    <div class="s">Próxima: <span class="mono">${fmtDate(planNext(p))}</span>${p.tecnico?" · <i class=ico-worker></i>"+esc(nm(p.tecnico)):""}${open?" · ordem já criada":""}</div></div>
    <div class="r"><span class="badge ${st[1]}">${st[0]}</span></div></div>`;
}
const emptyBox = (msg, btn) => `<div class="empty">${msg}${btn?`<br>${btn}`:""}</div>`;
const condoFilterSel = () => condoF && S.condos[condoF]
  ? `<div class="cfil on"><span class="search"><b class="mono">${esc(S.condos[condoF].codigo || "")}</b> ${esc(S.condos[condoF].nome)}</span><button type="button" class="btn sm" onclick="condoF='';render()" aria-label="Mostrar todos">✕</button></div>`
  : `<div class="cfil"><input class="search" id="cf_q" placeholder="Todos os condomínios — escreva para procurar" autocomplete="off" oninput="procCondoF(this.value)" onfocus="procCondoF(this.value)" onkeydown="if(event.key==='Enter'){const b=document.querySelector('#cf_res button');if(b)b.click()}" onblur="setTimeout(()=>{const r=document.getElementById('cf_res');if(r)r.innerHTML=''},200)"><div class="cres cdrop" id="cf_res"></div></div>`;
function procCondoF(v){
  const res = document.getElementById("cf_res"); if(!res) return; const qq = (v || "").trim();
  if(!qq){ res.innerHTML = ""; return; }
  const found = condosSorted().filter(c => hit([c.codigo, c.nome, c.morada].join(" "), qq));
  res.innerHTML = found.length ? found.slice(0, 12).map(c => `<button type="button" onmousedown="event.preventDefault()" onclick="condoF='${c.id}';render()"><b class="mono">${esc(c.codigo || "")}</b> ${esc(c.nome)}<small>${esc(c.morada || "")}</small></button>`).join("") + (found.length > 12 ? `<div class="mais">e mais ${found.length - 12} — escreva mais letras</div>` : "") : `<div class="mais">Nenhum condomínio encontrado.</div>`;
}
const techFilterSel = () => IS_ADMIN ? `<select class="search" onchange="techF=this.value;render()"><option value="">Todas as pessoas</option><option value="-" ${techF==="-"?"selected":""}>Por atribuir</option>${pessoasAgrupadas(techF)}</select>` : "";
const statCard = (n, label, onclick, warn) => `<div class="stat ${warn&&n?"warn":""}" onclick="${onclick}"><b>${n}</b><span>${label}</span></div>`;

/* ---------- vistas ---------- */
function viewEstado(){
  if(mode === "config") return `<div class="panel" style="margin-top:20px"><b>Falta configurar</b><p style="color:var(--muted);font-size:14px">Preencha o ficheiro <code>config.js</code> com o endereço e a chave do seu projeto Supabase (ver GUIA.md, passo 4).</p></div>`;
  if(mode === "loading") return `<div class="empty">A carregar…</div>`;
  if(mode === "error") return `<div class="panel" style="margin-top:20px"><b>Não foi possível carregar os dados</b><p style="color:var(--muted);font-size:14px">Verifique a ligação à internet. Se o problema continuar, o projeto Supabase pode estar em pausa (acontece após 7 dias sem uso) — o responsável pode reativá-lo no painel do Supabase.</p><button class="btn" onclick="location.reload()">Tentar de novo</button> <button class="btn" onclick="logout()">Sair</button></div>`;
  if(mode === "noprofile") return `<div class="panel" style="margin-top:20px"><b>Conta sem perfil</b><p style="color:var(--muted);font-size:14px">Esta conta ainda não tem perfil na aplicação. Peça ao escritório para verificar.</p><button class="btn" onclick="logout()">Sair</button></div>`;
  if(mode === "inactive") return `<div class="panel" style="margin-top:20px"><b>Conta desativada</b><p style="color:var(--muted);font-size:14px">Fale com o escritório.</p><button class="btn" onclick="logout()">Sair</button></div>`;
  return "";
}

// ordens agrupadas por tipo (videoporteiros, iluminação, infiltrações…), o tipo com mais ordens primeiro
const ICO_TIPO = { "Infiltrações e águas": "drop", "Videoporteiros, campainhas e portas": "bell", "Portões e garagem": "gate", "Iluminação": "bulb", "Eletricidade": "bolt", "Placas e sinalização": "signp", "Elevadores": "lift", "Outros": "wrench" };
function porTipo(lista, pref){
  const g = new Set(lista.map(grupoOc));
  if(g.size === 1 && g.has("Outros")) return `<div class="list">${lista.map(o => otItem(o)).join("")}</div>`;
  return blocosTipo(lista, pref || "tph");
}
// lista de um técnico (escritório): agrupada por tipo, cada grupo com as suas linhas
function porTipoAdm(lista){ return blocosTipo(lista, "tp:" + techF + ":" + otFilter); }
// grupos por tipo que abrem e fecham (como os outros grupos do Painel)
function blocosTipo(lista, pref){
  const t = today(); const g = {}; for(const o of lista){ const k = grupoOc(o); (g[k] ||= []).push(o); }
  const ks = Object.keys(g).sort((a, b) => (a === "Outros") - (b === "Outros") || g[b].length - g[a].length);
  return ks.map(k => { const os = g[k]; const atr = os.filter(o => o.estado !== "concluida" && o.data && o.data < t).length; const urg = os.filter(o => o.estado !== "concluida" && o.prioridade === "alta").length;
    return grpBlock(pref + ":" + k, `<i class="ico-${ICO_TIPO[k] || "wrench"}"></i>${esc(k)}`, [urg ? `<span class="warnTxt">${urg} urgente${urg === 1 ? "" : "s"}</span>` : "", atr ? `<span class="warnTxt">${atr} em atraso</span>` : ""].filter(Boolean).join(" · "), os); }).join("");
}
function viewInicio(){
  const t = today();
  if(!IS_ADMIN){
    const mine = otsSorted();
    const hoje = mine.filter(o => o.estado !== "concluida" && (!o.data || o.data <= t));
    const prox = mine.filter(o => o.estado !== "concluida" && o.data && o.data > t);
    const mes = mine.filter(o => o.estado === "concluida" && (o.concluida||"").slice(0,7) === t.slice(0,7)).length;
    const first = ((S.equipa[ME]||{}).nome||"").split(" ")[0];
    return `<h2>Olá${first?", "+esc(first):""} <span class="mono" style="font-size:14px;color:var(--muted)">${fmtDate(t)}</span></h2>${meteoAviso()}${installBanner()}${pushBanner()}${(S.equipa[ME]||{}).assinatura ? "" : `<div class="note" style="display:flex;gap:10px;align-items:center;justify-content:space-between"><span>Guarde a sua assinatura para ela sair nos relatórios.</span><button class="btn sm pri" onclick="openPerfil()">Assinar</button></div>`}
    <div class="stats">
      ${statCard(hoje.length, "Para hoje / em atraso", "otFilter='ativas';go('ordens')", true)}
      ${statCard(mine.filter(o=>o.estado==="curso").length, "Em curso", "otFilter='curso';go('ordens')")}
      ${statCard(prox.length, "Próximos dias", "otFilter='ativas';go('ordens')")}
      ${statCard(mes, "Concluídas este mês", "otFilter='concluida';go('ordens')")}
    </div>
    <h3>Para hoje e em atraso</h3>
    ${hoje.length ? porTipo(hoje, "tph:hoje") : `<div class="list">${emptyBox("Não tem ordens para hoje.")}</div>`}
    ${prox.length?`<h3>Próximas</h3>${porTipo(prox.slice(0,20), "tph:prox")}`:""}
    <div class="actions" style="margin-top:18px"><button class="btn dark" onclick="openTrabalho()">+ Novo trabalho</button></div>
    <p style="font-size:13px;color:var(--muted);margin-top:6px">Fez um trabalho num prédio? Registe-o aqui com o material, as horas e as fotos.</p>`;
  }
  const ots = Object.values(S.ots);
  const porAtribuir = sortOts(ots.filter(o => o.estado !== "concluida" && !o.tecnico));
  const plans = Object.values(S.plans);
  const atrasadas = plans.filter(p => planStatus(p)[3] < 0).length;
  const late = sortOts(ots.filter(o => o.estado !== "concluida" && o.tecnico && o.data && o.data < t));
  const due = plans.filter(p => planStatus(p)[3] <= 7 && !openOtForPlan(p.id)).sort((a,b) => planNext(a).localeCompare(planNext(b)));
  const tecs = tecnicos().filter(x => x.papel === "tec");
  return `<h2>Painel <span style="display:flex;gap:8px;align-items:center"><button class="btn sm" onclick="openResumos()"><i class=ico-clip></i>Resumos</button><button class="btn sm" onclick="openSaidaDireta()"><i class=ico-box></i>Entrega de material</button><span class="mono" style="font-size:14px;color:var(--muted)">${fmtDate(t)}</span></span></h2>${installBanner()}${pushBanner()}${copiaBanner()}${meteoAviso()}
  <div class="stats">
    ${statCard(porAtribuir.length, "Por atribuir", "techF='-';otFilter='ativas';go('ordens')", true)}
    ${statCard(ots.filter(o=>o.estado==="aberta").length, "Ordens abertas", "techF='';otFilter='aberta';go('ordens')")}
    ${statCard(ots.filter(o=>o.estado==="curso").length, "Em curso", "techF='';otFilter='curso';go('ordens')")}
    ${statCard(atrasadas, "Preventivas em atraso", "go('prev')", true)}
  </div>
  ${(() => { const desde = addDays(t, -7); const tr = Object.values(S.ots).filter(o => isTrab(o) && o.estado === "concluida" && (o.concluida || "") >= desde).sort((a,b) => (b.concluida||"").localeCompare(a.concluida||""));
    if(!tr.length) return ""; window.__grp = window.__grp || {};
    return `<h3><i class=ico-wrench></i>Trabalhos registados pelos técnicos <span style="font-weight:400;text-transform:none;letter-spacing:0">— últimos 7 dias</span></h3>` + grpBlock("tr:7d", "Concluídos", `${tr.length} para imprimir no resumo da semana`, tr, `<div class="actions" style="margin:6px 0"><span class="sp"></span><button class="btn sm" onclick="otOrig='trab';otFilter='concluida';go('ordens')">Ver todos</button><button class="btn sm" onclick="openBatchPrint()"><i class=ico-print></i>Imprimir semana</button></div>`); })()}
  ${(() => { const desde = addDays(t, -7); const fe = Object.values(S.ots).filter(o => o.estado === "concluida" && !isTrab(o) && !isEntrega(o) && (o.concluida || "") >= desde).sort((a,b) => (b.concluida||"").localeCompare(a.concluida||""));
    if(!fe.length) return ""; const g = {}; for(const o of fe){ const k = isExt(o) ? "Elevadores / empresa externa" : o.tecnico ? nm(o.tecnico) : "Sem técnico"; (g[k] ||= []).push(o); }
    return `<h3><i class=ico-check></i>Ocorrências fechadas <span style="font-weight:400;text-transform:none;letter-spacing:0">— últimos 7 dias</span></h3>` + Object.entries(g).sort((a,b) => b[1].length - a[1].length).map(([k, os]) => {
      const hoje = os.filter(o => o.concluida === t).length;
      return grpBlock("fe:" + k, esc(k), [`${os.length} fechada${os.length === 1 ? "" : "s"}`, hoje ? `${hoje} hoje` : ""].filter(Boolean).join(" · "), os);
    }).join(""); })()}
  ${porAtribuir.length ? (() => { const g = {}; for(const o of porAtribuir){ const k = isExt(o) ? "Elevadores / empresa externa" : (gecResp(o) || "Sem indicação"); (g[k] ||= []).push(o); }
    window.__grp = {};
    return `<h3>Por atribuir <span style="font-weight:400;text-transform:none;letter-spacing:0">— por responsável indicado no Gecond</span></h3>` + (Object.keys(S.zonas || {}).length ? `<div class="actions" style="margin:-4px 0 8px"><span class="sp"></span><button class="btn sm" onclick="atribuirPorZona()"><i class=ico-worker></i>Atribuir ao responsável de cada zona</button></div>` : "") + Object.entries(g).sort((a,b) => b[1].length - a[1].length).map(([k, os]) => { const key = "pa:" + k; window.__grp[key] = os.map(o => o.id);
      const urg = os.filter(o => o.prioridade === "alta").length; const velhas = os.filter(o => o.data && diffDays(t, o.data) > 30).length;
      return grpBlock(key, esc(k), [urg ? `<span class="warnTxt">${urg} urgente${urg===1?"":"s"}</span>` : "", velhas ? `${velhas} com mais de 30 dias` : ""].filter(Boolean).join(" · "), os,
        `<div class="actions" style="margin:6px 0;flex-wrap:nowrap"><span style="font-size:13px;color:var(--muted);white-space:nowrap">Atribuir todas a</span><select onchange="assignMany('${esc(key)}', this.value)" style="flex:1;min-width:0;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff">${techOptions("")}</select></div>`); }).join(""); })() : ""}
  <h3>Técnicos</h3>
  ${tecs.length ? `<div class="list">${tecs.map(x => {
      const mine = ots.filter(o => o.tecnico === x.id);
      const pend = mine.filter(o => o.estado !== "concluida"); const lt = pend.filter(o => o.data && o.data < t).length;
      const curso = mine.filter(o => o.estado === "curso").length;
      return `<div class="item" onclick="techF='${x.id}';otFilter='ativas';go('ordens')"><div class="bar ${lt?"red":pend.length?"amber":"green"}"></div><div class="main"><div class="t">${esc(x.nome)}</div><div class="s">${pend.length} pendente${pend.length===1?"":"s"} · ${curso} em curso</div></div><div class="r">${lt?`<span class="badge b-red">${lt} em atraso</span>`:""}</div></div>`;
    }).join("")}</div>` : emptyBox("Ainda não há técnicos. Crie as contas no separador <b>Equipa</b>.", `<button class="btn pri" onclick="go('equipa')">Ir para Equipa</button>`)}
  ${late.length ? `<h3>Em atraso</h3>` + (() => { const g = {}; for(const o of late) (g[nm(o.tecnico)] ||= []).push(o); return Object.entries(g).sort((a,b) => b[1].length - a[1].length).map(([k, os]) => grpBlock("at:" + k, esc(k), "", os)).join(""); })() : ""}
  ${due.length?`<h3>Preventivas a lançar</h3>` + (() => { const g = {}; for(const p of due){ const k = p.tecnico ? nm(p.tecnico) : "Sem técnico"; (g[k] ||= []).push(p); }
    const linha = p => `<div class="item"><div class="bar ${planStatus(p)[2]}"></div><div class="main" onclick="openPlan('${p.id}')"><div class="t">${esc(p.titulo)}</div><div class="s">${esc(cName(condoOf(p)))} · ${fmtDate(planNext(p))}</div></div><div class="r"><button class="btn sm pri" onclick="genFromPlan('${p.id}')">Criar ordem</button></div></div>`;
    return Object.entries(g).sort((a, b) => (a[0] === "Sem técnico") - (b[0] === "Sem técnico") || b[1].length - a[1].length).map(([k, ps]) => { const key = "pv:" + k; const ab = grpOpen.has(key); const atr = ps.filter(p => planStatus(p)[3] < 0).length;
      return `<details class="pgrp" ${ab ? "open" : ""} ontoggle="grpToggle('${esc(key)}', this.open)"><summary><span class="pg-t">${esc(k)}</span><span class="badge">${ps.length}</span>${atr ? `<span class="pg-s"><span class="warnTxt">${atr} em atraso</span></span>` : `<span class="pg-s">próxima a ${fmtDate(planNext(ps[0]))}</span>`}</summary>${ab ? `<div class="list" style="padding:6px">${ps.map(linha).join("")}</div>` : ""}</details>`; }).join(""); })() : ""}
  <div class="actions" style="margin-top:18px"><button class="btn dark" onclick="editOt()">+ Nova ordem de trabalho</button><button class="btn" onclick="openBatchPrint()"><i class=ico-print></i>Imprimir relatórios da semana</button></div>`;
}

// Trabalho registado por um técnico no local (não veio do escritório nem do Gecond).
const isTrab = o => !!o.criadoPor && (S.equipa[o.criadoPor] || {}).papel === "tec" && !(o.descricao || "").startsWith("Ocorrência Gecond");
let otOrig = "";
function viewOrdens(){
  const f = {ativas:o=>o.estado!=="concluida", aberta:o=>o.estado==="aberta", curso:o=>o.estado==="curso", concluida:o=>o.estado==="concluida", todas:()=>true}[otFilter] || (()=>true);
  const tf = !IS_ADMIN || !techF ? () => true : techF === "-" ? o => !o.tecnico : o => o.tecnico === techF;
  const fo = !IS_ADMIN || !otOrig ? () => true : otOrig === "trab" ? isTrab : otOrig === "entr" ? isEntrega : o => !isTrab(o) && !isEntrega(o);
  const base = otsSorted().filter(f).filter(tf).filter(o => !condoF || condoOf(o) === condoF);
  const nTrab = base.filter(isTrab).length, nEntrB = base.filter(isEntrega).length;
  const nEntr = otsSorted().filter(tf).filter(isEntrega).filter(o => !condoF || condoOf(o) === condoF).length;
  const list = otsSorted().filter(otOrig === "entr" ? () => true : f).filter(tf).filter(fo).filter(o => !condoF || condoOf(o) === condoF).filter(o => !q || hit([numOt(o), o.numero, o.titulo, cName(condoOf(o)), whereTxt(o), o.solicitante, o.descricao, o.notas, IS_ADMIN ? nm(o.tecnico) : ""].join(" "), q));
  const chips = [["ativas","Pendentes"],["aberta","Abertas"],["curso","Em curso"],["concluida","Concluídas"],["todas","Todas"]];
  const any = myOts().length;
  return `<h2>${IS_ADMIN?"Ordens de trabalho":"As minhas ordens"} <span style="display:flex;gap:6px">${IS_ADMIN?'<button class="btn sm" onclick="openSaidaDireta()"><i class=ico-box></i>Entrega de material</button>':""}${IS_ADMIN?'<button class="btn sm" onclick="openPendPrint()"><i class=ico-print></i>Por fechar</button><button class="btn sm" onclick="openBatchPrint()"><i class=ico-print></i>Imprimir semana</button>':""}<button class="btn pri sm" onclick="${IS_ADMIN ? "editOt()" : "openTrabalho()"}">+ ${IS_ADMIN?"Nova":"Novo trabalho"}</button></span></h2>
  ${IS_ADMIN ? `<div class="seg" style="margin-bottom:10px">${[["","Tudo", base.length],["ocorr","<i class=ico-clip></i>Ocorrências", base.length - nTrab - nEntrB],["trab","<i class=ico-wrench></i>Trabalhos dos técnicos", nTrab],["entr","<i class=ico-box></i>Entregas", nEntr]].map(([k, l, n]) => `<button class="${otOrig===k?"on":""}" onclick="otOrig='${k}';listMax=50;render()">${l} <span class="mono" style="opacity:.7">${n}</span></button>`).join("")}</div>` : ""}
  ${otOrig === "entr" ? "" : `<div class="chips">${chips.map(([k,l])=>`<button class="chip ${otFilter===k?"on":""}" onclick="otFilter='${k}';render()">${l}</button>`).join("")}</div>`}
  <div class="frow">${techFilterSel()}${condoFilterSel()}</div>
  <input class="search" placeholder="Procurar por nº, título, condomínio, zona…" value="${esc(q)}" oninput="q=this.value;renderListOnly()">
  <div class="${IS_ADMIN && techF && techF !== "-" && otOrig !== "entr" && list.length ? "" : IS_ADMIN ? "pgrp plain" : "list"}" id="lst">${list.length ? (IS_ADMIN && techF && techF !== "-" && otOrig !== "entr" ? porTipoAdm(list) : IS_ADMIN ? `<div class="plist">${list.slice(0, listMax).map(o => otRow(o, !!condoF)).join("")}</div>${list.length > listMax ? `<div class="actions" style="justify-content:center;margin:8px 0"><button class="btn" onclick="listMax+=100;renderListOnly()">Mostrar mais (${list.length - listMax} restantes)</button></div>` : ""}` : list.map(o=>otItem(o, !!condoF)).join("")) : emptyBox(any?"Nenhuma ordem corresponde ao filtro.":(IS_ADMIN?"Ainda não há ordens de trabalho.":"Ainda não tem ordens atribuídas."))}</div>`;
}

let prevF = "", prevTec = "", prevQ = "", prevOpen = null;
const semanaDe = d => { const x = new Date(d + "T12:00:00"); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return iso(x); };
function viewPrev(){
  const t = today();
  const all = Object.values(S.plans).filter(p => !condoF || condoOf(p) === condoF)
    .filter(p => !prevTec || (prevTec === "-" ? !p.tecnico : p.tecnico === prevTec))
    .filter(p => !prevQ || hit([cName(condoOf(p)), p.titulo, nm(p.tecnico)].join(" "), prevQ));
  const dd = p => diffDays(planNext(p), t);
  const cnt = { atraso: all.filter(p => dd(p) < 0).length, semana: all.filter(p => dd(p) <= 7).length, mes: all.filter(p => dd(p) <= 30).length, "": all.length };
  if(prevF === null || prevF === undefined) prevF = "";
  const list = all.filter(p => prevF === "atraso" ? dd(p) < 0 : prevF === "semana" ? dd(p) <= 7 : prevF === "mes" ? dd(p) <= 30 : true).sort((a,b) => planNext(a).localeCompare(planNext(b)) || cName(condoOf(a)).localeCompare(cName(condoOf(b)), "pt", {numeric:true}));
  const groups = []; const gi = {};
  for(const p of list){ const n = planNext(p); const k = n < t ? "atraso" : semanaDe(n); if(!(k in gi)){ gi[k] = groups.length; groups.push([k, []]); } groups[gi[k]][1].push(p); }
  if(prevOpen === null) prevOpen = new Set(prevF === "atraso" || prevF === "semana" ? groups.map(g => g[0]) : []);
  const tecs = [...new Set(Object.values(S.plans).map(p => p.tecnico || ""))];
  const fmtCurto = d => d.slice(8, 10) + "/" + d.slice(5, 7);
  return `<h2>Manutenção preventiva <button class="btn pri sm" onclick="editPlan()">+ Novo plano</button></h2>
  <div class="chips">${[["atraso","Em atraso"],["semana","Esta semana"],["mes","Próximos 30 dias"],["","Todas"]].map(([k,l]) => `<button class="chip ${prevF===k?"on":""}" onclick="prevF='${k}';prevOpen=null;render()">${l} <span class="mono" style="opacity:.7">${cnt[k]}</span></button>`).join("")}</div>
  <div class="grid2" style="gap:8px"><input class="search" placeholder="Procurar prédio…" value="${esc(prevQ)}" oninput="prevQ=this.value;prevOpen=null;renderListOnly()" style="margin:0">
  <select class="search" style="margin:0" onchange="prevTec=this.value;prevOpen=null;render()"><option value="">Todos os técnicos</option>${tecs.includes("") ? `<option value="-" ${prevTec==="-"?"selected":""}>Sem técnico</option>` : ""}${pessoasAgrupadas(prevTec)}</select></div>
  ${condoF ? `<div class="note" style="margin-top:8px">Filtrado por ${esc(cName(condoF))} <button class="btn sm" onclick="condoF='';render()">Ver todos</button></div>` : ""}
  <div id="lst" style="margin-top:10px">${groups.length ? groups.map(([k, ps]) => {
    const label = k === "atraso" ? "Em atraso" : (() => { const fim = addDays(k, 6); return `Semana de ${fmtCurto(k)} a ${fmtCurto(fim)}${k === semanaDe(t) ? " (esta semana)" : ""}`; })();
    const porTec = {}; for(const p of ps){ const n = p.tecnico ? nm(p.tecnico).split(" ")[0] : "sem técnico"; porTec[n] = (porTec[n] || 0) + 1; }
    const semOrdem = ps.filter(p => !openOtForPlan(p.id));
    const aberto = prevOpen.has(k) || !!prevQ || !!condoF;
    return `<details class="pgrp" ${aberto ? "open" : ""} ontoggle="prevToggle('${k}', this.open)"><summary><span class="pg-t ${k === "atraso" ? "warnTxt" : ""}">${label}</span><span class="badge">${ps.length}</span><span class="pg-s">${Object.entries(porTec).map(([n, c]) => `${esc(n)} ${c}`).join(" · ")}</span></summary>
      ${semOrdem.length ? `<div class="actions" style="margin:6px 0"><span style="font-size:13px;color:var(--muted)">${semOrdem.length} sem ordem criada</span><span class="sp"></span><button class="btn sm" onclick="event.stopPropagation();genPlans('${k}')">Criar ${semOrdem.length} ${semOrdem.length === 1 ? "ordem" : "ordens"}</button></div>` : ""}
      <div class="plist">${ps.map(p => { const st = planStatus(p); const o = openOtForPlan(p.id); return `<div class="prow" onclick="openPlan('${p.id}')"><span class="mono pd">${fmtCurto(planNext(p))}</span><span class="pn">${esc(cName(condoOf(p)))}<small>${esc(p.titulo)}${p.tecnico ? " · " + esc(nm(p.tecnico)) : ""}</small></span>${o ? `<span class="badge b-blue">Ordem ${esc(numOt(o) || "")}</span>` : `<span class="badge ${st[1]}">${st[0]}</span>`}</div>`; }).join("")}</div></details>`;
  }).join("") : emptyBox(Object.keys(S.plans).length ? (prevF === "semana" || prevF === "atraso" ? "Nada para esta semana." : "Nenhum plano com estes filtros.") + (prevF ? ` <button class="btn sm" onclick="prevF='';render()">Ver todas</button>` : "") : "Crie planos periódicos — ex.: ronda mensal às áreas comuns — com um técnico responsável.", Object.keys(S.plans).length ? "" : '<button class="btn pri" onclick="editPlan()">+ Criar plano</button>')}</div>`;
}
function prevToggle(k, open){ if(!prevOpen) prevOpen = new Set(); if(open) prevOpen.add(k); else prevOpen.delete(k); }
function genPlans(k){
  const t = today();
  const ps = Object.values(S.plans).filter(p => { const n = planNext(p); return (k === "atraso" ? n < t : n >= t && semanaDe(n) === k) && !openOtForPlan(p.id); })
    .filter(p => !condoF || condoOf(p) === condoF).filter(p => !prevTec || (prevTec === "-" ? !p.tecnico : p.tecnico === prevTec));
  for(const p of ps){
    const tec = p.tecnico || "";
    put("ots", {id:newId(), titulo:p.titulo, condoId:condoOf(p), equipId:p.equipId||"", zona:p.zona||"", tecnico:tec, tipo:"preventiva", prioridade:"media", estado:"aberta", data: planNext(p) < t ? t : planNext(p), descricao:"", solicitante:"", planId:p.id, checklist:(p.checklist||[]).map(x=>({t:x, ok:false})), pecas:[], fotos:[], notas:"", tempo:0, criada: t, criadaEm: nowIso(), criadoPor: ME, atribuida: tec ? t : "", atribuidaEm: tec ? nowIso() : "", atribuidoPor: tec ? ME : ""});
  }
  toast(ps.length + (ps.length === 1 ? " ordem criada." : " ordens criadas.") + (ps.some(p => !p.tecnico) ? " Algumas ficaram por atribuir." : ""));
  render();
}

let condoPend = false;
// Concelho de cada prédio: FL é sempre Felgueiras; os outros pela morada (freguesias juntas ao seu concelho).
const LOCALIDADES = [
  ["Vizela", ["vizela", "guimaraes", "moreira de conegos", "riba d'ave", "riba d ave", "riba de ave", "famalicao"]],
  ["Marco de Canaveses", ["marco de canaveses"]],
  ["Lousada", ["lousada", "lustosa", "lodares", "silvares", "barrosas", "sousela", "covas - lsd", "covas -lsd"]],
  ["Felgueiras", ["felgueiras", "idaes", "margaride", "pedreira", "revinhade"]],
  ["Penafiel", ["penafiel", "guilhufe", "urro", "irivo", "galegos", "marecos", "rio de moinhos"]],
  ["Paredes", ["paredes", "lordelo", "cristelo", "madalena", "castelões de cepeda", "casteloes de cepeda", "rebordosa"]],
  ["Freamunde", ["freamunde"]],
  ["Paços de Ferreira", ["pacos de ferreira", "pacos ferreira", "carvalhosa", "figueiro", "raimonda", "codessos", "ferreira"]],
  ["Porto", ["valongo", "alfena", "ermesinde", "rio tinto", "sao pedro da cova", "gondomar", "aguas santas", "maia", "santo tirso", "s. martinho", "sao martinho", "porto"]],
];
const semAcento = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function localidade(c){
  if(/^FL/i.test(c.codigo || "")) return "Felgueiras";
  const m = String(c.morada || ""); const cp = /\d{4}\s*-\s*\d{3}\s*,?\s*(.+)$/.exec(m) || /\b\d{4}\b\s*-?\s*([^\d,]+)$/.exec(m);
  const partes = [cp ? cp[1] : "", m.split(",").pop(), m];
  for(const parte of partes){ const t = semAcento(parte); if(!t.trim()) continue; for(const [nome, chaves] of LOCALIDADES) if(chaves.some(k => t.includes(semAcento(k)))) return nome; }
  return "Outras";
}
/* ---------- responsáveis por zona ---------- */
const respZona = cid => { const c = S.condos[cid]; const t = c && (S.zonas || {})[localidade(c)]; return t && S.equipa[t] && S.equipa[t].ativo ? t : ""; };
const zonasLista = () => { const g = {}; for(const c of Object.values(S.condos)){ const z = localidade(c); g[z] = (g[z] || 0) + 1; } return Object.entries(g).sort((a, b) => b[1] - a[1]); };
const tecsOnly = () => tecnicos().filter(t => t.papel !== "admin");
function zonasPanel(){
  if(!IS_ADMIN) return "";
  const zs = zonasLista(); const def = zs.filter(([z]) => respZona(Object.values(S.condos).find(c => localidade(c) === z)?.id)).length;
  const key = "zr"; const aberto = grpOpen.has(key);
  const semTec = !tecsOnly().length;
  return `<details class="pgrp" ${aberto ? "open" : ""} ontoggle="grpToggle('${key}', this.open)"><summary><span class="pg-t"><i class=ico-worker></i>Responsáveis por zona</span><span class="badge">${def}/${zs.length}</span><span class="pg-s">${def ? "Ordens e rondas novas vão para o responsável da zona" : "Ainda sem responsáveis"}</span></summary>
    <div style="padding:4px 12px 10px">
      ${!S.zonasOk ? `<div class="note" style="font-size:13px">Falta preparar a base de dados (ficheiro ZONAS).</div>` : ""}
      ${semTec ? `<div class="note" style="font-size:13px">Ainda não há técnicos registados. Crie as contas em Equipa e depois escolha aqui o responsável de cada zona.</div>` : ""}
      ${zs.map(([z, n]) => `<div class="trow"><span>${esc(z)} <small>${n} prédios</small></span><select style="max-width:55%;border:1px solid var(--line);border-radius:10px;padding:7px 8px;background:#fff" onchange="setZonaResp(${esc(JSON.stringify(z))}, this.value)" ${semTec || !S.zonasOk ? "disabled" : ""}><option value="">— Ninguém —</option>${tecsOnly().map(t => `<option value="${t.id}" ${(S.zonas || {})[z] === t.id ? "selected" : ""}>${esc(t.nome)}</option>`).join("")}</select></div>`).join("")}
      <div class="hint">Uma ocorrência ou ronda nova num prédio da zona fica logo atribuída ao responsável (pode sempre mudar à mão).</div>
    </div></details>`;
}
async function setZonaResp(z, tec){
  if(!IS_ADMIN) return;
  const antes = (S.zonas || {})[z] || "";
  const { error } = tec ? await sb.from("zonas_resp").upsert({ zona: z, tecnico: tec }) : await sb.from("zonas_resp").delete().eq("zona", z);
  if(error){ writeErr(error); render(); return; }
  S.zonas = { ...(S.zonas || {}) }; if(tec) S.zonas[z] = tec; else delete S.zonas[z];
  render();
  if(!tec){ toast(z + " ficou sem responsável."); return; }
  const naZona = cid => { const c = S.condos[cid]; return c && localidade(c) === z; };
  const elegivel = t => !t || t === antes;
  const ots = Object.values(S.ots).filter(o => o.estado !== "concluida" && !isExt(o) && !isEntrega(o) && naZona(condoOf(o)) && elegivel(o.tecnico) && o.tecnico !== tec);
  const pls = Object.values(S.plans).filter(p => naZona(condoOf(p)) && elegivel(p.tecnico) && p.tecnico !== tec);
  if(!ots.length && !pls.length){ toast(nm(tec) + " é agora o responsável de " + z + "."); return; }
  window.__zmov = { tec, ots: ots.map(o => o.id), pls: pls.map(p => p.id) };
  openSheet("Responsável de " + esc(z), `<p style="margin-top:0"><b>${esc(nm(tec))}</b> é agora o responsável de ${esc(z)}.</p>
    <p>Quer passar-lhe também o que já existe nesta zona${antes ? ` (que estava com ${esc(nm(antes))} ou sem ninguém)` : " e ainda não tem ninguém"}?</p>
    <div class="panel"><div class="parts"><div class="part"><span class="n">Ordens abertas</span><span class="mono">${ots.length}</span></div><div class="part"><span class="n">Rondas / planos preventivos</span><span class="mono">${pls.length}</span></div></div></div>
    <div class="actions"><button class="btn" onclick="closeSheet()">Não, só as novas</button><span class="sp"></span><button class="btn pri" onclick="passarZona()">Sim, passar tudo</button></div>`);
}
function passarZona(){
  const m = window.__zmov; if(!m) return; closeSheet();
  for(const id of m.ots) updOt(id, { tecnico: m.tec, atribuida: today(), atribuidaEm: nowIso(), atribuidoPor: ME }, true);
  for(const id of m.pls){ const p = S.plans[id]; if(p) put("plans", { ...p, tecnico: m.tec }, true); }
  render(); const pl = (n, a, b) => n + " " + (n === 1 ? a : b); toast(pl(m.ots.length, "ordem", "ordens") + " e " + pl(m.pls.length, "plano", "planos") + " passaram para " + nm(m.tec) + ".");
}
function atribuirPorZona(){
  const ots = Object.values(S.ots).filter(o => !o.tecnico && o.estado !== "concluida" && !isExt(o) && respZona(condoOf(o)));
  if(!ots.length){ toast("Não há ordens por atribuir em zonas com responsável."); return; }
  for(const o of ots) updOt(o.id, { tecnico: respZona(condoOf(o)), atribuida: today(), atribuidaEm: nowIso(), atribuidoPor: ME }, true);
  render(); toast(ots.length === 1 ? "1 ordem atribuída ao responsável da zona." : ots.length + " ordens atribuídas ao responsável da zona.");
}
function viewCondos(){
  const mine = myOts();
  const pendOf = {}; for(const o of mine) if(o.estado !== "concluida"){ const c = condoOf(o); pendOf[c] = (pendOf[c] || 0) + 1; }
  const lateOf = {}; if(IS_ADMIN) for(const p of Object.values(S.plans)) if(planStatus(p)[3] < 0){ const c = condoOf(p); lateOf[c] = (lateOf[c] || 0) + 1; }
  const list = condosSorted().filter(c => !q || hit([c.codigo,c.nome,c.morada,c.admin,c.nif].join(" "), q)).filter(c => !condoPend || pendOf[c.id]);
  const nPend = condosSorted().filter(c => pendOf[c.id]).length;
  const row = c => `<div class="prow" onclick="openCondo('${c.id}')"><span class="mono pd" style="color:var(--accent);font-weight:600;min-width:52px">${esc(c.codigo || "")}</span><span class="pn">${esc(c.nome)}<small>${esc(c.morada || "")}</small></span>${pendOf[c.id] ? `<span class="badge b-amber">${pendOf[c.id]}</span>` : ""}${lateOf[c.id] ? `<span class="badge b-red">${lateOf[c.id]} prev.</span>` : ""}</div>`;
  const zona = c => ((c.codigo || "").match(/^[A-Z]+/) || ["Outros"])[0];
  const terra = cs => { const n = {}; for(const c of cs){ const m = /\d{4}-\d{3}\s+(.+)$/.exec(c.morada || ""); if(m){ const t = m[1].trim(); n[t] = (n[t] || 0) + 1; } } const e = Object.entries(n).sort((a,b) => b[1] - a[1]); return e.length ? e[0][0] : ""; };
  let body;
  if(!list.length) body = emptyBox(Object.keys(S.condos).length ? "Nenhum condomínio encontrado." : "Ainda não há condomínios.");
  else if(q || list.length <= 15) body = `<div class="pgrp plain"><div class="plist">${list.map(row).join("")}</div></div>`;
  else {
    const g = {}; for(const c of list) (g[localidade(c)] ||= []).push(c);
    const nomeOrd = c => semAcento(c.nome).replace(/^(condominio\s+)?(edificio|edficio|edíficio|ed\.|urb\.?|urbanizacao)\s*/i, "").replace(/^[\s\-–—.]+/, "");
    for(const k in g) g[k].sort((a, b) => nomeOrd(a).localeCompare(nomeOrd(b), "pt", { numeric: true }));
    body = Object.entries(g).sort((a, b) => a[0] === "Outras" ? 1 : b[0] === "Outras" ? -1 : b[1].length - a[1].length).map(([z, cs]) => { const key = "cz:" + z; const aberto = grpOpen.has(key); const np = cs.reduce((a, c) => a + (pendOf[c.id] ? 1 : 0), 0);
      const cods = [...new Set(cs.map(zona))].join(", ");
      return `<details class="pgrp cz" ${aberto ? "open" : ""} ontoggle="grpToggle('${esc(key)}', this.open)"><summary><span class="pg-t">${esc(z)} <span class="mono" style="color:var(--muted);font-weight:400;font-size:12px">${esc(cods)}</span>${IS_ADMIN && (S.zonas || {})[z] ? ` <span style="font-weight:500;font-size:12.5px;color:var(--blue)"><i class=ico-worker></i>${esc(nm(S.zonas[z]))}</span>` : ""}</span><span class="badge">${cs.length}</span>${np ? `<span class="badge b-amber" title="Prédios com ordens pendentes">${np} c/ pendentes</span>` : ""}</summary>${aberto ? `<div class="plist">${cs.map(row).join("")}</div>` : ""}</details>`; }).join("");
  }
  return `<h2>Condomínios <span class="mono" style="font-size:14px;color:var(--muted);margin-right:auto;margin-left:8px">${Object.keys(S.condos).length}</span>${IS_ADMIN?'<button class="btn pri sm" onclick="editCondo()">+ Novo</button>':""}</h2>
  <div class="chips"><button class="chip ${!condoPend?"on":""}" onclick="condoPend=false;render()">Todos</button><button class="chip ${condoPend?"on":""}" onclick="condoPend=true;render()">Com ordens pendentes <span class="mono" style="opacity:.7">${nPend}</span></button></div>
  ${zonasPanel()}
  <input class="search" placeholder="Procurar por código, nome, morada ou NIF…" value="${esc(q)}" oninput="q=this.value;renderListOnly()">
  <div id="lst" class="${!q && list.length > 15 ? "czgrid" : ""}">${body}</div>`;
}

function viewEquipa(){
  const all = pessoas(); const ots = Object.values(S.ots); const t = today();
  return `<h2>Equipa <button class="btn pri sm" onclick="newUser()">+ Novo utilizador</button></h2>
  <div class="list">${all.map(x => {
    const mine = ots.filter(o => o.tecnico === x.id);
    const pend = mine.filter(o => o.estado !== "concluida").length;
    const mes = mine.filter(o => o.estado === "concluida" && (o.concluida||"").slice(0,7) === t.slice(0,7)).length;
    return `<div class="item" onclick="openPessoa('${x.id}')" style="${x.ativo?"":"opacity:.55"}"><div class="bar ${x.papel==="admin"?"amber":"blue"}"></div><div class="main"><div class="t">${esc(x.nome)}${x.id===ME?" (eu)":""}${x.ativo?"":' <span class="badge">Desativado</span>'}${x.oculto?' <span class="badge" style="background:#e8eef7;color:var(--blue)"><i class=ico-lock></i>Só eu vejo</span>':""}${x.soRegistaMaterial?' <span class="badge">Só material</span>':""}</div><div class="s">${x.papel==="admin"?"Administrativo":"Técnico"} · ${esc(x.email||"")}</div><div class="s"><i class=ico-mobile></i>${x.telefone?esc(x.telefone):'<span class="warnTxt">sem número</span>'} · <i class=ico-sign></i>${x.assinatura?"assinatura guardada":'<span class="warnTxt">sem assinatura</span>'}</div>${x.papel==="tec"?`<div class="s">${pend} pendente${pend===1?"":"s"} · ${mes} concluída${mes===1?"":"s"} este mês</div>`:""}</div></div>`;
  }).join("")}</div>
  ${VE_STOCK() ? `<div class="actions" style="margin:8px 0 4px"><button class="btn" onclick="verAcessos()"><i class=ico-lock></i>Acessos à app (só eu vejo)</button></div>` : ""}
  ${VE_STOCK() ? precosPanel() : ""}
  ${VE_STOCK() ? empresaPanel() : ""}
  <h3>Dados</h3>
  <div class="panel" style="font-size:14px">O plano gratuito do Supabase <b>não faz cópias de segurança</b>. Faça uma cópia <b>uma vez por semana</b> e guarde o ficheiro fora do computador (pen, Google Drive, OneDrive ou e-mail para si próprio). Se um dia for preciso, os dados repõem-se a partir deste ficheiro.
    <div style="margin-top:8px;color:var(--muted)">Última cópia neste aparelho: <b>${ultimaCopia() ? fmtDate(ultimaCopia()) : "nunca"}</b> · Fotografias: ${Object.values(S.ots).reduce((a, o) => a + (o.fotos || []).length, 0)} (cerca de ${Math.round(Object.values(S.ots).reduce((a, o) => a + (o.fotos || []).length, 0) * 0.18)} MB de 1 000 MB gratuitos)</div>
    <div style="margin-top:6px;color:var(--muted)">O Supabase suspende projetos gratuitos sem uso durante uma semana — em férias, abra a app pelo menos uma vez por semana.</div>
  <div class="actions" style="margin-top:10px"><button class="btn pri" onclick="backupCompleto(this)"><i class=ico-save></i>Fazer cópia de segurança</button><button class="btn" onclick="exportCSV()">Exportar ordens (Excel/CSV)</button></div></div>`;
}

const VERSAO = (() => { try{ return new URL(import.meta.url).searchParams.get("v") || ""; }catch(_){ return ""; } })();
const versaoHtml = () => VERSAO ? `<div class="versao">Versão ${esc(VERSAO)}</div>` : "";
const prLogo = () => (S.empresa || {}).logo ? `<img src="${esc(S.empresa.logo)}" alt="">` : "";
// caixa em branco para apontar à mão o(s) nº(s) de lançamento no Gecond
const gecondBox = () => `<br><span class="gecl">Lançamento Gecond: <span></span></span>`;
const prMarca = () => { const e = S.empresa || {}; return e.nome ? " · " + esc(e.nome) + (e.subtitulo ? " — " + esc(e.subtitulo) : "") : ""; };
const eurIn = (val, on, ph = "0,00") => `<span class="eurin"><input inputmode="decimal" value="${val}" placeholder="${ph}" onchange="${on}"><span>€</span></span>`;
const numPt = v => v === undefined || v === null || v === "" || isNaN(Number(v)) ? "" : Number(v).toFixed(2).replace(".", ",");
let matQ = "";
function precosPanel(){
  const T = S.tarifas;
  return `<div class="duo"><div><h3>Tarifas</h3>
  <div class="panel tarifas">
    <div class="trow"><span>Mão de obra <small>por hora</small></span>${eurIn(numPt(T.hora), "setTarifa('hora', this.value)")}</div>
    <div class="trow"><span>Deslocação <small>por deslocação</small></span>${eurIn(numPt(T.deslocacao), "setTarifa('deslocacao', this.value)")}</div>
    <div class="trow"><span>Manutenção A</span>${eurIn(numPt(T.extraA), "setTarifa('extraA', this.value)")}</div>
    <div class="trow"><span>Manutenção E</span>${eurIn(numPt(T.extraE), "setTarifa('extraE', this.value)")}</div>
    <div class="hint">Tarifas próprias de um técnico (ex.: Duarte, 40 € + 20 €/h, sem deslocações): abra o técnico na lista acima.</div>
  </div></div>
  <div><h3>Preços dos materiais <span class="mono" style="font-weight:500">${matList().length}</span></h3>
  <div class="panel mats">
    ${gruposMat().map(g => { const nome = g; const l = matList().filter(m => grupoMat(m) === g); if(!l.length) return "";
      const ps = l.map(m => S.precos[m.codigo]).filter(v => v !== undefined && v !== null);
      const faixa = ps.length ? (Math.min(...ps) === Math.max(...ps) ? numPt(ps[0]) : numPt(Math.min(...ps)) + "–" + numPt(Math.max(...ps))) + " €" : "sem preços";
      const aberto = matOpen.has(g);
      return `<div class="mgrp${aberto ? " on" : ""}" onclick="togMat(${esc(JSON.stringify(g))})"><b>${aberto ? "▾" : "▸"} ${esc(nome)}</b><span>${l.length} ${l.length === 1 ? "material" : "materiais"}${aberto ? "" : " · " + faixa}</span></div>
      ${aberto ? l.map(m => `<div class="mrow"><div class="mn" onclick="matSel=matSel==='${esc(m.codigo)}'?'':'${esc(m.codigo)}';render()"><div class="t">${esc(m.nome)}</div>${matSel === m.codigo ? `<div class="c">${esc(m.codigo)} · <button class="mx" onclick="event.stopPropagation();armMat(this,'${esc(m.codigo)}')">Retirar</button></div>
          <select class="mgsel" onclick="event.stopPropagation()" onchange="mudarGrupo('${esc(m.codigo)}', this.value)"><option value="">Mudar de grupo…</option>${gruposMat().filter(x => x !== g).map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}<option value="__novo">+ Novo grupo…</option></select>${S.matFornCol ? `<input class="mforn" placeholder="Fornecedor (ex.: Leroy Merlin)" list="dl_mforn" value="${esc(m.fornecedor || "")}" onclick="event.stopPropagation()" onchange="mudarForn('${esc(m.codigo)}', this.value)">` : ""}` : (m.fornecedor ? `<div class="c">${esc(m.fornecedor)}</div>` : "")}</div>${eurIn(numPt(S.precos[m.codigo]), `setPreco('${esc(m.codigo)}', this.value)`)}</div>`).join("") : ""}`; }).join("")}
    ${dlForn()}
    <details class="mnovo"><summary>+ Novo material</summary>
      <div class="grid2" style="margin-top:8px"><label class="f" style="margin:0"><span>Código</span><input id="m_cod" placeholder="Ex.: LAMP-E27" style="text-transform:uppercase"></label>
      <label class="f" style="margin:0"><span>Descrição</span><input id="m_nome" placeholder="Ex.: Lâmpada E27"></label></div>
      <label class="f" style="margin:8px 0 0"><span>Grupo</span><select id="m_grp" onchange="onGrpSel(this.value)">${gruposMat().map(x => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}<option value="__novo">+ Novo grupo…</option></select></label>
      <label class="f" id="m_grp_novo_w" style="margin:8px 0 0;display:none"><span>Nome do novo grupo</span><input id="m_grp_novo" placeholder="Ex.: Canalização"></label>
      ${S.matFornCol ? `<label class="f" style="margin:8px 0 0"><span>Fornecedor</span><input id="m_forn" list="dl_mforn" placeholder="Onde se compra (ex.: Leroy Merlin)"></label>` : ""}
      <div class="actions" style="margin-top:8px"><span class="sp"></span><button class="btn pri sm" onclick="addMat()">Adicionar</button></div>
    </details>
  </div></div></div>`;
}
// Grupos dos materiais: campo "grupo" (nome livre). Sem o campo, deduz-se pelo código.
const GRUPOS_BASE = ["Limpeza", "Placas", "Iluminação"];
function grupoMat(m){
  if(m.grupo) return m.grupo;
  const o = Number(m.ordem) || 0;
  if(o >= 900) return "Outros"; if(o >= 300) return "Iluminação"; if(o >= 200) return "Placas"; if(o >= 100) return "Limpeza";
  const t = (m.codigo + " " + m.nome).toUpperCase();
  if(/LAMP|FOCO|LÂMPADA|LED/.test(t)) return "Iluminação";
  if(/PLACA|QUADRO|SINAL/.test(t)) return "Placas";
  if(/DET|LIX|LIMPA|DESENTUP|DETERG/.test(t)) return "Limpeza";
  return "Outros";
}
const gruposMat = () => [...new Set([...matList().map(grupoMat), ...GRUPOS_BASE])].sort((a, b) => a.localeCompare(b, "pt"));
function onGrpSel(v){ const w = document.getElementById("m_grp_novo_w"); if(w) w.style.display = v === "__novo" ? "" : "none"; if(v === "__novo") setTimeout(() => { const e = document.getElementById("m_grp_novo"); if(e) e.focus(); }, 0); }
async function mudarForn(codigo, f){
  if(!VE_STOCK()) return; f = (f || "").trim();
  const { error } = await sb.from("materiais").update({ fornecedor: f }).eq("codigo", codigo); if(error) return writeErr(error);
  S.mat[codigo] = { ...S.mat[codigo], fornecedor: f }; toast(f ? "Fornecedor: " + f + "." : "Fornecedor retirado.");
}
async function mudarGrupo(codigo, g){
  if(!VE_STOCK()) return;
  if(g === "__novo"){ g = (prompt("Nome do novo grupo:") || "").trim(); if(!g){ render(); return; } }
  if(!S.matGrupoCol){ toast("Falta preparar a base de dados para grupos novos (ficheiro GRUPOS)."); render(); return; }
  const { error } = await sb.from("materiais").update({ grupo: g }).eq("codigo", codigo); if(error) return writeErr(error);
  S.mat[codigo] = { ...S.mat[codigo], grupo: g }; matOpen.add(g); matSel = ""; render(); toast("Passou para " + g + ".");
}
let matOpen = new Set(), matSel = "";
function togMat(g){ matOpen.has(g) ? matOpen.delete(g) : matOpen.add(g); const y = scroller().scrollTop; render(); scroller().scrollTop = y; }
function armMat(btn, codigo){
  if(btn.classList.contains("arm")){ rmMat(codigo); return; }
  btn.classList.add("arm"); btn.textContent = "Confirmar retirar";
  setTimeout(() => { if(btn.isConnected){ btn.classList.remove("arm"); btn.textContent = "Retirar"; } }, 4000);
}
/* ---------- registo de acessos (só o dono vê) ---------- */
const aparelho = () => { const u = navigator.userAgent;
  const tipo = isIOS ? (/ipad/i.test(u) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "iPad" : "iPhone") : /android/i.test(u) ? "Android" : /windows/i.test(u) ? "Computador (Windows)" : /mac os/i.test(u) ? "Computador (Mac)" : "Computador";
  const app = matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "app" : "navegador";
  return tipo + " · " + app; };
async function registarAcesso(){
  try{
    const k = "ultAcesso:" + ME, ult = Number(localStorage.getItem(k) || 0);
    if(Date.now() - ult < 30 * 60 * 1000) return;           // no máximo um registo a cada 30 min por aparelho
    const { error } = await sb.from("acessos").insert({ user_id: ME, aparelho: aparelho() });
    if(!error) localStorage.setItem(k, String(Date.now()));
  }catch(_){}
}
document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible" && mode === "ok") registarAcesso(); });
let acessos = null;
async function verAcessos(){
  if(!VE_STOCK()) return;
  const desde = new Date(Date.now() - 30 * 86400e3).toISOString();
  const { data, error } = await sb.from("acessos").select("*").gte("quando", desde).order("quando", { ascending: false }).limit(1000);
  if(error){ toast(/acessos/.test(error.message || "") ? "Falta preparar a base de dados (ficheiro ACESSOS)." : "Não foi possível ler os acessos."); return; }
  acessos = (data || []).filter(a => a.quando && !isNaN(Date.parse(a.quando))); abrirAcessos();
}
function abrirAcessos(filtro){
  const lista = acessos || []; const sete = Date.now() - 7 * 86400e3;
  const porPessoa = {};
  for(const a of lista){ const p = porPessoa[a.user_id] || (porPessoa[a.user_id] = { ult: a, n7: 0, n30: 0 }); p.n30++; if(Date.parse(a.quando) >= sete) p.n7++; }
  const fh = d => { const t = new Date(d); return fmtDate(iso(t)) + " " + t.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" }); };
  const pessoasT = pessoas().filter(p => p.ativo);
  const mostrar = filtro ? lista.filter(a => a.user_id === filtro) : lista;
  openSheet("Acessos à app", `
    <div style="font-size:13px;color:var(--muted);margin:-4px 0 10px">Últimos 30 dias. Conta uma entrada sempre que alguém abre a app (no máximo uma a cada 30 minutos por aparelho). Só a sua conta vê isto.</div>
    <div class="panel">${pessoasT.map(p => { const x = porPessoa[p.id]; return `<div class="trow" style="cursor:pointer;align-items:flex-start${filtro === p.id ? ";background:#fbefe2;margin:0 -8px;padding-left:8px;padding-right:8px;border-radius:8px" : ""}" onclick="abrirAcessos(${filtro === p.id ? "" : `'${p.id}'`})"><span><b style="font-weight:600">${esc(p.nome)}</b><small>${x ? "Último: " + fh(x.ult.quando) + " · " + esc(x.ult.aparelho || "") : "Nunca acedeu"}</small></span><span style="text-align:right;font-size:12.5px;color:var(--muted);white-space:nowrap"><b class="mono" style="color:var(--ink);font-size:14px">${x ? x.n7 : 0}</b> em 7 dias<br><b class="mono" style="color:var(--ink);font-size:14px">${x ? x.n30 : 0}</b> em 30 dias</span></div>`; }).join("")}</div>
    <h3 style="margin-top:14px">${filtro ? "Acessos de " + esc(nm(filtro)) + ` <button class="btn sm" onclick="abrirAcessos()">Ver todos</button>` : "Todos os acessos"}</h3>
    <div class="panel" style="max-height:340px;overflow:auto">${mostrar.slice(0, 200).map(a => `<div class="trow"><span>${esc(nm(a.user_id))}<small>${esc(a.aparelho || "")}</small></span><span class="mono" style="font-size:13px;white-space:nowrap">${fh(a.quando)}</span></div>`).join("") || '<div class="hint">Ainda sem acessos registados.</div>'}</div>
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Fechar</button></div>`);
}
function empresaPanel(){
  const e = S.empresa || {};
  return `<h3>Empresa nas impressões</h3>
  <div class="panel">
    <div style="font-size:13px;color:var(--muted);margin-bottom:8px">Nome e logótipo que aparecem no topo e no rodapé dos relatórios, guias e resumos. Ficam guardados nos dados, não no programa — pode mudar ou apagar quando quiser.</div>
    <div class="grid2"><label class="f" style="margin:0"><span>Nome</span><input id="em_nome" value="${esc(e.nome || "")}" placeholder="Ex.: Nome da empresa"></label>
    <label class="f" style="margin:0"><span>Frase (opcional)</span><input id="em_sub" value="${esc(e.subtitulo || "")}" placeholder="Ex.: Gestão de condomínios"></label></div>
    <div style="display:flex;align-items:center;gap:12px;margin-top:10px;flex-wrap:wrap">
      ${e.logo ? `<img src="${esc(e.logo)}" alt="" style="height:44px;max-width:200px;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:8px;padding:4px">` : `<span style="font-size:13px;color:var(--muted)">Sem logótipo</span>`}
      <label class="btn sm" style="cursor:pointer">${e.logo ? "Trocar logótipo" : "Escolher logótipo"}<input type="file" accept="image/*" style="display:none" onchange="empresaLogo(this)"></label>
      ${e.logo ? `<button class="btn sm danger" onclick="empresaGuardar({logo:''})">Tirar logótipo</button>` : ""}
      <span class="sp" style="flex:1"></span><button class="btn pri sm" onclick="empresaTexto()">Guardar</button>
    </div>
  </div>`;
}
function empresaTexto(){ empresaGuardar({ nome: val("em_nome"), subtitulo: val("em_sub") }); }
async function empresaGuardar(campos){
  if(!VE_STOCK()) return;
  const novo = { id: 1, nome: "", subtitulo: "", logo: "", ...S.empresa, ...campos }; delete novo.created_at;
  const { error } = await sb.from("empresa").upsert(novo);
  if(error){ if(/empresa/.test(error.message || "")) toast("Falta preparar a base de dados (ficheiro 07_empresa.sql)."); else writeErr(error); return; }
  S.empresa = novo; render(); toast("Guardado.");
}
function empresaLogo(inp){
  const f = inp.files && inp.files[0]; if(!f) return;
  const img = new Image(); const url = URL.createObjectURL(f);
  img.onload = () => { const h = Math.min(240, img.height); const w = Math.round(img.width * h / img.height);
    const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url);
    empresaGuardar({ logo: c.toDataURL("image/png") }); };
  img.onerror = () => toast("Não foi possível ler a imagem.");
  img.src = url;
}
function render(){
  if(mode === "ok" && ME) snapDepois();
  renderNav(); renderWho();
  { const nv = document.getElementById("navver"); if(nv && VERSAO) nv.textContent = "Versão " + VERSAO; }
  if(mode === "login"){ $("#app").innerHTML = viewLogin(); return; }
  if(mode !== "ok"){ $("#app").innerHTML = viewEstado(); return; }
  if(!IS_ADMIN && (tab === "prev" || tab === "equipa")) tab = "inicio";
  if(tab === "stock" && !VE_STOCK()) tab = "inicio";
  const v = {inicio:viewInicio, ordens:viewOrdens, prev:viewPrev, condos:viewCondos, equipa:viewEquipa, stock:viewStock}[tab];
  const active = document.activeElement && document.activeElement.tagName === "INPUT" && document.activeElement.classList.contains("search");
  $("#app").innerHTML = v();
  if(active){ const s = $("input.search"); if(s){ s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  if(sheetRefresh) sheetRefresh();
}
function renderListOnly(){
  const tmp = document.createElement("div");
  tmp.innerHTML = (tab === "ordens" ? viewOrdens() : tab === "prev" ? viewPrev() : viewCondos());
  const nl = tmp.querySelector("#lst"); if(nl) $("#lst").innerHTML = nl.innerHTML;
}

/* ---------- folha (modal) ---------- */
let sheetRefresh = null;
let sheetHist = false, tabHist = false, ignorePop = 0, pendingBack = null;
function histBack(){ ignorePop++; history.back(); }
window.addEventListener("popstate", () => {
  if(ignorePop > 0){ ignorePop--; return; }
  if($("#scrim").classList.contains("open")){ sheetHist = false; hideSheet(); return; }
  if(tabHist && tab !== "inicio"){ tabHist = false; tab = "inicio"; q = ""; listMax = 50; render(); scroller().scrollTop = 0; }
});
// Quando a ficha aberta se redesenha (chegou uma atualização), não se pode perder o que a pessoa
// está a escrever: guarda-se o estado dos campos e repõe-se depois.
function guardarForm(){
  const sh = document.getElementById("sheet"); if(!sh) return null; const m = {};
  for(const e of sh.querySelectorAll("input[id],select[id],textarea[id]")){
    m[e.id] = { v: e.value, c: e.checked, d: e.style.display, t: e.type };
  }
  for(const e of sh.querySelectorAll("[id][style*='display']")) if(!m[e.id]) m[e.id] = { d: e.style.display };
  const a = document.activeElement; m.__foco = a && sh.contains(a) && a.id ? { id: a.id, p: (() => { try{ return a.selectionStart; }catch(_){ return null; } })() } : null;
  return m;
}
function reporForm(m){
  if(!m) return; const sh = document.getElementById("sheet"); if(!sh) return;
  for(const [id, st] of Object.entries(m)){
    if(id === "__foco") continue; const e = document.getElementById(id); if(!e || !sh.contains(e)) continue;
    if(st.t === "checkbox" || st.t === "radio"){ if(st.c && !e.checked) e.checked = true; }
    else if(st.v !== undefined && st.v !== "" && (e.value === "" || e.tagName === "SELECT" && e.value !== st.v && !e.value)) e.value = st.v;
    if(st.d === "" && e.style.display === "none") e.style.display = "";
  }
  if(m.__foco){ const e = document.getElementById(m.__foco.id); if(e && sh.contains(e)){ try{ e.focus({ preventScroll: true }); if(m.__foco.p != null && e.setSelectionRange) e.setSelectionRange(m.__foco.p, m.__foco.p); }catch(_){} } }
}
function openSheet(title, html, refresh){
  if(pendingBack){ clearTimeout(pendingBack); pendingBack = null; }
  else if(!$("#scrim").classList.contains("open") && !sheetHist){ try{ history.pushState({ sheet: 1 }, ""); sheetHist = true; }catch(e){} }
  $("#sheet").innerHTML = `<div class="top"><h4>${title}</h4><button class="x" onclick="closeSheet()" aria-label="Fechar">×</button></div><div class="body">${html}</div>`;
  $("#scrim").classList.add("open"); $("#sheet").scrollTop = 0;
  sheetRefresh = refresh ? () => { const m = guardarForm(); const y = $("#sheet").scrollTop; refresh(); reporForm(m); mpkSync(); $("#sheet").scrollTop = y; } : null;
}
function hideSheet(){ $("#scrim").classList.remove("open"); sheetRefresh = null; }
function closeSheet(){ DIAS_RASC = {}; hideSheet(); if(sheetHist && !pendingBack) pendingBack = setTimeout(() => { pendingBack = null; if(sheetHist && !$("#scrim").classList.contains("open")){ sheetHist = false; histBack(); } }, 0); }
$("#scrim").addEventListener("click", e => { if(e.target.id === "scrim") closeSheet(); });
document.addEventListener("keydown", e => { if(e.key === "Escape") closeSheet(); });
function armDelete(btn, fn){
  if(btn.classList.contains("arm")){ fn(); return; }
  btn.classList.add("arm"); btn.textContent = "Confirmar";
  setTimeout(() => { if(btn.isConnected){ btn.classList.remove("arm"); btn.textContent = btn.dataset.label || "Eliminar"; } }, 4000);
}
const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
const condoOptions = (sel, f) => `<option value="">— Selecione —</option>` + condosSorted().filter(c => c.id === sel || !f || hit([c.codigo,c.nome,c.morada,c.nif].join(" "), f)).map(c => `<option value="${c.id}" ${c.id===sel?"selected":""}>${esc(cLabel(c))}</option>`).join("");
const condoPicker = (sel, onch) => `<div class="f"><span>Condomínio *</span><input id="f_cq" placeholder="Procurar por código, nome ou morada…" oninput="filterCondoSel(this.value)" autocomplete="off" style="margin-bottom:6px"><div id="f_cres" class="cres"></div><select id="f_condo" ${onch?'onchange="onCondoChange()"':""}>${condoOptions(sel)}</select></div>`;
function filterCondoSel(v){
  const s = $("#f_condo"); if(!s) return; const cur = s.value; s.innerHTML = condoOptions(cur, v);
  const res = $("#f_cres"); const q = (v || "").trim();
  const found = q ? condosSorted().filter(c => hit([c.codigo, c.nome, c.morada, c.nif].join(" "), q)) : [];
  if(found.length === 1 && !cur){ escolherCondo(found[0].id); return; }
  if(res) res.innerHTML = !q ? "" : found.length ? found.slice(0, 8).map(c => `<button type="button" onclick="escolherCondo('${c.id}')"><b class="mono">${esc(c.codigo || "")}</b> ${esc(c.nome)}<small>${esc(c.morada || "")}</small></button>`).join("") + (found.length > 8 ? `<div class="mais">Mais ${found.length - 8} — escreva mais letras para afinar.</div>` : "") : `<div class="mais">Nenhum condomínio encontrado.</div>`;
}
function escolherCondo(id){
  const s = $("#f_condo"); if(!s) return;
  s.innerHTML = condoOptions(id); s.value = id; if(s.onchange) s.onchange();
  const res = $("#f_cres"); if(res) res.innerHTML = "";
  const qi = $("#f_cq"); if(qi) qi.value = "";
}
const equipOptions = (condoId, sel) => {
  const list = Object.values(S.equip).filter(e => e.condoId === condoId).sort((a,b)=>a.nome.localeCompare(b.nome, "pt"));
  return `<option value="">${condoId ? "— Nenhum (área comum / geral) —" : "— Escolha primeiro o condomínio —"}</option>` + list.map(e => `<option value="${e.id}" ${e.id===sel?"selected":""}>${esc(e.nome)}${e.local?" — "+esc(e.local):""}</option>`).join("");
};
const pessoasAgrupadas = sel => { const opt = t => `<option value="${t.id}" ${t.id===sel?"selected":""}>${esc(t.nome)}</option>`; const tec = tecnicos().filter(t => t.papel !== "admin"), adm = tecnicos().filter(t => t.papel === "admin");
  return (tec.length ? `<optgroup label="Técnicos">${tec.map(opt).join("")}</optgroup>` : "") + (adm.length ? `<optgroup label="Administrativos">${adm.map(opt).join("")}</optgroup>` : ""); };
const techOptions = sel => `<option value="">— Por atribuir —</option>` + pessoasAgrupadas(sel) + (sel && !(S.equipa[sel] && S.equipa[sel].ativo) ? `<option value="${esc(sel)}" selected>${esc(nm(sel))}</option>` : "");
function onCondoChange(){ const s = $("#f_eq"); if(s) s.innerHTML = equipOptions(val("f_condo"), "");
  const t = $("#f_tec"); const r = respZona(val("f_condo"));
  if(t && r && (!t.value || t.dataset.auto === "1")){ t.value = r; t.dataset.auto = "1"; const h = $("#f_tec_h"); if(h) h.textContent = "Responsável da zona " + localidade(S.condos[val("f_condo")]) + "."; } }

/* ---------- perfil próprio ---------- */
function openPerfil(){
  const me = S.equipa[ME] || {};
  openSheet("O meu perfil", `
    <label class="f"><span>Nome</span><input id="p_nome" value="${esc(me.nome)}"></label>
    <label class="f"><span>Telemóvel (WhatsApp)</span><input id="p_tel" type="tel" inputmode="tel" value="${esc(me.telefone)}" placeholder="9xx xxx xxx"></label>
    <div class="actions"><span class="sp"></span><button class="btn pri" onclick="savePerfil()">Guardar</button></div>
    <h3>Notificações</h3>
    <div class="panel" style="font-size:14px">${pushOn ? "<i class=ico-check></i>Ativas neste telemóvel." : `Desativadas neste telemóvel. <button class="btn sm pri" onclick="enablePush()">Ativar</button>`}</div>
    <h3>Assinatura</h3>
    <div class="panel">
      <div style="font-size:13px;color:var(--muted);margin-bottom:8px">Assine com o dedo (ou com o rato) dentro do quadro. A assinatura é colocada nos relatórios impressos das suas ordens.</div>
      ${me.assinatura ? `<div style="margin-bottom:8px"><span style="font-size:13px;color:var(--muted)">Assinatura atual:</span><br><img src="${esc(me.assinatura)}" alt="" style="max-height:70px;max-width:100%;background:#fff;border:1px solid var(--line);border-radius:8px;padding:4px"></div>` : ""}
      <canvas id="sigPad" style="width:100%;height:170px;background:#fff;border:1px dashed #b9b2a4;border-radius:10px;touch-action:none;display:block"></canvas>
      <div class="actions" style="margin-top:8px"><button class="btn" onclick="sigClear()">Limpar</button>${me.assinatura?`<button class="btn danger" onclick="sigRemove()">Apagar assinatura</button>`:""}<span class="sp"></span><button class="btn pri" onclick="sigSave()">Guardar assinatura</button></div>
    </div>
    <h3>Palavra-passe</h3>
    <label class="f"><span>Nova palavra-passe</span><input id="p_pw" type="password" autocomplete="new-password" placeholder="Pelo menos 6 caracteres"></label>
    <div class="actions"><span class="sp"></span><button class="btn" onclick="changePw()">Mudar palavra-passe</button></div>
    <h3>Sessão</h3>
    <div class="actions"><span style="font-size:13px;color:var(--muted)">${esc(me.email||"")}</span><span class="sp"></span><button class="btn danger" onclick="logout()">Terminar sessão</button></div>`);
  setTimeout(sigInit, 50);
}
/* ---------- assinatura ---------- */
let sigDrawn = false;
function sigInit(){
  const c = document.getElementById("sigPad"); if(!c) return;
  const r = c.getBoundingClientRect(), dpr = Math.max(1, window.devicePixelRatio || 1);
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const ctx = c.getContext("2d"); ctx.scale(dpr, dpr); ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0b2a6b";
  sigDrawn = false; let down = false, last = null;
  const pos = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  c.onpointerdown = e => { down = true; c.setPointerCapture(e.pointerId); last = pos(e); ctx.beginPath(); ctx.arc(last[0], last[1], 1.1, 0, Math.PI * 2); ctx.fillStyle = ctx.strokeStyle; ctx.fill(); sigDrawn = true; e.preventDefault(); };
  c.onpointermove = e => { if(!down) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last = p; e.preventDefault(); };
  c.onpointerup = c.onpointercancel = () => { down = false; };
}
function sigClear(){ const c = document.getElementById("sigPad"); if(!c) return; c.getContext("2d").clearRect(0, 0, c.width, c.height); sigDrawn = false; }
// Assinatura escrita a subir/descer: endireita-a (só se for alongada, tipo nome escrito, e inclinada 3°–40°)
function sigEndireitar(c){
  const ctx = c.getContext("2d"); const { width: w, height: h } = c; const d = ctx.getImageData(0, 0, w, h).data;
  let n = 0, sx = 0, sy = 0; const pts = [];
  for(let y = 0; y < h; y += 2) for(let x = 0; x < w; x += 2) if(d[(y * w + x) * 4 + 3] > 10){ pts.push(x, y); sx += x; sy += y; n++; }
  if(n < 30) return c;
  const mx = sx / n, my = sy / n; let xx = 0, yy = 0, xy = 0;
  for(let i = 0; i < pts.length; i += 2){ const dx = pts[i] - mx, dy = pts[i + 1] - my; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
  const th = 0.5 * Math.atan2(2 * xy, xx - yy); // ângulo da direção principal (radianos, y para baixo)
  const tr = (xx + yy) / 2, df = Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy); const along = Math.sqrt((tr + df) / Math.max(tr - df, 1e-6));
  const graus = Math.abs(th * 180 / Math.PI);
  if(along < 3 || graus < 3 || graus > 40) return c;
  const cos = Math.abs(Math.cos(th)), sin = Math.abs(Math.sin(th));
  const o = document.createElement("canvas"); o.width = Math.ceil(w * cos + h * sin); o.height = Math.ceil(w * sin + h * cos);
  const g = o.getContext("2d"); g.translate(o.width / 2, o.height / 2); g.rotate(-th); g.drawImage(c, -w / 2, -h / 2);
  return o;
}
function sigTrim(c){
  c = sigEndireitar(c);
  const ctx = c.getContext("2d"); const { width: w, height: h } = c; const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for(let y = 0; y < h; y++) for(let x = 0; x < w; x++) if(d[(y * w + x) * 4 + 3] > 10){ if(x < x0) x0 = x; if(x > x1) x1 = x; if(y < y0) y0 = y; if(y > y1) y1 = y; }
  if(x1 < 0) return null;
  const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1; const k = Math.min(1, 600 / cw, 220 / ch);
  const o = document.createElement("canvas"); o.width = Math.max(1, Math.round(cw * k)); o.height = Math.max(1, Math.round(ch * k));
  o.getContext("2d").drawImage(c, x0, y0, cw, ch, 0, 0, o.width, o.height);
  return o.toDataURL("image/png");
}
async function sigSave(){
  const c = document.getElementById("sigPad"); if(!c || !sigDrawn){ toast("Assine primeiro dentro do quadro."); return; }
  const url = sigTrim(c); if(!url){ toast("Assine primeiro dentro do quadro."); return; }
  const { error } = await sb.from("perfis").update({ assinatura: url }).eq("id", ME);
  if(error) return writeErr(error);
  S.equipa[ME] = { ...S.equipa[ME], assinatura: url }; toast("Assinatura guardada."); openPerfil();
}
async function sigRemove(){
  const { error } = await sb.from("perfis").update({ assinatura: "" }).eq("id", ME);
  if(error) return writeErr(error);
  S.equipa[ME] = { ...S.equipa[ME], assinatura: "" }; toast("Assinatura apagada."); openPerfil();
}
async function savePerfil(){
  const me = S.equipa[ME]; const nome = val("p_nome"); const telefone = val("p_tel");
  if(!nome){ toast("Indique o nome."); return; }
  if(telefone && waNum(telefone).length < 11){ toast("Número inválido."); return; }
  const { error } = await sb.from("perfis").update({ nome, telefone }).eq("id", ME);
  if(error) return writeErr(error);
  S.equipa[ME] = { ...me, nome, telefone }; closeSheet(); render(); toast("Perfil guardado.");
}
async function changePw(){
  const pw = $("#p_pw").value; if(pw.length < 6){ toast("Use pelo menos 6 caracteres."); return; }
  const { error } = await sb.auth.updateUser({ password: pw });
  if(error) toast("Não foi possível mudar: " + error.message); else { $("#p_pw").value = ""; toast("Palavra-passe alterada."); }
}

/* ---------- gestão da equipa (administrativos) ---------- */
const randPw = () => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(10)); for(const x of r) s += a[x % a.length]; return s; };
async function callUsers(body){
  const { data, error } = await sb.functions.invoke("gerir-utilizadores", { body });
  if(error){ let msg = error.message; try{ const j = await error.context.json(); msg = j.erro || msg; }catch(e){} throw new Error(msg); }
  if(data && data.erro) throw new Error(data.erro);
  return data;
}
function newUser(){
  openSheet("Novo utilizador", `
    <label class="f"><span>Nome *</span><input id="u_nome" placeholder="Ex.: João Silva"></label>
    <label class="f"><span>E-mail *</span><input id="u_email" type="email" placeholder="usado para entrar na aplicação"></label>
    <div class="grid2"><label class="f"><span>Telemóvel</span><input id="u_tel" type="tel" placeholder="9xx xxx xxx"></label>
    <label class="f"><span>Perfil</span><select id="u_papel"><option value="tec">Técnico</option><option value="admin">Administrativo</option></select></label></div>
    <label class="f"><span>Palavra-passe inicial</span><input id="u_pw" value="${randPw()}"></label>
    <p style="font-size:13px;color:var(--muted);margin-top:-4px">A pessoa pode mudá-la depois em "O meu perfil".</p>
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" id="u_btn" onclick="createUser()">Criar conta</button></div>`);
}
async function createUser(){
  const nome = val("u_nome"), email = val("u_email").toLowerCase(), telefone = val("u_tel"), papel = val("u_papel"), password = val("u_pw");
  if(!nome || !email){ toast("Preencha o nome e o e-mail."); return; }
  const btn = $("#u_btn"); btn.disabled = true; btn.textContent = "A criar…";
  try{
    await callUsers({ acao: "criar", nome, email, telefone, papel, password });
    const { data } = await sb.from("perfis").select("*"); if(data) S.equipa = Object.fromEntries(data.map(p => [p.id, fromRow(p)]));
    render(); showCredentials(nome, email, password, telefone);
  }catch(e){ btn.disabled = false; btn.textContent = "Criar conta"; toast(e.message); }
}
function showCredentials(nome, email, password, telefone){
  const txt = `Olá ${nome.split(" ")[0]}! Já tens acesso à aplicação de Manutenção.\n\nEndereço: ${APP_URL}\nE-mail: ${email}\nPalavra-passe: ${password}\n\nAndroid: abre o endereço no Chrome, toca em ⋮ (três pontos) → "Instalar aplicação", entra com o e-mail e a palavra-passe e carrega em "Ativar notificações". Autoriza também a localização (para o tempo).\niPhone: abre no Safari → Partilhar → "Adicionar ao ecrã principal", abre pelo ícone e ativa as notificações.\n\nDepois de entrares, muda a palavra-passe e guarda a tua assinatura no 👤.`;
  openSheet("Conta criada", `<p style="margin-top:0">Envie estes dados a ${esc(nome)}:</p><div class="cred">${esc(txt)}</div>
    <div class="actions" style="margin-top:12px">${telefone ? waBtn(telefone, txt, "Enviar por WhatsApp") : ""}<button class="btn" onclick="copyText(${esc(JSON.stringify(txt))})">Copiar</button><span class="sp"></span><button class="btn" onclick="closeSheet()">Fechar</button></div>`);
}
async function copyText(t){ try{ await navigator.clipboard.writeText(t); toast("Copiado."); }catch(e){ toast("Não foi possível copiar."); } }
function openPessoa(id){
  const x = S.equipa[id]; if(!x) return;
  const self = id === ME;
  openSheet(esc(x.nome), `
    <label class="f"><span>Nome</span><input id="e_nome" value="${esc(x.nome)}"></label>
    <div class="grid2"><label class="f"><span>Telemóvel</span><input id="e_tel" type="tel" value="${esc(x.telefone)}"></label>
    <label class="f"><span>Perfil</span><select id="e_papel" ${self?"disabled":""}><option value="tec" ${x.papel==="tec"?"selected":""}>Técnico</option><option value="admin" ${x.papel==="admin"?"selected":""}>Administrativo</option></select></label></div>
    ${self?'<p style="font-size:13px;color:var(--muted);margin-top:-4px">Não pode mudar o seu próprio perfil.</p>':""}
    <div class="actions"><span class="sp"></span><button class="btn pri" onclick="savePessoa('${id}')">Guardar</button></div>
    ${x.papel === "tec" && VE_STOCK() ? (() => { const tt = S.tarTec[id]; return `<h3>Tarifa de mão de obra</h3>
    <div class="panel"><div style="font-size:13px;color:var(--muted);margin-bottom:8px">Deixe em branco para usar a tarifa normal (${eur(S.tarifas.hora)}/h).</div>
      <div class="grid2"><label class="f" style="margin:0"><span>1.ª hora (€)</span><input id="tt_h1" inputmode="decimal" value="${tt ? String(tt.hora1).replace(".", ",") : ""}" placeholder="Ex.: 40"></label>
      <label class="f" style="margin:0"><span>Horas seguintes (€/h)</span><input id="tt_h" inputmode="decimal" value="${tt ? String(tt.hora).replace(".", ",") : ""}" placeholder="Ex.: 20"></label></div>
      <div class="actions" style="margin-top:8px"><span class="sp"></span><button class="btn" onclick="setTarTec('${id}')">Guardar tarifa</button></div></div>`; })() : ""}
    <h3>Acesso</h3>
    <div class="panel" style="font-size:14px">E-mail de entrada: <b>${esc(x.email||"")}</b>
      <div class="actions" style="margin-top:10px"><button class="btn" onclick="resetPw('${id}')">Repor palavra-passe</button>
      ${!self && IS_ADMIN && x.papel !== "admin" ? `<button class="btn" onclick="setSoRegMat('${id}', ${!x.soRegistaMaterial})">${x.soRegistaMaterial ? "Registar tudo (tempo, notas, fotos)" : "Só regista material"}</button>` : ""}
      ${!self && VE_STOCK() ? `<button class="btn" onclick="setOculto('${id}', ${!x.oculto})"><i class=ico-lock></i>${x.oculto ? "Mostrar a todos" : "Conta de teste (só eu vejo)"}</button>` : ""}
      ${self?"":`<button class="btn ${x.ativo?"danger":""}" data-label="${x.ativo?"Desativar conta":"Reativar conta"}" onclick="${x.ativo ? `openDesativar('${id}')` : `armDelete(this,()=>setAtivo('${id}',true))`}">${x.ativo?"Desativar conta":"Reativar conta"}</button>`}</div></div>`);
}
async function setTarTec(id){
  if(!VE_STOCK()) return;
  const a = val("tt_h1"), b = val("tt_h");
  if(!a && !b){ const { error } = await sb.from("tarifas_tecnico").delete().eq("user_id", id); if(error) return writeErr(error); delete S.tarTec[id]; render(); toast("Usa a tarifa normal."); return; }
  const h1 = parsePrice(a), h = parsePrice(b); if(h1 === null || h === null){ toast("Preencha os dois valores."); return; }
  const { error } = await sb.from("tarifas_tecnico").upsert({ user_id: id, hora1: h1, hora: h }); if(error) return writeErr(error);
  S.tarTec[id] = { hora1: h1, hora: h }; render(); toast("Tarifa guardada.");
}
async function savePessoa(id){
  const x = S.equipa[id]; const nome = val("e_nome"), telefone = val("e_tel"); const papel = id === ME ? x.papel : val("e_papel");
  if(!nome){ toast("Indique o nome."); return; }
  const { error } = await sb.from("perfis").update({ nome, telefone, papel }).eq("id", id);
  if(error) return writeErr(error);
  S.equipa[id] = { ...x, nome, telefone, papel }; closeSheet(); render(); toast("Guardado.");
}
async function resetPw(id){
  const x = S.equipa[id]; const pw = randPw();
  try{ await callUsers({ acao: "repor", user_id: id, password: pw }); showCredentials(x.nome, x.email, pw, x.telefone); }
  catch(e){ toast(e.message); }
}
/* ---------- desativar: passar o que a pessoa tem para outra ---------- */
function pendentesDe(id){
  const ots = Object.values(S.ots).filter(o => o.tecnico === id && o.estado !== "concluida");
  const pls = Object.values(S.plans).filter(p => p.tecnico === id);
  const zonas = Object.entries(S.zonas || {}).filter(([, t]) => t === id).map(([z]) => z);
  const cars = VE_STOCK() && S.stk && S.stk.locais ? Object.values(S.stk.locais).filter(l => l.tipo === "carrinha" && l.tecnico === id) : [];
  return { ots, pls, zonas, cars };
}
function openDesativar(id){
  const x = S.equipa[id]; if(!x) return;
  const d = pendentesDe(id); const nada = !d.ots.length && !d.pls.length && !d.zonas.length && !d.cars.length;
  const outros = tecnicos().filter(t => t.id !== id && (x.papel === "admin" || t.papel !== "admin"));
  openSheet("Desativar " + esc(x.nome), `
    <p style="margin-top:0">${esc(x.nome)} deixa de conseguir entrar na app. O histórico (ordens feitas, fotos, material, relatórios e assinatura) fica guardado com o nome ${x.papel === "admin" ? "dele/dela" : "do técnico"}.</p>
    ${nada ? `<div class="panel" style="font-size:14px">Não tem nada pendente para passar a outra pessoa.</div>` : `
    <div class="panel"><b>Ainda tem:</b><div class="parts" style="margin-top:6px">
      ${d.ots.length ? `<div class="part"><span class="n">Ordens abertas / em curso</span><span class="mono">${d.ots.length}</span></div>` : ""}
      ${d.pls.length ? `<div class="part"><span class="n">Rondas / planos preventivos</span><span class="mono">${d.pls.length}</span></div>` : ""}
      ${d.zonas.length ? `<div class="part"><span class="n">Responsável de zona</span><span>${esc(d.zonas.join(", "))}</span></div>` : ""}
      ${d.cars.length ? `<div class="part"><span class="n">Carrinha</span><span>${esc(d.cars.map(l => l.nome.replace(/ —.*$/, "")).join(", "))}</span></div>` : ""}
    </div></div>
    <label class="f"><span>Passar tudo para</span><select id="dz_para"><option value="">— Deixar por atribuir —</option>${outros.map(t => `<option value="${t.id}">${esc(t.nome)}</option>`).join("")}</select></label>
    <div class="hint" style="font-size:12.5px;color:var(--muted);margin:-4px 0 8px">Se deixar por atribuir, as ordens aparecem no Painel em "Por atribuir"${d.zonas.length ? ", a zona fica sem responsável" : ""}${d.cars.length ? " e a carrinha fica sem técnico (o material continua lá)" : ""}.</div>`}
    <div class="actions"><button class="btn" onclick="openPessoa('${id}')">Cancelar</button><span class="sp"></span><button class="btn pri" style="background:var(--red);border-color:var(--red)" onclick="desativarPassar('${id}')">Desativar${nada ? "" : " e passar"}</button></div>`);
}
async function desativarPassar(id){
  const para = val("dz_para"); const d = pendentesDe(id);
  closeSheet(); toast("A tratar…");
  for(const o of d.ots) updOt(o.id, { tecnico: para, atribuida: para ? today() : "", atribuidaEm: para ? nowIso() : "", atribuidoPor: para ? ME : "" }, true);
  for(const p of d.pls) put("plans", { ...p, tecnico: para }, true);
  for(const z of d.zonas){ const { error } = para ? await sb.from("zonas_resp").upsert({ zona: z, tecnico: para }) : await sb.from("zonas_resp").delete().eq("zona", z);
    if(!error){ S.zonas = { ...(S.zonas || {}) }; if(para) S.zonas[z] = para; else delete S.zonas[z]; } }
  for(const l of d.cars){ const { error } = await sb.from("stock_locais").update({ tecnico: para || null }).eq("id", l.id); if(!error) S.stk.locais[l.id] = { ...S.stk.locais[l.id], tecnico: para || null }; }
  await setAtivo(id, false);
  const partes = [d.ots.length && d.ots.length + (d.ots.length === 1 ? " ordem" : " ordens"), d.pls.length && d.pls.length + (d.pls.length === 1 ? " plano" : " planos"), d.zonas.length && "zona " + d.zonas.join(", "), d.cars.length && "carrinha"].filter(Boolean);
  if(partes.length) setTimeout(() => toast("Conta desativada. " + partes.join(", ") + (para ? " → " + nm(para) : " ficaram por atribuir") + "."), 900);
}
async function setSoRegMat(id, v){
  if(!IS_ADMIN) return;
  const { error } = await sb.from("perfis").update({ so_regista_material: v }).eq("id", id);
  if(error){ if(/so_regista_material/.test(error.message || "")) toast("Falta preparar a base de dados (ficheiro SO_MATERIAL)."); else writeErr(error); return; }
  S.equipa[id] = { ...S.equipa[id], soRegistaMaterial: v }; closeSheet(); render();
  toast(v ? nm(id) + " passa a registar só o material." : nm(id) + " volta a registar tudo.");
}
async function setOculto(id, oculto){
  if(!VE_STOCK()) return;
  const { error } = await sb.from("perfis").update({ oculto }).eq("id", id);
  if(error){ if(/oculto/.test(error.message || "")) toast("Falta preparar a base de dados (ficheiro CONTAS_OCULTAS)."); else writeErr(error); return; }
  S.equipa[id] = { ...S.equipa[id], oculto }; closeSheet(); render(); toast(oculto ? "Só a sua conta vê esta pessoa." : "Esta pessoa volta a ser visível para todos.");
}
async function setAtivo(id, ativo){
  try{ await callUsers({ acao: "ativo", user_id: id, ativo }); S.equipa[id] = { ...S.equipa[id], ativo }; closeSheet(); render(); toast(ativo ? "Conta reativada." : "Conta desativada."); }
  catch(e){ toast(e.message); }
}

/* ---------- materiais do armazém ---------- */
async function addMat(){
  if(!VE_STOCK()) return;
  const codigo = val("m_cod").toUpperCase().replace(/\s+/g, "-"), nome = val("m_nome");
  if(!codigo || !nome){ toast("Indique o código e a descrição."); return; }
  let g = val("m_grp"); if(g === "__novo") g = val("m_grp_novo");
  if(!g){ toast("Indique o nome do novo grupo."); return; }
  const novoGrupo = !gruposMat().includes(g);
  if(!S.matGrupoCol && novoGrupo){ toast("Falta preparar a base de dados para grupos novos (ficheiro GRUPOS)."); return; }
  const ordem = Math.max(0, ...Object.values(S.mat).map(m => m.ordem || 0)) + 1;
  const row = { codigo, nome, ordem, ativo: true, ...(S.matGrupoCol ? { grupo: g } : {}), ...(S.matFornCol && val("m_forn") ? { fornecedor: val("m_forn") } : {}) };
  if(!S.matGrupoCol) row.ordem = { "Limpeza": 100, "Placas": 200, "Iluminação": 300 }[g] + ordem || 900 + ordem;
  const { error } = await sb.from("materiais").upsert(row);
  if(error) return writeErr(error);
  S.mat[codigo] = row; matOpen.add(g); render(); toast("Material adicionado.");
}
async function rmMat(codigo){
  if(!VE_STOCK()) return;
  const m = S.mat[codigo]; if(!m) return;
  const { error } = await sb.from("materiais").update({ ativo: false }).eq("codigo", codigo);
  if(error) return writeErr(error);
  S.mat[codigo] = { ...m, ativo: false }; render(); toast(m.nome + " retirado da lista.");
}

async function setPreco(codigo, v){
  if(!VE_STOCK()) return;
  const preco = parsePrice(v); if(preco === null && String(v).trim() !== ""){ toast("Preço inválido."); return; }
  const { error } = preco === null ? await sb.from("materiais_precos").delete().eq("codigo", codigo) : await sb.from("materiais_precos").upsert({ codigo, preco });
  if(error) return writeErr(error);
  if(preco === null) delete S.precos[codigo]; else S.precos[codigo] = preco;
  toast("Preço guardado: " + (S.mat[codigo] || {}).nome + (preco === null ? " sem preço" : " " + eur(preco)));
}
async function setTarifa(k, v){
  if(!VE_STOCK()) return;
  const n = parsePrice(v); if(n === null){ toast("Valor inválido."); return; }
  const t = { ...S.tarifas, [k]: n };
  const { error } = await sb.from("tarifas").upsert({ id: 1, deslocacao: t.deslocacao, hora: t.hora, ...(t.novas ? { extra_a: t.extraA, extra_e: t.extraE } : {}) });
  if(error) return writeErr(error);
  S.tarifas = t; render(); toast("Tarifa guardada: " + eur(n));
}
function setSoMaterial(id, on){ updOt(id, { soMaterial: !!on }); toast(on ? "Marcada como só entrega de material." : "Desmarcada."); }
function setDesloc(id, v){ const n = Math.max(0, parseInt(v) || 0); updOt(id, { deslocacoes: n }); }
function setPartPrice(id, i, v){
  const o = S.ots[id]; if(!o) return; const p = parsePrice(v);
  const pecas = (o.pecas || []).map((x, j) => { if(j !== i) return x; const y = { ...x }; if(p === null || (x.c && S.precos[x.c] === p)) delete y.p; else y.p = p; return y; });
  updOt(id, { pecas });
}

/* ---------- exportação ---------- */
function download(name, text, type){
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const ultimaCopia = () => { try{ return localStorage.getItem("ultimaCopia") || ""; }catch(e){ return ""; } };
async function backupCompleto(btn){
  if(!IS_ADMIN) return;
  if(btn){ btn.disabled = true; btn.textContent = "A preparar…"; }
  const tabelas = ["condominios", "condominos", "equipamentos", "planos", "ordens", "materiais", "materiais_precos", "tarifas", "tarifas_tecnico", "empresa", "zonas_resp", "perfis", ...(VE_STOCK() ? ["stock_locais", "stock_artigos", "stock_mov"] : [])];
  const out = { app: "Manutenção", versao: 1, exportado_em: nowIso(), exportado_por: nm(ME), tabelas: {} }; const falhas = [];
  for(const t of tabelas){
    const rows = []; let from = 0;
    try{ for(;;){ const { data, error } = await sb.from(t).select("*").range(from, from + 999); if(error) throw error; rows.push(...data); if(data.length < 1000) break; from += 1000; } out.tabelas[t] = rows; }
    catch(e){ falhas.push(t); }
  }
  const nf = Object.values(S.ots).reduce((a, o) => a + (o.fotos || []).length, 0);
  out.fotos = { quantidade: nf, nota: "As fotografias ficam no Supabase Storage (pasta 'fotos'); este ficheiro guarda só os caminhos." };
  download(`copia-seguranca-manutencao-${today()}.json`, JSON.stringify(out), "application/json");
  try{ localStorage.setItem("ultimaCopia", today()); }catch(e){}
  if(btn){ btn.disabled = false; btn.innerHTML = "<i class=ico-save></i>Fazer cópia de segurança"; }
  toast(falhas.length ? "Cópia feita, mas sem: " + falhas.join(", ") : "Cópia de segurança guardada (" + Object.values(out.tabelas).reduce((a, r) => a + r.length, 0) + " registos).");
  render();
}
// Conselho do tempo para o ecrã principal (técnicos e escritório)
// Aviso do tempo no Início: muda com a previsão (quando chove, quanto, frio, calor, dias secos)
// e a dica muda todos os dias.
const DICAS_TEMPO = {
  chuva: [
    "Bom momento para verificar caleiros, ralos e tubos de queda antes da chuva.",
    "Confirme que as grelhas das garagens e os ralos dos terraços estão desentupidos.",
    "Se há infiltrações pendentes, vale a pena ver as zonas afetadas logo a seguir à chuva — é quando melhor se vê de onde entra a água.",
    "Trabalhos em telhados e terraços ficam para dias secos; aproveite para trabalho interior (iluminação, campainhas, portas).",
    "Tapetes à entrada dos prédios evitam escorregadelas nos halls com piso molhado.",
    "Verifique as bombas de esgoto e de águas pluviais nas caves antes de chover forte.",
  ],
  seco: [
    "Dias secos à vista: boa altura para trabalhos exteriores, telhados e terraços.",
    "Aproveite o tempo seco para limpar caleiros e tubos de queda.",
    "Bom tempo para pinturas e retoques exteriores e para marcar trabalhos em fachadas.",
    "Tempo seco é bom para rever impermeabilizações e selagens antes da próxima chuva.",
    "Boa altura para afinar portões de garagem e rever iluminação exterior.",
  ],
  frio: [
    "Noites frias: atenção a canos expostos e contadores no exterior.",
    "Com frio e humidade, os pisos exteriores e rampas de garagem ficam escorregadios.",
    "O frio pode prender fechaduras e trincos exteriores — um pouco de lubrificante ajuda.",
  ],
  calor: [
    "Muito calor: trabalhos em telhados e terraços de manhã cedo ou ao fim da tarde.",
    "Com calor, leve água para as intervenções e evite as horas de maior sol.",
    "Os comandos e motores de portões aquecem ao sol — bom momento para verificar se funcionam bem.",
  ],
};
function meteoAviso(){
  if(!meteo || !meteo.dias || !meteo.dias.length) return "";
  const t = today(); const prox = meteo.dias.filter(d => d.data >= t).slice(0, 4); if(!prox.length) return "";
  const nDia = Math.floor(Date.parse(t) / 864e5); const dica = k => DICAS_TEMPO[k][nDia % DICAS_TEMPO[k].length];
  const qd = d => { const k = diffDays(d.data, t); return k === 0 ? "hoje" : k === 1 ? "amanhã" : DIAS_SEM[new Date(d.data + "T12:00:00").getDay()].toLowerCase(); };
  const caixa = (ic, tit, txt) => `<div class="note wxnote" onclick="openMeteo()"><span style="font-size:22px;line-height:1">${ic}</span><span><b>${tit}</b> ${txt}</span></div>`;
  const chuva = prox.slice(0, 3).find(d => d.prob >= 70);
  if(chuva){
    const dias = prox.slice(0, 3).filter(d => d.prob >= 70).length;
    const tit = dias >= 2 ? `Chuva prevista a partir de ${qd(chuva)} (${chuva.prob}%), vários dias.` : `Chuva prevista ${qd(chuva)} (${chuva.prob}%).`;
    return caixa(chuva.prob >= 90 ? "⛈️" : "🌧️", tit, dica("chuva"));
  }
  const frio = prox.slice(0, 3).find(d => d.tMin <= 3);
  if(frio) return caixa("🥶", `Frio ${qd(frio)}: mínima de ${Math.round(frio.tMin)}°.`, dica("frio"));
  const calor = prox.slice(0, 3).find(d => d.tMax >= 30);
  if(calor) return caixa("🥵", `Calor ${qd(calor)}: máxima de ${Math.round(calor.tMax)}°.`, dica("calor"));
  if(prox.slice(0, 3).every(d => d.prob < 30)) return caixa("☀️", "Sem chuva nos próximos dias.", dica("seco"));
  return "";
}
function copiaBanner(){
  if(!IS_ADMIN) return "";
  const u = ultimaCopia(); const dias = u ? diffDays(today(), u) : null;
  if(dias !== null && dias < 7) return "";
  return `<div class="note" style="display:flex;gap:10px;align-items:center;justify-content:space-between">${u ? `A última cópia de segurança foi há ${dias} dias.` : "Ainda não fez nenhuma cópia de segurança neste aparelho."} <button class="btn sm" onclick="backupCompleto(this)"><i class=ico-save></i>Fazer agora</button></div>`;
}
function exportJSON(){
  const data = { exportado_em: nowIso(), condominios: Object.values(S.condos), equipamentos: Object.values(S.equip), planos: Object.values(S.plans), ordens: Object.values(S.ots), equipa: Object.values(S.equipa).map(({id,nome,email,telefone,papel,ativo}) => ({id,nome,email,telefone,papel,ativo})) };
  download(`manutencao-${today()}.json`, JSON.stringify(data, null, 1), "application/json");
}
function exportCSV(){
  const head = ["Nº","Título","Código","Condomínio","Morada","Equipamento","Zona","Técnico","Tipo","Prioridade","Estado","Prevista","Concluída","Pedido por","Descrição","Peças","Tempo (min)","Materiais (€)","Mão de obra (€)","Deslocações","Deslocação (€)","Manutenção extra","Extra (€)","Total (€)","Notas"];
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = sortOts(Object.values(S.ots)).map(o => { const c = S.condos[condoOf(o)] || {}; return [numOt(o), o.titulo, c.codigo, c.nome, c.morada, eqName(o.equipId), o.zona, nm(o.tecnico), TIPOS_OT[o.tipo]||o.tipo, (PRIOR[o.prioridade]||PRIOR.media)[0], ESTADOS[o.estado], fmtDate(o.data), o.concluida?fmtDate(o.concluida):"", o.solicitante, o.descricao, (o.pecas||[]).map(p => partLabel(p) + " x" + p.q).join("; "), o.tempo, ...(v => [v.mat, v.mo, v.nd, v.desl, v.exTipo ? EXTRAS[v.exTipo] : "", v.ex, v.total].map((x, k) => k === 2 || k === 4 ? x : x.toFixed(2).replace(".", ",")))(valores(o)), o.notas].map(cell).join(";"); });
  download(`ordens-${today()}.csv`, "﻿" + [head.map(cell).join(";"), ...rows].join("\r\n"), "text/csv;charset=utf-8");
}

/* ---------- notificações (sino) ---------- */
function markNotifsRead(ids){
  ids = [...new Set(ids)].filter(Boolean); if(!ids.length) return;
  S.notifs = S.notifs.map(n => ids.includes(n.id) ? { ...n, lida: true } : n); renderWho();
  sb.from("notificacoes").update({ lida: true }).in("id", ids).then(() => {});
}
// Avisos de "ordem atribuída" deixam de contar quando a ordem está concluída (ou foi apagada).
function autoReadNotifs(){
  markNotifsRead(S.notifs.filter(n => !n.lida && n.tipo === "atrib" && n.ordemId && (!S.ots[n.ordemId] || S.ots[n.ordemId].estado === "concluida")).map(n => n.id));
}
function readNotifsForOrder(id){ markNotifsRead(S.notifs.filter(n => !n.lida && n.ordemId === id).map(n => n.id)); }
function openNotifs(){
  const L = S.notifs;
  openSheet("Notificações", L.length ? `<div class="list">${L.map(n => `<div class="item" onclick="${n.ordemId && S.ots[n.ordemId] ? `openOt('${esc(n.ordemId)}')` : ""}"><div class="bar ${n.lida?"":(n.tipo==="concl"?"green":"amber")}"></div><div class="main"><div class="t" style="${n.lida?"font-weight:500":""}">${esc(n.titulo)}</div><div class="s">${esc(n.corpo)}</div></div><div class="r">${n.lida?"":'<span class="badge b-amber">Nova</span>'}<span>${fmtDT(n.criadaEm)}</span></div></div>`).join("")}</div>`
    : emptyBox(IS_ADMIN ? "Ainda sem notificações. Vai ser avisado quando um técnico concluir uma ordem ou registar uma ocorrência." : "Ainda sem notificações. Vai ser avisado quando lhe atribuírem uma ordem."));
  if(L.some(n => !n.lida)){
    S.notifs = L.map(n => ({ ...n, lida: true })); renderWho();
    sb.from("notificacoes").update({ lida: true }).eq("user_id", ME).eq("lida", false).then(() => {});
  }
}

/* ---------- condomínios ---------- */
function editCondo(id){
  if(!IS_ADMIN) return;
  const c = id ? S.condos[id] : {};
  openSheet(id ? "Editar condomínio" : "Novo condomínio", `
    <div class="grid2"><label class="f"><span>Código</span><input id="c_cod" value="${esc(c.codigo)}" placeholder="Ex.: FR02"></label><label class="f"><span>NIF</span><input id="c_nif" inputmode="numeric" value="${esc(c.nif)}"></label></div>
    <label class="f"><span>Nome *</span><input id="c_nome" value="${esc(c.nome)}" placeholder="Ex.: Edifício Santa Cruz B4"></label>
    <label class="f"><span>Morada</span><input id="c_morada" value="${esc(c.morada)}" placeholder="Rua, nº, código postal, localidade"></label>
    <div class="grid2"><label class="f"><span>Administração</span><input id="c_admin" value="${esc(c.admin)}" placeholder="Empresa ou administrador"></label>
    <label class="f"><span>Contacto</span><input id="c_contacto" value="${esc(c.contacto)}" placeholder="Telefone / e-mail"></label></div>
    <label class="f"><span>Nº de frações</span><input id="c_fracoes" type="number" min="0" value="${esc(c.fracoes)}" style="max-width:140px"></label>
    <div class="f"><span>Coordenadas (GPS) do prédio</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><input id="c_geo" value="${c.lat != null && c.lon != null ? c.lat + ", " + c.lon : ""}" placeholder="Ex.: 41.24123, -8.52901 — ou cole o link do Google Maps" style="flex:1 1 220px;min-width:0" oninput="geoInfo()">
      <button type="button" class="btn sm" onclick="geoAqui()"><i class=ico-pin></i>Usar a minha localização</button></div>
      <div class="muted" id="c_geoinfo" style="font-size:12.5px;margin-top:4px">${c.lat != null ? (c.geoFonte === "local" ? "Confirmada no local." : "Aproximada (pela morada).") : "Serve para os técnicos escolherem o prédio pela localização (botão «Estou neste prédio»)."}</div></div>
    <label class="f"><span>Acessos e notas (visível para os técnicos)</span><textarea id="c_notas" placeholder="Onde estão as chaves, horários, contacto do porteiro, localização dos contadores…">${esc(c.notas)}</textarea></label>
    <div class="actions">${id?`<button class="btn danger" onclick="armDelete(this,()=>{delCondo('${id}')})">Eliminar</button>`:""}<span class="sp"></span><button class="btn" onclick="${id?`openCondo('${id}')`:"closeSheet()"}">Cancelar</button><button class="btn pri" onclick="saveCondo('${id||""}')">Guardar</button></div>`);
}
function saveCondo(id){
  const nome = val("c_nome"); if(!nome){ toast("Indique o nome do condomínio."); return; }
  const prev = id ? S.condos[id] : null;
  const c = {...(prev||{}), id: id || ("c" + newId()), codigo: val("c_cod").toUpperCase(), nif: val("c_nif"), nome, morada: val("c_morada"), admin: val("c_admin"), contacto: val("c_contacto"), fracoes: val("c_fracoes"), notas: val("c_notas")};
  const gtxt = val("c_geo"), g = lerCoords(gtxt);
  if(gtxt && !g){ toast("Não percebi as coordenadas. Escreva por exemplo: 41.24123, -8.52901"); return; }
  if(!gtxt){ c.lat = null; c.lon = null; c.geoFonte = ""; }
  else if(!prev || prev.lat !== g.lat || prev.lon !== g.lon){ c.lat = g.lat; c.lon = g.lon; c.geoFonte = "local"; }
  put("condos", c); toast("Condomínio guardado."); openCondo(c.id);
}
// "41.24, -8.52", "41,24123 -8,52901", ou um link do Google Maps (…@41.24,-8.52,17z / ?q=41.24,-8.52)
// link para o GPS (Google Maps abre a navegação; no iPhone/Android abre a app de mapas se existir)
const rotaUrl = c => c && (c.lat != null && c.lon != null ? `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}` : c.morada ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(c.morada)}` : "");
const rotaBtn = (c, cls) => rotaUrl(c) ? `<a class="btn ${cls || ""}" href="${rotaUrl(c)}" target="_blank" rel="noopener"><i class=ico-pin></i>Como chegar${c.lat != null ? "" : " (pela morada)"}</a>` : "";
function lerCoords(t){
  t = (t || "").trim(); if(!t) return null;
  let m = t.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/) || t.match(/[?&](?:q|query|ll|destination)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i) || t.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
  if(!m) m = t.replace(/(\d),(\d)/g, "$1.$2").match(/(-?\d{1,2}\.\d+)[\s,;]+(-?\d{1,3}\.\d+)/);
  if(!m) return null;
  const la = +m[1], lo = +m[2];
  if(!(la > 36 && la < 43 && lo > -10 && lo < -6)) return null; // Portugal continental
  return { lat: +la.toFixed(5), lon: +lo.toFixed(5) };
}
function geoInfo(){ const i = document.getElementById("c_geoinfo"), v = val("c_geo"); if(!i) return; const g = lerCoords(v); i.textContent = !v ? "Sem coordenadas." : g ? `Lido: ${g.lat}, ${g.lon}` : "Não percebi — escreva latitude, longitude (ex.: 41.24123, -8.52901)."; }
function geoAqui(){
  const i = document.getElementById("c_geoinfo"); if(i) i.textContent = "A ver onde está…";
  if(!navigator.geolocation){ if(i) i.textContent = "Este aparelho não dá a localização."; return; }
  navigator.geolocation.getCurrentPosition(p => { const e = document.getElementById("c_geo"); if(e) e.value = p.coords.latitude.toFixed(5) + ", " + p.coords.longitude.toFixed(5); const i2 = document.getElementById("c_geoinfo"); if(i2) i2.textContent = `Localização atual (precisão ~${Math.round(p.coords.accuracy)} m). Carregue em Guardar.`; },
    () => { const i2 = document.getElementById("c_geoinfo"); if(i2) i2.textContent = "Não foi possível saber a localização."; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
// técnico no prédio: guarda a localização (só se o prédio ainda não a tiver confirmada)
function guardarAqui(cid){
  if(!navigator.geolocation){ toast("Este aparelho não dá a localização."); return; }
  toast("A ver onde está…");
  navigator.geolocation.getCurrentPosition(async p => {
    if(p.coords.accuracy > 80){ toast(`A localização está pouco precisa (~${Math.round(p.coords.accuracy)} m). Tente na rua, junto à entrada.`); return; }
    const { error } = await sb.rpc("guardar_posicao_condo", { cid, la: p.coords.latitude, lo: p.coords.longitude });
    if(error){ toast("Não foi possível guardar."); return; }
    S.condos[cid] = { ...S.condos[cid], lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5), geoFonte: "local" }; toast("Localização do prédio guardada."); if(sheetRefresh) sheetRefresh();
  }, () => toast("Não foi possível saber a localização."), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
function delCondo(id){
  const busy = Object.values(S.ots).some(o => condoOf(o) === id) || Object.values(S.plans).some(p => condoOf(p) === id) || Object.values(S.equip).some(e => e.condoId === id);
  if(busy){ toast("Este condomínio tem equipamentos, planos ou ordens. Elimine-os primeiro."); return; }
  del("condos", id); closeSheet(); toast("Condomínio eliminado.");
}
function openCondo(id, startSub){
  if(!S.condos[id]) return;
  let sub = startSub || "ordens"; let cq = "";
  const draw = () => {
    const c = S.condos[id]; if(!c) return "";
    const ots = otsSorted().filter(o => condoOf(o) === id);
    const plans = Object.values(S.plans).filter(p => condoOf(p) === id).sort((a,b) => planNext(a).localeCompare(planNext(b)));
    const eqs = Object.values(S.equip).filter(e => e.condoId === id).sort((a,b)=>a.nome.localeCompare(b.nome, "pt"));
    const pend = ots.filter(o => o.estado !== "concluida");
    let content = "";
    if(sub === "ordens") content = `<div class="list">${ots.length ? ots.map(o=>otItem(o,true)).join("") : emptyBox(IS_ADMIN?"Sem ordens de trabalho neste condomínio.":"Não tem ordens neste condomínio.")}</div>`;
    if(sub === "prev") content = `<div class="list">${plans.length ? plans.map(p=>planItem(p,true)).join("") : emptyBox("Sem planos preventivos.")}</div><div class="actions" style="margin-top:10px"><button class="btn" onclick="editPlan(null,'${id}')">+ Plano preventivo</button></div>`;
    const cdms = Object.values(S.cdm).filter(x => x.condoId === id).sort((a,b) => (a.fracao ? 0 : 1) - (b.fracao ? 0 : 1) || (a.fracao||"").localeCompare(b.fracao||"", "pt", {numeric:true}) || a.nome.localeCompare(b.nome, "pt"));
    if(sub === "cdm"){
      const list = cdms.filter(x => !cq || hit([x.fracao, x.nome, x.telefone, x.email, x.notas].join(" "), cq));
      content = `${cdms.length > 8 ? `<input class="search" placeholder="Procurar condómino, fração ou telefone…" value="${esc(cq)}" oninput="condoCq(this.value)">` : ""}
      <div class="list" id="cdmList">${list.length ? list.map(x => `<div class="item" onclick="editCdm('${x.id}')" style="cursor:pointer"><div class="bar"></div><div class="main">
        <div class="t">${x.fracao?`<span class="mono" style="color:var(--accent);margin-right:6px">${esc(x.fracao)}</span>`:""}${esc(x.nome)}</div>
        ${x.telefone && !splitTels(x.telefone).length ? `<div class="s mono">${esc(x.telefone)}</div>` : ""}${x.email?`<div class="s">${esc(x.email)}</div>`:""}${x.notas?`<div class="s" style="white-space:pre-wrap">${esc(x.notas)}</div>`:""}
        <div class="actions" style="margin-top:6px" onclick="event.stopPropagation()">${x.telefone ? telBtns(x.telefone) : ""}${x.email?`<a class="btn sm" href="mailto:${esc(x.email)}"><i class=ico-mail></i>E-mail</a>`:""}</div>
      </div></div>`).join("") : emptyBox(cdms.length ? "Nenhum condómino encontrado." : "Ainda sem condóminos registados. Carregue em + Condómino para acrescentar.")}</div>
      <div class="actions" style="margin-top:10px"><button class="btn" onclick="editCdm(null,'${id}')">+ Condómino</button></div>`;
    }
    if(sub === "equip") content = `<div class="list">${eqs.length ? eqs.map(e => `<div class="item" onclick="openEquip('${e.id}')"><div class="bar"></div><div class="main"><div class="t">${esc(e.nome)}</div><div class="s">${esc([e.tipo, e.local].filter(Boolean).join(" · "))}</div></div></div>`).join("") : emptyBox("Sem equipamentos registados.")}</div>${IS_ADMIN?`<div class="actions" style="margin-top:10px"><button class="btn" onclick="editEquip(null,'${id}')">+ Equipamento</button></div>`:""}`;
    const maps = (c.lat != null || c.morada) ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.lat != null ? c.lat + "," + c.lon : c.morada)}" target="_blank" rel="noopener" style="color:var(--blue);font-size:13px;margin-left:6px">mapa ↗</a>` : "";
    const geoLinha = c.geoFonte === "local" ? `<div class="geol ok"><i class=ico-pin></i>Localização do prédio guardada${IS_ADMIN ? " · para corrigir, use Editar" : ""}</div>` : `<div class="geol"><button class="btn" onclick="guardarAqui('${id}')"><i class=ico-pin></i>Estou aqui — guardar localização</button><span>Carregue quando estiver no prédio.</span></div>`;
    return `<div class="panel"><dl class="kv">
      ${c.codigo?`<dt>Código</dt><dd class="mono">${esc(c.codigo)}</dd>`:""}
      <dt>Morada</dt><dd>${esc(c.morada||"—")}</dd>
      ${c.lat != null && c.lon != null ? `<dt>Coordenadas</dt><dd class="mono">${c.lat}, ${c.lon}</dd>` : ""}
      <dt>NIF</dt><dd class="mono">${esc(c.nif||"—")}</dd>
      ${c.admin?`<dt>Administração</dt><dd>${esc(c.admin)}</dd>`:""}
      ${c.contacto?`<dt>Contacto</dt><dd>${esc(c.contacto)}</dd>`:""}
      ${c.fracoes?`<dt>Frações</dt><dd>${esc(c.fracoes)}</dd>`:""}
      ${c.notas?`<dt>Acessos</dt><dd style="white-space:pre-wrap">${esc(c.notas)}</dd>`:""}</dl><div class="geol" style="border-top:0;margin-top:8px;padding-top:0">${rotaBtn(c, "pri")}</div>${geoLinha}</div>
      <div class="actions" style="margin-bottom:14px">${IS_ADMIN?`<button class="btn" onclick="editCondo('${id}')">Editar</button>`:""}<span class="sp"></span><button class="btn dark" onclick="${IS_ADMIN ? `editOt(null,'${id}')` : `openTrabalho('${id}')`}">+ ${IS_ADMIN?"Nova ordem":"Novo trabalho"}</button></div>
      <div class="seg" style="margin-bottom:10px">
        <button class="${sub==="ordens"?"on":""}" onclick="condoSub('ordens')">Ordens${pend.length?` (${pend.length})`:""}</button>
        ${IS_ADMIN?`<button class="${sub==="prev"?"on":""}" onclick="condoSub('prev')">Preventiva (${plans.length})</button>`:""}
        <button class="${sub==="cdm"?"on":""}" onclick="condoSub('cdm')">Condóminos (${cdms.length})</button>
        <button class="${sub==="equip"?"on":""}" onclick="condoSub('equip')">Equip. (${eqs.length})</button></div>
      ${content}`;
  };
  window.condoSub = s => { sub = s; cq = ""; const b = $("#sheet .body"); if(b) b.innerHTML = draw(); };
  window.condoCq = v => { cq = v; const tmp = document.createElement("div"); tmp.innerHTML = draw(); const n = tmp.querySelector("#cdmList"); if(n && $("#cdmList")) $("#cdmList").innerHTML = n.innerHTML; };
  openSheet(esc(cLabel(S.condos[id])), draw(), () => { const b = $("#sheet .body"); if(b && S.condos[id]) b.innerHTML = draw(); else if(!S.condos[id]) closeSheet(); });
}

/* ---------- condóminos ---------- */
let cdmVolta = null;   // de onde se abriu (ex.: uma ordem) para voltar lá depois de guardar
function editCdm(id, condoId, voltaOt){
  cdmVolta = voltaOt || null;
  const x = id ? S.cdm[id] : { condoId };
  openSheet(id ? "Editar condómino" : "Novo condómino", `
    <p style="margin-top:0;color:var(--muted);font-size:14px">${esc(cName(x.condoId))}</p>
    <div class="grid2"><label class="f"><span>Fração</span><input id="k_fr" value="${esc(x.fracao)}" placeholder="Ex.: 1º Esq Frt"></label>
    <label class="f"><span>Telemóvel / telefone</span><input id="k_tel" type="tel" value="${esc(x.telefone)}"></label></div>
    <label class="f"><span>Nome *</span><input id="k_nome" value="${esc(x.nome)}"></label>
    <label class="f"><span>E-mail</span><input id="k_mail" type="email" value="${esc(x.email)}"></label>
    <label class="f"><span>Notas</span><textarea id="k_notas" placeholder="Proprietário / inquilino, melhor hora para contactar…">${esc(x.notas)}</textarea></label>
    ${!id && !IS_ADMIN ? `<div style="font-size:12.5px;color:var(--muted);margin:-4px 0 8px">Fica guardado na lista de condóminos deste prédio, com o seu nome como quem o acrescentou.</div>` : ""}
    <div class="actions">${id && IS_ADMIN?`<button class="btn danger" onclick="armDelete(this,()=>{del('cdm','${id}');openCondo('${x.condoId}','cdm');toast('Condómino apagado.')})">Eliminar</button>`:""}<span class="sp"></span><button class="btn" onclick="cdmVoltar('${x.condoId}')">Cancelar</button><button class="btn pri" onclick="saveCdm('${id||""}','${x.condoId}')">Guardar</button></div>`);
}
function saveCdm(id, condoId){
  const nome = val("k_nome"); if(!nome){ toast("Indique o nome."); return; }
  let notas = val("k_notas");
  if(!id) notas = (notas ? notas + "\n" : "") + "Acrescentado por " + nm(ME) + " em " + fmtDate(today());
  const x = { ...(id ? S.cdm[id] : {}), id: id || newId(), condoId, fracao: val("k_fr"), nome, telefone: val("k_tel"), email: val("k_mail"), notas };
  put("cdm", x); toast("Condómino guardado."); cdmVoltar(condoId);
}
function cdmVoltar(condoId){ const o = cdmVolta; cdmVolta = null; if(o && S.ots[o]) openOt(o); else openCondo(condoId, "cdm");
}

/* ---------- equipamentos ---------- */
function editEquip(id, condoId){
  if(!IS_ADMIN) return;
  const e = id ? S.equip[id] : {condoId: condoId || condoF || ""};
  openSheet(id ? "Editar equipamento" : "Novo equipamento", `
    ${condoPicker(e.condoId)}
    <label class="f"><span>Nome *</span><input id="f_nome" value="${esc(e.nome)}" placeholder="Ex.: Elevador A, Portão da garagem"></label>
    <div class="grid2"><label class="f"><span>Tipo</span><select id="f_tipo">${TIPOS_EQ.map(t=>`<option ${t===e.tipo?"selected":""}>${t}</option>`).join("")}</select></label>
    <label class="f"><span>Localização no prédio</span><input id="f_local" value="${esc(e.local)}" placeholder="Ex.: Garagem -1, Cobertura"></label></div>
    <div class="grid2"><label class="f"><span>Marca</span><input id="f_marca" value="${esc(e.marca)}"></label>
    <label class="f"><span>Modelo</span><input id="f_modelo" value="${esc(e.modelo)}"></label></div>
    <div class="grid2"><label class="f"><span>Nº de série</span><input id="f_serie" value="${esc(e.serie)}"></label>
    <label class="f"><span>Empresa assistência / contrato</span><input id="f_emp" value="${esc(e.empresa)}" placeholder="Ex.: empresa dos elevadores"></label></div>
    <label class="f"><span>Notas</span><textarea id="f_notas">${esc(e.notas)}</textarea></label>
    <div class="actions">${id?`<button class="btn danger" onclick="armDelete(this,()=>{delEquip('${id}')})">Eliminar</button>`:""}<span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" onclick="saveEquip('${id||""}')">Guardar</button></div>`);
}
function saveEquip(id){
  const nome = val("f_nome"), condoId = val("f_condo");
  if(!nome || !condoId){ toast("Indique o condomínio e o nome."); return; }
  const prev = id ? S.equip[id] : null;
  const e = {...(prev||{}), id: id || newId(), condoId, nome, tipo: val("f_tipo"), local: val("f_local"), marca: val("f_marca"), modelo: val("f_modelo"), serie: val("f_serie"), empresa: val("f_emp"), notas: val("f_notas")};
  put("equip", e); toast("Equipamento guardado."); openEquip(e.id);
}
function delEquip(id){
  if(Object.values(S.ots).some(o => o.equipId === id) || Object.values(S.plans).some(p => p.equipId === id)){ toast("Este equipamento tem ordens ou planos associados."); return; }
  const c = S.equip[id] && S.equip[id].condoId; del("equip", id); toast("Equipamento eliminado.");
  if(c && S.condos[c]) openCondo(c); else closeSheet();
}
function openEquip(id){
  if(!S.equip[id]) return;
  const draw = () => {
    const e = S.equip[id]; if(!e) return "";
    const ots = otsSorted().filter(o => o.equipId === id);
    const plans = IS_ADMIN ? Object.values(S.plans).filter(p => p.equipId === id) : [];
    return `<div class="panel"><dl class="kv">
      <dt>Condomínio</dt><dd><a href="#" style="color:inherit" onclick="event.preventDefault();openCondo('${e.condoId}')">${esc(cName(e.condoId))}</a></dd>
      <dt>Tipo</dt><dd>${esc(e.tipo||"—")}</dd><dt>Local</dt><dd>${esc(e.local||"—")}</dd>
      <dt>Marca / modelo</dt><dd>${esc([e.marca,e.modelo].filter(Boolean).join(" ")||"—")}</dd>
      <dt>Nº série</dt><dd class="mono">${esc(e.serie||"—")}</dd>
      ${e.empresa?`<dt>Assistência</dt><dd>${esc(e.empresa)}</dd>`:""}
      ${e.notas?`<dt>Notas</dt><dd style="white-space:pre-wrap">${esc(e.notas)}</dd>`:""}</dl></div>
      <div class="actions">${IS_ADMIN?`<button class="btn" onclick="editEquip('${id}')">Editar</button><button class="btn" onclick="editPlan(null,'${e.condoId}','${id}')">+ Plano preventivo</button>`:""}<span class="sp"></span><button class="btn dark" onclick="editOt(null,'${e.condoId}','${id}')">+ ${IS_ADMIN?"Ordem":"Ocorrência"}</button></div>
      ${plans.length?`<h3>Planos preventivos</h3><div class="list">${plans.map(p=>planItem(p,true)).join("")}</div>`:""}
      <h3>Histórico de intervenções</h3><div class="list">${ots.length?ots.map(o=>otItem(o,true)).join(""):emptyBox("Sem intervenções registadas.")}</div>`;
  };
  openSheet(esc(S.equip[id].nome), draw(), () => { const b = $("#sheet .body"); if(b && S.equip[id]) b.innerHTML = draw(); else if(!S.equip[id]) closeSheet(); });
}

/* ---------- planos preventivos ---------- */
function editPlan(id, condoId, equipId){
  if(!IS_ADMIN) return;
  const p = id ? S.plans[id] : {periodo:30, condoId: condoId || condoF || "", equipId: equipId||"", inicio: today()};
  const cid = condoOf(p);
  const custom = !PERIODOS.some(x => x[0] == p.periodo);
  const last = id ? lastExec(p) : "";
  openSheet(id ? "Editar plano" : "Novo plano preventivo", `
    <label class="f"><span>Título *</span><input id="f_tit" value="${esc(p.titulo)}" placeholder="Ex.: Ronda mensal às áreas comuns"></label>
    ${condoPicker(cid, true)}
    <div class="grid2"><label class="f"><span>Equipamento (opcional)</span><select id="f_eq">${equipOptions(cid, p.equipId)}</select></label>
    <label class="f"><span>Zona</span><input id="f_zona" value="${esc(p.zona)}" placeholder="Ex.: Garagem, cobertura"></label></div>
    <label class="f"><span>Técnico responsável</span><select id="f_tec" onchange="this.dataset.auto='0'">${techOptions(p.tecnico || (!id ? respZona(cid) : ""))}</select><small id="f_tec_h" style="color:var(--muted)"></small></label>
    <div class="grid2"><label class="f"><span>Periodicidade</span><select id="f_per" onchange="document.getElementById('f_perc').parentElement.style.display=this.value==='x'?'block':'none'">${PERIODOS.map(([d,l])=>`<option value="${d}" ${d==p.periodo?"selected":""}>${l}</option>`).join("")}<option value="x" ${custom?"selected":""}>Outra…</option></select></label>
    <label class="f" style="display:${custom?"block":"none"}"><span>A cada (dias)</span><input id="f_perc" type="number" min="1" value="${custom?esc(p.periodo):""}"></label></div>
    <div class="grid2"><label class="f"><span>${last?"Última execução":"Primeira execução"}</span><input type="date" id="f_data" value="${esc(last||p.inicio)}"></label><span></span></div>
    <label class="f"><span>Checklist (uma verificação por linha)</span><textarea id="f_ck" style="min-height:140px" placeholder="Verificar iluminação das escadas e patamares&#10;Testar iluminação de emergência&#10;Verificar portão da garagem e fotocélulas&#10;Verificar pressão do hidropressor&#10;Inspecionar caixas de esgoto e caleiras&#10;Verificar validade dos extintores">${esc((p.checklist||[]).join("\n"))}</textarea></label>
    <div class="actions">${id?`<button class="btn danger" onclick="armDelete(this,()=>{del('plans','${id}');closeSheet();toast('Plano eliminado.')})">Eliminar</button>`:""}<span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" onclick="savePlan('${id||""}')">Guardar</button></div>`);
}
function savePlan(id){
  const titulo = val("f_tit"), condoId = val("f_condo");
  if(!titulo || !condoId){ toast("Preencha o título e o condomínio."); return; }
  let equipId = val("f_eq"); if(equipId && (S.equip[equipId]||{}).condoId !== condoId) equipId = "";
  let periodo = val("f_per"); if(periodo === "x") periodo = val("f_perc");
  periodo = Math.max(1, parseInt(periodo) || 30);
  const prev = id ? S.plans[id] : null; const d = val("f_data") || today();
  const p = {...(prev||{}), id: id || newId(), titulo, condoId, equipId, zona: val("f_zona"), tecnico: val("f_tec") || (!prev ? respZona(condoId) : ""), periodo, checklist: val("f_ck").split("\n").map(s=>s.trim()).filter(Boolean)};
  if(prev && lastExec(prev)){ p.ultima = d; } else { p.inicio = d; p.ultima = ""; }
  put("plans", p); toast("Plano guardado."); openPlan(p.id);
}
function openPlan(id){
  if(!IS_ADMIN || !S.plans[id]) return;
  const draw = () => {
    const p = S.plans[id]; if(!p) return "";
    const st = planStatus(p); const open = openOtForPlan(id);
    const hist = sortOts(Object.values(S.ots).filter(o => o.planId === id));
    return `<div class="panel"><dl class="kv">
      <dt>Condomínio</dt><dd>${esc(cName(condoOf(p)))}</dd>
      ${whereTxt(p)?`<dt>Equip. / zona</dt><dd>${esc(whereTxt(p))}</dd>`:""}
      <dt>Responsável</dt><dd>${esc(nm(p.tecnico))}</dd>
      <dt>Periodicidade</dt><dd>${esc(perLabel(p))}</dd>
      <dt>Última</dt><dd>${fmtDate(lastExec(p))}</dd><dt>Próxima</dt><dd><span class="mono">${fmtDate(planNext(p))}</span> <span class="badge ${st[1]}">${st[0]}</span></dd></dl>
      ${(p.checklist||[]).length?`<div style="margin-top:10px;font-size:14px"><b>Checklist</b><ul style="margin:4px 0 0;padding-left:18px">${p.checklist.map(c=>`<li>${esc(c)}</li>`).join("")}</ul></div>`:""}</div>
      <div class="actions"><button class="btn" onclick="editPlan('${id}')">Editar</button><span class="sp"></span>${open?`<button class="btn dark" onclick="openOt('${open.id}')">Abrir ordem em curso</button>`:`<button class="btn pri" onclick="genFromPlan('${id}')">Criar ordem de trabalho</button>`}</div>
      ${hist.length?`<h3>Execuções</h3><div class="list">${hist.map(o=>otItem(o,true)).join("")}</div>`:""}`;
  };
  openSheet(esc(S.plans[id].titulo), draw(), () => { const b=$("#sheet .body"); if(b && S.plans[id]) b.innerHTML = draw(); else if(!S.plans[id]) closeSheet(); });
}
function genFromPlan(pid){
  if(!IS_ADMIN) return;
  const p = S.plans[pid]; if(!p) return;
  const ex = openOtForPlan(pid); if(ex){ openOt(ex.id); return; }
  const tec = p.tecnico || "";
  const o = {id:newId(), titulo:p.titulo, condoId:condoOf(p), equipId:p.equipId||"", zona:p.zona||"", tecnico:tec, tipo:"preventiva", prioridade:"media", estado:"aberta", data: planNext(p) < today() ? today() : planNext(p), descricao:"", solicitante:"", planId:pid, checklist:(p.checklist||[]).map(t=>({t, ok:false})), pecas:[], fotos:[], notas:"", tempo:0, criada: today(), criadaEm: nowIso(), criadoPor: ME, atribuida: tec ? today() : "", atribuidaEm: tec ? nowIso() : "", atribuidoPor: tec ? ME : ""};
  put("ots", o); toast(tec ? "Ordem criada e atribuída a " + nm(tec) + "." : "Ordem criada — falta atribuir."); openOt(o.id);
}

/* ---------- ordens de trabalho ---------- */
function editOt(id, condoId, equipId){
  const o = id ? S.ots[id] : {tipo:"corretiva", prioridade:"media", data: today(), condoId: condoId || condoF || "", equipId: equipId||"", tecnico: IS_ADMIN ? (techF && techF !== "-" ? techF : "") : ME};
  if(id && !canEditOt(o)) return;
  if(id && isEntrega(o)) return openSaidaDireta(id);
  const cid = condoOf(o);
  openSheet(id ? "Editar ordem" : (IS_ADMIN ? "Nova ordem de trabalho" : "Novo trabalho"), `
    ${IS_ADMIN?"":'<p style="font-size:13px;color:var(--muted);margin-top:0">Para um trabalho feito sem ordem do escritório (manutenção, reparação, avaria encontrada no local). Depois de guardar, acrescente o material, as horas e as fotos e carregue em <b>Concluir</b>. O escritório é avisado.</p>'}
    <label class="f"><span>Título *</span><input id="f_tit" value="${esc(o.titulo)}" placeholder="Ex.: Manutenção geral, troca de lâmpadas no 3º"></label>
    ${condoPicker(cid, true)}
    <div class="grid2"><label class="f"><span>Equipamento (opcional)</span><select id="f_eq">${equipOptions(cid, o.equipId)}</select></label>
    <label class="f"><span>Zona / fração</span><input id="f_zona" value="${esc(o.zona)}" placeholder="Ex.: Hall do 3º esq., garagem -1"></label></div>
    ${IS_ADMIN?`<label class="f"><span>Atribuir a</span><select id="f_tec" onchange="this.dataset.auto='0'">${techOptions(o.tecnico || (!id ? respZona(cid) : ""))}</select><small id="f_tec_h" style="color:var(--muted)">${!id && !o.tecnico && respZona(cid) ? "Responsável da zona " + esc(localidade(S.condos[cid])) + "." : ""}</small></label>`:""}
    <div class="grid2"><label class="f"><span>Tipo</span><select id="f_tipo">${Object.entries(TIPOS_OT).map(([k,l])=>`<option value="${k}" ${o.tipo===k?"selected":""}>${l}</option>`).join("")}</select></label>
    <label class="f"><span>Prioridade</span><select id="f_pri">${Object.entries(PRIOR).map(([k,v])=>`<option value="${k}" ${k===o.prioridade?"selected":""}>${v[0]}</option>`).join("")}</select></label></div>
    <div class="grid2"><label class="f"><span>Data prevista</span><input type="date" id="f_data" value="${esc(o.data)}"></label>
    <label class="f"><span>Pedido por</span><input id="f_sol" value="${esc(o.solicitante)}" placeholder="Administração, condómino 2º dto…"></label></div>
    <label class="f"><span>Descrição da avaria / pedido</span><textarea id="f_desc">${esc(o.descricao)}</textarea></label>
    ${IS_ADMIN && !id && S.folhaCol ? `<label class="fatchk" style="margin:-4px 0 12px"><input type="checkbox" id="f_folha"> Serviço já feito — estou a passar a folha do técnico <span style="color:var(--muted);font-size:12.5px">(o técnico não é avisado)</span></label>` : ""}
    <label class="f"><span>Checklist (opcional, uma verificação por linha)</span><textarea id="f_ck">${esc((o.checklist||[]).map(c=>c.t).join("\n"))}</textarea></label>
    <div class="actions">${id && IS_ADMIN?`<button class="btn danger" onclick="armDelete(this,()=>{del('ots','${id}');closeSheet();toast('Ordem eliminada.')})">Eliminar</button>`:""}<span class="sp"></span><button class="btn" onclick="${id?`openOt('${id}')`:"closeSheet()"}">Cancelar</button><button class="btn pri" onclick="saveOt('${id||""}')">Guardar</button></div>`);
}
function saveOt(id){
  const titulo = val("f_tit"), condoId = val("f_condo");
  if(!titulo || !condoId){ toast("Preencha o título e o condomínio."); return; }
  let equipId = val("f_eq"); if(equipId && (S.equip[equipId]||{}).condoId !== condoId) equipId = "";
  const prev = id ? S.ots[id] : null;
  const old = new Map((prev && prev.checklist || []).map(c => [c.t, c.ok]));
  const checklist = val("f_ck").split("\n").map(s=>s.trim()).filter(Boolean).map(t => ({t, ok: !!old.get(t)}));
  const tecnico = IS_ADMIN ? (val("f_tec") || (!prev ? respZona(condoId) : "")) : (prev ? prev.tecnico : ME);
  const o = {...(prev || {estado:"aberta", pecas:[], fotos:[], notas:"", tempo:0, criada: today(), criadaEm: nowIso(), criadoPor: ME}), id: id || newId(), titulo, condoId, equipId, tecnico, zona: val("f_zona"), tipo: val("f_tipo"), prioridade: val("f_pri"), data: val("f_data"), solicitante: val("f_sol"), descricao: val("f_desc"), checklist};
  if(tecnico && (!prev || prev.tecnico !== tecnico)){ o.atribuida = today(); o.atribuidaEm = nowIso(); o.atribuidoPor = ME; }
  const folha = !prev && IS_ADMIN && document.getElementById("f_folha") && document.getElementById("f_folha").checked;
  if(folha){ o.deFolha = true; o.estado = "curso"; }
  put("ots", o);
  if(folha) toast("Ordem guardada sem avisar " + (tecnico ? nm(tecnico) : "ninguém") + ". Registe agora o material e o tempo."); else
  toast(IS_ADMIN && tecnico && (!prev || prev.tecnico !== tecnico) ? (tecnico === ME ? "Ordem guardada." : "Ordem atribuída a " + nm(tecnico) + " — vai receber notificação.") : "Ordem guardada.");
  openOt(o.id);
}
function updOt(id, patch, quiet){ const o = S.ots[id]; if(!o) return; return put("ots", {...o, ...patch}, quiet); }
function assignOt(id, tec){ updOt(id, {tecnico: tec, atribuida: tec ? today() : "", atribuidaEm: tec ? nowIso() : "", atribuidoPor: tec ? ME : ""}); toast(tec ? "Atribuída a " + nm(tec) + "." : "Ordem sem técnico atribuído."); }
function svcPanel(o, id, locked){
  if(locked) return `<div class="panel svc ok"><i class=ico-check></i><b>Serviço terminado</b>${o.concluida ? " em " + fmtDate(o.concluida) : ""}</div>`;
  const porTerminar = o.estado === "curso" && (nDias(o) > 0 || o.falta || Number(o.tempo) > 0);
  return `<div class="panel svc"><b>O serviço ficou terminado?</b>
    <div class="svcbtns"><button class="btn pri" id="btnConc" onclick="setEstado('${id}','concluida')"><i class=ico-check></i>Sim, está terminado</button>
    <button class="btn ${porTerminar ? "on" : ""}" onclick="naoTerminado('${id}')">Não, ainda vou terminar</button></div>
    <div id="svc_falta" style="${porTerminar ? "" : "display:none"}"><label class="f" style="margin:8px 0 0"><span>O que falta fazer</span><input id="t_falta" value="${esc(o.falta || "")}" placeholder="Ex.: falta pintar; volto quinta-feira com a peça" onchange="setFalta('${id}', this.value)"></label>
      <div style="font-size:12.5px;color:var(--muted);margin-top:4px">Fica <b>Em curso</b>. Quando voltar, acrescente o dia no tempo gasto e no fim carregue em "Sim, está terminado".</div></div>
  </div>`;
}
function naoTerminado(id){
  const o = S.ots[id]; if(!o) return;
  if(o.estado !== "curso") updOt(id, { estado: "curso" }, true);
  const w = $("#svc_falta"); if(w) w.style.display = ""; const f = $("#t_falta"); if(f) f.focus();
  document.querySelectorAll(".svcbtns .btn:not(.pri)").forEach(b => b.classList.add("on"));
  toast("Fica em curso — pode voltar a esta ordem quando continuar.");
}
function setFalta(id, v){
  if(!S.faltaCol){ toast("Falta preparar a base de dados (ficheiro FALTA)."); return; }
  if(S.ots[id] && (S.ots[id].falta || "") !== v) updOt(id, { falta: v }, true);
}
function setEstado(id, estado, fromTop){
  const o = S.ots[id]; if(!o) return;
  if(estado === "concluida"){
    const ck = o.checklist || []; const falta = ck.filter(c => !c.ok).length;
    const btn = document.getElementById("btnConc");
    if(falta && btn && !btn.classList.contains("arm")){ btn.classList.add("arm","danger"); btn.textContent = `Faltam ${falta} verificações — concluir mesmo assim?`; btn.scrollIntoView({behavior:"smooth", block:"center"}); toast(`Faltam ${falta} verificações. Confirme em baixo.`); return; }
    const patch = {estado, concluida: today(), concluidaEm: nowIso(), concluidoPor: ME};
    const pend = pendingPart(); const pn = !!pend; if(pend) patch.pecas = [...(o.pecas||[]), pend];
    const tn = document.getElementById("t_notas"); if(tn && tn.value !== (o.notas||"")){ clearTimeout(notesTimer); patch.notas = tn.value; }
    const th = parseInt(val("t_h"))||0, tm = parseInt(val("t_m"))||0; if(document.getElementById("t_h")) patch.tempo = th*60+tm;
    if(pn) clearPart();
    updOt(id, patch); readNotifsForOrder(id);
    toast(IS_ADMIN ? "Ordem concluída." : "Ordem concluída — o escritório foi avisado.");
  } else {
    updOt(id, {estado, concluida: "", concluidaEm: "", concluidoPor: ""});
  }
}
function toggleCk(id, i){ const o = S.ots[id]; const ck = (o.checklist||[]).map((c,j) => j===i ? {...c, ok:!c.ok} : c); updOt(id, {checklist: ck}); }
function addPart(id){
  const part = pendingPart(); if(!part){ toast("Escolha um material ou escreva o nome."); return; }
  clearPart(); updOt(id, {pecas: [...(S.ots[id].pecas||[]), part]});
}
function rmPart(id, i){ updOt(id, {pecas: (S.ots[id].pecas||[]).filter((_,j)=>j!==i)}); }
let notesTimer = null;
/* ---------- sugestões automáticas (sem IA, por palavras) ---------- */
const GRUPOS_OC = [
  { g: "Infiltrações e águas", re: /infiltr|humid|bolor|água|agua|chuva|caleir|ralo|entup|esgoto|saneamento|tubo de queda|verte|goteira/i, svc: 3, mat: /silicone|veda|desentup/i },
  { g: "Videoporteiros, campainhas e portas", re: /campainh|intercom|video ?porteiro|videop|botoneir|trinco|fechadura|canh[aã]o|n[aã]o abre|porta (de )?entrada|mola/i, svc: 1, mat: /campainh|botoneir|fechadur|canh|trinco/i },
  { g: "Portões e garagem", re: /port[aã]o|comando|garagem|motor/i, svc: 2, mat: /comando|lubrific|massa/i },
  { g: "Iluminação", re: /l[aâ]mpad|luz|luzes|ilumin|sensor|temporizador|foco|apag/i, svc: 0, mat: /l[aâ]mpad|foco|led|sensor/i },
  { g: "Eletricidade", re: /quadro el|disjunt|diferencial|tomada|curto|eletric/i, svc: 4, mat: /tomada|disjunt/i },
  { g: "Placas e sinalização", re: /placa|sinal[eé]tica|sinaliza|pinos/i, svc: 5, mat: /placa|quadro/i },
  { g: "Elevadores", re: /elevador/i, svc: -1, mat: null },
];
const textoOt = o => (o.titulo || "") + " " + (o.descricao || "");
const grupoOc = o => { const t = textoOt(o); const x = GRUPOS_OC.find(g => g.re.test(t)); return x ? x.g : "Outros"; };
const dataOt = o => o.criada || o.data || "";
function sugestoesPanel(o, id, mine, locked, sm){
  if(isExt(o) || locked || isEntrega(o)) return "";
  const t = textoOt(o); const grs = GRUPOS_OC.filter(g => g.re.test(t) && g.svc >= 0);
  const cid = condoOf(o); const blocos = [];
  if(mine && !sm && grs.length){
    const notas = o.notas || ""; const ja = x => notas.split("\n").some(l => l.replace(/^[•\-]\s*/, "").trim() === x);
    const pal = (t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z]{5,}/g) || []).map(w => w.slice(0, 6));
    const pontos = x => { const n = x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); return pal.filter(w => n.includes(w)).length; };
    const svcs = [...new Set(grs.flatMap(g => SERVICOS[g.svc][1]))].filter(x => !ja(x)).map((x, i) => [x, pontos(x), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(a => a[0]).slice(0, 5);
    if(svcs.length) blocos.push(`<div class="muted">Serviços prováveis <span>(toque para pôr nas notas)</span></div>${svcs.map(x => `<button type="button" class="schip" onclick="poeServico('t_notas', this)"><span class="t">${esc(x)}</span></button>`).join("")}`);
  }
  if(mine && grs.length){
    const tem = new Set((o.pecas || []).map(x => x.c));
    const mats = matList().filter(m => !tem.has(m.codigo) && grs[0].mat && grs[0].mat.test(m.nome + " " + m.codigo)).slice(0, 4);
    if(mats.length) blocos.push(`<div class="muted">Material habitual neste tipo de serviço</div>${mats.map(m => `<button type="button" class="schip" onclick="sugMat('${id}','${esc(m.codigo)}')">+ ${esc(m.nome)}</button>`).join("")}`);
  }
  const linhas = [];
  if(grs.length && cid){
    const desde = addDays(today(), -90); const g0 = grupoOc(o);
    const iguais = Object.values(S.ots).filter(x => x.id !== id && condoOf(x) === cid && dataOt(x) >= desde && grupoOc(x) === g0).length;
    if(iguais) linhas.push(`<div class="srow"><span>${iguais} ${iguais === 1 ? "ocorrência" : "ocorrências"} de ${esc(g0.toLowerCase())} neste prédio nos últimos 90 dias</span><button type="button" class="btn sm" onclick="verPredio('${cid}')">Ver</button></div>`);
  }
  if(cid){
    const dig = (o.descricao || "").replace(/\D/g, " ");
    const cd = Object.values(S.cdm).find(k => k.condoId === cid && ((k.telefone && splitTels(k.telefone).some(tl => tl.replace(/\D/g, "").length >= 9 && dig.includes(tl.replace(/\D/g, "")))) || (k.nome && k.nome.length > 4 && (o.descricao || "").toLowerCase().includes(k.nome.toLowerCase()))));
    if(cd && cd.telefone) linhas.push(`<div class="srow"><span>Condómino registado: ${esc(cd.nome)}${cd.fracao ? " (" + esc(cd.fracao) + ")" : ""}</span><a class="btn sm" href="tel:${esc(splitTels(cd.telefone)[0] || cd.telefone)}">Ligar</a></div>`);
  }
  if(linhas.length) blocos.push(`<div class="muted">Também neste prédio</div>${linhas.join("")}`);
  const adm = [];
  if(IS_ADMIN && !o.tecnico){ const r = respZona(cid); if(r) adm.push(`<div class="srow"><span>Técnico da zona ${esc(localidade(S.condos[cid]))}: <b>${esc(nm(r))}</b></span><button type="button" class="btn sm pri" onclick="assignOt('${id}','${r}')">Atribuir</button></div>`); }
  if(IS_ADMIN && o.prioridade !== "alta" && o.prioridade !== "urgente"){
    const desde = addDays(today(), -90); const rep = cid && Object.values(S.ots).filter(x => x.id !== id && condoOf(x) === cid && dataOt(x) >= desde && grupoOc(x) === grupoOc(o) && grupoOc(o) !== "Outros").length;
    const urg = /urgent|n[aã]o abre|n[aã]o fecha|cai [aá]gua|inunda|sem luz|perigo|fuga/i.test(t);
    const inf = grupoOc(o) === "Infiltrações e águas";
    if(urg || (inf && rep)) adm.push(`<div class="srow"><span>Prioridade sugerida: <b>Alta</b> <span class="muted">(${urg ? "pela descrição" : "infiltração repetida"})</span></span><button type="button" class="btn sm" onclick="updOt('${id}',{prioridade:'alta'});toast('Prioridade alta.')">Aplicar</button></div>`);
  }
  if(adm.length) blocos.push(`<div class="muted">Para o escritório</div>${adm.join("")}`);
  if(!blocos.length) return "";
  return `<div class="panel sugp"><div class="sh"><i class=ico-check></i>Sugestões para esta ordem <span>— pela descrição</span></div>${blocos.join("")}</div>`;
}
function sugMat(id, codigo){ const o = S.ots[id], m = S.mat[codigo]; if(!o || !m) return; updOt(id, { pecas: [...(o.pecas || []), { n: m.nome, c: m.codigo, q: 1 }] }); toast(m.nome + " acrescentado (1). Ajuste a quantidade se for preciso."); }
function verPredio(cid){ closeSheet(); condoF = cid; otFilter = "todas"; q = ""; go("ordens"); }

/* ---------- resumos (só escritório) ---------- */
let resPer = "mes";
function periodoRes(k){
  const t = today(), y = +t.slice(0, 4), m = +t.slice(5, 7);
  const pad = n => String(n).padStart(2, "0");
  if(k === "mes") return [`${y}-${pad(m)}-01`, t, "Este mês"];
  if(k === "ant"){ const yy = m === 1 ? y - 1 : y, mm = m === 1 ? 12 : m - 1; const fim = iso(new Date(y, m - 1, 0)); return [`${yy}-${pad(mm)}-01`, fim, "Mês passado"]; }
  if(k === "90") return [addDays(t, -90), t, "Últimos 90 dias"];
  return [`${y}-01-01`, t, "Este ano"];
}
function openResumos(k){
  if(!IS_ADMIN) return; if(k) resPer = k;
  const [ini, fim] = periodoRes(resPer); const dentro = d => d && d >= ini && d <= fim;
  const all = Object.values(S.ots).filter(o => !isEntrega(o));
  const fech = all.filter(o => o.estado === "concluida" && dentro(o.concluida));
  const dias = fech.map(o => { const a = dataOt(o); return a ? (Date.parse(o.concluida) - Date.parse(a)) / 86400e3 : null; }).filter(x => x !== null && x >= 0);
  const media = dias.length ? (dias.reduce((a, b) => a + b, 0) / dias.length) : null;
  const velhas = all.filter(o => o.estado !== "concluida" && !isExt(o) && dataOt(o) && dataOt(o) <= addDays(today(), -30)).length;
  const unid = fech.reduce((a, o) => a + (o.pecas || []).reduce((b, x) => b + (Number(x.q) || 0), 0), 0);
  const conta = (arr, f) => { const m = {}; for(const o of arr){ const k = f(o); if(k) m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const porTec = conta(fech, o => o.tecnico); const maxT = porTec.length ? porTec[0][1] : 1;
  const criadas = all.filter(o => dentro(dataOt(o)));
  const porTipo = conta(criadas, grupoOc);
  const porPredio = conta(criadas, condoOf).slice(0, 8);
  let cars = "";
  if(VE_STOCK() && S.stk && S.stk.ok){
    const m = {}; for(const mv of S.stk.mov){ if(mv.tipo !== "servico" || !dentro(mv.data)) continue; const l = mv.origem; const v = vendaMov(mv); (m[l] = m[l] || { q: 0, e: 0 }); m[l].q += Number(mv.qtd) || 0; m[l].e += v.venda || 0; }
    const rows = Object.entries(m).sort((a, b) => b[1].e - a[1].e);
    cars = `<h3>Material aplicado por local <span class="muted" style="text-transform:none;letter-spacing:0">(só para si)</span></h3><div class="panel">${rows.map(([l, v]) => `<div class="srow"><span>${esc(locNome(l))}</span><span class="mono">${String(v.q).replace(".", ",")} un · ${eur(v.e)}</span></div>`).join("") || '<div class="muted">Sem material aplicado neste período.</div>'}</div>`;
  }
  const lin = (rows, f, clique) => rows.length ? rows.map(([k, n]) => `<div class="srow" ${clique ? `style="cursor:pointer" onclick="${clique(k)}"` : ""}><span>${f(k)}</span><span class="mono">${n}</span></div>`).join("") : '<div class="muted">Sem dados neste período.</div>';
  openSheet("Resumos", `
    <div class="seg" style="margin-bottom:12px">${[["mes","Este mês"],["ant","Mês passado"],["90","90 dias"],["ano","Ano"]].map(([k, l]) => `<button class="${resPer === k ? "on" : ""}" onclick="openResumos('${k}')">${l}</button>`).join("")}</div>
    <div class="stats">
      <div class="stat"><b>${fech.length}</b><span>Ordens fechadas</span></div>
      <div class="stat"><b>${media === null ? "—" : media.toFixed(1).replace(".", ",") + " dias"}</b><span>Tempo médio até fechar</span></div>
      <div class="stat"><b style="${velhas ? "color:var(--red)" : ""}">${velhas}</b><span>Abertas há +30 dias</span></div>
      <div class="stat"><b>${String(unid).replace(".", ",")}</b><span>Unidades de material</span></div>
    </div>
    <h3>Ordens fechadas por técnico</h3><div class="panel">${porTec.length ? porTec.map(([k, n]) => `<div class="srow" style="cursor:pointer" onclick="closeSheet();techF='${k}';otFilter='todas';go('ordens')"><span>${esc(nm(k))}</span><span class="mono">${n}</span></div><div class="rbar"><i style="width:${Math.round(n / maxT * 100)}%"></i></div>`).join("") : '<div class="muted">Nenhuma ordem fechada neste período.</div>'}</div>
    <h3>Tipo de ocorrência <span class="muted" style="text-transform:none;letter-spacing:0">(abertas no período)</span></h3><div class="panel">${lin(porTipo, esc)}</div>
    <h3>Prédios com mais ocorrências</h3><div class="panel">${lin(porPredio, k => esc(cName(k)), k => `verPredio('${k}')`)}</div>
    ${cars}
    <div class="muted" style="margin-top:6px">Toque num técnico ou num prédio para ver essas ordens.</div>
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Fechar</button></div>`);
}
/* ---------- serviços pré-definidos (toca e o texto vai para as notas) ---------- */
const SERVICOS = [
  ["Iluminação", ["Reparação ou substituição de sensor de movimento / temporizador", "Reparação ou substituição de interruptor", "Verificação de iluminação de emergência"]],
  ["Campainhas e porta de entrada", ["Reparação de campainha / intercomunicador / videoporteiro", "Ajuste ou substituição de botoneira", "Reparação do trinco elétrico (a porta não abre)", "Afinação de mola / fecho da porta de entrada", "Substituição de fechadura ou canhão"]],
  ["Portões e garagem", ["Reparação ou afinação de portão de garagem", "Programação de comandos", "Verificação do motor e dos fins de curso", "Lubrificação de calhas e dobradiças"]],
  ["Infiltrações e águas", ["Verificação de infiltração", "Limpeza de caleiros", "Desentupimento de ralos", "Desentupimento de tubos de queda", "Aplicação de silicone / veda-juntas em janelas ou terraços", "Verificação da cobertura / telhado"]],
  ["Eletricidade", ["Verificação do quadro elétrico das zonas comuns", "Rearme de disjuntor / diferencial", "Substituição de tomada"]],
  ["Limpeza e conservação", ["Aplicação de placas (animais, estacionamento) e quadros acrílicos", "Colocação de pinos ou sinalização no estacionamento", "Limpeza de garagem / arrumos comuns"]],
  ["Visitas", ["Acompanhamento de empresa externa", "Visita para orçamento / avaliação"]],
];
const svcTabSel = {};
function servicosPicker(alvo, notas){
  const sel = svcTabSel[alvo] || 0; const tem = t => (notas || "").split("\n").some(l => l.replace(/^[•\-]\s*/, "").trim() === t);
  return `<div class="svcpick2" data-alvo="${alvo}"><div class="sph">Serviços frequentes <span>toque para pôr nas notas</span></div>
    <div class="sptabs">${SERVICOS.map(([g], i) => `<button type="button" class="${i === sel ? "on" : ""}" onclick="svcTab(this, ${i})">${esc(g.replace(" e porta de entrada", "").replace(" e garagem", "").replace(" e águas", "").replace(" e conservação", ""))}</button>`).join("")}</div>
    ${SERVICOS.map(([g, l], i) => `<div class="splist" data-i="${i}" style="${i !== sel ? "display:none" : ""}">${l.map(t => `<button type="button" class="spit${tem(t) ? " on" : ""}" onclick="poeServico('${alvo}', this)"><span class="t">${esc(t)}</span><span class="mais">+</span></button>`).join("")}</div>`).join("")}
  </div>`;
}
function svcTab(btn, i){ const w = btn.closest(".svcpick2"); svcTabSel[w.dataset.alvo] = i; w.querySelectorAll(".sptabs button").forEach(b => b.classList.toggle("on", b === btn)); w.querySelectorAll(".splist").forEach(l => l.style.display = l.dataset.i == i ? "" : "none"); }
function poeServico(alvo, btn){
  const ta = document.getElementById(alvo); if(!ta) return; const t = (btn.querySelector(".t") || btn).textContent.trim();
  const linhas = ta.value.split("\n"); if(linhas.some(l => l.replace(/^[•\-]\s*/, "").trim() === t)){ toast("Já está nas notas."); return; }
  ta.value = (ta.value.trim() ? ta.value.replace(/\s+$/, "") + "\n" : "") + "• " + t;
  ta.dispatchEvent(new Event("input")); btn.classList.add("on");
}
function onNotes(id, v){ clearTimeout(notesTimer); notesTimer = setTimeout(() => { if(S.ots[id] && S.ots[id].notas !== v) updOt(id, {notas: v}, true); }, 900); }
function setExtra(id, k){ updOt(id, { extra: k }); toast(k ? EXTRAS[k] + " registada." : "Sem manutenção extra."); }
function saveClose(id){
  const o = S.ots[id]; if(!o){ closeSheet(); return; }
  clearTimeout(notesTimer);
  const patch = {};
  const tn = document.getElementById("t_notas"); if(tn && tn.value !== (o.notas || "")) patch.notas = tn.value;
  if(document.getElementById("t_h")){ const t = (parseInt(val("t_h"))||0)*60 + (parseInt(val("t_m"))||0); if(t !== (o.tempo||0)) patch.tempo = t; }
  if(isExt(o)){
    const sel = val("x_emp"); const emp = sel === "__outra" ? val("x_emp2") : sel;
    if(document.getElementById("x_emp") && emp !== (o.empresa || "")) patch.empresa = emp;
    const ct = val("x_cont"); if(document.getElementById("x_cont") && ct !== (o.contactada || "")) patch.contactada = ct;
    const rf = val("x_ref"); if(document.getElementById("x_ref") && rf !== (o.refExterna || "")) patch.refExterna = rf;
    if((patch.contactada || o.contactada) && o.estado === "aberta") patch.estado = "curso";
  }
  const pend = pendingPart(); if(pend && o.estado !== "concluida"){ patch.pecas = [...(o.pecas||[]), pend]; clearPart(); }
  if(Object.keys(patch).length) updOt(id, patch, true);
  closeSheet();
  toast(o.estado === "concluida" ? "Guardado." : "Guardado — a ordem continua por fechar.");
}
function diasRows(lista, onch, semData, comX){
  const x_ = onch.replace(/"/g, "&quot;");
  return lista.map(x => `<div class="drow" data-onch="${x_}"${x.sa ? ' data-sa="1"' : ""}>
    <div class="dl1">${semData ? "" : `<input type="date" class="dd" value="${esc(x.d || today())}" onchange="${onch}">`}<input type="number" min="0" class="dh" value="${Math.floor((x.m || 0) / 60)}" onchange="limparHoras(this);${onch}"><span class="dlab">h</span><input type="number" min="0" max="59" step="5" class="dm" value="${(x.m || 0) % 60}" onchange="limparHoras(this);${onch}"><span class="dlab">min</span>${!semData && (comX || lista.length > 1) ? `<button type="button" class="btn sm" onclick="tirarDia(this)" aria-label="Tirar dia">✕</button>` : ""}</div>
    <div class="dl2"><span class="dlab">ou das</span><input type="time" class="di" value="${esc(x.i || "")}" onchange="horaDia(this)"><span class="dlab">às</span><input type="time" class="df" value="${esc(x.f || "")}" onchange="horaDia(this)"></div><div class="dalm">${almTxt(x)}</div></div>`).join("");
}
// Hora de almoço: só se desconta 1 h quando um único período apanha todo o intervalo das 12h00 às 14h00
// (almoçou algures lá dentro, à hora que for). Quem parte o dia em dois períodos (ex.: 9–13 e 14–18) não tem desconto.
// Em cada linha pode-se dizer "não almoçou" (fica guardado como sa = sem almoço).
const ALM_INI = 12 * 60, ALM_FIM = 14 * 60, ALM_MIN = 60;
const minsHora = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const apanhaAlmoco = (i, f) => { if(!i || !f) return false; const a = minsHora(i); let b = minsHora(f); if(b < a) b += 1440; return a <= ALM_INI && b >= ALM_FIM && b - a > ALM_MIN; };
const almHtml = (i, f, sa) => !apanhaAlmoco(i, f) ? "" : sa
  ? `Sem desconto de almoço · <a href="#" onclick="event.preventDefault();togAlmoco(this)">descontar 1 h de almoço</a>`
  : `1 h de almoço descontada · <a href="#" onclick="event.preventDefault();togAlmoco(this)">não almoçou</a>`;
const almTxt = x => almHtml(x.i, x.f, x.sa);
// Das X às Y → calcula as horas e minutos dessa linha
function horaDia(el){
  const r = el.closest(".drow"); const a = r.querySelector(".di").value, b = r.querySelector(".df").value;
  let nota = "";
  if(a && b){ const [h1, m1] = a.split(":").map(Number), [h2, m2] = b.split(":").map(Number); const ini = h1 * 60 + m1; let fim = h2 * 60 + m2; if(fim < ini) fim += 24 * 60;
    let t = fim - ini; const sa = r.dataset.sa === "1";
    if(apanhaAlmoco(a, b) && !sa) t -= ALM_MIN;
    nota = almHtml(a, b, sa);
    r.querySelector(".dh").value = Math.floor(t / 60); r.querySelector(".dm").value = t % 60; }
  let n = r.querySelector(".dalm"); if(!n){ n = document.createElement("div"); n.className = "dalm"; r.appendChild(n); } n.innerHTML = nota;
  correrOnch(r);
}
function togAlmoco(a){ const r = a.closest(".drow"); r.dataset.sa = r.dataset.sa === "1" ? "" : "1"; horaDia(r.querySelector(".df")); }
function limparHoras(el){ const r = el.closest(".drow"); r.querySelector(".di").value = ""; r.querySelector(".df").value = ""; const n = r.querySelector(".dalm"); if(n) n.textContent = ""; }
function tirarDia(btn){ const r = btn.closest(".drow"); const box = r.parentNode; const f = r.dataset.onch; r.remove(); if(box.querySelectorAll(".drow").length === 1){ const b = box.querySelector(".drow button"); if(b) b.remove(); } if(f) (new Function(f.replace(/&quot;/g, '"')))(); }
function correrOnch(r){ const f = r.dataset.onch; if(f) (new Function(f.replace(/&quot;/g, '"')))(); }
function lerDias(elId){ const el = document.getElementById(elId); if(!el) return [];
  return [...el.querySelectorAll(".drow")].map(r => { const o = { d: (r.querySelector(".dd") || {}).value || "", m: (parseInt(r.querySelector(".dh").value) || 0) * 60 + (parseInt(r.querySelector(".dm").value) || 0) };
    const a = r.querySelector(".di").value, b = r.querySelector(".df").value; if(a && b){ o.i = a; o.f = b; if(r.dataset.sa === "1" && apanhaAlmoco(a, b)) o.sa = true; } return o; }); }
function maisDia(elId, mesmo){
  const el = document.getElementById(elId); if(!el) return; const rows = el.querySelectorAll(".drow"); const ult = rows.length ? (rows[rows.length - 1].querySelector(".dd") || {}).value : "";
  let nd = today(); if(mesmo && ult) nd = ult; else if(ult && ult >= today()){ const t = new Date(ult + "T12:00:00"); t.setDate(t.getDate() + 1); nd = iso(t); }
  const onch = rows.length ? (rows[0].dataset.onch || "").replace(/&quot;/g, '"') : "";
  el.insertAdjacentHTML("beforeend", diasRows([{ d: nd, m: 0 }], onch, false, true));
  if(rows.length === 1 && !rows[0].querySelector("button")) rows[0].querySelector(".dl1").insertAdjacentHTML("beforeend", `<button type="button" class="btn sm" onclick="tirarDia(this)" aria-label="Tirar dia">✕</button>`);
  if(onch) (new Function(onch))();
  const novo = el.querySelector(".drow:last-child .di"); if(novo) novo.focus();
}
// rascunho das linhas de dias que ainda não têm horas (para não desaparecerem quando o ecrã se redesenha)
let DIAS_RASC = {};
const normDias = a => JSON.stringify((a || []).map(x => [x.d || "", Number(x.m) || 0, x.i || "", x.f || "", !!x.sa]));
function diasParaMostrar(o, id){
  const base = o.dias && o.dias.length ? o.dias : [{ d: o.concluida || o.data || today(), m: Number(o.tempo) || 0 }];
  const r = DIAS_RASC[id]; if(!r) return base;
  const guardados = o.dias && o.dias.length ? o.dias : null;
  const cheios = r.filter(x => x.m > 0);
  const bate = guardados ? normDias(cheios) === normDias(guardados) : cheios.reduce((a, x) => a + x.m, 0) === (Number(o.tempo) || 0);
  return bate ? r : base;
}
function onTempo(id){
  const o = S.ots[id]; if(!o) return;
  const dias = lerDias("t_dias"); DIAS_RASC[id] = dias; const t = dias.reduce((a, x) => a + x.m, 0);
  const patch = {};
  if(o.tempo !== t) patch.tempo = t;
  if(S.diasCol){ const limpos = dias.filter(x => x.m > 0); const novo = limpos.length > 1 || limpos.some(x => x.i) ? limpos : [];
    if(normDias(o.dias) !== normDias(novo)) patch.dias = novo;
    const nd = new Set(limpos.map(x => x.d || "")).size; if(nd > 1 && nDesloc(o) < nd) patch.deslocacoes = nd; }
  if(Object.keys(patch).length) updOt(id, patch, true);
}

/* ---------- fotografias ---------- */
const URLS = {}; const URL_EXP = {};
async function ensureUrls(paths){
  const need = paths.filter(p => !URLS[p] || URL_EXP[p] < Date.now());
  if(!need.length) return false;
  const { data } = await sb.storage.from("fotos").createSignedUrls(need, 3600);
  for(const d of data || []) if(d.signedUrl){ URLS[d.path] = d.signedUrl; URL_EXP[d.path] = Date.now() + 3500 * 1000; }
  return true;
}
function compress(file){
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1280; let { width: w, height: h } = img; const k = Math.min(1, max / Math.max(w, h)); w = Math.round(w*k); h = Math.round(h*k);
      const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(u); c.toBlob(b => b ? res(b) : rej(new Error("imagem")), "image/jpeg", 0.7);
    };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error("Formato de imagem não suportado.")); };
    img.src = u;
  });
}
async function addFotos(id, input){
  const files = [...input.files]; input.value = ""; if(!files.length) return;
  toast(`A enviar ${files.length} foto${files.length>1?"s":""}…`);
  const novos = [];
  for(const f of files){
    try{
      const blob = await compress(f); const path = `${id}/${Date.now()}-${Math.random().toString(36).slice(2,6)}.jpg`;
      const { error } = await sb.storage.from("fotos").upload(path, blob, { contentType: "image/jpeg" });
      if(error) throw error; novos.push(path);
    }catch(e){ console.error(e); toast("Falhou o envio de uma foto: " + e.message); }
  }
  if(novos.length){ await updOt(id, {fotos: [...(S.ots[id].fotos||[]), ...novos]}); toast("Fotos guardadas."); }
}
function rmFoto(id, path){
  updOt(id, {fotos: (S.ots[id].fotos||[]).filter(p => p !== path)});
  sb.storage.from("fotos").remove([path]).then(() => {});
}
function viewFoto(path){ if(URLS[path]) window.open(URLS[path], "_blank", "noopener"); }

/* ---------- avarias tratadas por empresa externa (ex.: elevadores) ---------- */
const EMPRESAS_ELEV = ["Kone","Nogueira e Macedo","Schindler","Enor","Caroldi","Orona","Otis","Schmitt","Pinto & Cruz","TK Elevadores","Elevcom","Grupo Nor","Liftirso","Nova Elevadores"];
const empresasConhecidas = () => [...new Set([...EMPRESAS_ELEV, ...Object.values(S.equip).map(e => e.empresa), ...Object.values(S.ots).map(o => o.empresa)].map(x => (x || "").trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, "pt"));
function extPanel(o, id, can){
  const eqEmp = (S.equip[o.equipId] || {}).empresa || "";
  const inp = (k, v, attrs) => `<input ${attrs} value="${esc(v || "")}" ${can ? "" : "disabled"} onchange="setExt('${id}','${k}',this.value)" style="width:100%;border:1px solid var(--line);border-radius:10px;padding:8px;background:#fff">`;
  const dias = o.contactada && o.concluida ? diasEntre(o.contactada, o.concluida) : null;
  return `<div class="panel" style="background:var(--blue-bg)"><b>Acompanhamento — empresa externa</b>
    <div style="font-size:13px;color:var(--muted);margin:2px 0 8px">Sem horas, deslocações nem materiais: regista-se o contacto com a empresa e quando ficou resolvido.</div>
    <label class="f" style="margin:0 0 8px"><span>Empresa contactada</span>${(() => { const cur = o.empresa || eqEmp; const lst = empresasConhecidas(); const outra = cur && !lst.includes(cur);
      return `<select id="x_emp" ${can ? "" : "disabled"} onchange="if(this.value==='__outra'){document.getElementById('x_emp2').style.display='';document.getElementById('x_emp2').focus();}else{document.getElementById('x_emp2').style.display='none';setExt('${id}','empresa',this.value)}" style="width:100%;border:1px solid var(--line);border-radius:10px;padding:8px;background:#fff"><option value="">— Escolher empresa —</option>${lst.map(e => `<option value="${esc(e)}" ${e===cur?"selected":""}>${esc(e)}</option>`).join("")}<option value="__outra" ${outra?"selected":""}>Outra (escrever)…</option></select>
      <input id="x_emp2" value="${esc(outra ? cur : "")}" placeholder="Nome da empresa" ${can ? "" : "disabled"} onchange="setExt('${id}','empresa',this.value)" style="${outra?"":"display:none;"}width:100%;margin-top:6px;border:1px solid var(--line);border-radius:10px;padding:8px;background:#fff">`; })()}</label>
    <div class="grid2"><label class="f" style="margin:0"><span>Contactada em</span>${inp("contactada", o.contactada, 'id="x_cont" type="date"')}</label>
    <label class="f" style="margin:0"><span>Nº / referência do pedido</span>${inp("refExterna", o.refExterna, 'id="x_ref" placeholder="Opcional"')}</label></div>
    ${can && !o.contactada ? `<button class="btn sm" style="margin-top:8px" onclick="setExt('${id}','contactada','${today()}')"><i class=ico-phone></i>Contactei hoje</button>` : ""}
    ${o.concluida ? `<div style="margin-top:8px;font-size:14px"><i class=ico-check></i>Resolvida pela empresa em <b>${fmtDate(o.concluida)}</b>${dias !== null ? ` · ${dias} ${dias === 1 ? "dia" : "dias"} após o contacto` : ""}</div>` : ""}</div>`;
}
const diasEntre = (a, b) => Math.max(0, Math.round((new Date(String(b).slice(0,10)) - new Date(String(a).slice(0,10))) / 864e5));
function setExt(id, k, v){
  const o = S.ots[id]; if(!o) return;
  const patch = { [k]: (v || "").trim() };
  if(k === "contactada" && v && o.estado === "aberta") patch.estado = "curso";
  updOt(id, patch, k !== "contactada");
  if(k === "contactada") toast(v ? "Contacto registado — ordem em curso." : "Data de contacto apagada.");
}
function openOt(id){
  if(!S.ots[id]) return;
  if(isEntrega(S.ots[id])) return openEntrega(id);
  readNotifsForOrder(id);
  const draw = () => {
    const o = S.ots[id]; if(!o) return "";
    const p = PRIOR[o.prioridade] || PRIOR.media; const ck = o.checklist || []; const done = ck.filter(c=>c.ok).length;
    const c = S.condos[condoOf(o)] || {};
    const locked = o.estado === "concluida";
    const mine = IS_ADMIN || o.tecnico === ME;
    const sm = smOt(o);   // técnico que só regista material
    const fotos = o.fotos || [];
    if(fotos.length) ensureUrls(fotos).then(ch => { if(ch && sheetRefresh) sheetRefresh(); });
    const maps = rotaUrl(c) ? ` <a href="${rotaUrl(c)}" target="_blank" rel="noopener" style="color:var(--blue);font-size:13px;white-space:nowrap"><i class=ico-pin></i>como chegar ↗</a>` : "";
    return `<div class="seg" style="margin-bottom:12px">${Object.entries(ESTADOS).map(([k,l]) => k==="concluida"
        ? `<button class="${o.estado===k?"on":""}" onclick="${o.estado===k||!mine?"":`setEstado('${id}','concluida',true)`}">${l}</button>`
        : `<button class="${o.estado===k?"on":""}" onclick="setEstado('${id}','${k}')">${l}</button>`).join("")}</div>
      ${IS_ADMIN?`<div class="panel"><label class="f" style="margin:0"><span>${isExt(o) ? "Responsável" : "Atribuída a"}</span><select onchange="assignOt('${id}', this.value)">${techOptions(o.tecnico)}</select></label>
        ${o.tecnico && o.tecnico !== ME && !locked && phoneOf(o.tecnico) ? `<div style="margin-top:10px">${waBtn(phoneOf(o.tecnico), waOrdem(o), "Enviar também por WhatsApp")}</div>` : ""}</div>`:""}
      <div class="panel"><dl class="kv">
        <dt>Condomínio</dt><dd><a href="#" onclick="event.preventDefault();openCondo('${condoOf(o)}')" style="color:inherit">${esc(cName(condoOf(o)))}</a>${Object.values(S.cdm).some(x => x.condoId === condoOf(o)) ? ` <a href="#" onclick="event.preventDefault();openCondo('${condoOf(o)}','cdm')" style="color:var(--blue);font-size:13px;white-space:nowrap"><i class=ico-users></i>condóminos</a>` : ""}${condoOf(o) ? ` <a href="#" onclick="event.preventDefault();editCdm(null,'${condoOf(o)}','${id}')" style="color:var(--blue);font-size:13px;white-space:nowrap">+ condómino</a>` : ""}</dd>
        ${c.morada?`<dt>Morada</dt><dd>${esc(c.morada)}${maps}</dd>`:""}
        ${o.equipId && S.equip[o.equipId]?`<dt>Equipamento</dt><dd><a href="#" onclick="event.preventDefault();openEquip('${o.equipId}')" style="color:inherit">${esc(eqName(o.equipId))}</a></dd>`:""}
        ${o.zona?`<dt>Zona</dt><dd>${esc(o.zona)}</dd>`:""}
        <dt>Tipo</dt><dd>${esc(TIPOS_OT[o.tipo]||o.tipo)}</dd><dt>Prioridade</dt><dd><span class="badge ${p[1]}">${p[0]}</span></dd>
        ${o.solicitante?`<dt>Pedido por</dt><dd>${esc(o.solicitante)}</dd>`:""}
        ${!IS_ADMIN && o.criadoPor && o.criadoPor !== ME?`<dt>Criada por</dt><dd>${esc(nm(o.criadoPor))}</dd>`:""}
        <dt>Prevista</dt><dd>${fmtDate(o.data)}</dd>${o.concluida?`<dt>Concluída</dt><dd>${fmtDate(o.concluida)}${o.concluidoPor && IS_ADMIN?" por "+esc(nm(o.concluidoPor)):""}</dd>`:""}
      </dl>${o.descricao?`<div style="margin-top:10px;white-space:pre-wrap;font-size:14px">${esc(o.descricao)}</div>`:""}
      ${c.notas?`<details style="margin-top:10px;font-size:14px"><summary style="cursor:pointer;color:var(--muted)">Acessos do condomínio</summary><div style="white-space:pre-wrap;margin-top:4px">${esc(c.notas)}</div></details>`:""}</div>
      ${isExt(o) ? extPanel(o, id, mine && !locked) : ""}
      ${sugestoesPanel(o, id, mine, locked, sm)}
      ${ck.length?`<div class="panel"><div style="display:flex;justify-content:space-between"><b>Checklist</b><span class="mono" style="color:var(--muted)">${done}/${ck.length}</span></div>
        <div class="progress"><i style="width:${done/ck.length*100}%"></i></div>
        ${ck.map((x,i)=>`<div class="chk ${x.ok?"ok":""}" onclick="toggleCk('${id}',${i})"><span class="box">${x.ok?"✓":""}</span><span class="lbl">${esc(x.t)}</span></div>`).join("")}</div>`:""}
      ${isExt(o) || sm ? "" : `<div class="panel"><div style="display:flex;justify-content:space-between;align-items:center"><b>Fotografias</b>
        <label class="btn sm upl"><i class=ico-camera></i>Adicionar<input type="file" accept="image/*" multiple onchange="addFotos('${id}', this)"></label></div>
        ${fotos.length ? `<div class="fotos">${fotos.map(ph => `<div class="ph" onclick="viewFoto('${esc(ph)}')">${URLS[ph]?`<img src="${esc(URLS[ph])}" alt="" loading="lazy">`:""}${mine?`<button onclick="event.stopPropagation();rmFoto('${id}','${esc(ph)}')" aria-label="Remover">✕</button>`:""}</div>`).join("")}</div>` : '<div style="color:var(--muted);font-size:14px;margin-top:4px">Sem fotografias. Tire fotos do antes e do depois.</div>'}</div>`}
      ${isExt(o) ? "" : `<div class="panel"><b>Peças / materiais usados</b>
        <div class="parts" style="margin-top:6px">${(o.pecas||[]).map((x,i)=>`<div class="part"><span class="n">${esc(x.n)}${x.c?` <span class="mono" style="color:var(--muted);font-size:12px">${esc(x.c)}</span>`:""} ${fatTag(x)}</span><span class="mono">× ${esc(x.q)}</span>${IS_ADMIN?`<input inputmode="decimal" title="Preço unitário" value="${unitPrice(x)!==null?String(unitPrice(x)).replace(".", ","):""}" placeholder="€/un" onchange="setPartPrice('${id}',${i},this.value)" style="width:70px;text-align:right;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff"><span class="mono" style="min-width:64px;text-align:right">${lineTotal(x)!==null?eur(lineTotal(x)):"—"}</span>`:""}<button class="btn sm" onclick="rmPart('${id}',${i})" aria-label="Remover">✕</button></div>`).join("") || '<span style="color:var(--muted);font-size:14px">Nenhuma peça registada.</span>'}${IS_ADMIN && (o.pecas||[]).length ? `<div class="part" style="border-top:1px solid var(--line);padding-top:6px;font-weight:600"><span class="n">Total materiais</span><span class="mono">${eur(partsTotal(o.pecas||[]))}</span></div>` : ""}</div>
        ${matList().length ? matPicker("p_sel", "onPartSel(this.value)", true) : ""}
        <div class="addpart"><input id="p_nome" placeholder="Nome do material" style="${matList().length?"display:none":""}" onkeydown="if(event.key==='Enter')addPart('${id}')"><input id="p_qtd" type="number" min="0" step="any" placeholder="Qtd" onkeydown="if(event.key==='Enter')addPart('${id}')"><button class="btn sm" onclick="addPart('${id}')">Adicionar</button></div>${fatCampos("p")}</div>
      ${sm ? (IS_ADMIN ? `<div class="panel" style="background:#fbf8f2"><b>Valores</b> <span style="font-size:12px;color:var(--muted)">(só material — mão de obra noutra folha)</span><div class="parts" style="margin-top:6px"><div class="part"><span class="n">Materiais</span><span class="mono">${eur(valores(o).mat)}</span></div></div></div>` : "") : `
      <label class="panel" style="display:flex;gap:10px;align-items:center;cursor:pointer"><input type="checkbox" ${o.soMaterial===true?"checked":""} onchange="setSoMaterial('${id}', this.checked)" style="width:22px;height:22px;accent-color:var(--accent)"><span><b>Só aplicação de material</b><br><span style="font-size:13px;color:var(--muted)">Marque quando só aplicou material — não conta mão de obra nem deslocação.</span></span></label>
      ${!("extra" in o) ? "" : `<div class="panel"><b>Manutenção extra</b>
        <div class="seg" style="margin-top:6px">${[["","Nenhuma"],["A","Manutenção A"],["E","Manutenção E"]].map(([k,l]) => `<button class="${(o.extra||"")===k?"on":""}" ${mine && !locked ? `onclick="setExtra('${id}','${k}')"` : "disabled"}>${l}${IS_ADMIN && k ? ` <span style="font-weight:400">${eur(extraVal(k))}</span>` : ""}</button>`).join("")}</div></div>`}
      <div class="panel"><b>Tempo gasto</b>${nDias(o) > 1 ? ` <span style="color:var(--muted);font-size:13px">· total ${tempoTxt(o)}</span>` : ""}
        <div id="t_dias" style="margin-top:6px">${diasRows(S.diasCol ? diasParaMostrar(o, id) : [{ d: "", m: Number(o.tempo) || 0 }], `onTempo('${id}')`, !S.diasCol)}</div>
        ${S.diasCol ? `<button class="btn sm" style="margin-top:6px" onclick="maisDia('t_dias', true)">+ Mais horas no mesmo dia</button> <button class="btn sm" style="margin-top:6px" onclick="maisDia('t_dias')">+ Mais um dia</button>` : ""}</div>
      ${IS_ADMIN ? (() => { const v = valores(o); return `<div class="panel" style="background:#fbf8f2"><b>Valores</b> <span style="font-size:12px;color:var(--muted)">(só administrativos)</span>
        <div class="parts" style="margin-top:6px">
          <div class="part"><span class="n">Materiais</span><span class="mono">${eur(v.mat)}</span></div>
          ${v.so ? `<div class="part"><span class="n" style="color:var(--muted)">Só aplicação de material — sem deslocação nem mão de obra</span></div>` : `<div class="part"><span class="n">Mão de obra <span style="color:var(--muted);font-size:13px">${moTxt(o, v)}</span></span><span class="mono">${eur(v.mo)}</span></div>
          ${v.tt ? `<div class="part"><span class="n">Deslocação <span style="color:var(--muted);font-size:13px">incluída na tarifa do técnico</span></span><span class="mono">${eur(0)}</span></div>` : `<div class="part"><span class="n">Deslocação <span style="color:var(--muted);font-size:13px">× ${eur(S.tarifas.deslocacao)}</span></span><input type="number" min="0" step="1" value="${v.nd}" onchange="setDesloc('${id}', this.value)" style="width:56px;text-align:center;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff"><span class="mono" style="min-width:70px;text-align:right">${eur(v.desl)}</span></div>`}`}
          ${v.ex ? `<div class="part"><span class="n">${EXTRAS[v.exTipo]}</span><span class="mono">${eur(v.ex)}</span></div>` : ""}
          <div class="part" style="border-top:1px solid var(--line);padding-top:6px;font-weight:700"><span class="n">Total</span><span class="mono">${eur(v.total)}</span></div>
        </div></div>`; })() : ""}`}
      `}
      ${sm ? "" : `<label class="f"><span>${isExt(o) ? "Ponto de situação / notas" : "Notas do técnico"}</span><textarea id="t_notas" oninput="onNotes('${id}',this.value)" placeholder="${isExt(o) ? "Ex.: liguei à empresa, técnico vem amanhã de manhã…" : "O que foi encontrado, o que foi feito, o que fica por fazer…"}">${esc(o.notas)}</textarea></label>`}
      ${!isExt(o) && !sm && mine && !locked ? servicosPicker("t_notas", o.notas) : ""}
      ${isExt(o) || !mine ? "" : sm ? (locked ? svcPanel(o, id, true) : `<div class="panel svc"><button class="btn pri" id="btnConc" style="width:100%;justify-content:center" onclick="setEstado('${id}','concluida')"><i class=ico-check></i>Concluir — material registado</button></div>`) : svcPanel(o, id, locked)}
      ${!IS_ADMIN && locked ? (() => { const to = o.atribuidoPor || o.criadoPor; const tel = phoneOf(to); return tel && to !== ME ? `<div class="panel" style="background:var(--green-bg);border-color:#bfe0cb;font-size:14px"><i class=ico-check></i>Concluída. O escritório já recebeu uma notificação. ${waBtn(tel, waConcl(o), "Avisar também por WhatsApp")}</div>` : ""; })() : ""}
      <div class="actions">${canEditOt(o)?`<button class="btn" onclick="editOt('${id}')">Editar</button>`:""}<button class="btn" onclick="showReport('${id}')">Relatório</button>${(IS_ADMIN||locked) && !isExt(o)?`<button class="btn${isEntrega(o)?" pri":""}" onclick="printOt('${id}')"><i class=ico-print></i>Imprimir${isEntrega(o)?" guia":""}</button>`:""}<span class="sp"></span>
      ${mine && !locked ? `<button class="btn" onclick="saveClose('${id}')"><i class=ico-save></i>Guardar e sair</button>` : ""}
      ${!mine?"":locked?`<button class="btn" onclick="setEstado('${id}','curso')">Reabrir</button>`:isExt(o)?`<button class="btn pri" id="btnConc" onclick="setEstado('${id}','concluida')">Resolvida pela empresa</button>`:""}</div>`;
  };
  openSheet((numOt(S.ots[id]) ? `<span class="mono" style="color:var(--muted);font-weight:500">${numOt(S.ots[id])}</span> ` : "") + esc(S.ots[id].titulo), draw(), () => {
    const b = $("#sheet .body"); if(!b) return; if(!S.ots[id]){ closeSheet(); return; }
    const a = document.activeElement;
    if(a && b.contains(a) && a.tagName === "SELECT") return;
    const keep = a && b.contains(a) && a.id ? {id:a.id, v:a.value, s:a.selectionStart} : null;
    const pn = val("p_nome"), pq = val("p_qtd"), ps = val("p_sel"); const st = $("#sheet").scrollTop;
    b.innerHTML = draw();
    if(ps && $("#p_sel")){ $("#p_sel").value = ps; onPartSel(ps); }
    if(pn) $("#p_nome").value = pn; if(pq) $("#p_qtd").value = pq;
    if(keep){ const el = document.getElementById(keep.id); if(el && "value" in el){ el.value = keep.v; el.focus(); try{ el.setSelectionRange(keep.s, keep.s); }catch(e){} } }
    $("#sheet").scrollTop = st;
  });
}

/* ---------- relatório ---------- */
function reportText(id){
  const o = S.ots[id]; const e = S.equip[o.equipId]; const c = S.condos[condoOf(o)] || {};
  const L = [];
  L.push("RELATÓRIO DE INTERVENÇÃO", "========================");
  L.push("Condomínio: " + (c.nome ? cLabel(c) : "—"));
  if(c.morada) L.push("Morada: " + c.morada);
  if(c.nif) L.push("NIF: " + c.nif);
  L.push("", "Ordem " + numLabel(o) + ": " + o.titulo, "Estado: " + ESTADOS[o.estado], "Tipo: " + (TIPOS_OT[o.tipo]||o.tipo) + "   Prioridade: " + (PRIOR[o.prioridade]||PRIOR.media)[0]);
  if(o.solicitante) L.push("Pedido por: " + o.solicitante);
  if(o.tecnico) L.push((isExt(o) ? "Responsável: " : "Técnico: ") + nm(o.tecnico));
  L.push("Data prevista: " + fmtDate(o.data) + (o.concluida ? "   Concluída: " + fmtDate(o.concluida) : ""));
  if(e || o.zona){ L.push(""); if(e) L.push("Equipamento: " + e.nome + (e.local ? " (" + e.local + ")" : "") + ([e.marca,e.modelo].filter(Boolean).length ? " — " + [e.marca,e.modelo].filter(Boolean).join(" ") : "")); if(o.zona) L.push("Zona: " + o.zona); }
  if(o.descricao) L.push("", "DESCRIÇÃO", o.descricao);
  if(isExt(o)){ const em = o.empresa || (e && e.empresa) || ""; L.push("", "ACOMPANHAMENTO (empresa externa)", "Empresa: " + (em || "—"), "Contactada em: " + (o.contactada ? fmtDate(o.contactada) : "—")); if(o.refExterna) L.push("Referência: " + o.refExterna); L.push("Resolvida em: " + (o.concluida ? fmtDate(o.concluida) : "por resolver")); if(o.notas) L.push("", "PONTO DE SITUAÇÃO", o.notas); return L.join("\n"); }
  if((o.checklist||[]).length){ L.push("", "VERIFICAÇÕES"); o.checklist.forEach(x => L.push((x.ok ? "[x] " : "[ ] ") + x.t)); }
  if((o.pecas||[]).length){ L.push("", "PEÇAS / MATERIAIS"); o.pecas.forEach(x => L.push("- " + partLabel(x) + " × " + x.q + (IS_ADMIN && lineTotal(x) !== null ? "  " + eur(unitPrice(x)) + "/un = " + eur(lineTotal(x)) : ""))); if(IS_ADMIN) L.push("Total materiais: " + eur(partsTotal(o.pecas))); }
  if(o.soMaterial === true) L.push("", "Só aplicação de material.");
  if(o.extra && o.soMaterial !== true) L.push("", "Manutenção extra: " + EXTRAS[o.extra]);
  if(o.tempo) L.push("", "Tempo gasto: " + tempoTxt(o) + (diasTxt(o) ? " (" + diasTxt(o) + ")" : ""));
  if(!isExt(o)) L.push("Serviço: " + (o.estado === "concluida" ? "terminado" : "por terminar" + (o.falta ? " — falta: " + o.falta : "")));
  if(IS_ADMIN){ const v = valores(o); L.push("", "VALORES", "Materiais: " + eur(v.mat)); if(v.so) L.push("Só aplicação de material — sem deslocação nem mão de obra", "TOTAL: " + eur(v.total)); else L.push("Mão de obra (" + moTxtFora(o) + "): " + eur(v.mo), "Deslocação (" + deslTxtFora(v) + "): " + eur(v.desl), ...(v.ex ? [EXTRAS[v.exTipo] + ": " + eur(v.ex)] : []), "TOTAL: " + eur(v.total)); }
  if((o.fotos||[]).length) L.push("", "Fotografias registadas: " + o.fotos.length);
  if(o.notas) L.push("", "TRABALHO REALIZADO / NOTAS", o.notas);
  return L.join("\n");
}
function showReport(id){
  const txt = reportText(id);
  openSheet("Relatório", `<pre class="rep" id="rep">${esc(txt)}</pre>
    <div class="actions"><button class="btn" onclick="openOt('${id}')">Voltar</button><span class="sp"></span>${isExt(S.ots[id]) ? "" : `<button class="btn" onclick="printOt('${id}')"><i class=ico-print></i>Imprimir</button>`}${navigator.share?`<button class="btn" onclick="shareReport('${id}')">Partilhar</button>`:""}<button class="btn pri" onclick="copyText(${esc(JSON.stringify(txt))})">Copiar texto</button></div>
    <p style="font-size:13px;color:var(--muted)">Copie ou partilhe para um e-mail ou mensagem para a administração do condomínio.</p>`);
}
function shareReport(id){ navigator.share({ title: "Relatório — " + S.ots[id].titulo, text: reportText(id) }).catch(() => {}); }

/* ---------- impressão (folha A4) ---------- */
function extReportHtml(o, withPhotos){
  const e = S.equip[o.equipId]; const c = S.condos[condoOf(o)] || {};
  const fotos = o.fotos || [];
  const row = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : "";
  const emp = o.empresa || (e && e.empresa) || "";
  const dias = o.contactada && o.concluida ? diasEntre(o.contactada, o.concluida) : null;
  const sg = o.tecnico && (S.equipa[o.tecnico] || {}).assinatura;
  return `<div class="pr">
    <div class="hd"><div class="lg">${prLogo()}<div><h1>Ficha de Acompanhamento de Avaria</h1><div>${esc(o.titulo)}</div></div></div>
      <div class="meta">Ordem nº <b>${esc(numOt(o) || "—")}</b><br>Estado: <b>${o.estado === "concluida" ? "Resolvida" : esc(ESTADOS[o.estado])}</b>${o.concluida?`<br>Resolvida: ${fmtDate(o.concluida)}`:""}${gecondBox()}</div></div>
    <h2>Condomínio</h2>
    <table class="prkv">${row("Condomínio", c.nome ? cLabel(c) : "—")}${row("Morada", c.morada)}${row("NIF", c.nif)}</table>
    <h2>Avaria</h2>
    <table class="prkv">${row("Prioridade", (PRIOR[o.prioridade]||PRIOR.media)[0])}${row("Pedido por", o.solicitante)}
      ${row("Equipamento", e ? e.nome + (e.local ? " (" + e.local + ")" : "") : "")}${row("Zona / fração", o.zona)}${row("Reportada em", fmtDate(o.criada || o.data))}${row("Responsável", o.tecnico ? nm(o.tecnico) : "")}</table>
    ${o.descricao?`<h2>Descrição da avaria</h2><div class="txt">${esc(o.descricao)}</div>`:""}
    <h2>Acompanhamento</h2>
    <table class="prkv">${row("Empresa contactada", emp || "—")}${row("Contactada em", o.contactada ? fmtDate(o.contactada) : "—")}${row("Nº / referência do pedido", o.refExterna)}${row("Resolvida em", o.concluida ? fmtDate(o.concluida) : "Por resolver")}${row("Tempo de resolução", dias !== null ? dias + (dias === 1 ? " dia" : " dias") + " após o contacto" : "")}</table>
    <h2>Ponto de situação / observações</h2><div class="txt">${esc(o.notas || "")}</div>
    ${fotos.length && withPhotos?`<h2>Fotografias</h2><div class="ph">${fotos.filter(p => URLS[p]).map(p => `<img src="${esc(URLS[p])}" alt="">`).join("")}</div>`:""}
    <div class="sig${sg ? " has" : ""}"><div>${sg ? `<img class="sgimg" src="${esc(sg)}" alt="">` : ""}<span>O Responsável${o.tecnico ? "<br>" + esc(nm(o.tecnico)) : ""}</span></div><div><span>A Empresa / O Condomínio<br>&nbsp;</span></div></div>
    <div class="ft">Impresso em ${fmtDate(today())} ${prMarca()}</div></div>`;
}
function reportHtml(o, withPhotos = true){
  if(isExt(o)) return extReportHtml(o, withPhotos);
  const e = S.equip[o.equipId]; const c = S.condos[condoOf(o)] || {};
  const fotos = o.fotos || [];
  const row = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : "";
  const ck = o.checklist || [], pc = o.pecas || [];
  const tempo = o.tempo ? tempoTxt(o) + (diasTxt(o) ? " — " + diasTxt(o) : "") : "";
  return `<div class="pr">
    <div class="hd"><div class="lg">${prLogo()}<div><h1>Relatório de Intervenção</h1><div>${esc(o.titulo)}</div></div></div>
      <div class="meta">Ordem nº <b>${esc(numOt(o) || "—")}</b><br>Estado: <b>${esc(ESTADOS[o.estado])}</b>${o.concluida?`<br>Concluída: ${fmtDate(o.concluida)}`:""}${gecondBox()}</div></div>
    <h2>Condomínio</h2>
    <table class="prkv">${row("Condomínio", c.nome ? cLabel(c) : "—")}${row("Morada", c.morada)}${row("NIF", c.nif)}${row("Administração", c.admin)}</table>
    <h2>Intervenção</h2>
    <table class="prkv">${row("Tipo", TIPOS_OT[o.tipo]||o.tipo)}${row("Prioridade", (PRIOR[o.prioridade]||PRIOR.media)[0])}${row("Pedido por", o.solicitante)}
      ${row("Equipamento", e ? e.nome + (e.local ? " (" + e.local + ")" : "") + ([e.marca,e.modelo].filter(Boolean).length ? " — " + [e.marca,e.modelo].filter(Boolean).join(" ") : "") : "")}${row("Zona / fração", o.zona)}
      ${row("Técnico", o.tecnico ? nm(o.tecnico) : "")}${row("Data prevista", o.data ? fmtDate(o.data) : "")}${row("Data de conclusão", o.concluida ? fmtDate(o.concluida) : "")}${row("Tempo gasto", tempo)}${row("Serviço", o.estado === "concluida" ? "Terminado" : "Por terminar" + (o.falta ? " — falta: " + o.falta : ""))}${o.soMaterial===true?row("Observação", "Só aplicação de material"):""}${o.extra && o.soMaterial!==true?row("Manutenção extra", EXTRAS[o.extra]):""}</table>
    ${o.descricao?`<h2>Descrição da avaria / pedido</h2><div class="txt">${esc(o.descricao)}</div>`:""}
    ${ck.length?`<h2>Verificações</h2><table>${ck.map(x => `<tr><td style="width:34px;text-align:center">${x.ok?"✔":"✘"}</td><td>${esc(x.t)}</td></tr>`).join("")}</table>`:""}
    ${pc.length ? (IS_ADMIN
      ? `<h2>Peças / materiais</h2><table><tr><th style="width:auto">Descrição</th><th style="width:130px">Código</th>${pc.some(fornLinha) ? '<th style="width:120px">Fornecedor</th>' : ""}<th style="width:45px;text-align:right">Qtd</th><th style="width:80px;text-align:right">Preço un.</th><th style="width:85px;text-align:right">Total</th></tr>${pc.map(x => `<tr><td>${esc(x.n + fatTxtCurto(x))}</td><td>${esc(x.c||"")}</td>${pc.some(fornLinha) ? `<td>${esc(fornLinha(x))}</td>` : ""}<td style="text-align:right">${esc(x.q)}</td><td style="text-align:right">${unitPrice(x)!==null?eur(unitPrice(x)):"—"}</td><td style="text-align:right">${lineTotal(x)!==null?eur(lineTotal(x)):"—"}</td></tr>`).join("")}<tr><th colspan="${pc.some(fornLinha) ? 5 : 4}" style="text-align:right;background:#eee">Total materiais</th><th style="text-align:right;background:#eee">${eur(partsTotal(pc))}</th></tr></table>`
      : `<h2>Peças / materiais</h2><table><tr><th style="width:auto">Descrição</th><th style="width:150px">Código</th>${pc.some(fornLinha) ? '<th style="width:130px">Fornecedor</th>' : ""}<th style="width:60px">Qtd</th></tr>${pc.map(x => `<tr><td>${esc(x.n + fatTxtCurto(x))}</td><td>${esc(x.c||"")}</td>${pc.some(fornLinha) ? `<td>${esc(fornLinha(x))}</td>` : ""}<td>${esc(x.q)}</td></tr>`).join("")}</table>`) : ""}
    ${IS_ADMIN ? (() => { const v = valores(o); return `<h2>Valores</h2><table>
      <tr><td>Materiais</td><td style="width:110px;text-align:right">${eur(v.mat)}</td></tr>
      ${v.so ? `<tr><td colspan="2">Só aplicação de material — sem deslocação nem mão de obra</td></tr>` : `<tr><td>Mão de obra — ${moTxtFora(o)}</td><td style="text-align:right">${eur(v.mo)}</td></tr>
      <tr><td>Deslocação — ${deslTxtFora(v)}</td><td style="text-align:right">${eur(v.desl)}</td></tr>${v.ex ? `<tr><td>${EXTRAS[v.exTipo]}</td><td style="text-align:right">${eur(v.ex)}</td></tr>` : ""}`}
      <tr><th style="text-align:right">Total</th><th style="text-align:right">${eur(v.total)}</th></tr></table>`; })() : ""}
    <h2>Trabalho realizado / observações</h2><div class="txt">${esc(o.notas || "")}</div>
    ${fotos.length && withPhotos?`<h2>Fotografias</h2><div class="ph">${fotos.filter(p => URLS[p]).map(p => `<img src="${esc(URLS[p])}" alt="">`).join("")}</div>`:""}
    ${(() => { const sg = o.tecnico && (S.equipa[o.tecnico] || {}).assinatura; return `<div class="sig${sg ? " has" : ""}"><div>${sg ? `<img class="sgimg" src="${esc(sg)}" alt="">` : ""}<span>O Técnico${o.tecnico ? "<br>" + esc(nm(o.tecnico)) : ""}</span></div><div><span>O Responsável do Condomínio<br>&nbsp;</span></div></div>`; })()}
    <div class="ft">Impresso em ${fmtDate(today())} ${prMarca()}</div></div>`;
}
// assinaturas já guardadas: endireitam-se na hora de imprimir (as novas já são guardadas direitas)
const SIG_DIR = {};
async function sigDireita(src){
  if(SIG_DIR[src]) return SIG_DIR[src];
  try{ const img = new Image(); img.src = src; await img.decode(); const c = document.createElement("canvas"); c.width = img.width + 40; c.height = img.height + 40; c.getContext("2d").drawImage(img, 20, 20); SIG_DIR[src] = sigTrim(c) || src; }catch(_){ SIG_DIR[src] = src; }
  return SIG_DIR[src];
}
async function printHtml(html){
  let pa = document.getElementById("printArea");
  if(!pa){ pa = document.createElement("div"); pa.id = "printArea"; document.body.appendChild(pa); }
  pa.innerHTML = html;
  for(const im of pa.querySelectorAll("img.sgimg")) if(im.src.startsWith("data:")) im.src = await sigDireita(im.src);
  const imgs = [...pa.querySelectorAll("img")];
  await Promise.race([
    Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))),
    new Promise(r => setTimeout(r, 12000)),
  ]);
  try{ window.print(); }catch(_){ toast("Este dispositivo não permite imprimir daqui. Use o computador."); }
}
/* ---------- guia de entrega de material ---------- */
const isEntrega = o => o.soMaterial === true && o.titulo === "Entrega de material";
const DIA_MS = 24 * 3600 * 1000;
const entregaAberta = o => !!o.criadaEm && Date.now() - Date.parse(o.criadaEm) < DIA_MS;
const entregaLimite = o => { const t = new Date(Date.parse(o.criadaEm) + DIA_MS); return fmtDate(iso(t)) + " às " + t.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" }); };
function openEntrega(id){
  const o = S.ots[id]; if(!o) return;
  const c = S.condos[condoOf(o)] || {}; const aberta = entregaAberta(o) && IS_ADMIN;
  openSheet("<i class=ico-box></i>Entrega nº " + (numOt(o) || "—"), `
    <div class="panel"><dl class="kv"><dt>Prédio</dt><dd>${esc(c.nome ? cLabel(c) : "—")}</dd><dt>Data</dt><dd>${fmtDate(o.data || o.criada)}</dd>
      <dt>Levou</dt><dd>${esc(entregaQuem(o))}</dd><dt>Entregou</dt><dd>${esc(nm(o.criadoPor))}</dd></dl></div>
    <div class="panel"><b>Material</b><div class="parts" style="margin-top:6px">${(o.pecas || []).map(p => `<div class="part"><span class="n">${esc(p.n)}</span><span class="mono">${esc(p.q)}</span></div>`).join("")}</div></div>
    ${entregaObs(o) ? `<div class="panel" style="white-space:pre-wrap;font-size:14px">${esc(entregaObs(o))}</div>` : ""}
    ${aberta ? `<div class="note" style="font-size:13px">Se houver algum engano, pode corrigir ou apagar até <b>${esc(entregaLimite(o))}</b>. Depois fica só para consulta.</div>`
             : `<div class="note" style="font-size:13px"><i class=ico-lock></i>Registo fechado — passaram mais de 24 horas. Só para consulta e impressão.</div>`}
    <div class="actions">${aberta ? `<button class="btn danger ico" onclick="confirmarApagarEntrega('${id}')">${ICONS.apagar}Apagar</button><button class="btn ico" onclick="openSaidaDireta('${id}')">${ICONS.editar}Corrigir</button>` : ""}<span class="sp"></span><button class="btn" onclick="closeSheet()">Fechar</button><button class="btn pri" onclick="printOt('${id}')"><i class=ico-print></i>Imprimir guia</button></div>`);
}
function confirmarApagarEntrega(id){
  const o = S.ots[id]; if(!o) return;
  if(!entregaAberta(o)){ toast("Passaram mais de 24 horas — já não é possível apagar."); return; }
  openSheet("Apagar entrega nº " + (numOt(o) || ""), `
    <p style="margin-top:0">Vai apagar a entrega de <b>${esc(entregaQuem(o))}</b> para <b>${esc(cName(condoOf(o)))}</b>:</p>
    <div class="panel"><div class="parts">${(o.pecas || []).map(p => `<div class="part"><span class="n">${esc(p.n)}</span><span class="mono">${esc(p.q)}</span></div>`).join("")}</div></div>
    <p style="font-size:13px;color:var(--muted)">${VE_STOCK() ? "O material volta ao stock. " : ""}Isto não se pode desfazer.</p>
    <div class="actions"><button class="btn" onclick="openEntrega('${id}')">Não, voltar</button><span class="sp"></span><button class="btn pri" style="background:var(--red);border-color:var(--red)" onclick="apagarEntrega('${id}')">Sim, apagar</button></div>`);
}
async function apagarEntrega(id){
  const o = S.ots[id]; if(!o) return;
  if(!entregaAberta(o)){ toast("Passaram mais de 24 horas — já não é possível apagar."); return; }
  closeSheet(); await del("ots", id); toast(VE_STOCK() ? "Entrega apagada — o material voltou ao stock." : "Entrega apagada.");
  if(VE_STOCK()) setTimeout(() => stockChanged(), 1500);
}
function entregaQuem(o){ const m = /levantado no escritório por (.+?)\.(\n|$)/.exec(o.descricao || ""); return o.solicitante || (m ? m[1] : ""); }
function entregaObs(o){ return (o.notas || "").trim(); }
function guiaPronta(id){
  const o = S.ots[id]; if(!o) return;
  openSheet("<i class=ico-box></i>Entrega registada", `
    <p style="margin:0 0 10px">Guia nº <b class="mono">${esc(numOt(o) || "—")}</b> · ${esc(cName(condoOf(o)))}<br>Levou: <b>${esc(entregaQuem(o))}</b> · Entregou: <b>${esc(nm(o.criadoPor))}</b></p>
    <div class="panel"><div class="parts">${(o.pecas || []).map(p => `<div class="part"><span class="n">${esc(p.n)}</span><span class="mono">${esc(p.q)}</span></div>`).join("")}</div></div>
    <p style="font-size:13px;color:var(--muted)">Imprima agora e assine a guia. A guia fica guardada em <b>Ordens → <i class=ico-box></i>Entregas</b>, para voltar a consultar ou imprimir.</p>
    <div class="actions"><button class="btn" onclick="closeSheet()">Fechar</button><span class="sp"></span><button class="btn pri" onclick="printOt('${id}')"><i class=ico-print></i>Imprimir guia</button></div>`);
}
function guiaHtml(o){
  const c = S.condos[condoOf(o)] || {}; const pc = o.pecas || [];
  const row = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : "";
  const quem = entregaQuem(o), por = nm(o.criadoPor);
  const hora = o.criadaEm ? new Date(o.criadaEm).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" }) : "";
  const via = v => `<div class="pr">
    <div class="hd"><div class="lg">${prLogo()}<div><h1>Guia de Entrega de Material</h1></div></div>
      <div class="meta">Guia nº <b>${esc(numOt(o) || "—")}</b><br>Data: <b>${fmtDate(o.data || o.criada)}</b>${hora ? " · " + hora : ""}${gecondBox()}</div></div>
    <h2>Destino</h2>
    <table class="prkv">${row("Condomínio", c.nome ? cLabel(c) : "—")}${row("Morada", c.morada)}</table>
    <h2>Entrega</h2>
    <table class="prkv">${row(o.origemStock && o.origemStock !== "principal" && o.origemStock !== "c5arm" ? "Técnico" : "Levantado por", quem)}${row("Entregue por", por)}${row("Local", o.origemStock && o.origemStock !== "principal" && S.stk.locais[o.origemStock] ? S.stk.locais[o.origemStock].nome.replace(/ —.*$/, "") : "Escritório")}</table>
    <h2>Material</h2>
    <table><tr><th style="width:auto">Descrição</th><th style="width:120px">Código</th>${pc.some(fornLinha) ? '<th style="width:120px">Fornecedor</th>' : ""}<th style="width:45px;text-align:right">Qtd</th><th style="width:80px;text-align:right">Preço un.</th><th style="width:85px;text-align:right">Total</th></tr>${pc.map(x => `<tr><td>${esc(x.n + fatTxtCurto(x))}</td><td>${esc(x.c || "")}</td>${pc.some(fornLinha) ? `<td>${esc(fornLinha(x))}</td>` : ""}<td style="text-align:right">${esc(x.q)}</td><td style="text-align:right">${unitPrice(x) !== null ? eur(unitPrice(x)) : "—"}</td><td style="text-align:right">${lineTotal(x) !== null ? eur(lineTotal(x)) : "—"}</td></tr>`).join("")}<tr><th colspan="${pc.some(fornLinha) ? 5 : 4}" style="text-align:right;background:#eee">Total</th><th style="text-align:right;background:#eee">${eur(partsTotal(pc))}</th></tr></table>
    ${entregaObs(o) ? `<h2>Observações</h2><div class="txt">${esc(entregaObs(o))}</div>` : ""}
    ${(() => { const sg = o.criadoPor && (S.equipa[o.criadoPor] || {}).assinatura; return `<div class="sig${sg ? " has" : ""}"><div>${sg ? `<img class="sgimg" src="${esc(sg)}" alt="">` : ""}<span>Entregue por<br>${esc(por)}</span></div></div>`; })()}
    <div class="ft">Impresso em ${fmtDate(today())} ${prMarca()}</div></div>`;
  return via("Via do escritório");
}
async function printOt(id, fotos){
  const o = S.ots[id]; if(!o) return;
  if(isEntrega(o)){ await printHtml(guiaHtml(o)); return; }
  const n = (o.fotos || []).length;
  if(n && fotos === undefined){
    openSheet("Imprimir ficha", `<p style="margin-top:0">Esta ordem tem ${n} ${n === 1 ? "fotografia" : "fotografias"}. Quer imprimi-las na ficha?</p>
      <div class="actions"><button class="btn" onclick="openOt('${id}')">Cancelar</button><span class="sp"></span><button class="btn" onclick="printOt('${id}', false)"><i class=ico-print></i>Sem fotografias</button><button class="btn pri" onclick="printOt('${id}', true)"><i class=ico-print></i>Com fotografias</button></div>`);
    return;
  }
  if(n && fotos){ toast("A preparar fotografias…"); try{ await ensureUrls(o.fotos); }catch(_){} }
  await printHtml(reportHtml(o, n ? !!fotos : true));
  if(n) openOt(id);
}

/* ---------- impressão por período (semana), agrupada por técnico ---------- */
function weekRange(offset){ // offset 0 = esta semana, -1 = semana passada
  const d = new Date(); const dow = (d.getDay() + 6) % 7; // 0 = segunda
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow + offset * 7);
  return [iso(mon), addDays(iso(mon), 6)];
}
function batchList(){
  const de = val("b_de"), ate = val("b_ate"), tec = val("b_tec");
  return Object.values(S.ots).filter(o => !isExt(o) && o.estado === "concluida" && o.concluida && o.concluida >= de && o.concluida <= ate && (!tec || (tec === "-" ? !o.tecnico : o.tecnico === tec)))
    .sort((a,b) => nm(a.tecnico).localeCompare(nm(b.tecnico), "pt") || (a.concluida||"").localeCompare(b.concluida||"") || (a.numero||0) - (b.numero||0));
}
function batchCount(){ const n = batchList().length; const el = $("#b_count"); if(el) el.textContent = n ? `${n} ${n===1?"ordem concluída":"ordens concluídas"} neste período` : "Nenhuma ordem concluída neste período"; const b = $("#b_btn"); if(b) b.disabled = !n; }
function setWeek(off){ const [a,b] = weekRange(off); $("#b_de").value = a; $("#b_ate").value = b; batchCount(); }
function openBatchPrint(){
  if(!IS_ADMIN) return;
  const [de, ate] = weekRange(-1);
  openSheet("Imprimir relatórios por período", `
    <div class="chips"><button class="chip" onclick="setWeek(-1)">Semana passada</button><button class="chip" onclick="setWeek(0)">Esta semana</button></div>
    <div class="grid2"><label class="f"><span>De (data de conclusão)</span><input type="date" id="b_de" value="${de}" onchange="batchCount()"></label>
    <label class="f"><span>Até</span><input type="date" id="b_ate" value="${ate}" onchange="batchCount()"></label></div>
    <label class="f"><span>Pessoa</span><select id="b_tec" onchange="batchCount()"><option value="">Todas as pessoas</option>${pessoasAgrupadas("")}</select></label>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" id="b_res" checked> Página de resumo por técnico</label>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" id="b_rel" checked> Relatórios completos (um por página)</label>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0 12px"><input type="checkbox" id="b_fot" checked> Incluir fotografias nos relatórios</label>
    <div class="note" style="background:var(--blue-bg);color:var(--blue)" id="b_count"></div>
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" id="b_btn" onclick="doBatchPrint()"><i class=ico-print></i>Imprimir</button></div>`);
  batchCount();
}
async function doBatchPrint(){
  const list = batchList(); if(!list.length) return;
  const de = val("b_de"), ate = val("b_ate");
  const withSum = $("#b_res").checked, withRep = $("#b_rel").checked, withPh = $("#b_fot").checked;
  if(!withSum && !withRep){ toast("Escolha pelo menos o resumo ou os relatórios."); return; }
  const btn = $("#b_btn"); btn.disabled = true; btn.textContent = "A preparar…";
  if(withRep && withPh){ const all = list.flatMap(o => o.fotos || []); if(all.length){ try{ await ensureUrls(all); }catch(_){} } }
  const parts = [];
  if(withSum){
    const groups = {}; for(const o of list){ const k = o.tecnico || ""; (groups[k] ||= []).push(o); }
    const aggMats = os => { const m = {}; for(const o of os) for(const x of (o.pecas || [])){ const k = x.c || x.n; if(!m[k]) m[k] = { n: x.n, c: x.c, q: 0, v: 0 }; m[k].q += Number(x.q) || 0; m[k].v += lineTotal(x) || 0; } return Object.values(m).sort((a,b) => a.n.localeCompare(b.n, "pt")); };
    const matsTxt = arr => arr.map(x => `${String(x.q).replace(".", ",")}× ${esc(x.n + fatTxt(x))}`).join("<br>");
    const hrs = min => `${Math.floor(min/60)}h${pad(min%60)} <span style="color:#555">(${(min/60).toFixed(2).replace(".", ",")} h)</span>`;
    let grand = 0, gMin = 0, gDesl = 0;
    const secs = Object.entries(groups).map(([t, os]) => {
      const sum = os.reduce((a, o) => { const v = valores(o); a.tot += v.total; a.mo += v.mo; a.desl += v.desl; a.nd += v.nd; a.mat += v.mat; a.ex += v.ex; a.min += v.so ? 0 : (Number(o.tempo) || 0); return a; }, { tot: 0, mo: 0, desl: 0, nd: 0, mat: 0, ex: 0, min: 0 });
      grand += sum.tot; gMin += sum.min; gDesl += sum.nd;
      const byCondo = {}; for(const o of os){ const k = condoOf(o); (byCondo[k] ||= []).push(o); }
      const condoRows = Object.entries(byCondo).sort((a,b) => cName(a[0]).localeCompare(cName(b[0]), "pt", {numeric:true})).map(([cid, cos]) => {
        const r = cos.reduce((a, o) => { const v = valores(o); a.mo += v.mo; a.desl += v.desl; a.nd += v.nd; a.mat += v.mat; a.ex += v.ex; a.tot += v.total; a.min += v.so ? 0 : (Number(o.tempo) || 0); return a; }, { mo: 0, desl: 0, nd: 0, mat: 0, ex: 0, tot: 0, min: 0 });
        return `<tr><td>${esc(cName(cid))}</td><td style="text-align:center">${cos.length}</td><td>${hrs(r.min)}</td><td style="text-align:center">${r.nd}</td><td>${matsTxt(aggMats(cos)) || "—"}</td><td style="text-align:right">${eur(r.mo)}</td><td style="text-align:right">${eur(r.desl)}</td><td style="text-align:right">${r.ex ? eur(r.ex) : "—"}</td><td style="text-align:right">${eur(r.mat)}</td><td style="text-align:right"><b>${eur(r.tot)}</b></td></tr>`;
      }).join("");
      return `<h2>${esc(nm(t))} <span style="font-weight:400;text-transform:none;letter-spacing:0">— ${os.length} ${os.length===1?"ordem":"ordens"} · ${Math.floor(sum.min/60)}h${pad(sum.min%60)} · ${sum.nd} ${sum.nd===1?"deslocação":"deslocações"}</span></h2>
        <table class="sm"><tr><th style="width:44px">Nº</th><th style="width:66px">Data</th><th style="width:auto">Condomínio</th><th style="width:auto">Trabalho</th><th style="width:auto">Materiais</th><th style="width:62px">Horas</th><th style="width:40px;text-align:center">Desl.</th><th style="width:70px;text-align:right">Valor</th></tr>
        ${os.map(o => { const v = valores(o); return `<tr><td>${esc(numOt(o))}</td><td>${fmtDate(o.concluida)}</td><td>${esc(cName(condoOf(o)))}</td><td>${esc(o.titulo)}${v.so?" <i>(só material)</i>":""}${v.ext?` <i>(empresa externa${o.empresa?": "+esc(o.empresa):""})</i>`:""}${v.ex?` <b>+ ${EXTRAS[v.exTipo]}</b>`:""}</td><td>${matsTxt(aggMats([o])) || "—"}</td><td>${v.so ? "—" : Math.floor((o.tempo||0)/60) + "h" + pad((o.tempo||0)%60)}</td><td style="text-align:center">${v.nd}</td><td style="text-align:right">${eur(v.total)}</td></tr>`; }).join("")}</table>
        <h3 class="sub">Resumo por prédio — ${esc(nm(t))}</h3>
        <table class="sm"><tr><th style="width:auto">Condomínio</th><th style="width:44px;text-align:center">Ordens</th><th style="width:96px">Horas</th><th style="width:44px;text-align:center">Desl.</th><th style="width:auto">Materiais</th><th style="width:72px;text-align:right">Mão de obra</th><th style="width:72px;text-align:right">Deslocação</th><th style="width:62px;text-align:right">Extra A/E</th><th style="width:72px;text-align:right">Materiais</th><th style="width:78px;text-align:right">Total</th></tr>
        ${condoRows}
        <tr><th colspan="2" style="text-align:right">Total ${esc(nm(t))}</th><th>${hrs(sum.min)}</th><th style="text-align:center">${sum.nd}</th><th>${matsTxt(aggMats(os)) || "—"}</th><th style="text-align:right">${eur(sum.mo)}</th><th style="text-align:right">${eur(sum.desl)}</th><th style="text-align:right">${sum.ex ? eur(sum.ex) : "—"}</th><th style="text-align:right">${eur(sum.mat)}</th><th style="text-align:right">${eur(sum.tot)}</th></tr></table>`;
    }).join("");
    parts.push(`<div class="pr sumpage"><div class="hd"><div class="lg">${prLogo()}<div><h1>Resumo de intervenções</h1><div>${fmtDate(de)} a ${fmtDate(ate)}</div></div></div>
      <div class="meta">${list.length} ${list.length===1?"ordem concluída":"ordens concluídas"} · ${Math.floor(gMin/60)}h${pad(gMin%60)} · ${gDesl} desl.<br>Total: <b>${eur(grand)}</b></div></div>
      ${secs}
      <table style="margin-top:14px"><tr><th style="text-align:right">Total geral</th><th style="width:110px;text-align:right">${eur(grand)}</th></tr></table>
      <div class="ft">Impresso em ${fmtDate(today())} ${prMarca()}</div></div>`);
  }
  if(withRep) for(const o of list) parts.push(reportHtml(o, withPh));
  btn.disabled = false; btn.innerHTML = "<i class=ico-print></i>Imprimir";
  await printHtml(parts.map((h, i) => i ? `<div class="pb">${h}</div>` : h).join(""));
}

/* ---------- impressão das ordens por fechar, uma folha por técnico ---------- */
const gecResp = o => { const m = /Responsável no Gecond:\s*([^\n]+)/.exec(o.notas || ""); return m ? m[1].trim() : ""; };
const gecNum = o => { const m = /Gecond nº\s*(\d+)/.exec(o.descricao || ""); return m ? m[1] : ""; };
// Técnico atribuído na app; se ainda não houver, o responsável indicado no Gecond.
const pendKey = o => o.tecnico ? nm(o.tecnico) : (gecResp(o) || "Por atribuir");
const diasDesde = s => s ? Math.max(0, Math.round((new Date(today()) - new Date(String(s).slice(0,10))) / 864e5)) : 0;
function pendList(){
  const tec = val("p_tec"), so = val("p_est");
  return Object.values(S.ots).filter(o => !isExt(o) && o.estado !== "concluida" && (!so || o.estado === so) && (!tec || pendKey(o) === tec))
    .sort((a,b) => pendKey(a).localeCompare(pendKey(b), "pt") || (a.data||a.criada||"").localeCompare(b.data||b.criada||"") || (a.numero||0) - (b.numero||0));
}
function pendCount(){ const n = pendList().length; const el = $("#p_count"); if(el) el.textContent = n ? `${n} ${n===1?"ordem por fechar":"ordens por fechar"}` : "Não há ordens por fechar com estes filtros"; const b = $("#p_btn"); if(b) b.disabled = !n; }
function openPendPrint(){
  if(!IS_ADMIN) return;
  const abertas = Object.values(S.ots).filter(o => !isExt(o) && o.estado !== "concluida");
  const cnt = {}; for(const o of abertas){ const k = pendKey(o); cnt[k] = (cnt[k] || 0) + 1; }
  const nomes = Object.keys(cnt).sort((a,b) => a.localeCompare(b, "pt"));
  openSheet("Imprimir ordens por fechar", `
    <label class="f"><span>Técnico</span><select id="p_tec" onchange="pendCount()"><option value="">Todos (uma folha por técnico)</option>${nomes.map(n => `<option value="${esc(n)}">${esc(n)} (${cnt[n]})</option>`).join("")}</select></label>
    <label class="f"><span>Estado</span><select id="p_est" onchange="pendCount()"><option value="">Abertas e em curso</option><option value="aberta">Só abertas</option><option value="curso">Só em curso</option></select></label>
    <div class="note">Quando a ordem ainda não está atribuída na app, conta para o responsável indicado no Gecond. As avarias com empresa externa (elevadores) não entram.</div>
    <div class="note" style="background:var(--blue-bg);color:var(--blue)" id="p_count"></div>
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" id="p_btn" onclick="doPendPrint()"><i class=ico-print></i>Imprimir</button></div>`);
  pendCount();
}
async function doPendPrint(){
  const list = pendList(); if(!list.length) return;
  const groups = {}; for(const o of list) (groups[pendKey(o)] ||= []).push(o);
  const pages = Object.entries(groups).map(([t, os]) => {
    const urg = os.filter(o => o.prioridade === "alta").length, curso = os.filter(o => o.estado === "curso").length;
    const semApp = os.filter(o => !o.tecnico).length;
    const rows = os.map(o => { const d = o.data || o.criada; const z = whereTxt(o); const g = gecNum(o);
      return `<tr><td>${esc(numOt(o))}</td><td>${fmtDate(d)}</td><td style="text-align:center">${diasDesde(d)}</td><td>${esc(cName(condoOf(o)))}</td><td>${o.prioridade==="alta"?"<b>⚠ </b>":""}${esc(o.titulo)}${z && z !== "—" ? `<br><span style="color:#555">${esc(z)}</span>` : ""}${isExt(o) ? `<br><span style="color:#555">Empresa: ${esc(o.empresa || (S.equip[o.equipId]||{}).empresa || "por contactar")}${o.contactada ? " · contactada " + fmtDate(o.contactada) : ""}</span>` : ""}</td><td>${o.estado==="curso"?"Em curso":"Aberta"}</td><td>${esc(g || "—")}</td><td style="width:60px"></td></tr>`; }).join("");
    return `<div class="pr"><div class="hd"><div class="lg">${prLogo()}<div><h1>Ordens por fechar</h1><div><b>${esc(t)}</b></div></div></div>
      <div class="meta">${os.length} ${os.length===1?"ordem":"ordens"}${curso?` · ${curso} em curso`:""}${urg?`<br><b>${urg} urgente${urg===1?"":"s"}</b>`:""}<br>Situação a ${fmtDate(today())}</div></div>
      ${semApp ? `<div style="font-size:9pt;color:#555;margin:0 0 6px">${semApp===os.length?"Ainda não atribuídas na app — responsável segundo o Gecond.":`${semApp} ainda não atribuída${semApp===1?"":"s"} na app (responsável segundo o Gecond).`}</div>` : ""}
      <table class="sm"><tr><th style="width:40px">Nº</th><th style="width:64px">Data</th><th style="width:36px;text-align:center">Dias</th><th style="width:auto">Condomínio</th><th style="width:auto">Trabalho</th><th style="width:52px">Estado</th><th style="width:44px">Gecond</th><th style="width:60px">Feito / obs.</th></tr>${rows}</table>
      <div class="ft">Impresso em ${fmtDate(today())} ${prMarca()}</div></div>`;
  });
  await printHtml(pages.map((h, i) => i ? `<div class="pb">${h}</div>` : h).join(""));
}

/* =====================================================================
   STOCK — só para quem tem acesso (perfis.ve_stock)
   ===================================================================== */
const VE_STOCK = () => IS_ADMIN && !!(S.equipa[ME] || {}).veStock;
const TIPOS_MOV = { inicial:"Stock inicial", compra:"Compra", carga:"Carga p/ carrinha", devolucao:"Devolução", transferencia:"Transferência", ajuste:"Ajuste", servico:"Aplicado em obra" };
let stkLoc = "", stkMovF = "", stkPer = "mes", stkTipo = "servico";
const GRUPOS_MOV = [["servico","Saídas p/ obra",["servico"]],["carga","Cargas",["carga"]],["compra","Compras",["compra","inicial"]],["mov","Devoluções e transferências",["devolucao","transferencia"]],["ajuste","Ajustes",["ajuste"]],["","Todos",null]];
// Venda e margem de cada saída para obra: preço da linha na ordem (ou preço atual) e custo médio do artigo.
function vendaMov(m){
  const o = m.ordemId ? S.ots[m.ordemId] : null; const ln = o && (o.pecas || []).find(x => x.c === m.codigo);
  const pu = ln ? unitPrice(ln) : (m.preco !== "" && m.preco != null) ? Number(m.preco) : (S.precos[m.codigo] !== undefined ? S.precos[m.codigo] : null);
  const cu = Number((S.stk.art[m.codigo] || {}).custo) || 0; const q = Number(m.qtd) || 0;
  const venda = pu === null ? 0 : pu * q, custo = cu * q;
  return { pu, venda, custo, margem: venda - custo, q };
}
function vendasPeriodo(per, codigo){
  const ini = per === "mes" ? today().slice(0, 7) : "";
  return S.stk.mov.filter(m => m.tipo === "servico" && (!codigo || m.codigo === codigo) && (!ini || (m.data || "").slice(0, 7) === ini))
    .reduce((a, m) => { const v = vendaMov(m); a.q += v.q; a.venda += v.venda; a.custo += v.custo; a.margem += v.margem; a.semPreco += v.pu === null ? 1 : 0; return a; }, { q: 0, venda: 0, custo: 0, margem: 0, semPreco: 0 });
}
async function loadStock(){
  if(!VE_STOCK()) return;
  try{
    const [{ data: l, error: e1 }, { data: a, error: e2 }] = await Promise.all([sb.from("stock_locais").select("*").order("ordem"), sb.from("stock_artigos").select("*")]);
    if(e1 || e2) throw (e1 || e2);
    const mov = []; let from = 0;
    for(;;){ const { data, error } = await sb.from("stock_mov").select("*").order("id").range(from, from + 999); if(error) throw error; mov.push(...data); if(data.length < 1000) break; from += 1000; }
    S.stk = { locais: Object.fromEntries((l || []).map(x => [x.id, fromRow(x)])), art: Object.fromEntries((a || []).map(x => [x.codigo, fromRow(x)])), mov: mov.map(fromRow), ok: true };
  }catch(e){ console.warn("stock", e); S.stk = { locais:{}, art:{}, mov:[], ok:false }; }
}
let stockTimer = null;
function stockChanged(){ clearTimeout(stockTimer); stockTimer = setTimeout(async () => { await loadStock(); if(tab === "stock") render(); if(sheetRefresh) sheetRefresh(); }, 400); }
const locaisList = () => Object.values(S.stk.locais).filter(l => l.ativo !== false).sort((a,b) => a.ordem - b.ordem);
const locNome = id => (S.stk.locais[id] || {}).nome || "—";
const locCurto = l => l.tipo === "carrinha" ? l.nome.replace(/^Carrinha (\d+).*/, "C$1") : l.id === "principal" ? "Armazém" : l.nome.replace("Armazém ", "Arm. ");
function stockQty(){
  const q = {};
  for(const m of S.stk.mov){
    const n = Number(m.qtd) || 0;
    if(m.destino){ ((q[m.destino] ||= {})[m.codigo] = (q[m.destino][m.codigo] || 0) + n); }
    if(m.origem){ ((q[m.origem] ||= {})[m.codigo] = (q[m.origem][m.codigo] || 0) - n); }
  }
  return q;
}
const stkArtigos = () => matList().map(m => ({ ...m, ...(S.stk.art[m.codigo] || {}), codigo: m.codigo, nome: m.nome }));
const numTxt = n => { const r = Math.round(n * 100) / 100; return String(r).replace(".", ","); };
function viewStock(){
  if(!VE_STOCK()) return emptyBox("Sem acesso.");
  if(!S.stk.ok) return `<h2>Stock</h2>${emptyBox("Não foi possível carregar o stock. Confirme que o ficheiro do stock foi corrido no Supabase.")}`;
  const Q = stockQty(); const locs = locaisList(); const arts = stkArtigos();
  const tot = c => locs.reduce((s, l) => s + ((Q[l.id] || {})[c] || 0), 0);
  const baixos = arts.filter(a => ((Q.principal || {})[a.codigo] || 0) < (Number(a.minimo) || 0));
  const negs = []; for(const l of locs) for(const a of arts){ const v = (Q[l.id] || {})[a.codigo] || 0; if(v < 0) negs.push(`${a.nome} em ${l.nome} (${numTxt(v)})`); }
  const uni = id => Object.values(Q[id] || {}).reduce((s, v) => s + v, 0);
  const valor = arts.reduce((s, a) => s + tot(a.codigo) * (Number(a.custo) || 0), 0);
  const carr = locs.filter(l => l.tipo === "carrinha").reduce((s, l) => s + uni(l.id), 0);
  const shown = stkLoc ? locs.filter(l => l.id === stkLoc) : locs;
  const fMov = m => !stkMovF || m.codigo === stkMovF || m.origem === stkMovF || m.destino === stkMovF || (stkMovF.startsWith("ed:") && m.condoId === stkMovF.slice(3));
  const movsAll = S.stk.mov.filter(fMov);
  const grp = GRUPOS_MOV.find(g => g[0] === stkTipo) || GRUPOS_MOV[0];
  const movsTipo = grp[2] ? movsAll.filter(m => grp[2].includes(m.tipo)) : movsAll;
  const movs = movsTipo.slice().sort((a,b) => (b.data||"").localeCompare(a.data||"") || b.id - a.id).slice(0, 60);
  return `<h2>Stock <span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" onclick="stockExport()"><i class=ico-down></i>Excel</button></span></h2>
  <div class="stats">
    <div class="stat"><b>${numTxt(uni("principal"))}</b><span>Armazém principal</span></div>
    <div class="stat"><b>${numTxt(uni("c5arm"))}</b><span>Armazém C5</span></div>
    <div class="stat"><b>${numTxt(carr)}</b><span>Nas carrinhas</span></div>
    <div class="stat"><b>${numTxt(uni("principal") + uni("c5arm") + carr)}</b><span>Stock total · ${eur(valor)} a custo</span></div>
  </div>
  ${(() => { const v = vendasPeriodo(stkPer); return `<div class="chips" style="margin:12px 0 6px"><button class="chip ${stkPer==="mes"?"on":""}" onclick="stkPer='mes';render()">Este mês</button><button class="chip ${stkPer==="tudo"?"on":""}" onclick="stkPer='tudo';render()">Desde o início</button></div>
  <div class="stats">
    <div class="stat"><b>${numTxt(v.q)}</b><span>Unidades aplicadas</span></div>
    <div class="stat"><b style="font-size:22px">${eur(v.venda)}</b><span>Total vendido</span></div>
    <div class="stat"><b style="font-size:22px">${eur(v.custo)}</b><span>Custo estimado</span></div>
    <div class="stat"><b style="font-size:22px;color:${v.margem < 0 ? "var(--red)" : "var(--green)"}">${eur(v.margem)}</b><span>Margem estimada</span></div>
  </div>${v.semPreco ? `<div style="font-size:13px;color:var(--muted);margin-top:6px">${v.semPreco} saída(s) sem preço de venda — defina o preço em Equipa → Materiais.</div>` : ""}`; })()}
  <div class="actions" style="margin:0 0 12px;flex-wrap:wrap">
    <button class="btn pri" onclick="openMov('compra')">+ Compra</button>
    <button class="btn" onclick="openMov('carga')"><i class=ico-van></i>Carga p/ carrinha</button>
    <button class="btn" onclick="openMov('devolucao')"><i class=ico-undo></i>Devolução</button>
    <button class="btn" onclick="openMov('transferencia')"><i class=ico-swap></i>Carregar Arm. C5 / Transferência</button>
    <button class="btn" onclick="openMov('ajuste')">± Ajuste</button>
    <button class="btn" onclick="openSaidaDireta()"><i class=ico-box></i>Entrega de material</button>
  </div>
  ${baixos.length ? `<div class="note" style="background:var(--red-bg,#fdecea);color:var(--red,#b42318)"><i class=ico-alert></i><b>Repor no armazém:</b> ${baixos.map(a => `${esc(a.nome)} (${numTxt((Q.principal || {})[a.codigo] || 0)} / mín. ${numTxt(Number(a.minimo)||0)})`).join(" · ")}</div>` : ""}
  ${negs.length ? `<div class="note">Stock negativo — falta registar uma carga ou corrigir com um ajuste: ${esc(negs.join(" · "))}</div>` : ""}
  <div class="chips"><button class="chip ${!stkLoc?"on":""}" onclick="stkLoc='';render()">Todos os locais</button>${locs.map(l => `<button class="chip ${stkLoc===l.id?"on":""}" onclick="stkLoc='${l.id}';render()">${esc(locCurto(l))}</button>`).join("")}</div>
  <div class="panel" style="padding:0;overflow-x:auto"><table class="stk"><thead><tr><th style="text-align:left">Artigo</th>${shown.map(l => `<th title="${esc(l.nome)}">${esc(locCurto(l))}</th>`).join("")}${stkLoc ? "" : "<th>Total</th>"}<th>Mín.</th></tr></thead><tbody>
    ${arts.map(a => { const arm = (Q.principal || {})[a.codigo] || 0; const low = arm < (Number(a.minimo) || 0);
      return `<tr onclick="openStockArt('${esc(a.codigo)}')" style="cursor:pointer"><td style="text-align:left">${esc(a.nome)}<div class="mono" style="font-size:11px;color:var(--muted)">${esc(a.codigo)}</div></td>${shown.map(l => { const v = (Q[l.id] || {})[a.codigo] || 0; return `<td class="mono" style="${v < 0 ? "color:#b42318;font-weight:700" : l.id === "principal" && low ? "color:#b42318;font-weight:700" : v ? "" : "color:#bbb"}">${numTxt(v)}</td>`; }).join("")}${stkLoc ? "" : `<td class="mono" style="font-weight:700">${numTxt(tot(a.codigo))}</td>`}<td class="mono" style="color:var(--muted)">${numTxt(Number(a.minimo) || 0)}</td></tr>`; }).join("")}
  </tbody></table></div>
  <h3>Carrinhas e técnicos</h3>
  <div class="panel"><div style="font-size:13px;color:var(--muted);margin-bottom:8px">O material das ordens concluídas sai da carrinha do técnico atribuído. Técnicos sem carrinha descontam do armazém principal.</div>
    ${locs.filter(l => l.tipo === "carrinha").map(l => `<div class="part" style="gap:8px"><span class="n">${esc(l.nome)} <span class="mono" style="color:var(--muted);font-size:12px">${esc(l.matricula||"")}</span></span><select onchange="setCarTec('${l.id}', this.value)" style="max-width:48%;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff"><option value="">— Sem técnico —</option>${pessoasAgrupadas(l.tecnico)}</select></div>`).join("")}</div>
  <h3>Movimentos <span class="mono" style="font-weight:500">${S.stk.mov.length}</span></h3>
  <select class="search" onchange="stkMovF=this.value;render()"><option value="">Todos os artigos e locais</option><optgroup label="Locais">${locs.map(l => `<option value="${l.id}" ${stkMovF===l.id?"selected":""}>${esc(l.nome)}</option>`).join("")}</optgroup><optgroup label="Artigos">${arts.map(a => `<option value="${esc(a.codigo)}" ${stkMovF===a.codigo?"selected":""}>${esc(a.nome)}</option>`).join("")}</optgroup><optgroup label="Edifícios (consumo)">${[...new Set(S.stk.mov.filter(m => m.tipo === "servico" && m.condoId).map(m => m.condoId))].sort((a,b) => cName(a).localeCompare(cName(b), "pt", {numeric:true})).map(c => `<option value="ed:${esc(c)}" ${stkMovF==="ed:"+c?"selected":""}>${esc(cName(c))}</option>`).join("")}</optgroup></select>
  ${stkMovF ? (() => { const sv = movsAll.filter(m => m.tipo === "servico"); if(!sv.length) return ""; const t = sv.reduce((a, m) => { const v = vendaMov(m); a.q += v.q; a.venda += v.venda; a.margem += v.margem; return a; }, { q: 0, venda: 0, margem: 0 });
    const porArt = {}; for(const m of sv) porArt[m.codigo] = (porArt[m.codigo] || 0) + Number(m.qtd);
    return `<div class="panel" style="font-size:14px">Aplicado em obra: <b>${numTxt(t.q)}</b> un. · Vendido <b>${eur(t.venda)}</b> · Margem <b>${eur(t.margem)}</b>${stkMovF.startsWith("ed:") || S.stk.locais[stkMovF] ? `<div style="color:var(--muted);margin-top:4px">${Object.entries(porArt).map(([c, q]) => `${numTxt(q)}× ${esc((S.mat[c] || {}).nome || c)}`).join(" · ")}</div>` : ""}</div>`; })() : ""}
  <div class="chips" style="margin-top:10px">${GRUPOS_MOV.map(([k, l, ts]) => { const n = ts ? movsAll.filter(m => ts.includes(m.tipo)).length : movsAll.length; return `<button class="chip ${stkTipo===k?"on":""}" onclick="stkTipo='${k}';render()">${l} <span class="mono" style="opacity:.7">${n}</span></button>`; }).join("")}</div>
  ${stkTipo === "carga" && movsTipo.length ? (() => { const pc = {}; for(const m of movsTipo){ pc[m.destino] = (pc[m.destino] || 0) + Number(m.qtd); } return `<div class="panel" style="font-size:14px">Carregado: ${Object.entries(pc).sort((a,b) => ((S.stk.locais[a[0]]||{}).ordem||0) - ((S.stk.locais[b[0]]||{}).ordem||0)).map(([l, q]) => `${esc(locCurto(S.stk.locais[l] || {nome:l,tipo:""}))} <b>${numTxt(q)}</b>`).join(" · ")}</div>`; })() : ""}
  ${stkTipo === "compra" && movsTipo.length ? (() => { const t = movsTipo.filter(m => m.tipo === "compra").reduce((a, m) => a + (Number(m.qtd) || 0) * (Number(m.preco) || 0), 0); return `<div class="panel" style="font-size:14px">Total comprado: <b>${eur(t)}</b> · ${numTxt(movsTipo.filter(m => m.tipo === "compra").reduce((a, m) => a + Number(m.qtd), 0))} un.</div>`; })() : ""}
  <div class="list">${movs.map(movItem).join("") || emptyBox("Sem movimentos deste tipo.")}</div>
  ${movsTipo.length > 60 ? '<p style="font-size:13px;color:var(--muted)">A mostrar os 60 mais recentes. Use o filtro ou exporte para ver todos.</p>' : ""}`;
}
function movItem(m){
  const o = m.ordemId ? S.ots[m.ordemId] : null;
  const de = m.origem ? locNome(m.origem) : "", para = m.destino ? locNome(m.destino) : "";
  const sinal = m.tipo === "ajuste" ? (m.destino ? "+" : "−") : "";
  const obra = m.condoId ? cName(m.condoId) : "";
  return `<div class="item"><div class="bar ${m.tipo==="compra"?"green":m.tipo==="servico"?"amber":"blue"}"></div><div class="main">
    <div class="t">${sinal}${numTxt(Number(m.qtd))} × ${esc((S.mat[m.codigo] || {}).nome || m.codigo)}</div>
    <div class="s">${esc(TIPOS_MOV[m.tipo] || m.tipo)} · ${fmtDate(m.data)}${de || para ? " · " + esc([de, para].filter(Boolean).join(" → ")) : ""}</div>
    ${o || obra ? `<div class="s">${o ? `<a href="#" onclick="event.preventDefault();openOt('${o.id}')" style="color:var(--blue)">Ordem ${esc(numOt(o))}</a> · ` : ""}${esc(obra)}${m.criadoPor ? " · " + esc(nm(m.criadoPor)) : ""}</div>` : ""}
    ${m.fornecedor || m.documento || m.preco ? `<div class="s">${esc([m.fornecedor, m.documento, m.preco ? eur(Number(m.preco)) + "/un" : ""].filter(Boolean).join(" · "))}</div>` : ""}
    ${m.obs ? `<div class="s">${esc(m.obs)}</div>` : ""}</div>
    ${m.tipo !== "servico" ? `<button class="btn sm" data-label="✕" onclick="event.stopPropagation();armDelete(this,()=>delMov(${m.id}))" aria-label="Apagar">✕</button>` : ""}</div>`;
}
async function delMov(id){ const { error } = await sb.from("stock_mov").delete().eq("id", id); if(error) return writeErr(error); S.stk.mov = S.stk.mov.filter(m => m.id !== id); render(); toast("Movimento apagado."); }
async function setCarTec(loc, tec){
  const { error } = await sb.from("stock_locais").update({ tecnico: tec || null }).eq("id", loc); if(error) return writeErr(error);
  S.stk.locais[loc] = { ...S.stk.locais[loc], tecnico: tec }; toast(tec ? locNome(loc) + " → " + nm(tec) : "Carrinha sem técnico.");
}
/* ---------- formulário de movimento ---------- */
let movLines = [];
function openMov(tipo, codigo){
  const locs = locaisList(); const arm = locs.filter(l => l.tipo === "armazem"), car = locs.filter(l => l.tipo === "carrinha");
  const opts = (list, sel) => list.map(l => `<option value="${l.id}" ${l.id===sel?"selected":""}>${esc(l.nome)}</option>`).join("");
  movLines = [];
  let campos = "";
  if(tipo === "compra") campos = `<label class="f"><span>Entra em</span><select id="mv_dest">${opts(arm, "principal")}</select></label>
    <div class="grid2"><label class="f"><span>Fornecedor</span><input id="mv_forn" list="dl_forn" placeholder="Opcional"><datalist id="dl_forn">${[...new Set(S.stk.mov.map(m => m.fornecedor).filter(Boolean))].map(f => `<option value="${esc(f)}">`).join("")}</datalist></label>
    <label class="f"><span>Documento / fatura</span><input id="mv_doc" placeholder="Opcional"></label></div>`;
  if(tipo === "carga") campos = `<div class="grid2"><label class="f"><span>Sai de</span><select id="mv_orig">${opts(arm, "principal")}</select></label><label class="f"><span>Para a carrinha</span><select id="mv_dest" onchange="if(this.value==='car5')document.getElementById('mv_orig').value='c5arm'; else if(document.getElementById('mv_orig').value==='c5arm')document.getElementById('mv_orig').value='principal'">${opts(car)}</select></label></div>
    <div style="font-size:13px;color:var(--muted);margin:-4px 0 10px">A Carrinha 5 abastece-se a partir do Armazém C5.</div>`;
  if(tipo === "devolucao") campos = `<div class="grid2"><label class="f"><span>Da carrinha</span><select id="mv_orig">${opts(car)}</select></label><label class="f"><span>Volta para</span><select id="mv_dest">${opts(arm, "principal")}</select></label></div>`;
  if(tipo === "transferencia") campos = `<div class="grid2"><label class="f"><span>De</span><select id="mv_orig">${opts(locs, "principal")}</select></label><label class="f"><span>Para</span><select id="mv_dest">${opts(locs, "c5arm")}</select></label></div>`;
  if(tipo === "ajuste") campos = `<div class="grid2"><label class="f"><span>Local</span><select id="mv_loc">${opts(locs, "principal")}</select></label><label class="f"><span>Ajuste</span><select id="mv_sinal"><option value="+">+ Acrescentar</option><option value="-">− Retirar</option></select></label></div>`;
  openSheet({compra:"Compra / entrada", carga:"Carga para carrinha", devolucao:"Devolução ao armazém", transferencia:"Transferência", ajuste:"Ajuste de stock"}[tipo], `
    ${campos}
    <label class="f"><span>Data</span><input type="date" id="mv_data" value="${today()}"></label>
    <div class="panel"><b>Artigos</b><div id="mv_lines" class="parts" style="margin-top:6px"></div>
      <div class="addpart" style="flex-wrap:wrap"><select id="mv_art" style="flex:1 1 100%;margin-bottom:6px;border:1px solid var(--line);border-radius:10px;padding:8px;background:#fff">${stkArtigos().map(a => `<option value="${esc(a.codigo)}" ${a.codigo===codigo?"selected":""}>${esc(a.nome)} · ${esc(a.codigo)}</option>`).join("")}</select>
      <input id="mv_qtd" type="number" min="0" step="any" placeholder="Qtd" onkeydown="if(event.key==='Enter')addMovLine('${tipo}')">${tipo === "compra" ? `<input id="mv_preco" inputmode="decimal" placeholder="€/un" style="width:80px">` : ""}<button class="btn sm" onclick="addMovLine('${tipo}')">Adicionar</button></div></div>
    <label class="f"><span>Observações</span><input id="mv_obs" placeholder="${tipo === "ajuste" ? "Motivo (ex.: contagem, partido)" : "Opcional"}"></label>
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" onclick="saveMov('${tipo}')">Guardar</button></div>`);
  drawMovLines();
}
function drawMovLines(){ const el = $("#mv_lines"); if(!el) return; el.innerHTML = movLines.map((x, i) => `<div class="part"><span class="n">${esc((S.mat[x.c] || {}).nome || x.c)}</span><span class="mono">× ${numTxt(x.q)}${x.p != null ? " · " + eur(x.p) + "/un" : ""}</span><button class="btn sm" onclick="movLines.splice(${i},1);drawMovLines()">✕</button></div>`).join("") || '<span style="color:var(--muted);font-size:14px">Escolha o artigo, a quantidade e carregue em Adicionar.</span>'; }
function addMovLine(tipo){
  const c = val("mv_art"), q = parseFloat(String(val("mv_qtd")).replace(",", "."));
  if(!c || !(q > 0)){ toast("Indique a quantidade."); return; }
  let p = null; if(tipo === "compra" && val("mv_preco")){ p = parsePrice(val("mv_preco")); if(p === null){ toast("Preço inválido."); return; } }
  movLines.push({ c, q, p }); $("#mv_qtd").value = ""; if($("#mv_preco")) $("#mv_preco").value = ""; drawMovLines(); $("#mv_qtd").focus();
}
async function saveMov(tipo){
  if(val("mv_qtd")) addMovLine(tipo);
  if(!movLines.length){ toast("Acrescente pelo menos um artigo."); return; }
  let origem = null, destino = null;
  if(tipo === "compra") destino = val("mv_dest");
  else if(tipo === "ajuste"){ if(val("mv_sinal") === "+") destino = val("mv_loc"); else origem = val("mv_loc"); }
  else { origem = val("mv_orig"); destino = val("mv_dest"); }
  if(origem && origem === destino){ toast("Origem e destino têm de ser diferentes."); return; }
  if(tipo === "ajuste" && !val("mv_obs")){ toast("Indique o motivo do ajuste."); return; }
  const base = { tipo, data: val("mv_data") || today(), origem, destino, fornecedor: val("mv_forn"), documento: val("mv_doc"), obs: val("mv_obs") };
  const rows = movLines.map(x => ({ ...base, codigo: x.c, qtd: x.q, preco: x.p }));
  const { data, error } = await sb.from("stock_mov").insert(rows).select(); if(error) return writeErr(error);
  S.stk.mov.push(...(data || []).map(fromRow));
  if(origem){ const Q = stockQty(); const neg = movLines.filter(x => ((Q[origem] || {})[x.c] || 0) < 0); if(neg.length) toast("Atenção: " + locNome(origem) + " ficou com stock negativo em " + neg.map(x => (S.mat[x.c] || {}).nome).join(", ")); else toast("Guardado."); } else toast("Guardado.");
  closeSheet(); render();
}
/* ---------- novo trabalho feito no local (formulário único) ---------- */
let twLines = [], twFotos = [];
/* ---------- "Estou neste prédio": escolhe o prédio pela localização do telemóvel ---------- */
// A posição só serve para escolher o prédio; não fica guardada nada sobre a pessoa.
// Se o prédio ainda não tinha a posição confirmada no local, o telemóvel ensina-a (fica no prédio, não na pessoa).
let POS_AQUI = null;
const distM = (a, b, c, d) => { const k = Math.PI / 180, x = (d - b) * k * Math.cos((a + c) / 2 * k), y = (c - a) * k; return Math.sqrt(x * x + y * y) * 6371000; };
const LIM_GEO = { local: 200, morada: 300, rua: 500 };
function aquiBox(){ return `<div id="aquiBox" class="aqui"><button type="button" class="btn sm" onclick="detetarPredio()"><i class=ico-pin></i>Estou neste prédio</button><span class="muted" id="aquiTxt">Escolhe o prédio pela localização do telemóvel.</span></div>`; }
function detetarPredio(auto){
  const t = document.getElementById("aquiTxt"); if(!t) return;
  if(!navigator.geolocation){ t.textContent = "Este aparelho não dá a localização."; return; }
  t.textContent = "A ver onde está…";
  navigator.geolocation.getCurrentPosition(p => {
    const t2 = document.getElementById("aquiTxt"); if(!t2) return;
    const la = p.coords.latitude, lo = p.coords.longitude, ac = p.coords.accuracy || 999;
    POS_AQUI = { la, lo, ac };
    const perto = Object.values(S.condos).filter(c => c.lat != null && c.lon != null).map(c => ({ c, d: distM(la, lo, c.lat, c.lon) })).sort((a, b) => a.d - b.d);
    if(!perto.length){ t2.textContent = "Os prédios ainda não têm localização. Procure pelo nome."; return; }
    const m = x => x.d < 1000 ? Math.round(x.d / 10) * 10 + " m" : (x.d / 1000).toFixed(1).replace(".", ",") + " km";
    const p0 = perto[0], lim = (LIM_GEO[p0.c.geoFonte] || 0) + Math.min(ac, 150);
    const segundo = perto[1] && perto[1].d - p0.d < 40 && perto[1].d < lim;
    if(p0.d <= lim && !segundo){
      escolherCondo(p0.c.id);
      t2.innerHTML = `<b>${esc(p0.c.codigo || "")} ${esc(p0.c.nome)}</b> · a ${m(p0)}. Se não for este, procure abaixo.`;
      return;
    }
    const opc = perto.slice(0, 4).filter(x => x.d < 3000);
    if(!opc.length){ t2.textContent = "Não há nenhum prédio perto daqui. Procure pelo nome."; return; }
    t2.innerHTML = `Mais perto daqui:` + opc.map(x => `<button type="button" class="schip" onclick="escolherCondo('${x.c.id}');document.getElementById('aquiTxt').innerHTML='<b>'+this.dataset.n+'</b>'" data-n="${esc((x.c.codigo || "") + " " + x.c.nome)}">${esc(x.c.codigo || "")} ${esc(x.c.nome)} <span class="muted">· ${m(x)}</span></button>`).join("");
  }, e => { const t2 = document.getElementById("aquiTxt"); if(t2) t2.textContent = e && e.code === 1 ? "A localização está bloqueada para a app. Ative-a nas definições do telemóvel, ou procure pelo nome." : "Não foi possível saber a localização. Procure pelo nome."; },
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}
function autoDetetar(){
  POS_AQUI = null;
  try{ if(navigator.permissions && navigator.permissions.query) navigator.permissions.query({ name: "geolocation" }).then(r => { if(r.state === "granted") detetarPredio(true); }).catch(() => {}); }catch(_){}
}
async function ensinarPosicao(cid){
  const c = S.condos[cid]; if(!POS_AQUI || !c || c.geoFonte === "local" || POS_AQUI.ac > 60) return;
  if(c.lat != null && distM(POS_AQUI.la, POS_AQUI.lo, c.lat, c.lon) > 2000) return; // longe demais da morada: provavelmente não está no prédio
  try{ await sb.rpc("guardar_posicao_condo", { cid, la: POS_AQUI.la, lo: POS_AQUI.lo }); S.condos[cid] = { ...c, lat: +POS_AQUI.la.toFixed(5), lon: +POS_AQUI.lo.toFixed(5), geoFonte: "local" }; }catch(_){}
}
function openTrabalho(cid){
  twLines = []; twFotos = [];
  const smMe = !IS_ADMIN && !!(S.equipa[ME] || {}).soRegistaMaterial;   // só regista material
  const temExtra = !Object.keys(S.ots).length || Object.values(S.ots).some(o => "extra" in o);
  openSheet("Novo trabalho", `
    ${cid ? "" : aquiBox()}
    ${condoPicker(cid || "")}
    ${smMe ? `<label class="f"><span>O que foi feito</span><input id="tw_tit" placeholder="Opcional — ex.: material aplicado no hall"></label>`
      : `<label class="f"><span>O que foi feito *</span><textarea id="tw_notas" rows="4" placeholder="Descreva o serviço: o que estava avariado, o que fez, o que ficou por fazer…"></textarea></label>${servicosPicker("tw_notas")}`}
    <label class="f"><span>Zona / fração</span><input id="tw_zona" placeholder="Ex.: escadas, garagem -1, 2º esq."></label>
    <div class="panel"><b>Material usado</b><div id="tw_lines" class="parts" style="margin-top:6px"></div>
      ${matList().length ? matPicker("tw_sel", "document.getElementById('tw_nome').style.display=this.value==='__outro'?'':'none'") : ""}
      <div class="addpart"><input id="tw_nome" placeholder="Nome do material" style="${matList().length ? "display:none" : ""}"><input id="tw_qtd" type="number" min="0" step="any" placeholder="Qtd" onkeydown="if(event.key==='Enter')addTwLine()"><button class="btn sm" onclick="addTwLine()">Adicionar</button></div>${fatCampos("tw")}</div>
${smMe ? "" : `    <label class="panel" style="display:flex;gap:10px;align-items:center;cursor:pointer"><input type="checkbox" id="tw_so" style="width:22px;height:22px;accent-color:var(--accent)" onchange="document.getElementById('tw_tempo').style.display=this.checked?'none':''"><span><b>Só aplicação de material</b><br><span style="font-size:13px;color:var(--muted)">Só aplicou material — sem mão de obra nem deslocação.</span></span></label>
    <div id="tw_tempo">
      <div class="panel"><b>Tempo gasto</b><div id="tw_dias" style="margin-top:6px">${diasRows([{ d: today(), m: 0 }], "twDiasMud()", !S.diasCol)}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">${S.diasCol ? `<button type="button" class="btn sm" onclick="maisDia('tw_dias', true)">+ Mais horas no mesmo dia</button><button type="button" class="btn sm" onclick="maisDia('tw_dias')">+ Mais um dia</button>` : ""}
        <span style="display:flex;gap:6px;align-items:center;margin-left:auto">Deslocações <input id="tw_d" type="number" min="0" value="1" style="width:56px;border:1px solid var(--line);border-radius:10px;padding:8px"></span></div></div>
      ${temExtra ? `<div class="panel"><b>Manutenção extra</b><div class="seg" id="tw_extra" style="margin-top:6px">${[["","Nenhuma"],["A","Manutenção A"],["E","Manutenção E"]].map(([k,l]) => `<button type="button" data-k="${k}" class="${k===""?"on":""}" onclick="[...this.parentNode.children].forEach(b=>b.classList.toggle('on', b===this))">${l}</button>`).join("")}</div></div>` : ""}
    </div>
    <div class="panel"><b>Fotografias</b> <span id="tw_nf" style="color:var(--muted);font-size:13px"></span><div style="margin-top:6px"><label class="btn sm" style="cursor:pointer"><i class=ico-camera></i>Juntar fotos<input type="file" accept="image/*" multiple style="display:none" onchange="twFotos.push(...this.files);this.value='';document.getElementById('tw_nf').textContent=twFotos.length+' foto(s)'"></label></div></div>
`}
    <div class="actions" style="flex-wrap:wrap"><button class="btn" onclick="closeSheet()">Cancelar</button><span class="sp"></span><button class="btn" onclick="saveTrabalho(false)"><i class=ico-save></i>Guardar e acabar depois</button><button class="btn pri" onclick="saveTrabalho(true)"><i class=ico-check></i>Concluir trabalho</button></div>`);
  drawTwLines(); if(!cid) autoDetetar();
}
function drawTwLines(){ const el = $("#tw_lines"); if(!el) return; el.innerHTML = twLines.map((x, i) => `<div class="part"><span class="n">${esc(x.n)} ${fatTag(x)}</span><span class="mono">× ${numTxt(x.q)}</span><button class="btn sm" onclick="twLines.splice(${i},1);drawTwLines()">✕</button></div>`).join(""); }
function addTwLine(){
  const sel = val("tw_sel"); const q = parseFloat(String(val("tw_qtd")).replace(",", ".")) || 1;
  const fat = lerFat("tw");
  if(sel && sel !== "__outro"){ const m = S.mat[sel]; if(m) twLines.push({ c: m.codigo, n: m.nome, q, ...fat }); }
  else { const n = val("tw_nome"); if(!n){ toast("Escolha o material."); return; } twLines.push({ n, q, ...fat }); $("#tw_nome").value = ""; }
  if($("#tw_sel")) $("#tw_sel").value = ""; if($("#tw_nome") && matList().length) $("#tw_nome").style.display = "none"; $("#tw_qtd").value = ""; drawTwLines(); mpkSync();
}
function twDiasMud(){ const n = lerDias("tw_dias").filter(x => x.m > 0).length; const d = $("#tw_d"); if(d && n > 1 && (parseInt(d.value) || 0) < n) d.value = n; }
// título curto a partir da descrição: primeira frase, até ~60 letras (a descrição completa vai para "Trabalho realizado")
function tituloDe(t){
  t = (t || "").replace(/^[•\-\s]+/, "").trim(); if(!t) return "";
  let f = t.split(/\n|(?<=[.!?])\s/)[0].replace(/^[•\-\s]+/, "").trim().replace(/[.;:,]+$/, "");
  if(f.length > 60){ f = f.slice(0, 60); const k = f.lastIndexOf(" "); if(k > 30) f = f.slice(0, k); f += "…"; }
  return f.charAt(0).toUpperCase() + f.slice(1);
}
async function saveTrabalho(concluir){
  const smMe = !IS_ADMIN && !!(S.equipa[ME] || {}).soRegistaMaterial;
  const cid = val("f_condo"), desc = val("tw_notas");
  const tit = smMe ? (val("tw_tit") || "Material aplicado") : tituloDe(desc);
  if(!cid || !tit){ toast("Escolha o prédio e escreva o que foi feito."); return; }
  ensinarPosicao(cid);
  if(val("tw_qtd") || (val("tw_sel") && val("tw_sel") !== "__outro") || val("tw_nome")) addTwLine();
  const so = !!($("#tw_so") || {}).checked;
  const twDias = so ? [] : lerDias("tw_dias").filter(x => x.m > 0);
  const tempo = twDias.reduce((a, x) => a + x.m, 0);
  if(concluir && !so && !tempo && !twLines.length){ toast("Indique o tempo gasto ou o material usado."); return; }
  const exBtn = document.querySelector("#tw_extra button.on"); const extra = so || !exBtn ? "" : exBtn.dataset.k;
  const t = today(), now = nowIso();
  const o = { id: newId(), titulo: tit, condoId: cid, equipId: "", zona: val("tw_zona"), tecnico: ME, tipo: "corretiva", prioridade: "media", estado: concluir ? "concluida" : "curso",
    data: t, descricao: "", solicitante: "", checklist: [], pecas: twLines.slice(), fotos: [], notas: val("tw_notas"), tempo, ...(S.diasCol && (twDias.length > 1 || twDias.some(x => x.i)) ? { dias: twDias } : {}),
    deslocacoes: so ? 0 : Math.max(0, parseInt(val("tw_d")) || 0), soMaterial: so, criada: t, criadaEm: now, criadoPor: ME, atribuida: t, atribuidaEm: now, atribuidoPor: ME,
    ...(concluir ? { concluida: t, concluidaEm: now, concluidoPor: ME } : {}), ...(Object.values(S.ots).some(x => "extra" in x) || extra ? { extra } : {}) };
  const fotos = twFotos.slice();
  put("ots", o); closeSheet();
  toast(concluir ? "Trabalho concluído e registado." : "Trabalho guardado — pode acabá-lo depois.");
  if(fotos.length){ await new Promise(r => setTimeout(r, 800)); await addFotos(o.id, { files: fotos, set value(v){} }); }
}
/* ---------- saída direta do armazém para um prédio ---------- */
// Cria uma ordem concluída "Entrega de material" (só material) atribuída a quem regista;
// sem carrinha associada, o material sai do armazém principal e entra nos relatórios do prédio.
function openSaidaDireta(editId){
  const ed = editId ? S.ots[editId] : null;
  if(ed && !entregaAberta(ed)){ toast("Passaram mais de 24 horas — esta entrega já só pode ser consultada."); return; }
  movLines = ed ? (ed.pecas || []).map(p => ({ c: p.c, q: Number(p.q) })) : [];
  openSheet(ed ? "Corrigir entrega nº " + (numOt(ed) || "") : "Entrega de material", `
    ${ed ? `<div class="note" style="font-size:13px">Pode corrigir até ${esc(entregaLimite(ed))}. Depois disso fica só para consulta.</div>` : ""}
    ${condoPicker(ed ? condoOf(ed) : "")}
    <div class="panel"><b>Material</b><div id="mv_lines" class="parts" style="margin-top:6px"></div>
      <div class="addpart" style="flex-wrap:wrap"><select id="mv_art" style="flex:1 1 100%;margin-bottom:6px;border:1px solid var(--line);border-radius:10px;padding:8px;background:#fff">${stkArtigos().map(a => `<option value="${esc(a.codigo)}">${esc(a.nome)} · ${esc(a.codigo)}</option>`).join("")}</select>
      <input id="mv_qtd" type="number" min="0" step="any" placeholder="Qtd" onkeydown="if(event.key==='Enter')addMovLine('saida')"><button class="btn sm" onclick="addMovLine('saida')">Adicionar</button></div></div>
    ${VE_STOCK() ? `<label class="f"><span>Sai de</span><select id="mv_origem" onchange="origemEntrega(this.value)">${locaisList().filter(l => l.ativo !== false).map(l => `<option value="${l.id}" ${l.id === ((ed && ed.origemStock) || "principal") ? "selected" : ""}>${esc(l.nome)}</option>`).join("")}</select></label>` : ""}
    <div class="grid2"><label class="f"><span>Data</span><input type="date" id="mv_data" value="${ed ? esc(ed.data || today()) : today()}"></label>
    <label class="f"><span id="mv_quem_l">${ed && ed.origemStock && ed.origemStock !== "principal" ? "Técnico *" : "Quem levou *"}</span><input id="mv_quem" placeholder="Nome de quem levantou o material" value="${ed ? esc(entregaQuem(ed)) : ""}"></label></div>
    <label class="f"><span>Observações</span><input id="mv_obs" placeholder="Opcional" value="${ed ? esc((ed.notas || "").replace(/\n?\[Corrigida por[^\]]*\]/g, "").trim()) : ""}"></label>
    ${VE_STOCK() && !ed ? `<div class="note" style="font-size:13px">Para material levantado no escritório. Sai do <b>armazém principal</b> e fica registada uma ordem concluída de <b>entrega de material</b> neste prédio, que entra nos relatórios e no resumo semanal só com o valor do material (sem horas nem deslocação).</div>` : ""}
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" onclick="saveSaidaDireta(${ed ? `'${esc(editId)}'` : ""})">${ed ? "Guardar correção" : "Registar saída"}</button></div>`);
  drawMovLines();
}
function origemEntrega(v){
  const car = v && v !== "principal" && v !== "c5arm"; const l = $("#mv_quem_l"); if(l) l.textContent = car ? "Técnico *" : "Quem levou *";
  const q = $("#mv_quem"); if(q){ q.placeholder = car ? "Técnico que aplicou o material (folha em papel)" : "Nome de quem levantou o material";
    const loc = S.stk.locais[v]; if(car && loc && !q.value){ const t = loc.tecnico ? nm(loc.tecnico) : (loc.nome.split("—")[1] || "").trim(); if(t && t !== "—") q.value = t; } }
}
async function saveSaidaDireta(editId){
  const ed = editId ? S.ots[editId] : null;
  if(editId && (!ed || !entregaAberta(ed))){ toast("Passaram mais de 24 horas — já não é possível corrigir."); closeSheet(); return; }
  const cid = val("f_condo"); if(!cid){ toast("Escolha o prédio."); return; }
  if(val("mv_qtd")) addMovLine("saida");
  if(!movLines.length){ toast("Acrescente pelo menos um artigo."); return; }
  if(!val("mv_quem")){ toast("Indique quem levou o material."); $("#mv_quem").focus(); return; }
  const d = val("mv_data") || today(); const obs = val("mv_obs");
  const pecas = movLines.map(x => ({ c: x.c, n: (S.mat[x.c] || {}).nome || x.c, q: x.q }));
  const quemEntregou = ed ? ed.criadoPor : ME;
  const origem = VE_STOCK() && $("#mv_origem") ? val("mv_origem") : ((ed && ed.origemStock) || "");
  const daCarrinha = origem && origem !== "principal" && origem !== "c5arm";
  const locN = origem ? (S.stk.locais[origem] || {}).nome || "" : "";
  const o = { id: ed ? ed.id : newId(), titulo: "Entrega de material", condoId: cid, equipId: "", zona: "", tecnico: ME, tipo: "corretiva", prioridade: "media", estado: "concluida",
    data: d, descricao: daCarrinha ? "Material aplicado por " + val("mv_quem") + " a partir da " + locN.replace(/ —.*$/, "") + " (folha em papel).\nRegistado por " + nm(quemEntregou) + "." + (obs ? "\n" + obs : "")
      : "Material levantado no escritório por " + val("mv_quem") + ".\nEntregue por " + nm(quemEntregou) + "." + (obs ? "\n" + obs : ""), solicitante: val("mv_quem"), checklist: [], pecas, fotos: [], notas: obs, tempo: 0,
    deslocacoes: 0, soMaterial: true, criada: today(), criadaEm: nowIso(), criadoPor: ME, atribuida: today(), atribuidaEm: nowIso(), atribuidoPor: ME,
    concluida: d, concluidaEm: nowIso(), concluidoPor: ME };
  if(origem && origem !== "principal") o.origemStock = origem; else if(ed && ed.origemStock) o.origemStock = "";
  if(ed){ Object.assign(o, { numero: ed.numero, tecnico: ed.tecnico, criada: ed.criada, criadaEm: ed.criadaEm, criadoPor: ed.criadoPor, atribuida: ed.atribuida, atribuidaEm: ed.atribuidaEm, atribuidoPor: ed.atribuidoPor });
    const ant = (ed.notas || "").match(/\[Corrigida por[^\]]*\]/g) || [];
    o.notas = [obs, ...ant, "[Corrigida por " + nm(ME) + " em " + fmtDate(today()) + " às " + new Date().toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" }) + "]"].filter(Boolean).join("\n"); }
  closeSheet(); toast(ed ? "A guardar a correção…" : "A registar a entrega…");
  await put("ots", o);
  if(VE_STOCK()) setTimeout(() => stockChanged(), 1500);
  guiaPronta(o.id);
}
/* ---------- ficha do artigo ---------- */
function openStockArt(c){
  const a = stkArtigos().find(x => x.codigo === c); if(!a) return;
  const Q = stockQty(); const locs = locaisList();
  const usado = S.stk.mov.filter(m => m.codigo === c && m.tipo === "servico");
  const porPredio = {}; for(const m of usado){ porPredio[m.condoId] = (porPredio[m.condoId] || 0) + Number(m.qtd); }
  openSheet(esc(a.nome), `
    <div class="panel"><div class="parts">${locs.map(l => `<div class="part"><span class="n">${esc(l.nome)}</span><span class="mono">${numTxt((Q[l.id] || {})[c] || 0)}</span></div>`).join("")}
      <div class="part" style="border-top:1px solid var(--line);padding-top:6px;font-weight:700"><span class="n">Total</span><span class="mono">${numTxt(locs.reduce((s, l) => s + ((Q[l.id] || {})[c] || 0), 0))}</span></div></div></div>
    <div class="grid2"><label class="f"><span>Stock mínimo no armazém</span><input id="sa_min" inputmode="decimal" value="${numTxt(Number(a.minimo) || 0)}"></label>
    <label class="f"><span>Custo médio (€)</span><input id="sa_custo" inputmode="decimal" value="${a.custo !== "" && a.custo != null ? String(Math.round(Number(a.custo) * 100) / 100).replace(".", ",") : ""}"></label></div>
    <div class="actions"><button class="btn" onclick="closeSheet();openMov('compra','${esc(c)}')">+ Compra</button><button class="btn" onclick="closeSheet();openMov('carga','${esc(c)}')"><i class=ico-van></i>Carga</button><span class="sp"></span><button class="btn pri" onclick="saveStockArt('${esc(c)}')">Guardar</button></div>
    ${(() => { const v = vendasPeriodo("tudo", c); return v.q ? `<div class="panel"><div class="parts"><div class="part"><span class="n">Aplicado em obra</span><span class="mono">${numTxt(v.q)}</span></div><div class="part"><span class="n">Total vendido</span><span class="mono">${eur(v.venda)}</span></div><div class="part"><span class="n">Custo estimado</span><span class="mono">${eur(v.custo)}</span></div><div class="part" style="font-weight:700"><span class="n">Margem estimada</span><span class="mono">${eur(v.margem)}</span></div></div></div>` : ""; })()}
    ${Object.keys(porPredio).length ? `<h3>Aplicado por prédio (pela app)</h3><div class="panel"><div class="parts">${Object.entries(porPredio).sort((x, y) => y[1] - x[1]).map(([k, v]) => `<div class="part"><span class="n">${esc(cName(k))}</span><span class="mono">${numTxt(v)}</span></div>`).join("")}</div></div>` : ""}`);
}
async function saveStockArt(c){
  const minimo = parsePrice(val("sa_min")); const custo = val("sa_custo") ? parsePrice(val("sa_custo")) : null;
  if(minimo === null){ toast("Mínimo inválido."); return; }
  const { error } = await sb.from("stock_artigos").upsert({ codigo: c, minimo, custo }); if(error) return writeErr(error);
  S.stk.art[c] = { ...(S.stk.art[c] || {}), codigo: c, minimo, custo }; closeSheet(); render(); toast("Guardado.");
}
/* ---------- exportar ---------- */
function stockExport(){
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`; const n = v => String(Math.round((Number(v) || 0) * 100) / 100).replace(".", ",");
  const Q = stockQty(); const locs = locaisList(); const arts = stkArtigos();
  const head = ["Código", "Descrição", ...locs.map(l => l.nome), "Total", "Stock mínimo", "Estado", "Custo médio (€)", "Valor a custo (€)"];
  const rows = arts.map(a => { const t = locs.reduce((s, l) => s + ((Q[l.id] || {})[a.codigo] || 0), 0); const arm = (Q.principal || {})[a.codigo] || 0;
    return [a.codigo, a.nome, ...locs.map(l => n((Q[l.id] || {})[a.codigo] || 0)), n(t), n(a.minimo), arm < (Number(a.minimo) || 0) ? "REPOR" : "OK", a.custo !== "" && a.custo != null ? n(a.custo) : "", a.custo !== "" && a.custo != null ? n(t * Number(a.custo)) : ""].map(cell).join(";"); });
  const mh = ["Data", "Tipo", "Código", "Descrição", "Quantidade", "De", "Para", "Ordem", "Edifício", "Fornecedor", "Documento", "Preço compra unit. (€)", "Preço venda unit. (€)", "Total vendido (€)", "Custo estimado (€)", "Margem estimada (€)", "Observações", "Registado por"];
  const mr = S.stk.mov.slice().sort((a,b) => (a.data||"").localeCompare(b.data||"") || a.id - b.id).map(m => [fmtDate(m.data), TIPOS_MOV[m.tipo] || m.tipo, m.codigo, (S.mat[m.codigo] || {}).nome || "", n(m.qtd), m.origem ? locNome(m.origem) : "", m.destino ? locNome(m.destino) : "", m.ordemId && S.ots[m.ordemId] ? numOt(S.ots[m.ordemId]) : "", m.condoId ? cName(m.condoId) : "", m.fornecedor, m.documento, m.preco ? n(m.preco) : "", ...(m.tipo === "servico" ? (v => [v.pu === null ? "" : n(v.pu), n(v.venda), n(v.custo), n(v.margem)])(vendaMov(m)) : ["", "", "", ""]), m.obs, m.criadoPor ? nm(m.criadoPor) : ""].map(cell).join(";"));
  const tm = vendasPeriodo("mes"), tt = vendasPeriodo("tudo");
  download(`stock-${today()}.csv`, "﻿" + ["STOCK A " + fmtDate(today()), head.map(cell).join(";"), ...rows, "", "VENDAS", [cell(""), cell("Unidades aplicadas"), cell("Total vendido (€)"), cell("Custo estimado (€)"), cell("Margem estimada (€)")].join(";"), [cell("Este mês"), cell(n(tm.q)), cell(n(tm.venda)), cell(n(tm.custo)), cell(n(tm.margem))].join(";"), [cell("Desde o início"), cell(n(tt.q)), cell(n(tt.venda)), cell(n(tt.custo)), cell(n(tt.margem))].join(";"), "", "MOVIMENTOS", mh.map(cell).join(";"), ...mr].join("\r\n"), "text/csv;charset=utf-8");
}

/* ---------- expor funções usadas no HTML ---------- */
Object.defineProperty(window, 'stkLoc', { get: () => stkLoc, set: v => { stkLoc = v; } }); for(const [k, g, st] of [['matQ', () => matQ, v => { matQ = v; }], ['matSel', () => matSel, v => { matSel = v; }], ['otOrig', () => otOrig, v => { otOrig = v; }], ['condoPend', () => condoPend, v => { condoPend = v; }], ['listMax', () => listMax, v => { listMax = v; }], ['prevF', () => prevF, v => { prevF = v; }], ['prevTec', () => prevTec, v => { prevTec = v; }], ['prevQ', () => prevQ, v => { prevQ = v; }], ['prevOpen', () => prevOpen, v => { prevOpen = v; }]]) Object.defineProperty(window, k, { get: g, set: st });
Object.defineProperty(window, 'stkTipo', { get: () => stkTipo, set: v => { stkTipo = v; } }); Object.defineProperty(window, 'stkPer', { get: () => stkPer, set: v => { stkPer = v; } }); Object.defineProperty(window, 'stkMovF', { get: () => stkMovF, set: v => { stkMovF = v; } }); Object.defineProperty(window, 'movLines', { get: () => movLines }); Object.defineProperty(window, 'twLines', { get: () => twLines }); Object.defineProperty(window, 'twFotos', { get: () => twFotos });
Object.assign(window, { go, mpkAbrir, mpkLista, mpkEscolher, geoInfo, geoAqui, guardarAqui, detetarPredio, mudarLocalMeteo, procLocalMeteo, escolherLocalMeteo, usarLocalizacaoMeteo, togAlmoco, mudarForn, procCondoF, sugMat, verPredio, openResumos, svcTab, setSoRegMat, poeServico, cdmVoltar, naoTerminado, setFalta, horaDia, limparHoras, tirarDia, maisDia, twDiasMud, onTempo, ajudaNotificacoes, origemEntrega, verAcessos, abrirAcessos, escolherCondo, setOculto, openDesativar, desativarPassar, setZonaResp, passarZona, atribuirPorZona, armMat, togMat, onGrpSel, mudarGrupo, empresaTexto, empresaGuardar, empresaLogo, openEntrega, apagarEntrega, confirmarApagarEntrega, guiaPronta, render, renderListOnly, openSheet, closeSheet, armDelete, filterCondoSel, onCondoChange,
  doLogin, logout, enablePush, openPerfil, savePerfil, changePw, newUser, createUser, openPessoa, savePessoa, resetPw, setAtivo, copyText,
  exportJSON, exportCSV, openNotifs, editCondo, saveCondo, delCondo, openCondo, editEquip, saveEquip, delEquip, openEquip,
  editPlan, savePlan, openPlan, genFromPlan, editOt, saveOt, assignOt, setEstado, toggleCk, addPart, rmPart, onNotes, onTempo,
  addFotos, rmFoto, viewFoto, openOt, showReport, shareReport, printOt, del, toast, onPartSel, addMat, rmMat, setPreco, setPartPrice, setTarifa, setDesloc, setSoMaterial, editCdm, saveCdm, openBatchPrint, doBatchPrint, setWeek, batchCount, openPendPrint, doPendPrint, pendCount, setExt, saveClose, instalarApp, openTrabalho, addTwLine, drawTwLines, saveTrabalho, openSaidaDireta, saveSaidaDireta, openMeteo, loadMeteo, backupCompleto, prevToggle, genPlans, grpToggle, assignMany, setExtra, setTarTec, openMov, addMovLine, saveMov, drawMovLines, delMov, setCarTec, openStockArt, saveStockArt, stockExport, sigClear, sigSave, sigRemove });
Object.defineProperty(window, "otFilter", { get: () => otFilter, set: v => { otFilter = v; } });
Object.defineProperty(window, "condoF", { get: () => condoF, set: v => { condoF = v; } });
Object.defineProperty(window, "techF", { get: () => techF, set: v => { techF = v; } });
Object.defineProperty(window, "q", { get: () => q, set: v => { q = v; } });

start();
