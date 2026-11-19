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
const TIPOS_OT = {corretiva:"Corretiva / avaria", preventiva:"Preventiva", inspecao:"Inspeção / ronda", pedido:"Pedido de condómino"};
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
  ordens: ["id","titulo","condoId","equipId","zona","tecnico","tipo","prioridade","estado","data","solicitante","descricao","checklist","pecas","fotos","notas","tempo","planId","criada","criadaEm","criadoPor","atribuida","atribuidaEm","atribuidoPor","concluida","concluidaEm","concluidoPor","deslocacoes","soMaterial"],
};
const NULLABLE = new Set(["equipId","tecnico","planId","data","inicio","ultima","criada","criadaEm","criadoPor","atribuida","atribuidaEm","atribuidoPor","concluida","concluidaEm","concluidoPor"]);
const snake = k => k.replace(/[A-Z]/g, m => "_" + m.toLowerCase());
const camel = k => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function toRow(table, o){ const r = {}; for(const k of COLS[table]){ if(!(k in o)) continue; let v = o[k]; if(NULLABLE.has(k) && (v === "" || v === undefined)) v = null; if(k === "periodo" || k === "tempo") v = Number(v) || 0; if(k === "deslocacoes") v = (v === "" || v === undefined) ? 1 : (Number(v) || 0); if(k === "soMaterial") v = v === true; r[snake(k)] = v; } return r; }
function fromRow(r){ const o = {}; for(const k in r){ const v = r[k]; o[camel(k)] = v === null ? "" : v; } return o; }

/* ---------- estado ---------- */
const S = { cdm:{}, condos:{}, equip:{}, plans:{}, ots:{}, equipa:{}, notifs:[], mat:{}, precos:{}, tarifas:{ deslocacao: 0, hora: 0 } };
let ME = null, IS_ADMIN = false, mode = "loading";
const chains = {};

async function put(col, obj, quiet){
  S[col][obj.id] = obj; if(!quiet) render();
  const table = TABLES[col]; const key = col + "/" + obj.id;
  const row = toRow(table, obj);
  chains[key] = (chains[key] || Promise.resolve()).then(async () => {
    const { error } = await sb.from(table).upsert(row);
    if(error){ writeErr(error); await reloadRow(col, obj.id); }
    else if(col === "ots") flushPush();
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
async function start(){
  if(!configured){ mode = "config"; render(); return; }
  if("serviceWorker" in navigator){
    try{
      const reg = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
      reg.update().catch(() => {});
      document.addEventListener("visibilitychange", () => { if(document.visibilityState === "visible") reg.update().catch(() => {}); });
      // Quando chega uma versão nova da aplicação, recarrega uma vez para a usar
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if(reloaded || !navigator.serviceWorker.controller) return; reloaded = true; if(!$("#scrim").classList.contains("open")) location.reload(); });
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
    if(tf) S.tarifas = { deslocacao: Number(tf.deslocacao) || 0, hora: Number(tf.hora) || 0 };
  }
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
  ch.on("postgres_changes", { event: "*", schema: "public", table: "materiais" }, p => {
    if(p.eventType === "DELETE"){ if(p.old && p.old.codigo) delete S.mat[p.old.codigo]; } else S.mat[p.new.codigo] = p.new;
    render();
  });
  ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "notificacoes", filter: `user_id=eq.${ME}` }, p => {
    const n = fromRow(p.new); S.notifs.unshift(n);
    if(sheetRefresh && document.visibilityState === "visible" && $("#sheet .top h4") && S.ots[n.ordemId] && $("#sheet .top h4").textContent === S.ots[n.ordemId].titulo) setTimeout(() => readNotifsForOrder(n.ordemId), 500);
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
function valores(o){
  const mat = r2(partsTotal(o.pecas || []));
  const horas = (Number(o.tempo) || 0) / 60;
  const so = o.soMaterial === true;
  const mo = so ? 0 : r2(horas * S.tarifas.hora);
  const nd = so ? 0 : nDesloc(o); const desl = r2(nd * S.tarifas.deslocacao);
  return { mat, mo, nd, desl, so, total: r2(mat + mo + desl) };
}
const fmtTempo = t => `${Math.floor((t||0)/60)} h ${pad((t||0)%60)} min`;
const canEditOt = o => IS_ADMIN || o.criadoPor === ME;

/* ---------- WhatsApp ---------- */
const APP_URL = location.origin + location.pathname;
function waNum(t){ let d = String(t||"").replace(/\D/g, ""); if(d.startsWith("00")) d = d.slice(2); if(d.length === 9) d = "351" + d; return d; }
const waLink = (tel, text) => `https://wa.me/${waNum(tel)}?text=${encodeURIComponent(text)}`;
function waOrdem(o){
  const c = S.condos[condoOf(o)] || {};
  return [`🔧 Nova ordem de trabalho`, `*${o.titulo}*`, c.nome ? cLabel(c) : "", c.morada || "", whereTxt(o), `Prioridade: ${(PRIOR[o.prioridade]||PRIOR.media)[0]} · Prevista: ${fmtDate(o.data)}`, o.descricao ? "\n" + o.descricao : "", `\nAbrir: ${APP_URL}?ordem=${o.id}`].filter(Boolean).join("\n");
}
function waConcl(o){ return [`✅ Ordem concluída`, `*${o.titulo}*`, cName(condoOf(o)), o.notas ? "\n" + o.notas : "", `\nVer: ${APP_URL}?ordem=${o.id}`].filter(Boolean).join("\n"); }
const waBtn = (tel, text, label) => `<a class="btn wa" href="${esc(waLink(tel, text))}" target="_blank" rel="noopener">📲 ${esc(label)}</a>`;

/* ---------- navegação ---------- */
let tab = "inicio", otFilter = "ativas", condoF = "", techF = "", q = "";
const ICONS = {
  inicio:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  ordens:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
  prev:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/></svg>',
  condos:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M2 21h20M8 8h3M8 12h3M8 16h3"/></svg>',
  equipa:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>'
};
const tabsFor = () => IS_ADMIN
  ? [["inicio","Início"],["ordens","Ordens"],["prev","Preventiva"],["condos","Condomínios"],["equipa","Equipa"]]
  : [["inicio","Hoje"],["ordens","As minhas"],["condos","Condomínios"]];
function go(t){ tab = t; q = ""; render(); window.scrollTo(0,0); }
function renderNav(){
  if(mode !== "ok"){ $("#nav").innerHTML = ""; return; }
  $("#nav").innerHTML = tabsFor().map(([k,l]) => `<button class="${tab===k?"on":""}" onclick="go('${k}')">${ICONS[k]}${esc(l)}</button>`).join("");
}
function renderWho(){
  const el = $("#who");
  if(mode !== "ok"){ el.innerHTML = ""; document.title = "Manutenção"; return; }
  const nu = S.notifs.filter(n => !n.lida).length;
  document.title = (nu ? "(" + nu + ") " : "") + "Manutenção";
  try{ if(navigator.setAppBadge) nu ? navigator.setAppBadge(nu) : navigator.clearAppBadge(); }catch(e){}
  el.innerHTML = `<button class="bell" onclick="openNotifs()" aria-label="Notificações">🔔${nu?`<i>${nu>99?"99+":nu}</i>`:""}</button><span class="who-n" onclick="openPerfil()" style="cursor:pointer"></span><span class="badge ${IS_ADMIN?"b-amber":"b-blue"}" onclick="openPerfil()" style="cursor:pointer">${IS_ADMIN?"Administrativo":"Técnico"}</span>`;
  el.querySelector(".who-n").textContent = (S.equipa[ME] || {}).nome || "";
}

/* ---------- itens de lista ---------- */
function otItem(o, hideCondo){
  const p = PRIOR[o.prioridade] || PRIOR.media;
  const late = o.estado !== "concluida" && o.data && o.data < today();
  const ck = o.checklist || []; const done = ck.filter(c => c.ok).length;
  const est = o.estado === "concluida" ? '<span class="badge b-green">Concluída</span>' : o.estado === "curso" ? '<span class="badge b-blue">Em curso</span>' : '<span class="badge">Aberta</span>';
  const sub = [hideCondo ? "" : cName(condoOf(o)), whereTxt(o)].filter(Boolean).join(" · ");
  const who = IS_ADMIN ? `<div class="s">👷 <span class="${o.tecnico?"":"warnTxt"}">${esc(nm(o.tecnico))}</span></div>` : "";
  const nf = (o.fotos||[]).length;
  return `<div class="item" onclick="openOt('${o.id}')"><div class="bar ${o.estado==="concluida"?"green":p[2]}"></div>
    <div class="main"><div class="t">${esc(o.titulo)}</div><div class="s">${esc(sub)}</div>${who}
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
const techFilterSel = () => IS_ADMIN ? `<select class="search" onchange="techF=this.value;render()"><option value="">Todos os técnicos</option><option value="-" ${techF==="-"?"selected":""}>Por atribuir</option>${tecnicos().map(t=>`<option value="${t.id}" ${t.id===techF?"selected":""}>${esc(t.nome)}${t.papel==="admin"?" (administrativo)":""}</option>`).join("")}</select>` : "";
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
    return `<h2>Olá${first?", "+esc(first):""} <span class="mono" style="font-size:14px;color:var(--muted)">${fmtDate(t)}</span></h2>${pushBanner()}
    <div class="stats">
      ${statCard(hoje.length, "Para hoje / em atraso", "otFilter='ativas';go('ordens')", true)}
      ${statCard(mine.filter(o=>o.estado==="curso").length, "Em curso", "otFilter='curso';go('ordens')")}
      ${statCard(prox.length, "Próximos dias", "otFilter='ativas';go('ordens')")}
      ${statCard(mes, "Concluídas este mês", "otFilter='concluida';go('ordens')")}
    </div>
    <h3>Para hoje e em atraso</h3>
    <div class="list">${hoje.length ? hoje.map(o=>otItem(o)).join("") : emptyBox("Não tem ordens para hoje. 👍")}</div>
    ${prox.length?`<h3>Próximas</h3><div class="list">${prox.slice(0,10).map(o=>otItem(o)).join("")}</div>`:""}
    <div class="actions" style="margin-top:18px"><button class="btn dark" onclick="editOt()">+ Registar ocorrência</button></div>`;
  }
  const ots = Object.values(S.ots);
  const porAtribuir = sortOts(ots.filter(o => o.estado !== "concluida" && !o.tecnico));
  const plans = Object.values(S.plans);
  const atrasadas = plans.filter(p => planStatus(p)[3] < 0).length;
  const late = sortOts(ots.filter(o => o.estado !== "concluida" && o.tecnico && o.data && o.data < t));
  const due = plans.filter(p => planStatus(p)[3] <= 7 && !openOtForPlan(p.id)).sort((a,b) => planNext(a).localeCompare(planNext(b)));
  const tecs = tecnicos().filter(x => x.papel === "tec");
  return `<h2>Painel <span class="mono" style="font-size:14px;color:var(--muted)">${fmtDate(t)}</span></h2>${pushBanner()}
  <div class="stats">
    ${statCard(porAtribuir.length, "Por atribuir", "techF='-';otFilter='ativas';go('ordens')", true)}
    ${statCard(ots.filter(o=>o.estado==="aberta").length, "Ordens abertas", "techF='';otFilter='aberta';go('ordens')")}
    ${statCard(ots.filter(o=>o.estado==="curso").length, "Em curso", "techF='';otFilter='curso';go('ordens')")}
    ${statCard(atrasadas, "Preventivas em atraso", "go('prev')", true)}
  </div>
  ${porAtribuir.length?`<h3>Por atribuir</h3><div class="list">${porAtribuir.map(o=>otItem(o)).join("")}</div>`:""}
  <h3>Técnicos</h3>
  ${tecs.length ? `<div class="list">${tecs.map(x => {
      const mine = ots.filter(o => o.tecnico === x.id);
      const pend = mine.filter(o => o.estado !== "concluida"); const lt = pend.filter(o => o.data && o.data < t).length;
      const curso = mine.filter(o => o.estado === "curso").length;
      return `<div class="item" onclick="techF='${x.id}';otFilter='ativas';go('ordens')"><div class="bar ${lt?"red":pend.length?"amber":"green"}"></div><div class="main"><div class="t">${esc(x.nome)}</div><div class="s">${pend.length} pendente${pend.length===1?"":"s"} · ${curso} em curso</div></div><div class="r">${lt?`<span class="badge b-red">${lt} em atraso</span>`:""}</div></div>`;
    }).join("")}</div>` : emptyBox("Ainda não há técnicos. Crie as contas no separador <b>Equipa</b>.", `<button class="btn pri" onclick="go('equipa')">Ir para Equipa</button>`)}
  ${late.length?`<h3>Em atraso</h3><div class="list">${late.map(o=>otItem(o)).join("")}</div>`:""}
  ${due.length?`<h3>Preventivas a lançar</h3><div class="list">${due.map(p => `<div class="item"><div class="bar ${planStatus(p)[2]}"></div><div class="main" onclick="openPlan('${p.id}')"><div class="t">${esc(p.titulo)}</div><div class="s">${esc(cName(condoOf(p)))} · ${fmtDate(planNext(p))}${p.tecnico?" · 👷 "+esc(nm(p.tecnico)):""}</div></div><div class="r"><button class="btn sm pri" onclick="genFromPlan('${p.id}')">Criar ordem</button></div></div>`).join("")}</div>`:""}
  <div class="actions" style="margin-top:18px"><button class="btn dark" onclick="editOt()">+ Nova ordem de trabalho</button></div>`;
}

function viewOrdens(){
  const f = {ativas:o=>o.estado!=="concluida", aberta:o=>o.estado==="aberta", curso:o=>o.estado==="curso", concluida:o=>o.estado==="concluida", todas:()=>true}[otFilter] || (()=>true);
  const tf = !IS_ADMIN || !techF ? () => true : techF === "-" ? o => !o.tecnico : o => o.tecnico === techF;
  const list = otsSorted().filter(f).filter(tf).filter(o => !condoF || condoOf(o) === condoF).filter(o => !q || hit([o.titulo, cName(condoOf(o)), whereTxt(o), o.solicitante, IS_ADMIN ? nm(o.tecnico) : ""].join(" "), q));
  const chips = [["ativas","Pendentes"],["aberta","Abertas"],["curso","Em curso"],["concluida","Concluídas"],["todas","Todas"]];
  const any = myOts().length;
  return `<h2>${IS_ADMIN?"Ordens de trabalho":"As minhas ordens"} <button class="btn pri sm" onclick="editOt()">+ ${IS_ADMIN?"Nova":"Ocorrência"}</button></h2>
  <div class="chips">${chips.map(([k,l])=>`<button class="chip ${otFilter===k?"on":""}" onclick="otFilter='${k}';render()">${l}</button>`).join("")}</div>
  ${techFilterSel()}${condoFilterSel()}
  <input class="search" placeholder="Procurar por título, condomínio, zona…" value="${esc(q)}" oninput="q=this.value;renderListOnly()">
  <div class="list" id="lst">${list.length ? list.map(o=>otItem(o, !!condoF)).join("") : emptyBox(any?"Nenhuma ordem corresponde ao filtro.":(IS_ADMIN?"Ainda não há ordens de trabalho.":"Ainda não tem ordens atribuídas."))}</div>`;
}

function viewPrev(){
  const list = Object.values(S.plans).filter(p => !condoF || condoOf(p) === condoF).sort((a,b) => planNext(a).localeCompare(planNext(b)));
  return `<h2>Manutenção preventiva <button class="btn pri sm" onclick="editPlan()">+ Novo plano</button></h2>
  ${condoFilterSel()}
  <div class="list">${list.length ? list.map(p=>planItem(p, !!condoF)).join("") : emptyBox("Crie planos periódicos — ex.: ronda mensal às áreas comuns, verificação trimestral do hidropressor — com um técnico responsável. Quando estiverem a vencer, aparecem no Painel para criar a ordem com um toque.", '<button class="btn pri" onclick="editPlan()">+ Criar plano</button>')}</div>`;
}

function viewCondos(){
  const list = condosSorted().filter(c => !q || hit([c.codigo,c.nome,c.morada,c.admin,c.nif].join(" "), q));
  const mine = myOts();
  return `<h2>Condomínios <span class="mono" style="font-size:14px;color:var(--muted);margin-right:auto;margin-left:8px">${Object.keys(S.condos).length}</span>${IS_ADMIN?'<button class="btn pri sm" onclick="editCondo()">+ Novo</button>':""}</h2>
  <input class="search" placeholder="Procurar por código, nome, morada ou NIF…" value="${esc(q)}" oninput="q=this.value;renderListOnly()">
  <div class="list" id="lst">${list.length ? list.map(c => {
    const pend = mine.filter(o => condoOf(o) === c.id && o.estado !== "concluida").length;
    const late = IS_ADMIN ? Object.values(S.plans).filter(p => condoOf(p) === c.id && planStatus(p)[3] < 0).length : 0;
    const neq = Object.values(S.equip).filter(e => e.condoId === c.id).length;
    return `<div class="item" onclick="openCondo('${c.id}')"><div class="bar ${late?"red":pend?"amber":""}"></div><div class="main"><div class="t">${c.codigo?`<span class="mono" style="color:var(--accent);margin-right:6px">${esc(c.codigo)}</span>`:""}${esc(c.nome)}</div><div class="s">${esc(c.morada||"")}</div>${neq?`<div class="s">${neq} equipamento${neq===1?"":"s"}</div>`:""}</div>
      <div class="r">${pend?`<span class="badge b-amber">${pend} pendente${pend>1?"s":""}</span>`:""}${late?`<span class="badge b-red">${late} prev. atrasada${late>1?"s":""}</span>`:""}</div></div>`;
  }).join("") : emptyBox(Object.keys(S.condos).length ? "Nenhum condomínio encontrado." : "Ainda não há condomínios. Execute o ficheiro 02_condominios.sql no Supabase (ver GUIA.md).")}</div>`;
}

function viewEquipa(){
  const all = pessoas(); const ots = Object.values(S.ots); const t = today();
  return `<h2>Equipa <button class="btn pri sm" onclick="newUser()">+ Novo utilizador</button></h2>
  <div class="list">${all.map(x => {
    const mine = ots.filter(o => o.tecnico === x.id);
    const pend = mine.filter(o => o.estado !== "concluida").length;
    const mes = mine.filter(o => o.estado === "concluida" && (o.concluida||"").slice(0,7) === t.slice(0,7)).length;
    return `<div class="item" onclick="openPessoa('${x.id}')" style="${x.ativo?"":"opacity:.55"}"><div class="bar ${x.papel==="admin"?"amber":"blue"}"></div><div class="main"><div class="t">${esc(x.nome)}${x.id===ME?" (eu)":""}${x.ativo?"":' <span class="badge">Desativado</span>'}</div><div class="s">${x.papel==="admin"?"Administrativo":"Técnico"} · ${esc(x.email||"")}</div><div class="s">📱 ${x.telefone?esc(x.telefone):'<span class="warnTxt">sem número</span>'}</div>${x.papel==="tec"?`<div class="s">${pend} pendente${pend===1?"":"s"} · ${mes} concluída${mes===1?"":"s"} este mês</div>`:""}</div></div>`;
  }).join("")}</div>
  <h3>Tarifas</h3>
  <div class="panel"><div class="grid2">
    <label class="f" style="margin:0"><span>Deslocação (€ por deslocação)</span><input inputmode="decimal" value="${String(S.tarifas.deslocacao).replace(".", ",")}" onchange="setTarifa('deslocacao', this.value)"></label>
    <label class="f" style="margin:0"><span>Mão de obra (€ por hora)</span><input inputmode="decimal" value="${String(S.tarifas.hora).replace(".", ",")}" onchange="setTarifa('hora', this.value)"></label>
  </div></div>
  <h3>Materiais do armazém <span class="mono" style="font-weight:500">${matList().length}</span></h3>
  <div class="panel">
    <div style="font-size:13px;color:var(--muted);margin-bottom:6px">Preço unitário de cada material (só os administrativos veem). Usado na impressão das ordens.</div>
    <div class="parts">${matList().map(m => `<div class="part"><span class="n">${esc(m.nome)} <span class="mono" style="color:var(--muted);font-size:12px">${esc(m.codigo)}</span></span><input inputmode="decimal" value="${S.precos[m.codigo] !== undefined ? String(S.precos[m.codigo]).replace(".", ",") : ""}" placeholder="0,00" onchange="setPreco('${esc(m.codigo)}', this.value)" style="width:84px;text-align:right;border:1px solid var(--line);border-radius:8px;padding:6px 8px;background:#fff"> €<button class="btn sm" onclick="rmMat('${esc(m.codigo)}')" aria-label="Retirar">✕</button></div>`).join("") || '<span style="color:var(--muted)">Sem materiais.</span>'}</div>
    <div class="addpart" style="margin-top:10px"><input id="m_cod" placeholder="Código (ex.: LAMP-E27)" style="flex:0 0 38%;text-transform:uppercase"><input id="m_nome" placeholder="Descrição (ex.: Lâmpada E27)" style="flex:1"><button class="btn sm" onclick="addMat()">Adicionar</button></div>
  </div>
  <h3>Dados</h3>
  <div class="panel" style="font-size:14px">O plano gratuito do Supabase não faz cópias de segurança. Exporte os dados de vez em quando (por exemplo, uma vez por mês) e guarde o ficheiro.
  <div class="actions" style="margin-top:10px"><button class="btn" onclick="exportJSON()">Exportar tudo (JSON)</button><button class="btn" onclick="exportCSV()">Exportar ordens (Excel/CSV)</button></div></div>`;
}

function render(){
  renderNav(); renderWho();
  if(mode === "login"){ $("#app").innerHTML = viewLogin(); return; }
  if(mode !== "ok"){ $("#app").innerHTML = viewEstado(); return; }
  if(!IS_ADMIN && (tab === "prev" || tab === "equipa")) tab = "inicio";
  const v = {inicio:viewInicio, ordens:viewOrdens, prev:viewPrev, condos:viewCondos, equipa:viewEquipa}[tab];
  const active = document.activeElement && document.activeElement.tagName === "INPUT" && document.activeElement.classList.contains("search");
  $("#app").innerHTML = v();
  if(active){ const s = $("input.search"); if(s){ s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  if(sheetRefresh) sheetRefresh();
}
function renderListOnly(){
  const tmp = document.createElement("div");
  tmp.innerHTML = (tab === "ordens" ? viewOrdens() : viewCondos());
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
const techOptions = sel => `<option value="">— Por atribuir —</option>` + tecnicos().map(t => `<option value="${t.id}" ${t.id===sel?"selected":""}>${esc(t.nome)}${t.papel==="admin"?" (administrativo)":""}</option>`).join("") + (sel && !(S.equipa[sel] && S.equipa[sel].ativo) ? `<option value="${esc(sel)}" selected>${esc(nm(sel))}</option>` : "");
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
    <h3>Palavra-passe</h3>
    <label class="f"><span>Nova palavra-passe</span><input id="p_pw" type="password" autocomplete="new-password" placeholder="Pelo menos 6 caracteres"></label>
    <div class="actions"><span class="sp"></span><button class="btn" onclick="changePw()">Mudar palavra-passe</button></div>
    <h3>Sessão</h3>
    <div class="actions"><span style="font-size:13px;color:var(--muted)">${esc(me.email||"")}</span><span class="sp"></span><button class="btn danger" onclick="logout()">Terminar sessão</button></div>`);
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
    <h3>Acesso</h3>
    <div class="panel" style="font-size:14px">E-mail de entrada: <b>${esc(x.email||"")}</b>
      <div class="actions" style="margin-top:10px"><button class="btn" onclick="resetPw('${id}')">Repor palavra-passe</button>
      ${self?"":`<button class="btn ${x.ativo?"danger":""}" data-label="${x.ativo?"Desativar conta":"Reativar conta"}" onclick="armDelete(this,()=>setAtivo('${id}',${!x.ativo}))">${x.ativo?"Desativar conta":"Reativar conta"}</button>`}</div></div>`);
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
  const row = { id: 1, ...S.tarifas, [k]: n };
  const { error } = await sb.from("tarifas").upsert(row);
  if(error) return writeErr(error);
  S.tarifas = { deslocacao: row.deslocacao, hora: row.hora }; toast("Tarifa guardada: " + eur(n));
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
function exportJSON(){
  const data = { exportado_em: nowIso(), condominios: Object.values(S.condos), equipamentos: Object.values(S.equip), planos: Object.values(S.plans), ordens: Object.values(S.ots), equipa: Object.values(S.equipa).map(({id,nome,email,telefone,papel,ativo}) => ({id,nome,email,telefone,papel,ativo})) };
  download(`manutencao-${today()}.json`, JSON.stringify(data, null, 1), "application/json");
}
function exportCSV(){
  const head = ["Título","Código","Condomínio","Morada","Equipamento","Zona","Técnico","Tipo","Prioridade","Estado","Prevista","Concluída","Pedido por","Descrição","Peças","Tempo (min)","Materiais (€)","Mão de obra (€)","Deslocações","Deslocação (€)","Total (€)","Notas"];
  const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = sortOts(Object.values(S.ots)).map(o => { const c = S.condos[condoOf(o)] || {}; return [o.titulo, c.codigo, c.nome, c.morada, eqName(o.equipId), o.zona, nm(o.tecnico), TIPOS_OT[o.tipo]||o.tipo, (PRIOR[o.prioridade]||PRIOR.media)[0], ESTADOS[o.estado], fmtDate(o.data), o.concluida?fmtDate(o.concluida):"", o.solicitante, o.descricao, (o.pecas||[]).map(p => partLabel(p) + " x" + p.q).join("; "), o.tempo, ...(v => [v.mat, v.mo, v.nd, v.desl, v.total].map((x, k) => k === 2 ? x : x.toFixed(2).replace(".", ",")))(valores(o)), o.notas].map(cell).join(";"); });
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
        ${x.telefone?`<div class="s mono">${esc(x.telefone)}</div>`:""}${x.email?`<div class="s">${esc(x.email)}</div>`:""}${x.notas?`<div class="s" style="white-space:pre-wrap">${esc(x.notas)}</div>`:""}
        <div class="actions" style="margin-top:6px" onclick="event.stopPropagation()">${x.telefone?`<a class="btn sm" href="tel:${esc(String(x.telefone).replace(/[^0-9+]/g, ""))}">📞 Ligar</a>${waNum(x.telefone).length >= 11 ? `<a class="btn sm wa" href="https://wa.me/${waNum(x.telefone)}" target="_blank" rel="noopener">WhatsApp</a>` : ""}`:""}${x.email?`<a class="btn sm" href="mailto:${esc(x.email)}">✉️ E-mail</a>`:""}</div>
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
      <div class="actions" style="margin-bottom:14px">${IS_ADMIN?`<button class="btn" onclick="editCondo('${id}')">Editar</button>`:""}<span class="sp"></span><button class="btn dark" onclick="editOt(null,'${id}')">+ ${IS_ADMIN?"Nova ordem":"Ocorrência"}</button></div>
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
  openSheet(id ? "Editar ordem" : (IS_ADMIN ? "Nova ordem de trabalho" : "Registar ocorrência"), `
    ${IS_ADMIN?"":'<p style="font-size:13px;color:var(--muted);margin-top:0">Use para registar um problema que encontrou no local. A ordem fica atribuída a si e o escritório é avisado.</p>'}
    <label class="f"><span>Título *</span><input id="f_tit" value="${esc(o.titulo)}" placeholder="Ex.: Lâmpada fundida no patamar do 3º"></label>
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
      const max = 1600; let { width: w, height: h } = img; const k = Math.min(1, max / Math.max(w, h)); w = Math.round(w*k); h = Math.round(h*k);
      const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(u); c.toBlob(b => b ? res(b) : rej(new Error("imagem")), "image/jpeg", 0.75);
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
      ${IS_ADMIN?`<div class="panel"><label class="f" style="margin:0"><span>Técnico atribuído</span><select onchange="assignOt('${id}', this.value)">${techOptions(o.tecnico)}</select></label>
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
      ${ck.length?`<div class="panel"><div style="display:flex;justify-content:space-between"><b>Checklist</b><span class="mono" style="color:var(--muted)">${done}/${ck.length}</span></div>
        <div class="progress"><i style="width:${done/ck.length*100}%"></i></div>
        ${ck.map((x,i)=>`<div class="chk ${x.ok?"ok":""}" onclick="toggleCk('${id}',${i})"><span class="box">${x.ok?"✓":""}</span><span class="lbl">${esc(x.t)}</span></div>`).join("")}</div>`:""}
      <div class="panel"><div style="display:flex;justify-content:space-between;align-items:center"><b>Fotografias</b>
        <label class="btn sm upl">📷 Adicionar<input type="file" accept="image/*" multiple onchange="addFotos('${id}', this)"></label></div>
        ${fotos.length ? `<div class="fotos">${fotos.map(ph => `<div class="ph" onclick="viewFoto('${esc(ph)}')">${URLS[ph]?`<img src="${esc(URLS[ph])}" alt="" loading="lazy">`:""}${mine?`<button onclick="event.stopPropagation();rmFoto('${id}','${esc(ph)}')" aria-label="Remover">✕</button>`:""}</div>`).join("")}</div>` : '<div style="color:var(--muted);font-size:14px;margin-top:4px">Sem fotografias. Tire fotos do antes e do depois.</div>'}</div>
      <div class="panel"><b>Peças / materiais usados</b>
        <div class="parts" style="margin-top:6px">${(o.pecas||[]).map((x,i)=>`<div class="part"><span class="n">${esc(x.n)}${x.c?` <span class="mono" style="color:var(--muted);font-size:12px">${esc(x.c)}</span>`:""}</span><span class="mono">× ${esc(x.q)}</span>${IS_ADMIN?`<input inputmode="decimal" title="Preço unitário" value="${unitPrice(x)!==null?String(unitPrice(x)).replace(".", ","):""}" placeholder="€/un" onchange="setPartPrice('${id}',${i},this.value)" style="width:70px;text-align:right;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff"><span class="mono" style="min-width:64px;text-align:right">${lineTotal(x)!==null?eur(lineTotal(x)):"—"}</span>`:""}<button class="btn sm" onclick="rmPart('${id}',${i})" aria-label="Remover">✕</button></div>`).join("") || '<span style="color:var(--muted);font-size:14px">Nenhuma peça registada.</span>'}${IS_ADMIN && (o.pecas||[]).length ? `<div class="part" style="border-top:1px solid var(--line);padding-top:6px;font-weight:600"><span class="n">Total materiais</span><span class="mono">${eur(partsTotal(o.pecas||[]))}</span></div>` : ""}</div>
        ${matList().length ? `<select id="p_sel" class="search" style="margin:8px 0 0" onchange="onPartSel(this.value)"><option value="">— Escolher material do armazém —</option>${matList().map(m => `<option value="${esc(m.codigo)}">${esc(m.nome)} · ${esc(m.codigo)}</option>`).join("")}<option value="__outro">Outro material (escrever)…</option></select>` : ""}
        <div class="addpart"><input id="p_nome" placeholder="Nome do material" style="${matList().length?"display:none":""}" onkeydown="if(event.key==='Enter')addPart('${id}')"><input id="p_qtd" type="number" min="0" step="any" placeholder="Qtd" onkeydown="if(event.key==='Enter')addPart('${id}')"><button class="btn sm" onclick="addPart('${id}')">Adicionar</button></div></div>
      <label class="panel" style="display:flex;gap:10px;align-items:center;cursor:pointer"><input type="checkbox" ${o.soMaterial===true?"checked":""} onchange="setSoMaterial('${id}', this.checked)" style="width:22px;height:22px;accent-color:var(--accent)"><span><b>Só entrega de material</b><br><span style="font-size:13px;color:var(--muted)">Marque quando só foi deixar material, sem fazer trabalho no local.</span></span></label>
      <div class="panel"><b>Tempo gasto</b>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px"><input id="t_h" type="number" min="0" value="${Math.floor((o.tempo||0)/60)}" style="width:70px;border:1px solid var(--line);border-radius:10px;padding:8px" onchange="onTempo('${id}')"> h
        <input id="t_m" type="number" min="0" max="59" value="${(o.tempo||0)%60}" style="width:70px;border:1px solid var(--line);border-radius:10px;padding:8px" onchange="onTempo('${id}')"> min</div></div>
      ${IS_ADMIN ? (() => { const v = valores(o); return `<div class="panel" style="background:#fbf8f2"><b>Valores</b> <span style="font-size:12px;color:var(--muted)">(só administrativos)</span>
        <div class="parts" style="margin-top:6px">
          <div class="part"><span class="n">Materiais</span><span class="mono">${eur(v.mat)}</span></div>
          ${v.so ? `<div class="part"><span class="n" style="color:var(--muted)">Só entrega de material — sem deslocação nem mão de obra</span></div>` : `<div class="part"><span class="n">Mão de obra <span style="color:var(--muted);font-size:13px">${fmtTempo(o.tempo)} × ${eur(S.tarifas.hora)}/h</span></span><span class="mono">${eur(v.mo)}</span></div>
          <div class="part"><span class="n">Deslocação <span style="color:var(--muted);font-size:13px">× ${eur(S.tarifas.deslocacao)}</span></span><input type="number" min="0" step="1" value="${v.nd}" onchange="setDesloc('${id}', this.value)" style="width:56px;text-align:center;border:1px solid var(--line);border-radius:8px;padding:6px;background:#fff"><span class="mono" style="min-width:70px;text-align:right">${eur(v.desl)}</span></div>`}
          <div class="part" style="border-top:1px solid var(--line);padding-top:6px;font-weight:700"><span class="n">Total</span><span class="mono">${eur(v.total)}</span></div>
        </div></div>`; })() : ""}
      <label class="f"><span>Notas do técnico</span><textarea id="t_notas" oninput="onNotes('${id}',this.value)" placeholder="O que foi encontrado, o que foi feito, o que fica por fazer…">${esc(o.notas)}</textarea></label>
      ${!IS_ADMIN && locked ? (() => { const to = o.atribuidoPor || o.criadoPor; const tel = phoneOf(to); return tel && to !== ME ? `<div class="panel" style="background:var(--green-bg);border-color:#bfe0cb;font-size:14px">✅ Concluída. O escritório já recebeu uma notificação. ${waBtn(tel, waConcl(o), "Avisar também por WhatsApp")}</div>` : ""; })() : ""}
      <div class="actions">${canEditOt(o)?`<button class="btn" onclick="editOt('${id}')">Editar</button>`:""}<button class="btn" onclick="showReport('${id}')">Relatório</button>${IS_ADMIN||locked?`<button class="btn" onclick="printOt('${id}')">🖨️ Imprimir</button>`:""}<span class="sp"></span>
      ${!mine?"":locked?`<button class="btn" onclick="setEstado('${id}','curso')">Reabrir</button>`:`<button class="btn pri" id="btnConc" onclick="setEstado('${id}','concluida')">Concluir ordem</button>`}</div>`;
  };
  openSheet(esc(S.ots[id].titulo), draw(), () => {
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
  L.push("", "Ordem: " + o.titulo, "Estado: " + ESTADOS[o.estado], "Tipo: " + (TIPOS_OT[o.tipo]||o.tipo) + "   Prioridade: " + (PRIOR[o.prioridade]||PRIOR.media)[0]);
  if(o.solicitante) L.push("Pedido por: " + o.solicitante);
  if(o.tecnico) L.push("Técnico: " + nm(o.tecnico));
  L.push("Data prevista: " + fmtDate(o.data) + (o.concluida ? "   Concluída: " + fmtDate(o.concluida) : ""));
  if(e || o.zona){ L.push(""); if(e) L.push("Equipamento: " + e.nome + (e.local ? " (" + e.local + ")" : "") + ([e.marca,e.modelo].filter(Boolean).length ? " — " + [e.marca,e.modelo].filter(Boolean).join(" ") : "")); if(o.zona) L.push("Zona: " + o.zona); }
  if(o.descricao) L.push("", "DESCRIÇÃO", o.descricao);
  if((o.checklist||[]).length){ L.push("", "VERIFICAÇÕES"); o.checklist.forEach(x => L.push((x.ok ? "[x] " : "[ ] ") + x.t)); }
  if((o.pecas||[]).length){ L.push("", "PEÇAS / MATERIAIS"); o.pecas.forEach(x => L.push("- " + partLabel(x) + " × " + x.q + (IS_ADMIN && lineTotal(x) !== null ? "  " + eur(unitPrice(x)) + "/un = " + eur(lineTotal(x)) : ""))); if(IS_ADMIN) L.push("Total materiais: " + eur(partsTotal(o.pecas))); }
  if(o.soMaterial === true) L.push("", "Só entrega de material.");
  if(o.tempo) L.push("", "Tempo gasto: " + Math.floor(o.tempo/60) + " h " + (o.tempo%60) + " min");
  if(IS_ADMIN){ const v = valores(o); L.push("", "VALORES", "Materiais: " + eur(v.mat)); if(v.so) L.push("Só entrega de material — sem deslocação nem mão de obra", "TOTAL: " + eur(v.total)); else L.push("Mão de obra (" + fmtTempo(o.tempo) + " × " + eur(S.tarifas.hora) + "/h): " + eur(v.mo), "Deslocação (" + v.nd + " × " + eur(S.tarifas.deslocacao) + "): " + eur(v.desl), "TOTAL: " + eur(v.total)); }
  if((o.fotos||[]).length) L.push("", "Fotografias registadas: " + o.fotos.length);
  if(o.notas) L.push("", "TRABALHO REALIZADO / NOTAS", o.notas);
  return L.join("\n");
}
function showReport(id){
  const txt = reportText(id);
  openSheet("Relatório", `<pre class="rep" id="rep">${esc(txt)}</pre>
    <div class="actions"><button class="btn" onclick="openOt('${id}')">Voltar</button><span class="sp"></span><button class="btn" onclick="printOt('${id}')">🖨️ Imprimir</button>${navigator.share?`<button class="btn" onclick="shareReport('${id}')">Partilhar</button>`:""}<button class="btn pri" onclick="copyText(${esc(JSON.stringify(txt))})">Copiar texto</button></div>
    <p style="font-size:13px;color:var(--muted)">Copie ou partilhe para um e-mail ou mensagem para a administração do condomínio.</p>`);
}
function shareReport(id){ navigator.share({ title: "Relatório — " + S.ots[id].titulo, text: reportText(id) }).catch(() => {}); }

/* ---------- impressão (folha A4) ---------- */
async function printOt(id){
  const o = S.ots[id]; if(!o) return;
  const e = S.equip[o.equipId]; const c = S.condos[condoOf(o)] || {};
  const fotos = o.fotos || [];
  if(fotos.length){ toast("A preparar fotografias…"); try{ await ensureUrls(fotos); }catch(_){} }
  const row = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : "";
  const ck = o.checklist || [], pc = o.pecas || [];
  const tempo = o.tempo ? `${Math.floor(o.tempo/60)} h ${o.tempo%60} min` : "";
  const html = `<div class="pr">
    <div class="hd"><div><h1>Relatório de Intervenção</h1><div>${esc(o.titulo)}</div></div>
      <div class="meta">Ordem nº <b>${esc(o.id.toUpperCase())}</b><br>Estado: <b>${esc(ESTADOS[o.estado])}</b>${o.concluida?`<br>Concluída: ${fmtDate(o.concluida)}`:""}</div></div>
    <h2>Condomínio</h2>
    <table class="prkv">${row("Condomínio", c.nome ? cLabel(c) : "—")}${row("Morada", c.morada)}${row("NIF", c.nif)}${row("Administração", c.admin)}</table>
    <h2>Intervenção</h2>
    <table class="prkv">${row("Tipo", TIPOS_OT[o.tipo]||o.tipo)}${row("Prioridade", (PRIOR[o.prioridade]||PRIOR.media)[0])}${row("Pedido por", o.solicitante)}
      ${row("Equipamento", e ? e.nome + (e.local ? " (" + e.local + ")" : "") + ([e.marca,e.modelo].filter(Boolean).length ? " — " + [e.marca,e.modelo].filter(Boolean).join(" ") : "") : "")}${row("Zona / fração", o.zona)}
      ${row("Técnico", o.tecnico ? nm(o.tecnico) : "")}${row("Data prevista", o.data ? fmtDate(o.data) : "")}${row("Data de conclusão", o.concluida ? fmtDate(o.concluida) : "")}${row("Tempo gasto", tempo)}${o.soMaterial===true?row("Observação", "Só entrega de material"):""}</table>
    ${o.descricao?`<h2>Descrição da avaria / pedido</h2><div class="txt">${esc(o.descricao)}</div>`:""}
    ${ck.length?`<h2>Verificações</h2><table>${ck.map(x => `<tr><td style="width:34px;text-align:center">${x.ok?"✔":"✘"}</td><td>${esc(x.t)}</td></tr>`).join("")}</table>`:""}
    ${pc.length ? (IS_ADMIN
      ? `<h2>Peças / materiais</h2><table><tr><th style="width:auto">Descrição</th><th style="width:130px">Código</th><th style="width:45px;text-align:right">Qtd</th><th style="width:80px;text-align:right">Preço un.</th><th style="width:85px;text-align:right">Total</th></tr>${pc.map(x => `<tr><td>${esc(x.n)}</td><td>${esc(x.c||"")}</td><td style="text-align:right">${esc(x.q)}</td><td style="text-align:right">${unitPrice(x)!==null?eur(unitPrice(x)):"—"}</td><td style="text-align:right">${lineTotal(x)!==null?eur(lineTotal(x)):"—"}</td></tr>`).join("")}<tr><th colspan="4" style="text-align:right;background:#eee">Total materiais</th><th style="text-align:right;background:#eee">${eur(partsTotal(pc))}</th></tr></table>`
      : `<h2>Peças / materiais</h2><table><tr><th style="width:auto">Descrição</th><th style="width:150px">Código</th><th style="width:60px">Qtd</th></tr>${pc.map(x => `<tr><td>${esc(x.n)}</td><td>${esc(x.c||"")}</td><td>${esc(x.q)}</td></tr>`).join("")}</table>`) : ""}
    ${IS_ADMIN ? (() => { const v = valores(o); return `<h2>Valores</h2><table>
      <tr><td>Materiais</td><td style="width:110px;text-align:right">${eur(v.mat)}</td></tr>
      ${v.so ? `<tr><td colspan="2">Só entrega de material — sem deslocação nem mão de obra</td></tr>` : `<tr><td>Mão de obra — ${fmtTempo(o.tempo)} × ${eur(S.tarifas.hora)}/hora</td><td style="text-align:right">${eur(v.mo)}</td></tr>
      <tr><td>Deslocação — ${v.nd} × ${eur(S.tarifas.deslocacao)}</td><td style="text-align:right">${eur(v.desl)}</td></tr>`}
      <tr><th style="text-align:right">Total</th><th style="text-align:right">${eur(v.total)}</th></tr></table>`; })() : ""}
    <h2>Trabalho realizado / observações</h2><div class="txt">${esc(o.notas || "")}</div>
    ${fotos.length?`<h2>Fotografias</h2><div class="ph">${fotos.filter(p => URLS[p]).map(p => `<img src="${esc(URLS[p])}" alt="">`).join("")}</div>`:""}
    <div class="sig"><div>O Técnico${o.tecnico ? "<br>" + esc(nm(o.tecnico)) : ""}</div><div>O Responsável do Condomínio</div></div>
    <div class="ft">Impresso em ${fmtDate(today())} · Manutenção de Condomínios</div></div>`;
  let pa = document.getElementById("printArea");
  if(!pa){ pa = document.createElement("div"); pa.id = "printArea"; document.body.appendChild(pa); }
  pa.innerHTML = html;
  const imgs = [...pa.querySelectorAll("img")];
  await Promise.race([
    Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))),
    new Promise(r => setTimeout(r, 6000)),
  ]);
  try{ window.print(); }catch(_){ toast("Este dispositivo não permite imprimir daqui. Use o computador."); }
}

/* ---------- expor funções usadas no HTML ---------- */
Object.assign(window, { go, render, renderListOnly, openSheet, closeSheet, armDelete, filterCondoSel, onCondoChange,
  doLogin, logout, enablePush, openPerfil, savePerfil, changePw, newUser, createUser, openPessoa, savePessoa, resetPw, setAtivo, copyText,
  exportJSON, exportCSV, openNotifs, editCondo, saveCondo, delCondo, openCondo, editEquip, saveEquip, delEquip, openEquip,
  editPlan, savePlan, openPlan, genFromPlan, editOt, saveOt, assignOt, setEstado, toggleCk, addPart, rmPart, onNotes, onTempo,
  addFotos, rmFoto, viewFoto, openOt, showReport, shareReport, printOt, del, toast, onPartSel, addMat, rmMat, setPreco, setPartPrice, setTarifa, setDesloc, setSoMaterial, editCdm, saveCdm });
Object.defineProperty(window, "otFilter", { get: () => otFilter, set: v => { otFilter = v; } });
Object.defineProperty(window, "condoF", { get: () => condoF, set: v => { condoF = v; } });
Object.defineProperty(window, "techF", { get: () => techF, set: v => { techF = v; } });
Object.defineProperty(window, "q", { get: () => q, set: v => { q = v; } });

start();
