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
  condominios: ["id","codigo","nome","morada","nif","fracoes","admin","contacto","notas"],
  condominos: ["id","condoId","fracao","nome","telefone","email","notas"],
  equipamentos: ["id","condoId","nome","tipo","local","marca","modelo","serie","empresa","notas"],
  planos: ["id","titulo","condoId","equipId","zona","tecnico","periodo","inicio","ultima","checklist"],
  ordens: ["id","titulo","condoId","equipId","zona","tecnico","tipo","prioridade","estado","data","solicitante","descricao","checklist","pecas","fotos","notas","tempo","planId","criada","criadaEm","criadoPor","atribuida","atribuidaEm","atribuidoPor","concluida","concluidaEm","concluidoPor","deslocacoes","soMaterial","empresa","contactada","refExterna","extra"],
};
const NULLABLE = new Set(["equipId","tecnico","planId","data","inicio","ultima","criada","criadaEm","criadoPor","atribuida","atribuidaEm","atribuidoPor","concluida","concluidaEm","concluidoPor","contactada"]);
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

async function put(col, obj, quiet){
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
let lastTouchEnd = 0;
document.addEventListener("touchend", e => { const n = Date.now(); if(n - lastTouchEnd < 300 && !e.target.closest("input,textarea,select,canvas")) e.preventDefault(); lastTouchEnd = n; }, { passive: false });
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

async function loadAll(uid){
  ME = uid; mode = "loading"; render();
  const all = async (table, q = x => x) => {
    const out = []; let from = 0;
    for(;;){ const { data, error } = await q(sb.from(table).select("*")).range(from, from + 999); if(error) throw error; out.push(...data); if(data.length < 1000) break; from += 1000; }
    return out;
  };
  try{
    const [perfis, condos, equip, plans, ots, notifs] = await Promise.all([
      all("perfis"), all("condominios"), all("equipamentos"), all("planos"), all("ordens"),
      sb.from("notificacoes").select("*").order("id", { ascending: false }).limit(80).then(r => r.data || []),
    ]);
    const { data: mats } = await sb.from("materiais").select("*");
    S.mat = Object.fromEntries((mats || []).map(m => [m.codigo, m]));
    S.equipa = Object.fromEntries(perfis.map(p => [p.id, fromRow(p)]));
    S.condos = Object.fromEntries(condos.map(r => [r.id, fromRow(r)]));
    S.equip = Object.fromEntries(equip.map(r => [r.id, fromRow(r)]));
    S.plans = Object.fromEntries(plans.map(r => [r.id, fromRow(r)]));
    S.cdm = Object.fromEntries((await all("condominos")).map(r => [r.id, fromRow(r)]));
    S.ots = Object.fromEntries(ots.map(r => [r.id, fromRow(r)]));
    S.notifs = notifs.map(fromRow);
  }catch(e){ console.error(e); mode = "error"; render(); return; }
  const me = S.equipa[ME];
  if(!me){ mode = "noprofile"; render(); return; }
  if(!me.ativo){ mode = "inactive"; render(); return; }
  IS_ADMIN = me.papel === "admin";
  if(IS_ADMIN){
    const [{ data: pr }, { data: tf }] = await Promise.all([sb.from("materiais_precos").select("*"), sb.from("tarifas").select("*").eq("id", 1).maybeSingle()]);
    S.precos = Object.fromEntries((pr || []).map(x => [x.codigo, Number(x.preco)]));
    if(tf) S.tarifas = { deslocacao: Number(tf.deslocacao) || 0, hora: Number(tf.hora) || 0, extraA: tf.extra_a != null ? Number(tf.extra_a) : 50, extraE: tf.extra_e != null ? Number(tf.extra_e) : 75, novas: "extra_a" in tf };
    const { data: tt } = await sb.from("tarifas_tecnico").select("*");
    S.tarTec = Object.fromEntries((tt || []).map(x => [x.user_id, { hora1: Number(x.hora1), hora: Number(x.hora) }]));
  }
  await loadStock();
  loadMeteo(); setInterval(() => loadMeteo(), 30 * 60 * 1000);
  mode = "ok";
  subscribeRealtime();
  render();
  autoReadNotifs();
  const q = new URLSearchParams(location.search).get("ordem");
  if(q && S.ots[q]){ history.replaceState(null, "", location.pathname); openOt(q); }
  checkPushState();
}

function subscribeRealtime(){
  const ch = sb.channel("dados");
  const map = { perfis: "equipa", condominios: "condos", equipamentos: "equip", planos: "plans", ordens: "ots", condominos: "cdm" };
  for(const [table, col] of Object.entries(map)){
    ch.on("postgres_changes", { event: "*", schema: "public", table }, p => {
      if(p.eventType === "DELETE"){ if(p.old && p.old.id) delete S[col][p.old.id]; }
      else { const o = fromRow(p.new); S[col][o.id] = o; if(col === "equipa" && o.id === ME){ IS_ADMIN = o.papel === "admin"; if(!o.ativo) location.reload(); } }
      render();
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
    toast("🔔 " + n.titulo + ": " + n.corpo);
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
    if(ots) S.ots = Object.fromEntries(ots.map(r => [r.id, fromRow(r)]));
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
  if(!("serviceWorker" in navigator) || !("PushManager" in window)){ toast("Este navegador não suporta notificações. Use o Chrome (Android) ou o Safari (iPhone)."); return; }
  const perm = await Notification.requestPermission();
  if(perm !== "granted"){ toast("Notificações bloqueadas. Ative-as nas definições do telemóvel para esta aplicação."); return; }
  try{
    const reg = await navigator.serviceWorker.ready;
    let s = await reg.pushManager.getSubscription();
    if(!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CFG.VAPID_PUBLIC_KEY) });
    await saveSub(s); pushOn = true; render(); toast("Notificações ativadas neste telemóvel.");
  }catch(e){ console.error(e); toast("Não foi possível ativar as notificações: " + e.message); }
}
function showInstallHelp(){
  openSheet("Instalar no iPhone", `<p style="margin-top:0">No iPhone, as notificações só funcionam com a aplicação instalada no ecrã principal:</p>
  <ol style="line-height:1.7;padding-left:20px"><li>Abra esta página no <b>Safari</b>.</li><li>Toque no botão <b>Partilhar</b> (quadrado com seta para cima).</li><li>Escolha <b>Adicionar ao ecrã principal</b> e confirme.</li><li>Abra a aplicação pelo novo ícone <b>Manutenção</b>, entre, e toque em <b>Ativar notificações</b>.</li></ol>
  <p style="font-size:13px;color:var(--muted)">Requer iOS 16.4 ou mais recente.</p>`);
}
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
const pessoas = () => Object.values(S.equipa).sort((a,b) => (a.papel === b.papel ? (a.nome||"").localeCompare(b.nome||"", "pt") : a.papel === "tec" ? -1 : 1));
const tecnicos = () => pessoas().filter(p => p.ativo);
const matList = () => Object.values(S.mat).filter(m => m.ativo !== false).sort((a,b) => (a.ordem||0) - (b.ordem||0) || a.nome.localeCompare(b.nome, "pt"));
const partLabel = x => x.n + (x.c ? " (" + x.c + ")" : "");
function pendingPart(){
  const sel = document.getElementById("p_sel"); const qt = parseFloat(val("p_qtd")) || 1;
  if(sel && sel.value && sel.value !== "__outro"){ const m = S.mat[sel.value]; if(m) return {n: m.nome, c: m.codigo, q: qt}; }
  const n = val("p_nome"); return n ? {n, q: qt} : null;
}
function clearPart(){ const sel = $("#p_sel"), a = $("#p_nome"), b = $("#p_qtd"); if(sel) sel.value = ""; if(a){ a.value = ""; a.style.display = matList().length ? "none" : ""; } if(b) b.value = ""; }
function onPartSel(v){ const a = $("#p_nome"); if(!a) return; a.style.display = v === "__outro" ? "" : "none"; if(v === "__outro") a.focus(); else if(v) { const q = $("#p_qtd"); if(q && !q.value) q.value = 1; } }
const EUR = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" });
const eur = v => EUR.format(Number(v) || 0);
const unitPrice = x => (x.p !== undefined && x.p !== "" && x.p !== null) ? Number(x.p) : (x.c && S.precos[x.c] !== undefined ? S.precos[x.c] : null);
const lineTotal = x => { const u = unitPrice(x); return u === null ? null : u * (Number(x.q) || 0); };
const partsTotal = pc => pc.reduce((t, x) => t + (lineTotal(x) || 0), 0);
const parsePrice = v => { const n = parseFloat(String(v).replace(/\s|€/g, "").replace(",", ".")); return isNaN(n) ? null : Math.round(n * 100) / 100; };
const nDesloc = o => (o.deslocacoes === "" || o.deslocacoes === undefined || o.deslocacoes === null) ? 1 : Number(o.deslocacoes) || 0;
const r2 = v => Math.round(v * 100) / 100;
const moTxt = (o, v) => v.tt ? `${fmtTempo(o.tempo)} · ${eur(v.tt.hora1)} 1.ª hora + ${eur(v.tt.hora)}/h seguintes` : `${fmtTempo(o.tempo)} × ${eur(S.tarifas.hora)}/h`;
function valores(o){
  if(isExt(o)) return { mat: 0, mo: 0, nd: 0, desl: 0, so: false, ext: true, ex: 0, exTipo: "", total: 0 };
  const mat = r2(partsTotal(o.pecas || []));
  const horas = (Number(o.tempo) || 0) / 60;
  const so = o.soMaterial === true;
  const tt = S.tarTec[o.tecnico]; const min = Number(o.tempo) || 0;
  const mo = so ? 0 : tt ? r2(min > 0 ? tt.hora1 + Math.max(0, min - 60) / 60 * tt.hora : 0) : r2(horas * S.tarifas.hora);
  const nd = so ? 0 : nDesloc(o); const desl = r2(nd * S.tarifas.deslocacao);
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
const telBtns = t => { const ns = splitTels(t); return ns.map(n => `<a class="btn sm" href="tel:${esc(n)}">📞 ${esc(fmtTel(n))}</a>${waNum(n).length >= 11 && /^(\+?351)?9/.test(n.replace(/^00/, "+")) ? `<a class="btn sm wa" href="https://wa.me/${waNum(n)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}`).join(""); };
function waNum(t){ let d = String(t||"").replace(/\D/g, ""); if(d.startsWith("00")) d = d.slice(2); if(d.length === 9) d = "351" + d; return d; }
const waLink = (tel, text) => `https://wa.me/${waNum(tel)}?text=${encodeURIComponent(text)}`;
function waOrdem(o){
  const c = S.condos[condoOf(o)] || {};
  return [`🔧 Nova ordem de trabalho ${numLabel(o)}`, `*${o.titulo}*`, c.nome ? cLabel(c) : "", c.morada || "", whereTxt(o), `Prioridade: ${(PRIOR[o.prioridade]||PRIOR.media)[0]} · Prevista: ${fmtDate(o.data)}`, o.descricao ? "\n" + o.descricao : "", `\nAbrir: ${APP_URL}?ordem=${o.id}`].filter(Boolean).join("\n");
}
function waConcl(o){ return [`✅ Ordem ${numLabel(o)} concluída`, `*${o.titulo}*`, cName(condoOf(o)), o.notas ? "\n" + o.notas : "", `\nVer: ${APP_URL}?ordem=${o.id}`].filter(Boolean).join("\n"); }
const waBtn = (tel, text, label) => `<a class="btn wa" href="${esc(waLink(tel, text))}" target="_blank" rel="noopener">📲 ${esc(label)}</a>`;

/* ---------- navegação ---------- */
let tab = "inicio", otFilter = "ativas", condoF = "", techF = "", q = "";
const ICONS = {
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
function go(t){ tab = t; q = ""; listMax = 50; render(); window.scrollTo(0,0); }
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
  const pos = await obterPosicao(); meteoPos = pos || null;
  try{
    const { data, error } = await sb.functions.invoke("meteo", { body: pos || {} });
    if(error || !data || data.erro || !data.dias) throw (error || new Error(data && data.erro));
    meteo = data; lsSet("meteo2", { t: Date.now(), d: data, pos: meteoPos });
    renderWho(); if(sheetRefresh && document.getElementById("wxSheet")) sheetRefresh();
  }catch(e){ console.warn("meteo", e); }
}
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
    const ondeTxt = meteoPos ? `📍 Pela sua localização${meteo.km != null ? ` (estação de previsão a ~${meteo.km} km)` : ""}` : meteoNegado ? "📍 A localização não está autorizada — a mostrar o Porto. Para usar a sua zona, autorize a localização para esta app nas definições do telemóvel." : "📍 Sem localização — a mostrar o Porto.";
    return `<div id="wxSheet">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px"><span style="font-size:44px;line-height:1">${WX[a ? a.tipo : meteoHoje().tipo] || "🌡️"}</span><div><div style="font-size:22px;font-weight:700">${esc(meteo.local)}${a ? ` · ${Math.round(a.temp)}°` : ""}</div><div style="color:var(--muted);font-size:14px">${esc(a ? a.desc : meteoHoje().desc)}${a && a.prob >= 0 ? ` · 💧 ${Math.round(a.prob)}%` : ""}</div></div></div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:10px">${ondeTxt} <button class="btn sm" onclick="loadMeteo(true)" style="margin-left:4px">Atualizar</button></div>
      <div class="plist" style="border:1px solid var(--line);border-radius:var(--r);margin:0;background:var(--card)">${meteo.dias.map(d => { const nome = d.data === t ? "Hoje" : d.data === am ? "Amanhã" : DIAS_SEM[new Date(d.data + "T12:00:00").getDay()];
        return `<div class="prow" style="cursor:default"><span style="font-size:28px;line-height:1">${WX[d.tipo] || "🌡️"}</span><span class="pn"><b>${nome}</b> <span style="color:var(--muted);font-size:13px">${fmtDate(d.data).slice(0, 5)}</span><small>${esc(d.desc)}${d.vento ? " · vento " + esc(d.vento) : ""}</small></span><span style="text-align:right;white-space:nowrap"><b>${Math.round(d.tMax)}°</b> <span style="color:var(--muted)">${Math.round(d.tMin)}°</span><br><span style="font-size:13px;color:${d.prob >= 50 ? "var(--blue)" : "var(--muted)"}">💧 ${Math.round(d.prob)}%</span></span></div>`; }).join("")}</div>
      ${meteo.dias.slice(0, 3).some(d => d.prob >= 70) ? `<div class="note" style="margin-top:10px">🌧️ Chuva provável nos próximos dias — bom momento para verificar caleiros, ralos e infiltrações; trabalhos em telhados e terraços ficam para dias secos.</div>` : ""}
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
  el.innerHTML = `${meteoChip()}<button class="bell" onclick="openNotifs()" aria-label="Notificações">🔔${nu?`<i>${nu>99?"99+":nu}</i>`:""}</button><span class="who-n" onclick="openPerfil()" style="cursor:pointer"></span><span class="badge ${IS_ADMIN?"b-amber":"b-blue"}" onclick="openPerfil()" style="cursor:pointer"><span class="lg-only">${IS_ADMIN?"Administrativo":"Técnico"}</span><span class="sm-only">${IS_ADMIN?"Admin.":"Técnico"}</span></span><button class="bell" onclick="openPerfil()" aria-label="O meu perfil" title="O meu perfil (palavra-passe e assinatura)">👤</button>`;
  el.querySelector(".who-n").textContent = (S.equipa[ME] || {}).nome || "";
}

/* ---------- itens de lista ---------- */
function otRow(o, hideCondo){
  const late = o.estado !== "concluida" && o.data && o.data < today();
  const est = o.estado === "concluida" ? '<span class="badge b-green">Concluída</span>' : o.estado === "curso" ? '<span class="badge b-blue">Em curso</span>' : "";
  const sub = [hideCondo ? "" : cName(condoOf(o)), IS_ADMIN ? (o.tecnico ? nm(o.tecnico) : (gecResp(o) ? "Gecond: " + gecResp(o) : "Por atribuir")) : ""].filter(Boolean).join(" · ");
  const pr = o.prioridade === "alta" ? '<b style="color:var(--red)">⚠ </b>' : "";
  return `<div class="prow" onclick="openOt('${o.id}')"><span class="mono pd">${esc(numOt(o) || "")}</span><span class="pn">${pr}${isTrab(o) ? "🔧 " : ""}${esc(o.titulo)}${isExt(o) ? " 🛗" : ""}<small>${esc(sub)}</small></span>${est}<span class="badge ${late ? "b-red" : ""}" style="white-space:nowrap">${o.estado==="concluida" ? fmtDate(o.concluida) : fmtDate(o.data)}</span></div>`;
}
let grpOpen = new Set(), listMax = 50;
function grpBlock(key, label, sub, items, extra){
  const aberto = grpOpen.has(key);
  return `<details class="pgrp" ${aberto ? "open" : ""} ontoggle="grpToggle('${esc(key)}', this.open)"><summary><span class="pg-t">${label}</span><span class="badge">${items.length}</span>${sub ? `<span class="pg-s">${sub}</span>` : ""}</summary>${aberto ? `${extra || ""}<div class="plist">${items.map(o => otRow(o)).join("")}</div>` : ""}</details>`;
}
function grpToggle(k, open){ if(open){ if(!grpOpen.has(k)){ grpOpen.add(k); const y = window.scrollY; render(); window.scrollTo(0, y); } } else { grpOpen.delete(k); } }
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
  const who = IS_ADMIN ? `<div class="s">👷 <span class="${o.tecnico?"":"warnTxt"}">${esc(nm(o.tecnico))}</span></div>` : "";
  const nf = (o.fotos||[]).length;
  return `<div class="item" onclick="openOt('${o.id}')"><div class="bar ${o.estado==="concluida"?"green":p[2]}"></div>
    <div class="main"><div class="t">${numOt(o)?`<span class="mono" style="color:var(--muted);font-weight:500;margin-right:6px">${numOt(o)}</span>`:""}${esc(o.titulo)}</div><div class="s">${esc(sub)}</div>${who}
    ${ck.length||nf?`<div class="s mono">${ck.length?`${done}/${ck.length} verificações`:""}${ck.length&&nf?" · ":""}${nf?`📷 ${nf}`:""}</div>`:""}</div>
    <div class="r">${est}<span class="${late?"badge b-red":""}">${o.estado==="concluida"?fmtDate(o.concluida):fmtDate(o.data)}</span>${o.tipo==="preventiva"?'<span class="badge">Preventiva</span>':o.tipo==="pedido"?'<span class="badge">Pedido</span>':""}</div></div>`;
}
function planItem(p, hideCondo){
  const st = planStatus(p); const open = openOtForPlan(p.id);
  const sub = [hideCondo ? "" : cName(condoOf(p)), whereTxt(p), perLabel(p)].filter(Boolean).join(" · ");
  return `<div class="item" onclick="openPlan('${p.id}')"><div class="bar ${st[2]}"></div>
    <div class="main"><div class="t">${esc(p.titulo)}</div><div class="s">${esc(sub)}</div>
    <div class="s">Próxima: <span class="mono">${fmtDate(planNext(p))}</span>${p.tecnico?" · 👷 "+esc(nm(p.tecnico)):""}${open?" · ordem já criada":""}</div></div>
    <div class="r"><span class="badge ${st[1]}">${st[0]}</span></div></div>`;
}
const emptyBox = (msg, btn) => `<div class="empty">${msg}${btn?`<br>${btn}`:""}</div>`;
const condoFilterSel = () => `<select class="search" onchange="condoF=this.value;render()"><option value="">Todos os condomínios</option>${condosSorted().map(c=>`<option value="${c.id}" ${c.id===condoF?"selected":""}>${esc(cLabel(c))}</option>`).join("")}</select>`;
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

function viewInicio(){
  const t = today();
  if(!IS_ADMIN){
    const mine = otsSorted();
    const hoje = mine.filter(o => o.estado !== "concluida" && (!o.data || o.data <= t));
    const prox = mine.filter(o => o.estado !== "concluida" && o.data && o.data > t);
    const mes = mine.filter(o => o.estado === "concluida" && (o.concluida||"").slice(0,7) === t.slice(0,7)).length;
    const first = ((S.equipa[ME]||{}).nome||"").split(" ")[0];
    return `<h2>Olá${first?", "+esc(first):""} <span class="mono" style="font-size:14px;color:var(--muted)">${fmtDate(t)}</span></h2>${pushBanner()}${(S.equipa[ME]||{}).assinatura ? "" : `<div class="note" style="display:flex;gap:10px;align-items:center;justify-content:space-between"><span>Guarde a sua assinatura para ela sair nos relatórios.</span><button class="btn sm pri" onclick="openPerfil()">Assinar</button></div>`}
    <div class="stats">
      ${statCard(hoje.length, "Para hoje / em atraso", "otFilter='ativas';go('ordens')", true)}
      ${statCard(mine.filter(o=>o.estado==="curso").length, "Em curso", "otFilter='curso';go('ordens')")}
      ${statCard(prox.length, "Próximos dias", "otFilter='ativas';go('ordens')")}
      ${statCard(mes, "Concluídas este mês", "otFilter='concluida';go('ordens')")}
    </div>
    <h3>Para hoje e em atraso</h3>
    <div class="list">${hoje.length ? hoje.map(o=>otItem(o)).join("") : emptyBox("Não tem ordens para hoje. 👍")}</div>
    ${prox.length?`<h3>Próximas</h3><div class="list">${prox.slice(0,10).map(o=>otItem(o)).join("")}</div>`:""}
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
  return `<h2>Painel <span style="display:flex;gap:8px;align-items:center"><button class="btn sm" onclick="openSaidaDireta()">📦 Entrega de material</button><span class="mono" style="font-size:14px;color:var(--muted)">${fmtDate(t)}</span></span></h2>${pushBanner()}${copiaBanner()}
  <div class="stats">
    ${statCard(porAtribuir.length, "Por atribuir", "techF='-';otFilter='ativas';go('ordens')", true)}
    ${statCard(ots.filter(o=>o.estado==="aberta").length, "Ordens abertas", "techF='';otFilter='aberta';go('ordens')")}
    ${statCard(ots.filter(o=>o.estado==="curso").length, "Em curso", "techF='';otFilter='curso';go('ordens')")}
    ${statCard(atrasadas, "Preventivas em atraso", "go('prev')", true)}
  </div>
  ${(() => { const desde = addDays(t, -7); const tr = Object.values(S.ots).filter(o => isTrab(o) && o.estado === "concluida" && (o.concluida || "") >= desde).sort((a,b) => (b.concluida||"").localeCompare(a.concluida||""));
    if(!tr.length) return ""; window.__grp = window.__grp || {};
    return `<h3>🔧 Trabalhos registados pelos técnicos <span style="font-weight:400;text-transform:none;letter-spacing:0">— últimos 7 dias</span></h3>` + grpBlock("tr:7d", "Concluídos", `${tr.length} para imprimir no resumo da semana`, tr, `<div class="actions" style="margin:6px 0"><span class="sp"></span><button class="btn sm" onclick="otOrig='trab';otFilter='concluida';go('ordens')">Ver todos</button><button class="btn sm" onclick="openBatchPrint()">🖨️ Imprimir semana</button></div>`); })()}
  ${porAtribuir.length ? (() => { const g = {}; for(const o of porAtribuir){ const k = isExt(o) ? "Elevadores / empresa externa" : (gecResp(o) || "Sem indicação"); (g[k] ||= []).push(o); }
    window.__grp = {};
    return `<h3>Por atribuir <span style="font-weight:400;text-transform:none;letter-spacing:0">— por responsável indicado no Gecond</span></h3>` + Object.entries(g).sort((a,b) => b[1].length - a[1].length).map(([k, os]) => { const key = "pa:" + k; window.__grp[key] = os.map(o => o.id);
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
  ${due.length?`<h3>Preventivas a lançar</h3><div class="list">${due.map(p => `<div class="item"><div class="bar ${planStatus(p)[2]}"></div><div class="main" onclick="openPlan('${p.id}')"><div class="t">${esc(p.titulo)}</div><div class="s">${esc(cName(condoOf(p)))} · ${fmtDate(planNext(p))}${p.tecnico?" · 👷 "+esc(nm(p.tecnico)):""}</div></div><div class="r"><button class="btn sm pri" onclick="genFromPlan('${p.id}')">Criar ordem</button></div></div>`).join("")}</div>`:""}
  <div class="actions" style="margin-top:18px"><button class="btn dark" onclick="editOt()">+ Nova ordem de trabalho</button><button class="btn" onclick="openBatchPrint()">🖨️ Imprimir relatórios da semana</button></div>`;
}

// Trabalho registado por um técnico no local (não veio do escritório nem do Gecond).
const isTrab = o => !!o.criadoPor && (S.equipa[o.criadoPor] || {}).papel === "tec" && !(o.descricao || "").startsWith("Ocorrência Gecond");
let otOrig = "";
function viewOrdens(){
  const f = {ativas:o=>o.estado!=="concluida", aberta:o=>o.estado==="aberta", curso:o=>o.estado==="curso", concluida:o=>o.estado==="concluida", todas:()=>true}[otFilter] || (()=>true);
  const tf = !IS_ADMIN || !techF ? () => true : techF === "-" ? o => !o.tecnico : o => o.tecnico === techF;
  const fo = !IS_ADMIN || !otOrig ? () => true : otOrig === "trab" ? isTrab : o => !isTrab(o);
  const base = otsSorted().filter(f).filter(tf).filter(o => !condoF || condoOf(o) === condoF);
  const nTrab = base.filter(isTrab).length;
  const list = otsSorted().filter(f).filter(tf).filter(fo).filter(o => !condoF || condoOf(o) === condoF).filter(o => !q || hit([numOt(o), o.numero, o.titulo, cName(condoOf(o)), whereTxt(o), o.solicitante, o.descricao, o.notas, IS_ADMIN ? nm(o.tecnico) : ""].join(" "), q));
  const chips = [["ativas","Pendentes"],["aberta","Abertas"],["curso","Em curso"],["concluida","Concluídas"],["todas","Todas"]];
  const any = myOts().length;
  return `<h2>${IS_ADMIN?"Ordens de trabalho":"As minhas ordens"} <span style="display:flex;gap:6px">${IS_ADMIN?'<button class="btn sm" onclick="openSaidaDireta()">📦 Entrega de material</button>':""}${IS_ADMIN?'<button class="btn sm" onclick="openPendPrint()">🖨️ Por fechar</button><button class="btn sm" onclick="openBatchPrint()">🖨️ Imprimir semana</button>':""}<button class="btn pri sm" onclick="${IS_ADMIN ? "editOt()" : "openTrabalho()"}">+ ${IS_ADMIN?"Nova":"Novo trabalho"}</button></span></h2>
  ${IS_ADMIN ? `<div class="seg" style="margin-bottom:10px">${[["","Tudo", base.length],["ocorr","📋 Ocorrências", base.length - nTrab],["trab","🔧 Trabalhos dos técnicos", nTrab]].map(([k, l, n]) => `<button class="${otOrig===k?"on":""}" onclick="otOrig='${k}';listMax=50;render()">${l} <span class="mono" style="opacity:.7">${n}</span></button>`).join("")}</div>` : ""}
  <div class="chips">${chips.map(([k,l])=>`<button class="chip ${otFilter===k?"on":""}" onclick="otFilter='${k}';render()">${l}</button>`).join("")}</div>
  ${techFilterSel()}${condoFilterSel()}
  <input class="search" placeholder="Procurar por nº, título, condomínio, zona…" value="${esc(q)}" oninput="q=this.value;renderListOnly()">
  <div class="${IS_ADMIN ? "pgrp plain" : "list"}" id="lst">${list.length ? (IS_ADMIN ? `<div class="plist">${list.slice(0, listMax).map(o => otRow(o, !!condoF)).join("")}</div>${list.length > listMax ? `<div class="actions" style="justify-content:center;margin:8px 0"><button class="btn" onclick="listMax+=100;renderListOnly()">Mostrar mais (${list.length - listMax} restantes)</button></div>` : ""}` : list.map(o=>otItem(o, !!condoF)).join("")) : emptyBox(any?"Nenhuma ordem corresponde ao filtro.":(IS_ADMIN?"Ainda não há ordens de trabalho.":"Ainda não tem ordens atribuídas."))}</div>`;
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
  }).join("") : emptyBox(Object.keys(S.plans).length ? (prevF === "semana" || prevF === "atraso" ? "Nada para esta semana. 👍" : "Nenhum plano com estes filtros.") + (prevF ? ` <button class="btn sm" onclick="prevF='';render()">Ver todas</button>` : "") : "Crie planos periódicos — ex.: ronda mensal às áreas comuns — com um técnico responsável.", Object.keys(S.plans).length ? "" : '<button class="btn pri" onclick="editPlan()">+ Criar plano</button>')}</div>`;
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
      return `<details class="pgrp cz" ${aberto ? "open" : ""} ontoggle="grpToggle('${esc(key)}', this.open)"><summary><span class="pg-t">${esc(z)} <span class="mono" style="color:var(--muted);font-weight:400;font-size:12px">${esc(cods)}</span></span><span class="badge">${cs.length}</span>${np ? `<span class="badge b-amber" title="Prédios com ordens pendentes">${np} c/ pendentes</span>` : ""}</summary>${aberto ? `<div class="plist">${cs.map(row).join("")}</div>` : ""}</details>`; }).join("");
  }
  return `<h2>Condomínios <span class="mono" style="font-size:14px;color:var(--muted);margin-right:auto;margin-left:8px">${Object.keys(S.condos).length}</span>${IS_ADMIN?'<button class="btn pri sm" onclick="editCondo()">+ Novo</button>':""}</h2>
  <div class="chips"><button class="chip ${!condoPend?"on":""}" onclick="condoPend=false;render()">Todos</button><button class="chip ${condoPend?"on":""}" onclick="condoPend=true;render()">Com ordens pendentes <span class="mono" style="opacity:.7">${nPend}</span></button></div>
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
    return `<div class="item" onclick="openPessoa('${x.id}')" style="${x.ativo?"":"opacity:.55"}"><div class="bar ${x.papel==="admin"?"amber":"blue"}"></div><div class="main"><div class="t">${esc(x.nome)}${x.id===ME?" (eu)":""}${x.ativo?"":' <span class="badge">Desativado</span>'}</div><div class="s">${x.papel==="admin"?"Administrativo":"Técnico"} · ${esc(x.email||"")}</div><div class="s">📱 ${x.telefone?esc(x.telefone):'<span class="warnTxt">sem número</span>'} · ✍️ ${x.assinatura?"assinatura guardada":'<span class="warnTxt">sem assinatura</span>'}</div>${x.papel==="tec"?`<div class="s">${pend} pendente${pend===1?"":"s"} · ${mes} concluída${mes===1?"":"s"} este mês</div>`:""}</div></div>`;
  }).join("")}</div>
  <h3>Tarifas</h3>
  <div class="panel"><div class="grid2">
    <label class="f" style="margin:0"><span>Deslocação (€ por deslocação)</span><input inputmode="decimal" value="${String(S.tarifas.deslocacao).replace(".", ",")}" onchange="setTarifa('deslocacao', this.value)"></label>
    <label class="f" style="margin:0"><span>Mão de obra (€ por hora)</span><input inputmode="decimal" value="${String(S.tarifas.hora).replace(".", ",")}" onchange="setTarifa('hora', this.value)"></label>
    <label class="f" style="margin:0"><span>Manutenção A (€)</span><input inputmode="decimal" value="${String(S.tarifas.extraA).replace(".", ",")}" onchange="setTarifa('extraA', this.value)"></label>
    <label class="f" style="margin:0"><span>Manutenção E (€)</span><input inputmode="decimal" value="${String(S.tarifas.extraE).replace(".", ",")}" onchange="setTarifa('extraE', this.value)"></label>
  </div><div style="font-size:13px;color:var(--muted);margin-top:8px">Tarifas próprias de um técnico (ex.: 1.ª hora mais cara): abra o técnico na lista acima.</div></div>
  <h3>Materiais do armazém <span class="mono" style="font-weight:500">${matList().length}</span></h3>
  <div class="panel">
    <div style="font-size:13px;color:var(--muted);margin-bottom:6px">Preço unitário de cada material (só os administrativos veem). Usado na impressão das ordens.</div>
    <div class="parts">${matList().map(m => `<div class="part"><span class="n">${esc(m.nome)} <span class="mono" style="color:var(--muted);font-size:12px">${esc(m.codigo)}</span></span><input inputmode="decimal" value="${S.precos[m.codigo] !== undefined ? String(S.precos[m.codigo]).replace(".", ",") : ""}" placeholder="0,00" onchange="setPreco('${esc(m.codigo)}', this.value)" style="width:84px;text-align:right;border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:#fff"> €<button class="btn sm" onclick="rmMat('${esc(m.codigo)}')" aria-label="Retirar">✕</button></div>`).join("") || '<span style="color:var(--muted)">Sem materiais.</span>'}</div>
    <div class="addpart" style="margin-top:10px"><input id="m_cod" placeholder="Código (ex.: LAMP-E27)" style="flex:0 0 38%;text-transform:uppercase"><input id="m_nome" placeholder="Descrição (ex.: Lâmpada E27)" style="flex:1"><button class="btn sm" onclick="addMat()">Adicionar</button></div>
  </div>
  <h3>Dados</h3>
  <div class="panel" style="font-size:14px">O plano gratuito do Supabase <b>não faz cópias de segurança</b>. Faça uma cópia <b>uma vez por semana</b> e guarde o ficheiro fora do computador (pen, Google Drive, OneDrive ou e-mail para si próprio). Se um dia for preciso, os dados repõem-se a partir deste ficheiro.
    <div style="margin-top:8px;color:var(--muted)">Última cópia neste aparelho: <b>${ultimaCopia() ? fmtDate(ultimaCopia()) : "nunca"}</b> · Fotografias: ${Object.values(S.ots).reduce((a, o) => a + (o.fotos || []).length, 0)} (cerca de ${Math.round(Object.values(S.ots).reduce((a, o) => a + (o.fotos || []).length, 0) * 0.18)} MB de 1 000 MB gratuitos)</div>
    <div style="margin-top:6px;color:var(--muted)">O Supabase suspende projetos gratuitos sem uso durante uma semana — em férias, abra a app pelo menos uma vez por semana.</div>
  <div class="actions" style="margin-top:10px"><button class="btn pri" onclick="backupCompleto(this)">💾 Fazer cópia de segurança</button><button class="btn" onclick="exportCSV()">Exportar ordens (Excel/CSV)</button></div></div>`;
}

function render(){
  renderNav(); renderWho();
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
function openSheet(title, html, refresh){
  $("#sheet").innerHTML = `<div class="top"><h4>${title}</h4><button class="x" onclick="closeSheet()" aria-label="Fechar">×</button></div><div class="body">${html}</div>`;
  $("#scrim").classList.add("open"); $("#sheet").scrollTop = 0; sheetRefresh = refresh || null;
}
function closeSheet(){ $("#scrim").classList.remove("open"); sheetRefresh = null; }
$("#scrim").addEventListener("click", e => { if(e.target.id === "scrim") closeSheet(); });
document.addEventListener("keydown", e => { if(e.key === "Escape") closeSheet(); });
function armDelete(btn, fn){
  if(btn.classList.contains("arm")){ fn(); return; }
  btn.classList.add("arm"); btn.textContent = "Confirmar";
  setTimeout(() => { if(btn.isConnected){ btn.classList.remove("arm"); btn.textContent = btn.dataset.label || "Eliminar"; } }, 4000);
}
const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
const condoOptions = (sel, f) => `<option value="">— Selecione —</option>` + condosSorted().filter(c => c.id === sel || !f || hit([c.codigo,c.nome,c.morada,c.nif].join(" "), f)).map(c => `<option value="${c.id}" ${c.id===sel?"selected":""}>${esc(cLabel(c))}</option>`).join("");
const condoPicker = (sel, onch) => `<label class="f"><span>Condomínio *</span><input id="f_cq" placeholder="Procurar por código, nome ou morada…" oninput="filterCondoSel(this.value)" style="margin-bottom:6px"><select id="f_condo" ${onch?'onchange="onCondoChange()"':""}>${condoOptions(sel)}</select></label>`;
function filterCondoSel(v){ const s = $("#f_condo"); if(!s) return; const cur = s.value; s.innerHTML = condoOptions(cur, v); const opts = [...s.options].filter(o => o.value); if(!cur && opts.length === 1){ s.value = opts[0].value; if(s.onchange) s.onchange(); } }
const equipOptions = (condoId, sel) => {
  const list = Object.values(S.equip).filter(e => e.condoId === condoId).sort((a,b)=>a.nome.localeCompare(b.nome, "pt"));
  return `<option value="">${condoId ? "— Nenhum (área comum / geral) —" : "— Escolha primeiro o condomínio —"}</option>` + list.map(e => `<option value="${e.id}" ${e.id===sel?"selected":""}>${esc(e.nome)}${e.local?" — "+esc(e.local):""}</option>`).join("");
};
const pessoasAgrupadas = sel => { const opt = t => `<option value="${t.id}" ${t.id===sel?"selected":""}>${esc(t.nome)}</option>`; const tec = tecnicos().filter(t => t.papel !== "admin"), adm = tecnicos().filter(t => t.papel === "admin");
  return (tec.length ? `<optgroup label="Técnicos">${tec.map(opt).join("")}</optgroup>` : "") + (adm.length ? `<optgroup label="Administrativos">${adm.map(opt).join("")}</optgroup>` : ""); };
const techOptions = sel => `<option value="">— Por atribuir —</option>` + pessoasAgrupadas(sel) + (sel && !(S.equipa[sel] && S.equipa[sel].ativo) ? `<option value="${esc(sel)}" selected>${esc(nm(sel))}</option>` : "");
function onCondoChange(){ const s = $("#f_eq"); if(s) s.innerHTML = equipOptions(val("f_condo"), ""); }

/* ---------- perfil próprio ---------- */
function openPerfil(){
  const me = S.equipa[ME] || {};
  openSheet("O meu perfil", `
    <label class="f"><span>Nome</span><input id="p_nome" value="${esc(me.nome)}"></label>
    <label class="f"><span>Telemóvel (WhatsApp)</span><input id="p_tel" type="tel" inputmode="tel" value="${esc(me.telefone)}" placeholder="9xx xxx xxx"></label>
    <div class="actions"><span class="sp"></span><button class="btn pri" onclick="savePerfil()">Guardar</button></div>
    <h3>Notificações</h3>
    <div class="panel" style="font-size:14px">${pushOn ? "✅ Ativas neste telemóvel." : `Desativadas neste telemóvel. <button class="btn sm pri" onclick="enablePush()">Ativar</button>`}</div>
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
function sigTrim(c){
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
  const txt = `Olá ${nome.split(" ")[0]}! Já tens acesso à aplicação de Manutenção.\n\nEndereço: ${APP_URL}\nE-mail: ${email}\nPalavra-passe: ${password}\n\nNo telemóvel: abre o endereço, adiciona ao ecrã principal e ativa as notificações.`;
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
    ${x.papel === "tec" ? (() => { const tt = S.tarTec[id]; return `<h3>Tarifa de mão de obra</h3>
    <div class="panel"><div style="font-size:13px;color:var(--muted);margin-bottom:8px">Deixe em branco para usar a tarifa normal (${eur(S.tarifas.hora)}/h). Só os administrativos veem.</div>
      <div class="grid2"><label class="f" style="margin:0"><span>1.ª hora (€)</span><input id="tt_h1" inputmode="decimal" value="${tt ? String(tt.hora1).replace(".", ",") : ""}" placeholder="Ex.: 40"></label>
      <label class="f" style="margin:0"><span>Horas seguintes (€/h)</span><input id="tt_h" inputmode="decimal" value="${tt ? String(tt.hora).replace(".", ",") : ""}" placeholder="Ex.: 20"></label></div>
      <div class="actions" style="margin-top:8px"><span class="sp"></span><button class="btn" onclick="setTarTec('${id}')">Guardar tarifa</button></div></div>`; })() : ""}
    <h3>Acesso</h3>
    <div class="panel" style="font-size:14px">E-mail de entrada: <b>${esc(x.email||"")}</b>
      <div class="actions" style="margin-top:10px"><button class="btn" onclick="resetPw('${id}')">Repor palavra-passe</button>
      ${self?"":`<button class="btn ${x.ativo?"danger":""}" data-label="${x.ativo?"Desativar conta":"Reativar conta"}" onclick="armDelete(this,()=>setAtivo('${id}',${!x.ativo}))">${x.ativo?"Desativar conta":"Reativar conta"}</button>`}</div></div>`);
}
async function setTarTec(id){
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
async function setAtivo(id, ativo){
  try{ await callUsers({ acao: "ativo", user_id: id, ativo }); S.equipa[id] = { ...S.equipa[id], ativo }; closeSheet(); render(); toast(ativo ? "Conta reativada." : "Conta desativada."); }
  catch(e){ toast(e.message); }
}

/* ---------- materiais do armazém ---------- */
async function addMat(){
  const codigo = val("m_cod").toUpperCase().replace(/\s+/g, "-"), nome = val("m_nome");
  if(!codigo || !nome){ toast("Indique o código e a descrição."); return; }
  const ordem = Math.max(0, ...Object.values(S.mat).map(m => m.ordem || 0)) + 1;
  const row = { codigo, nome, ordem, ativo: true };
  const { error } = await sb.from("materiais").upsert(row);
  if(error) return writeErr(error);
  S.mat[codigo] = row; render(); toast("Material adicionado.");
}
async function rmMat(codigo){
  const m = S.mat[codigo]; if(!m) return;
  const { error } = await sb.from("materiais").update({ ativo: false }).eq("codigo", codigo);
  if(error) return writeErr(error);
  S.mat[codigo] = { ...m, ativo: false }; render(); toast(m.nome + " retirado da lista.");
}

async function setPreco(codigo, v){
  const preco = parsePrice(v); if(preco === null && String(v).trim() !== ""){ toast("Preço inválido."); return; }
  const { error } = preco === null ? await sb.from("materiais_precos").delete().eq("codigo", codigo) : await sb.from("materiais_precos").upsert({ codigo, preco });
  if(error) return writeErr(error);
  if(preco === null) delete S.precos[codigo]; else S.precos[codigo] = preco;
  toast("Preço guardado: " + (S.mat[codigo] || {}).nome + (preco === null ? " sem preço" : " " + eur(preco)));
}
async function setTarifa(k, v){
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
  const tabelas = ["condominios", "condominos", "equipamentos", "planos", "ordens", "materiais", "materiais_precos", "tarifas", "tarifas_tecnico", "perfis", ...(VE_STOCK() ? ["stock_locais", "stock_artigos", "stock_mov"] : [])];
  const out = { app: "Manutenção FLAT Condomínios", versao: 1, exportado_em: nowIso(), exportado_por: nm(ME), tabelas: {} }; const falhas = [];
  for(const t of tabelas){
    const rows = []; let from = 0;
    try{ for(;;){ const { data, error } = await sb.from(t).select("*").range(from, from + 999); if(error) throw error; rows.push(...data); if(data.length < 1000) break; from += 1000; } out.tabelas[t] = rows; }
    catch(e){ falhas.push(t); }
  }
  const nf = Object.values(S.ots).reduce((a, o) => a + (o.fotos || []).length, 0);
  out.fotos = { quantidade: nf, nota: "As fotografias ficam no Supabase Storage (pasta 'fotos'); este ficheiro guarda só os caminhos." };
  download(`copia-seguranca-manutencao-${today()}.json`, JSON.stringify(out), "application/json");
  try{ localStorage.setItem("ultimaCopia", today()); }catch(e){}
  if(btn){ btn.disabled = false; btn.textContent = "💾 Fazer cópia de segurança"; }
  toast(falhas.length ? "Cópia feita, mas sem: " + falhas.join(", ") : "Cópia de segurança guardada (" + Object.values(out.tabelas).reduce((a, r) => a + r.length, 0) + " registos).");
  render();
}
function copiaBanner(){
  if(!IS_ADMIN) return "";
  const u = ultimaCopia(); const dias = u ? diffDays(today(), u) : null;
  if(dias !== null && dias < 7) return "";
  return `<div class="note" style="display:flex;gap:10px;align-items:center;justify-content:space-between">${u ? `A última cópia de segurança foi há ${dias} dias.` : "Ainda não fez nenhuma cópia de segurança neste aparelho."} <button class="btn sm" onclick="backupCompleto(this)">💾 Fazer agora</button></div>`;
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
    <label class="f"><span>Acessos e notas (visível para os técnicos)</span><textarea id="c_notas" placeholder="Onde estão as chaves, horários, contacto do porteiro, localização dos contadores…">${esc(c.notas)}</textarea></label>
    <div class="actions">${id?`<button class="btn danger" onclick="armDelete(this,()=>{delCondo('${id}')})">Eliminar</button>`:""}<span class="sp"></span><button class="btn" onclick="${id?`openCondo('${id}')`:"closeSheet()"}">Cancelar</button><button class="btn pri" onclick="saveCondo('${id||""}')">Guardar</button></div>`);
}
function saveCondo(id){
  const nome = val("c_nome"); if(!nome){ toast("Indique o nome do condomínio."); return; }
  const prev = id ? S.condos[id] : null;
  const c = {...(prev||{}), id: id || ("c" + newId()), codigo: val("c_cod").toUpperCase(), nif: val("c_nif"), nome, morada: val("c_morada"), admin: val("c_admin"), contacto: val("c_contacto"), fracoes: val("c_fracoes"), notas: val("c_notas")};
  put("condos", c); toast("Condomínio guardado."); openCondo(c.id);
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
      <div class="list" id="cdmList">${list.length ? list.map(x => `<div class="item" ${IS_ADMIN?`onclick="editCdm('${x.id}')"`:""} style="cursor:${IS_ADMIN?"pointer":"default"}"><div class="bar"></div><div class="main">
        <div class="t">${x.fracao?`<span class="mono" style="color:var(--accent);margin-right:6px">${esc(x.fracao)}</span>`:""}${esc(x.nome)}</div>
        ${x.telefone && !splitTels(x.telefone).length ? `<div class="s mono">${esc(x.telefone)}</div>` : ""}${x.email?`<div class="s">${esc(x.email)}</div>`:""}${x.notas?`<div class="s" style="white-space:pre-wrap">${esc(x.notas)}</div>`:""}
        <div class="actions" style="margin-top:6px" onclick="event.stopPropagation()">${x.telefone ? telBtns(x.telefone) : ""}${x.email?`<a class="btn sm" href="mailto:${esc(x.email)}">✉️ E-mail</a>`:""}</div>
      </div></div>`).join("") : emptyBox(cdms.length ? "Nenhum condómino encontrado." : "Ainda sem condóminos registados." + (IS_ADMIN ? "" : " Peça ao escritório para os acrescentar."))}</div>
      ${IS_ADMIN?`<div class="actions" style="margin-top:10px"><button class="btn" onclick="editCdm(null,'${id}')">+ Condómino</button></div>`:""}`;
    }
    if(sub === "equip") content = `<div class="list">${eqs.length ? eqs.map(e => `<div class="item" onclick="openEquip('${e.id}')"><div class="bar"></div><div class="main"><div class="t">${esc(e.nome)}</div><div class="s">${esc([e.tipo, e.local].filter(Boolean).join(" · "))}</div></div></div>`).join("") : emptyBox("Sem equipamentos registados.")}</div>${IS_ADMIN?`<div class="actions" style="margin-top:10px"><button class="btn" onclick="editEquip(null,'${id}')">+ Equipamento</button></div>`:""}`;
    const maps = c.morada ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.morada)}" target="_blank" rel="noopener" style="color:var(--blue);font-size:13px;margin-left:6px">mapa ↗</a>` : "";
    return `<div class="panel"><dl class="kv">
      ${c.codigo?`<dt>Código</dt><dd class="mono">${esc(c.codigo)}</dd>`:""}
      <dt>Morada</dt><dd>${esc(c.morada||"—")}${maps}</dd>
      <dt>NIF</dt><dd class="mono">${esc(c.nif||"—")}</dd>
      ${c.admin?`<dt>Administração</dt><dd>${esc(c.admin)}</dd>`:""}
      ${c.contacto?`<dt>Contacto</dt><dd>${esc(c.contacto)}</dd>`:""}
      ${c.fracoes?`<dt>Frações</dt><dd>${esc(c.fracoes)}</dd>`:""}
      ${c.notas?`<dt>Acessos</dt><dd style="white-space:pre-wrap">${esc(c.notas)}</dd>`:""}</dl></div>
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
function editCdm(id, condoId){
  if(!IS_ADMIN) return;
  const x = id ? S.cdm[id] : { condoId };
  openSheet(id ? "Editar condómino" : "Novo condómino", `
    <p style="margin-top:0;color:var(--muted);font-size:14px">${esc(cName(x.condoId))}</p>
    <div class="grid2"><label class="f"><span>Fração</span><input id="k_fr" value="${esc(x.fracao)}" placeholder="Ex.: 1º Esq Frt"></label>
    <label class="f"><span>Telemóvel / telefone</span><input id="k_tel" type="tel" value="${esc(x.telefone)}"></label></div>
    <label class="f"><span>Nome *</span><input id="k_nome" value="${esc(x.nome)}"></label>
    <label class="f"><span>E-mail</span><input id="k_mail" type="email" value="${esc(x.email)}"></label>
    <label class="f"><span>Notas</span><textarea id="k_notas" placeholder="Proprietário / inquilino, melhor hora para contactar…">${esc(x.notas)}</textarea></label>
    <div class="actions">${id?`<button class="btn danger" onclick="armDelete(this,()=>{del('cdm','${id}');openCondo('${x.condoId}','cdm');toast('Condómino apagado.')})">Eliminar</button>`:""}<span class="sp"></span><button class="btn" onclick="openCondo('${x.condoId}','cdm')">Cancelar</button><button class="btn pri" onclick="saveCdm('${id||""}','${x.condoId}')">Guardar</button></div>`);
}
function saveCdm(id, condoId){
  const nome = val("k_nome"); if(!nome){ toast("Indique o nome."); return; }
  const x = { ...(id ? S.cdm[id] : {}), id: id || newId(), condoId, fracao: val("k_fr"), nome, telefone: val("k_tel"), email: val("k_mail"), notas: val("k_notas") };
  put("cdm", x); toast("Condómino guardado."); openCondo(condoId, "cdm");
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
    <label class="f"><span>Técnico responsável</span><select id="f_tec">${techOptions(p.tecnico)}</select></label>
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
  const p = {...(prev||{}), id: id || newId(), titulo, condoId, equipId, zona: val("f_zona"), tecnico: val("f_tec"), periodo, checklist: val("f_ck").split("\n").map(s=>s.trim()).filter(Boolean)};
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
  const cid = condoOf(o);
  openSheet(id ? "Editar ordem" : (IS_ADMIN ? "Nova ordem de trabalho" : "Novo trabalho"), `
    ${IS_ADMIN?"":'<p style="font-size:13px;color:var(--muted);margin-top:0">Para um trabalho feito sem ordem do escritório (manutenção, reparação, avaria encontrada no local). Depois de guardar, acrescente o material, as horas e as fotos e carregue em <b>Concluir</b>. O escritório é avisado.</p>'}
    <label class="f"><span>Título *</span><input id="f_tit" value="${esc(o.titulo)}" placeholder="Ex.: Manutenção geral, troca de lâmpadas no 3º"></label>
    ${condoPicker(cid, true)}
    <div class="grid2"><label class="f"><span>Equipamento (opcional)</span><select id="f_eq">${equipOptions(cid, o.equipId)}</select></label>
    <label class="f"><span>Zona / fração</span><input id="f_zona" value="${esc(o.zona)}" placeholder="Ex.: Hall do 3º esq., garagem -1"></label></div>
    ${IS_ADMIN?`<label class="f"><span>Atribuir a</span><select id="f_tec">${techOptions(o.tecnico)}</select></label>`:""}
    <div class="grid2"><label class="f"><span>Tipo</span><select id="f_tipo">${Object.entries(TIPOS_OT).map(([k,l])=>`<option value="${k}" ${o.tipo===k?"selected":""}>${l}</option>`).join("")}</select></label>
    <label class="f"><span>Prioridade</span><select id="f_pri">${Object.entries(PRIOR).map(([k,v])=>`<option value="${k}" ${k===o.prioridade?"selected":""}>${v[0]}</option>`).join("")}</select></label></div>
    <div class="grid2"><label class="f"><span>Data prevista</span><input type="date" id="f_data" value="${esc(o.data)}"></label>
    <label class="f"><span>Pedido por</span><input id="f_sol" value="${esc(o.solicitante)}" placeholder="Administração, condómino 2º dto…"></label></div>
    <label class="f"><span>Descrição da avaria / pedido</span><textarea id="f_desc">${esc(o.descricao)}</textarea></label>
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
  const tecnico = IS_ADMIN ? val("f_tec") : (prev ? prev.tecnico : ME);
  const o = {...(prev || {estado:"aberta", pecas:[], fotos:[], notas:"", tempo:0, criada: today(), criadaEm: nowIso(), criadoPor: ME}), id: id || newId(), titulo, condoId, equipId, tecnico, zona: val("f_zona"), tipo: val("f_tipo"), prioridade: val("f_pri"), data: val("f_data"), solicitante: val("f_sol"), descricao: val("f_desc"), checklist};
  if(tecnico && (!prev || prev.tecnico !== tecnico)){ o.atribuida = today(); o.atribuidaEm = nowIso(); o.atribuidoPor = ME; }
  put("ots", o);
  toast(IS_ADMIN && tecnico && (!prev || prev.tecnico !== tecnico) ? (tecnico === ME ? "Ordem guardada." : "Ordem atribuída a " + nm(tecnico) + " — vai receber notificação.") : "Ordem guardada.");
  openOt(o.id);
}
function updOt(id, patch, quiet){ const o = S.ots[id]; if(!o) return; return put("ots", {...o, ...patch}, quiet); }
function assignOt(id, tec){ updOt(id, {tecnico: tec, atribuida: tec ? today() : "", atribuidaEm: tec ? nowIso() : "", atribuidoPor: tec ? ME : ""}); toast(tec ? "Atribuída a " + nm(tec) + "." : "Ordem sem técnico atribuído."); }
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
function onTempo(id){ const h = parseInt(val("t_h"))||0, m = parseInt(val("t_m"))||0; const t = h*60+m; if(S.ots[id] && S.ots[id].tempo !== t) updOt(id, {tempo: t}, true); }

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
    ${can && !o.contactada ? `<button class="btn sm" style="margin-top:8px" onclick="setExt('${id}','contactada','${today()}')">📞 Contactei hoje</button>` : ""}
    ${o.concluida ? `<div style="margin-top:8px;font-size:14px">✅ Resolvida pela empresa em <b>${fmtDate(o.concluida)}</b>${dias !== null ? ` · ${dias} ${dias === 1 ? "dia" : "dias"} após o contacto` : ""}</div>` : ""}</div>`;
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
  readNotifsForOrder(id);
  const draw = () => {
    const o = S.ots[id]; if(!o) return "";
    const p = PRIOR[o.prioridade] || PRIOR.media; const ck = o.checklist || []; const done = ck.filter(c=>c.ok).length;
    const c = S.condos[condoOf(o)] || {};
    const locked = o.estado === "concluida";
    const mine = IS_ADMIN || o.tecnico === ME;
    const fotos = o.fotos || [];
    if(fotos.length) ensureUrls(fotos).then(ch => { if(ch && sheetRefresh) sheetRefresh(); });
    const maps = c.morada ? ` <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.morada)}" target="_blank" rel="noopener" style="color:var(--blue);font-size:13px">mapa ↗</a>` : "";
    return `<div class="seg" style="margin-bottom:12px">${Object.entries(ESTADOS).map(([k,l]) => k==="concluida"
        ? `<button class="${o.estado===k?"on":""}" onclick="${o.estado===k||!mine?"":`setEstado('${id}','concluida',true)`}">${l}</button>`
        : `<button class="${o.estado===k?"on":""}" onclick="setEstado('${id}','${k}')">${l}</button>`).join("")}</div>
      ${IS_ADMIN?`<div class="panel"><label class="f" style="margin:0"><span>${isExt(o) ? "Responsável" : "Atribuída a"}</span><select onchange="assignOt('${id}', this.value)">${techOptions(o.tecnico)}</select></label>
        ${o.tecnico && o.tecnico !== ME && !locked && phoneOf(o.tecnico) ? `<div style="margin-top:10px">${waBtn(phoneOf(o.tecnico), waOrdem(o), "Enviar também por WhatsApp")}</div>` : ""}</div>`:""}
      <div class="panel"><dl class="kv">
        <dt>Condomínio</dt><dd><a href="#" onclick="event.preventDefault();openCondo('${condoOf(o)}')" style="color:inherit">${esc(cName(condoOf(o)))}</a>${Object.values(S.cdm).some(x => x.condoId === condoOf(o)) ? ` <a href="#" onclick="event.preventDefault();openCondo('${condoOf(o)}','cdm')" style="color:var(--blue);font-size:13px;white-space:nowrap">👥 condóminos</a>` : ""}</dd>
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
      ${ck.length?`<div class="panel"><div style="display:flex;justify-content:space-between"><b>Checklist</b><span class="mono" style="color:var(--muted)">${done}/${ck.length}</span></div>
        <div class="progress"><i style="width:${done/ck.length*100}%"></i></div>
        ${ck.map((x,i)=>`<div class="chk ${x.ok?"ok":""}" onclick="toggleCk('${id}',${i})"><span class="box">${x.ok?"✓":""}</span><span class="lbl">${esc(x.t)}</span></div>`).join("")}</div>`:""}
      ${isExt(o) ? "" : `<div class="panel"><div style="display:flex;justify-content:space-between;align-items:center"><b>Fotografias</b>
        <label class="btn sm upl">📷 Adicionar<input type="file" accept="image/*" multiple onchange="addFotos('${id}', this)"></label></div>
        ${fotos.length ? `<div class="fotos">${fotos.map(ph => `<div class="ph" onclick="viewFoto('${esc(ph)}')">${URLS[ph]?`<img src="${esc(URLS[ph])}" alt="" loading="lazy">`:""}${mine?`<button onclick="event.stopPropagation();rmFoto('${id}','${esc(ph)}')" aria-label="Remover">✕</button>`:""}</div>`).join("")}</div>` : '<div style="color:var(--muted);font-size:14px;margin-top:4px">Sem fotografias. Tire fotos do antes e do depois.</div>'}</div>`}
      ${isExt(o) ? "" : `<div class="panel"><b>Peças / materiais usados</b>
        <div class="parts" style="margin-top:6px">${(o.pecas||[]).map((x,i)=>`<div class="part"><span class="n">${esc(x.n)}${x.c?` <span class="mono" style="color:var(--muted);font-size:12px">${esc(x.c)}</span>`:""}</span><span class="mono">× ${esc(x.q)}</span>${IS_ADMIN?`<input inputmode="decimal" title="Preço unitário" value="${unitPrice(x)!==null?String(unitPrice(x)).replace(".", ","):""}" placeholder="€/un" onchange="setPartPrice('${id}',${i},this.value)" style="width:70px;text-align:right;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff"><span class="mono" style="min-width:64px;text-align:right">${lineTotal(x)!==null?eur(lineTotal(x)):"—"}</span>`:""}<button class="btn sm" onclick="rmPart('${id}',${i})" aria-label="Remover">✕</button></div>`).join("") || '<span style="color:var(--muted);font-size:14px">Nenhuma peça registada.</span>'}${IS_ADMIN && (o.pecas||[]).length ? `<div class="part" style="border-top:1px solid var(--line);padding-top:6px;font-weight:600"><span class="n">Total materiais</span><span class="mono">${eur(partsTotal(o.pecas||[]))}</span></div>` : ""}</div>
        ${matList().length ? `<select id="p_sel" class="search" style="margin:8px 0 0" onchange="onPartSel(this.value)"><option value="">— Escolher material do armazém —</option>${matList().map(m => `<option value="${esc(m.codigo)}">${esc(m.nome)} · ${esc(m.codigo)}</option>`).join("")}<option value="__outro">Outro material (escrever)…</option></select>` : ""}
        <div class="addpart"><input id="p_nome" placeholder="Nome do material" style="${matList().length?"display:none":""}" onkeydown="if(event.key==='Enter')addPart('${id}')"><input id="p_qtd" type="number" min="0" step="any" placeholder="Qtd" onkeydown="if(event.key==='Enter')addPart('${id}')"><button class="btn sm" onclick="addPart('${id}')">Adicionar</button></div></div>
      <label class="panel" style="display:flex;gap:10px;align-items:center;cursor:pointer"><input type="checkbox" ${o.soMaterial===true?"checked":""} onchange="setSoMaterial('${id}', this.checked)" style="width:22px;height:22px;accent-color:var(--accent)"><span><b>Só entrega de material</b><br><span style="font-size:13px;color:var(--muted)">Marque quando só foi deixar material, sem fazer trabalho no local.</span></span></label>
      ${!("extra" in o) ? "" : `<div class="panel"><b>Manutenção extra</b>
        <div class="seg" style="margin-top:6px">${[["","Nenhuma"],["A","Manutenção A"],["E","Manutenção E"]].map(([k,l]) => `<button class="${(o.extra||"")===k?"on":""}" ${mine && !locked ? `onclick="setExtra('${id}','${k}')"` : "disabled"}>${l}${IS_ADMIN && k ? ` <span style="font-weight:400">${eur(extraVal(k))}</span>` : ""}</button>`).join("")}</div></div>`}
      <div class="panel"><b>Tempo gasto</b>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><input id="t_h" type="number" min="0" value="${Math.floor((o.tempo||0)/60)}" style="width:70px;border:1px solid var(--line);border-radius:10px;padding:8px" onchange="onTempo('${id}')"> h
        <input id="t_m" type="number" min="0" max="59" value="${(o.tempo||0)%60}" style="width:70px;border:1px solid var(--line);border-radius:10px;padding:8px" onchange="onTempo('${id}')"> min</div></div>
      ${IS_ADMIN ? (() => { const v = valores(o); return `<div class="panel" style="background:#fbf8f2"><b>Valores</b> <span style="font-size:12px;color:var(--muted)">(só administrativos)</span>
        <div class="parts" style="margin-top:6px">
          <div class="part"><span class="n">Materiais</span><span class="mono">${eur(v.mat)}</span></div>
          ${v.so ? `<div class="part"><span class="n" style="color:var(--muted)">Só entrega de material — sem deslocação nem mão de obra</span></div>` : `<div class="part"><span class="n">Mão de obra <span style="color:var(--muted);font-size:13px">${moTxt(o, v)}</span></span><span class="mono">${eur(v.mo)}</span></div>
          <div class="part"><span class="n">Deslocação <span style="color:var(--muted);font-size:13px">× ${eur(S.tarifas.deslocacao)}</span></span><input type="number" min="0" step="1" value="${v.nd}" onchange="setDesloc('${id}', this.value)" style="width:56px;text-align:center;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff"><span class="mono" style="min-width:70px;text-align:right">${eur(v.desl)}</span></div>`}
          ${v.ex ? `<div class="part"><span class="n">${EXTRAS[v.exTipo]}</span><span class="mono">${eur(v.ex)}</span></div>` : ""}
          <div class="part" style="border-top:1px solid var(--line);padding-top:6px;font-weight:700"><span class="n">Total</span><span class="mono">${eur(v.total)}</span></div>
        </div></div>`; })() : ""}`}
      <label class="f"><span>${isExt(o) ? "Ponto de situação / notas" : "Notas do técnico"}</span><textarea id="t_notas" oninput="onNotes('${id}',this.value)" placeholder="${isExt(o) ? "Ex.: liguei à empresa, técnico vem amanhã de manhã…" : "O que foi encontrado, o que foi feito, o que fica por fazer…"}">${esc(o.notas)}</textarea></label>
      ${!IS_ADMIN && locked ? (() => { const to = o.atribuidoPor || o.criadoPor; const tel = phoneOf(to); return tel && to !== ME ? `<div class="panel" style="background:var(--green-bg);border-color:#bfe0cb;font-size:14px">✅ Concluída. O escritório já recebeu uma notificação. ${waBtn(tel, waConcl(o), "Avisar também por WhatsApp")}</div>` : ""; })() : ""}
      <div class="actions">${canEditOt(o)?`<button class="btn" onclick="editOt('${id}')">Editar</button>`:""}<button class="btn" onclick="showReport('${id}')">Relatório</button>${(IS_ADMIN||locked) && !isExt(o)?`<button class="btn" onclick="printOt('${id}')">🖨️ Imprimir</button>`:""}<span class="sp"></span>
      ${mine && !locked ? `<button class="btn" onclick="saveClose('${id}')">💾 Guardar e sair</button>` : ""}
      ${!mine?"":locked?`<button class="btn" onclick="setEstado('${id}','curso')">Reabrir</button>`:`<button class="btn pri" id="btnConc" onclick="setEstado('${id}','concluida')">${isExt(o) ? "Resolvida pela empresa" : "Concluir ordem"}</button>`}</div>`;
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
  if(o.soMaterial === true) L.push("", "Só entrega de material.");
  if(o.extra && o.soMaterial !== true) L.push("", "Manutenção extra: " + EXTRAS[o.extra]);
  if(o.tempo) L.push("", "Tempo gasto: " + Math.floor(o.tempo/60) + " h " + (o.tempo%60) + " min");
  if(IS_ADMIN){ const v = valores(o); L.push("", "VALORES", "Materiais: " + eur(v.mat)); if(v.so) L.push("Só entrega de material — sem deslocação nem mão de obra", "TOTAL: " + eur(v.total)); else L.push("Mão de obra (" + moTxt(o, v) + "): " + eur(v.mo), "Deslocação (" + v.nd + " × " + eur(S.tarifas.deslocacao) + "): " + eur(v.desl), ...(v.ex ? [EXTRAS[v.exTipo] + ": " + eur(v.ex)] : []), "TOTAL: " + eur(v.total)); }
  if((o.fotos||[]).length) L.push("", "Fotografias registadas: " + o.fotos.length);
  if(o.notas) L.push("", "TRABALHO REALIZADO / NOTAS", o.notas);
  return L.join("\n");
}
function showReport(id){
  const txt = reportText(id);
  openSheet("Relatório", `<pre class="rep" id="rep">${esc(txt)}</pre>
    <div class="actions"><button class="btn" onclick="openOt('${id}')">Voltar</button><span class="sp"></span>${isExt(S.ots[id]) ? "" : `<button class="btn" onclick="printOt('${id}')">🖨️ Imprimir</button>`}${navigator.share?`<button class="btn" onclick="shareReport('${id}')">Partilhar</button>`:""}<button class="btn pri" onclick="copyText(${esc(JSON.stringify(txt))})">Copiar texto</button></div>
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
    <div class="hd"><div class="lg"><img src="logo.png" alt="FLAT Condomínios"><div><h1>Ficha de Acompanhamento de Avaria</h1><div>${esc(o.titulo)}</div></div></div>
      <div class="meta">Ordem nº <b>${esc(numOt(o) || "—")}</b><br>Estado: <b>${o.estado === "concluida" ? "Resolvida" : esc(ESTADOS[o.estado])}</b>${o.concluida?`<br>Resolvida: ${fmtDate(o.concluida)}`:""}</div></div>
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
    <div class="ft">Impresso em ${fmtDate(today())} · FLAT Condomínios — Gestão e Administração de Condomínios</div></div>`;
}
function reportHtml(o, withPhotos = true){
  if(isExt(o)) return extReportHtml(o, withPhotos);
  const e = S.equip[o.equipId]; const c = S.condos[condoOf(o)] || {};
  const fotos = o.fotos || [];
  const row = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : "";
  const ck = o.checklist || [], pc = o.pecas || [];
  const tempo = o.tempo ? `${Math.floor(o.tempo/60)} h ${o.tempo%60} min` : "";
  return `<div class="pr">
    <div class="hd"><div class="lg"><img src="logo.png" alt="FLAT Condomínios"><div><h1>Relatório de Intervenção</h1><div>${esc(o.titulo)}</div></div></div>
      <div class="meta">Ordem nº <b>${esc(numOt(o) || "—")}</b><br>Estado: <b>${esc(ESTADOS[o.estado])}</b>${o.concluida?`<br>Concluída: ${fmtDate(o.concluida)}`:""}</div></div>
    <h2>Condomínio</h2>
    <table class="prkv">${row("Condomínio", c.nome ? cLabel(c) : "—")}${row("Morada", c.morada)}${row("NIF", c.nif)}${row("Administração", c.admin)}</table>
    <h2>Intervenção</h2>
    <table class="prkv">${row("Tipo", TIPOS_OT[o.tipo]||o.tipo)}${row("Prioridade", (PRIOR[o.prioridade]||PRIOR.media)[0])}${row("Pedido por", o.solicitante)}
      ${row("Equipamento", e ? e.nome + (e.local ? " (" + e.local + ")" : "") + ([e.marca,e.modelo].filter(Boolean).length ? " — " + [e.marca,e.modelo].filter(Boolean).join(" ") : "") : "")}${row("Zona / fração", o.zona)}
      ${row("Técnico", o.tecnico ? nm(o.tecnico) : "")}${row("Data prevista", o.data ? fmtDate(o.data) : "")}${row("Data de conclusão", o.concluida ? fmtDate(o.concluida) : "")}${row("Tempo gasto", tempo)}${o.soMaterial===true?row("Observação", "Só entrega de material"):""}${o.extra && o.soMaterial!==true?row("Manutenção extra", EXTRAS[o.extra]):""}</table>
    ${o.descricao?`<h2>Descrição da avaria / pedido</h2><div class="txt">${esc(o.descricao)}</div>`:""}
    ${ck.length?`<h2>Verificações</h2><table>${ck.map(x => `<tr><td style="width:34px;text-align:center">${x.ok?"✔":"✘"}</td><td>${esc(x.t)}</td></tr>`).join("")}</table>`:""}
    ${pc.length ? (IS_ADMIN
      ? `<h2>Peças / materiais</h2><table><tr><th style="width:auto">Descrição</th><th style="width:130px">Código</th><th style="width:45px;text-align:right">Qtd</th><th style="width:80px;text-align:right">Preço un.</th><th style="width:85px;text-align:right">Total</th></tr>${pc.map(x => `<tr><td>${esc(x.n)}</td><td>${esc(x.c||"")}</td><td style="text-align:right">${esc(x.q)}</td><td style="text-align:right">${unitPrice(x)!==null?eur(unitPrice(x)):"—"}</td><td style="text-align:right">${lineTotal(x)!==null?eur(lineTotal(x)):"—"}</td></tr>`).join("")}<tr><th colspan="4" style="text-align:right;background:#eee">Total materiais</th><th style="text-align:right;background:#eee">${eur(partsTotal(pc))}</th></tr></table>`
      : `<h2>Peças / materiais</h2><table><tr><th style="width:auto">Descrição</th><th style="width:150px">Código</th><th style="width:60px">Qtd</th></tr>${pc.map(x => `<tr><td>${esc(x.n)}</td><td>${esc(x.c||"")}</td><td>${esc(x.q)}</td></tr>`).join("")}</table>`) : ""}
    ${IS_ADMIN ? (() => { const v = valores(o); return `<h2>Valores</h2><table>
      <tr><td>Materiais</td><td style="width:110px;text-align:right">${eur(v.mat)}</td></tr>
      ${v.so ? `<tr><td colspan="2">Só entrega de material — sem deslocação nem mão de obra</td></tr>` : `<tr><td>Mão de obra — ${moTxt(o, v)}</td><td style="text-align:right">${eur(v.mo)}</td></tr>
      <tr><td>Deslocação — ${v.nd} × ${eur(S.tarifas.deslocacao)}</td><td style="text-align:right">${eur(v.desl)}</td></tr>${v.ex ? `<tr><td>${EXTRAS[v.exTipo]}</td><td style="text-align:right">${eur(v.ex)}</td></tr>` : ""}`}
      <tr><th style="text-align:right">Total</th><th style="text-align:right">${eur(v.total)}</th></tr></table>`; })() : ""}
    <h2>Trabalho realizado / observações</h2><div class="txt">${esc(o.notas || "")}</div>
    ${fotos.length && withPhotos?`<h2>Fotografias</h2><div class="ph">${fotos.filter(p => URLS[p]).map(p => `<img src="${esc(URLS[p])}" alt="">`).join("")}</div>`:""}
    ${(() => { const sg = o.tecnico && (S.equipa[o.tecnico] || {}).assinatura; return `<div class="sig${sg ? " has" : ""}"><div>${sg ? `<img class="sgimg" src="${esc(sg)}" alt="">` : ""}<span>O Técnico${o.tecnico ? "<br>" + esc(nm(o.tecnico)) : ""}</span></div><div><span>O Responsável do Condomínio<br>&nbsp;</span></div></div>`; })()}
    <div class="ft">Impresso em ${fmtDate(today())} · FLAT Condomínios — Gestão e Administração de Condomínios</div></div>`;
}
async function printHtml(html){
  let pa = document.getElementById("printArea");
  if(!pa){ pa = document.createElement("div"); pa.id = "printArea"; document.body.appendChild(pa); }
  pa.innerHTML = html;
  const imgs = [...pa.querySelectorAll("img")];
  await Promise.race([
    Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))),
    new Promise(r => setTimeout(r, 12000)),
  ]);
  try{ window.print(); }catch(_){ toast("Este dispositivo não permite imprimir daqui. Use o computador."); }
}
async function printOt(id){
  const o = S.ots[id]; if(!o) return;
  if((o.fotos||[]).length){ toast("A preparar fotografias…"); try{ await ensureUrls(o.fotos); }catch(_){} }
  await printHtml(reportHtml(o));
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
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" id="b_btn" onclick="doBatchPrint()">🖨️ Imprimir</button></div>`);
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
    const matsTxt = arr => arr.map(x => `${String(x.q).replace(".", ",")}× ${esc(x.n)}`).join("<br>");
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
    parts.push(`<div class="pr sumpage"><div class="hd"><div class="lg"><img src="logo.png" alt="FLAT Condomínios"><div><h1>Resumo de intervenções</h1><div>${fmtDate(de)} a ${fmtDate(ate)}</div></div></div>
      <div class="meta">${list.length} ${list.length===1?"ordem concluída":"ordens concluídas"} · ${Math.floor(gMin/60)}h${pad(gMin%60)} · ${gDesl} desl.<br>Total: <b>${eur(grand)}</b></div></div>
      ${secs}
      <table style="margin-top:14px"><tr><th style="text-align:right">Total geral</th><th style="width:110px;text-align:right">${eur(grand)}</th></tr></table>
      <div class="ft">Impresso em ${fmtDate(today())} · FLAT Condomínios — Gestão e Administração de Condomínios</div></div>`);
  }
  if(withRep) for(const o of list) parts.push(reportHtml(o, withPh));
  btn.disabled = false; btn.textContent = "🖨️ Imprimir";
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
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" id="p_btn" onclick="doPendPrint()">🖨️ Imprimir</button></div>`);
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
    return `<div class="pr"><div class="hd"><div class="lg"><img src="logo.png" alt="FLAT Condomínios"><div><h1>Ordens por fechar</h1><div><b>${esc(t)}</b></div></div></div>
      <div class="meta">${os.length} ${os.length===1?"ordem":"ordens"}${curso?` · ${curso} em curso`:""}${urg?`<br><b>${urg} urgente${urg===1?"":"s"}</b>`:""}<br>Situação a ${fmtDate(today())}</div></div>
      ${semApp ? `<div style="font-size:9pt;color:#555;margin:0 0 6px">${semApp===os.length?"Ainda não atribuídas na app — responsável segundo o Gecond.":`${semApp} ainda não atribuída${semApp===1?"":"s"} na app (responsável segundo o Gecond).`}</div>` : ""}
      <table class="sm"><tr><th style="width:40px">Nº</th><th style="width:64px">Data</th><th style="width:36px;text-align:center">Dias</th><th style="width:auto">Condomínio</th><th style="width:auto">Trabalho</th><th style="width:52px">Estado</th><th style="width:44px">Gecond</th><th style="width:60px">Feito / obs.</th></tr>${rows}</table>
      <div class="ft">Impresso em ${fmtDate(today())} · FLAT Condomínios — Gestão e Administração de Condomínios</div></div>`;
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
  return `<h2>Stock <span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" onclick="stockExport()">⬇️ Excel</button></span></h2>
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
    <button class="btn" onclick="openMov('carga')">🚐 Carga p/ carrinha</button>
    <button class="btn" onclick="openMov('devolucao')">↩️ Devolução</button>
    <button class="btn" onclick="openMov('transferencia')">📦 Carregar Arm. C5 / ⇄ Transferência</button>
    <button class="btn" onclick="openMov('ajuste')">± Ajuste</button>
    <button class="btn" onclick="openSaidaDireta()">📦 Entrega de material</button>
  </div>
  ${baixos.length ? `<div class="note" style="background:var(--red-bg,#fdecea);color:var(--red,#b42318)">⚠️ <b>Repor no armazém:</b> ${baixos.map(a => `${esc(a.nome)} (${numTxt((Q.principal || {})[a.codigo] || 0)} / mín. ${numTxt(Number(a.minimo)||0)})`).join(" · ")}</div>` : ""}
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
function openTrabalho(cid){
  twLines = []; twFotos = [];
  const temExtra = !Object.keys(S.ots).length || Object.values(S.ots).some(o => "extra" in o);
  openSheet("Novo trabalho", `
    ${condoPicker(cid || "")}
    <label class="f"><span>O que foi feito *</span><input id="tw_tit" placeholder="Ex.: Manutenção geral, troca de lâmpadas no 3º"></label>
    <label class="f"><span>Zona / fração</span><input id="tw_zona" placeholder="Ex.: escadas, garagem -1, 2º esq."></label>
    <div class="panel"><b>Material usado</b><div id="tw_lines" class="parts" style="margin-top:6px"></div>
      ${matList().length ? `<select id="tw_sel" class="search" style="margin:8px 0 0" onchange="document.getElementById('tw_nome').style.display=this.value==='__outro'?'':'none'"><option value="">— Escolher material —</option>${matList().map(m => `<option value="${esc(m.codigo)}">${esc(m.nome)}</option>`).join("")}<option value="__outro">Outro material (escrever)…</option></select>` : ""}
      <div class="addpart"><input id="tw_nome" placeholder="Nome do material" style="${matList().length ? "display:none" : ""}"><input id="tw_qtd" type="number" min="0" step="any" placeholder="Qtd" onkeydown="if(event.key==='Enter')addTwLine()"><button class="btn sm" onclick="addTwLine()">Adicionar</button></div></div>
    <label class="panel" style="display:flex;gap:10px;align-items:center;cursor:pointer"><input type="checkbox" id="tw_so" style="width:22px;height:22px;accent-color:var(--accent)" onchange="document.getElementById('tw_tempo').style.display=this.checked?'none':''"><span><b>Só entrega de material</b><br><span style="font-size:13px;color:var(--muted)">Só deixou material, sem fazer trabalho.</span></span></label>
    <div id="tw_tempo">
      <div class="panel"><b>Tempo gasto</b><div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap"><span style="display:flex;gap:6px;align-items:center"><input id="tw_h" type="number" min="0" value="0" style="width:64px;border:1px solid var(--line);border-radius:10px;padding:8px"> h <input id="tw_m" type="number" min="0" max="59" step="5" value="0" style="width:64px;border:1px solid var(--line);border-radius:10px;padding:8px"> min</span>
        <span style="display:flex;gap:6px;align-items:center;margin-left:auto">Deslocações <input id="tw_d" type="number" min="0" value="1" style="width:56px;border:1px solid var(--line);border-radius:10px;padding:8px"></span></div></div>
      ${temExtra ? `<div class="panel"><b>Manutenção extra</b><div class="seg" id="tw_extra" style="margin-top:6px">${[["","Nenhuma"],["A","Manutenção A"],["E","Manutenção E"]].map(([k,l]) => `<button type="button" data-k="${k}" class="${k===""?"on":""}" onclick="[...this.parentNode.children].forEach(b=>b.classList.toggle('on', b===this))">${l}</button>`).join("")}</div></div>` : ""}
    </div>
    <label class="f"><span>Notas</span><textarea id="tw_notas" placeholder="Detalhes do que foi feito, o que fica por fazer…"></textarea></label>
    <div class="panel"><b>Fotografias</b> <span id="tw_nf" style="color:var(--muted);font-size:13px"></span><div style="margin-top:6px"><label class="btn sm" style="cursor:pointer">📷 Juntar fotos<input type="file" accept="image/*" multiple style="display:none" onchange="twFotos.push(...this.files);this.value='';document.getElementById('tw_nf').textContent=twFotos.length+' foto(s)'"></label></div></div>
    <div class="actions" style="flex-wrap:wrap"><button class="btn" onclick="closeSheet()">Cancelar</button><span class="sp"></span><button class="btn" onclick="saveTrabalho(false)">💾 Guardar e acabar depois</button><button class="btn pri" onclick="saveTrabalho(true)">✅ Concluir trabalho</button></div>`);
  drawTwLines();
}
function drawTwLines(){ const el = $("#tw_lines"); if(!el) return; el.innerHTML = twLines.map((x, i) => `<div class="part"><span class="n">${esc(x.n)}</span><span class="mono">× ${numTxt(x.q)}</span><button class="btn sm" onclick="twLines.splice(${i},1);drawTwLines()">✕</button></div>`).join(""); }
function addTwLine(){
  const sel = val("tw_sel"); const q = parseFloat(String(val("tw_qtd")).replace(",", ".")) || 1;
  if(sel && sel !== "__outro"){ const m = S.mat[sel]; if(m) twLines.push({ c: m.codigo, n: m.nome, q }); }
  else { const n = val("tw_nome"); if(!n){ toast("Escolha o material."); return; } twLines.push({ n, q }); $("#tw_nome").value = ""; }
  if($("#tw_sel")) $("#tw_sel").value = ""; if($("#tw_nome") && matList().length) $("#tw_nome").style.display = "none"; $("#tw_qtd").value = ""; drawTwLines();
}
async function saveTrabalho(concluir){
  const cid = val("f_condo"), tit = val("tw_tit");
  if(!cid || !tit){ toast("Escolha o prédio e escreva o que foi feito."); return; }
  if(val("tw_qtd") || (val("tw_sel") && val("tw_sel") !== "__outro") || val("tw_nome")) addTwLine();
  const so = !!($("#tw_so") || {}).checked;
  const tempo = so ? 0 : (parseInt(val("tw_h")) || 0) * 60 + (parseInt(val("tw_m")) || 0);
  if(concluir && !so && !tempo && !twLines.length){ toast("Indique o tempo gasto ou o material usado."); return; }
  const exBtn = document.querySelector("#tw_extra button.on"); const extra = so || !exBtn ? "" : exBtn.dataset.k;
  const t = today(), now = nowIso();
  const o = { id: newId(), titulo: tit, condoId: cid, equipId: "", zona: val("tw_zona"), tecnico: ME, tipo: "corretiva", prioridade: "media", estado: concluir ? "concluida" : "curso",
    data: t, descricao: "", solicitante: "", checklist: [], pecas: twLines.slice(), fotos: [], notas: val("tw_notas"), tempo,
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
function openSaidaDireta(){
  movLines = [];
  openSheet("Entrega de material", `
    ${condoPicker("")}
    <div class="panel"><b>Material</b><div id="mv_lines" class="parts" style="margin-top:6px"></div>
      <div class="addpart" style="flex-wrap:wrap"><select id="mv_art" style="flex:1 1 100%;margin-bottom:6px;border:1px solid var(--line);border-radius:10px;padding:8px;background:#fff">${stkArtigos().map(a => `<option value="${esc(a.codigo)}">${esc(a.nome)} · ${esc(a.codigo)}</option>`).join("")}</select>
      <input id="mv_qtd" type="number" min="0" step="any" placeholder="Qtd" onkeydown="if(event.key==='Enter')addMovLine('saida')"><button class="btn sm" onclick="addMovLine('saida')">Adicionar</button></div></div>
    <div class="grid2"><label class="f"><span>Data</span><input type="date" id="mv_data" value="${today()}"></label>
    <label class="f"><span>Quem levou *</span><input id="mv_quem" placeholder="Nome de quem levantou o material"></label></div>
    <label class="f"><span>Observações</span><input id="mv_obs" placeholder="Opcional"></label>
    ${VE_STOCK() ? `<div class="note" style="font-size:13px">Para material levantado no escritório. Sai do <b>armazém principal</b> e fica registada uma ordem concluída de <b>entrega de material</b> neste prédio, que entra nos relatórios e no resumo semanal só com o valor do material (sem horas nem deslocação).</div>` : ""}
    <div class="actions"><span class="sp"></span><button class="btn" onclick="closeSheet()">Cancelar</button><button class="btn pri" onclick="saveSaidaDireta()">Registar saída</button></div>`);
  drawMovLines();
}
async function saveSaidaDireta(){
  const cid = val("f_condo"); if(!cid){ toast("Escolha o prédio."); return; }
  if(val("mv_qtd")) addMovLine("saida");
  if(!movLines.length){ toast("Acrescente pelo menos um artigo."); return; }
  if(!val("mv_quem")){ toast("Indique quem levou o material."); $("#mv_quem").focus(); return; }
  const d = val("mv_data") || today(); const obs = val("mv_obs");
  const pecas = movLines.map(x => ({ c: x.c, n: (S.mat[x.c] || {}).nome || x.c, q: x.q }));
  const o = { id: newId(), titulo: "Entrega de material", condoId: cid, equipId: "", zona: "", tecnico: ME, tipo: "corretiva", prioridade: "media", estado: "concluida",
    data: d, descricao: "Material levantado no escritório por " + val("mv_quem") + "." + (obs ? "\n" + obs : ""), solicitante: val("mv_quem"), checklist: [], pecas, fotos: [], notas: obs, tempo: 0,
    deslocacoes: 0, soMaterial: true, criada: today(), criadaEm: nowIso(), criadoPor: ME, atribuida: today(), atribuidaEm: nowIso(), atribuidoPor: ME,
    concluida: d, concluidaEm: nowIso(), concluidoPor: ME };
  put("ots", o);
  closeSheet(); toast("Saída registada — " + pecas.map(p => p.q + "× " + p.n).join(", ") + " para " + cName(cid) + ".");
  if(VE_STOCK()) setTimeout(() => stockChanged(), 1500);
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
    <div class="actions"><button class="btn" onclick="closeSheet();openMov('compra','${esc(c)}')">+ Compra</button><button class="btn" onclick="closeSheet();openMov('carga','${esc(c)}')">🚐 Carga</button><span class="sp"></span><button class="btn pri" onclick="saveStockArt('${esc(c)}')">Guardar</button></div>
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
Object.defineProperty(window, 'stkLoc', { get: () => stkLoc, set: v => { stkLoc = v; } }); for(const [k, g, st] of [['otOrig', () => otOrig, v => { otOrig = v; }], ['condoPend', () => condoPend, v => { condoPend = v; }], ['listMax', () => listMax, v => { listMax = v; }], ['prevF', () => prevF, v => { prevF = v; }], ['prevTec', () => prevTec, v => { prevTec = v; }], ['prevQ', () => prevQ, v => { prevQ = v; }], ['prevOpen', () => prevOpen, v => { prevOpen = v; }]]) Object.defineProperty(window, k, { get: g, set: st });
Object.defineProperty(window, 'stkTipo', { get: () => stkTipo, set: v => { stkTipo = v; } }); Object.defineProperty(window, 'stkPer', { get: () => stkPer, set: v => { stkPer = v; } }); Object.defineProperty(window, 'stkMovF', { get: () => stkMovF, set: v => { stkMovF = v; } }); Object.defineProperty(window, 'movLines', { get: () => movLines }); Object.defineProperty(window, 'twLines', { get: () => twLines }); Object.defineProperty(window, 'twFotos', { get: () => twFotos });
Object.assign(window, { go, render, renderListOnly, openSheet, closeSheet, armDelete, filterCondoSel, onCondoChange,
  doLogin, logout, enablePush, openPerfil, savePerfil, changePw, newUser, createUser, openPessoa, savePessoa, resetPw, setAtivo, copyText,
  exportJSON, exportCSV, openNotifs, editCondo, saveCondo, delCondo, openCondo, editEquip, saveEquip, delEquip, openEquip,
  editPlan, savePlan, openPlan, genFromPlan, editOt, saveOt, assignOt, setEstado, toggleCk, addPart, rmPart, onNotes, onTempo,
  addFotos, rmFoto, viewFoto, openOt, showReport, shareReport, printOt, del, toast, onPartSel, addMat, rmMat, setPreco, setPartPrice, setTarifa, setDesloc, setSoMaterial, editCdm, saveCdm, openBatchPrint, doBatchPrint, setWeek, batchCount, openPendPrint, doPendPrint, pendCount, setExt, saveClose, openTrabalho, addTwLine, drawTwLines, saveTrabalho, openSaidaDireta, saveSaidaDireta, openMeteo, loadMeteo, backupCompleto, prevToggle, genPlans, grpToggle, assignMany, setExtra, setTarTec, openMov, addMovLine, saveMov, drawMovLines, delMov, setCarTec, openStockArt, saveStockArt, stockExport, sigClear, sigSave, sigRemove });
Object.defineProperty(window, "otFilter", { get: () => otFilter, set: v => { otFilter = v; } });
Object.defineProperty(window, "condoF", { get: () => condoF, set: v => { condoF = v; } });
Object.defineProperty(window, "techF", { get: () => techF, set: v => { techF = v; } });
Object.defineProperty(window, "q", { get: () => q, set: v => { q = v; } });

start();
