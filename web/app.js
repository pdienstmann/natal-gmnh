// Escala HE Natal 2026 — front-end
// Em produção a Vercel redireciona /api/* para o Worker (ver vercel.json).
// Para testar local: abra index.html?api=http://localhost:8787
const API = new URLSearchParams(location.search).get("api") || "";
const POLL_MS = 5000;

const WD = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WD_FULL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

const state = {
  dias: [],
  hoje: "",
  horarios: {},
  prazo: 5, // dias antes da HE em que o GM ainda pode cancelar
  selected: new Map(), // data -> código do horário
  mine: load("he-mine", {}), // { [id]: token }
  admin: loadSession("he-admin", ""),
  busy: false,
};

const $ = (s) => document.querySelector(s);
const nomeEl = $("#nome");
const matEl = $("#matricula");

// ---------- armazenamento local (tolerante a falhas) ----------
function load(k, fallback) {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
}
function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
}
function loadSession(k, fallback) {
  try { return sessionStorage.getItem(k) || fallback; } catch { return fallback; }
}
function saveSession(k, v) {
  try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch {}
}

const me = load("he-me", { nome: "", matricula: "" });
nomeEl.value = me.nome;
matEl.value = me.matricula;
for (const el of [nomeEl, matEl]) {
  el.addEventListener("input", () => {
    el.classList.remove("invalid");
    save("he-me", { nome: nomeEl.value.trim(), matricula: matEl.value.trim() });
    render();
  });
}

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(API + path, { ...opts, headers });
  const isJson = res.headers.get("content-type")?.includes("json");
  const data = isJson ? await res.json() : await res.blob();
  if (!res.ok) throw new Error((isJson && data.erro) || `Erro ${res.status}`);
  return data;
}

async function refresh() {
  try {
    const data = await api("/api/dias");
    state.dias = data.dias;
    state.hoje = data.hoje;
    state.horarios = data.horarios || {};
    if (Number.isInteger(data.prazoCancelamentoDias)) state.prazo = data.prazoCancelamentoDias;
    // tira da seleção o que lotou/passou enquanto a pessoa escolhia
    for (const d of [...state.selected.keys()]) {
      const dia = state.dias.find((x) => x.data === d);
      if (!dia || !canPick(dia)) state.selected.delete(d);
    }
    setStatus(`Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · atualiza automaticamente`);
    render();
  } catch (e) {
    setStatus("Sem conexão com a escala. Tentando de novo…", true);
  }
}

function setStatus(msg, err = false) {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("error", err);
}

// ---------- regras ----------
const myMat = () => matEl.value.trim().replace(/\s+/g, "").toUpperCase();
const isMine = (p) => Boolean(state.mine[p.id]) || (myMat() && p.matricula === myMat());
const amIn = (dia) => dia.inscritos.some(isMine);
const isPast = (dia) => state.hoje && dia.data < state.hoje;
const isFull = (dia) => dia.inscritos.length >= dia.capacidade;
const canPick = (dia) => !isPast(dia) && !isFull(dia) && !amIn(dia);

function parse(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
// último dia em que o GM pode cancelar a própria inscrição
const limiteCancelamento = (iso) => { const d = parse(iso); d.setUTCDate(d.getUTCDate() - state.prazo); return d.toISOString().slice(0, 10); };
const podeCancelar = (iso) => state.hoje && state.hoje <= limiteCancelamento(iso);
const fmt = (iso) => { const [, m, d] = iso.split("-"); return `${d}/${m}`; };
const hLabel = (code) => { const h = state.horarios[code]; return h ? `${h.inicio}–${h.fim}` : code; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- render ----------
function render() {
  // agrupa por semana (segunda a domingo)
  const weeks = [];
  for (const dia of state.dias) {
    const dt = parse(dia.data);
    const monday = new Date(dt);
    monday.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    let w = weeks.find((x) => x.key === key);
    if (!w) weeks.push((w = { key, dias: [] }));
    w.dias.push(dia);
  }

  $("#weeks").innerHTML = weeks
    .map((w, i) => {
      const first = w.dias[0].data, last = w.dias[w.dias.length - 1].data;
      const vagas = w.dias.reduce((s, d) => s + Math.max(0, d.capacidade - d.inscritos.length), 0);
      return `<section class="week">
        <h3>Semana ${i + 1} <small>${fmt(first)} a ${fmt(last)} · ${vagas} vaga${vagas === 1 ? "" : "s"} livre${vagas === 1 ? "" : "s"}</small></h3>
        <div class="days">${w.dias.map(dayCard).join("")}</div>
      </section>`;
    })
    .join("");

  const n = state.selected.size;
  $("#cart").hidden = n === 0;
  $("#cart-text").innerHTML = n
    ? `<strong>${n}</strong> dia${n > 1 ? "s" : ""} selecionado${n > 1 ? "s" : ""}: ${[...state.selected].sort().map(([d, h]) => `${fmt(d)} (${hLabel(h)})`).join(", ")}`
    : "";
}

function dayCard(dia) {
  const dt = parse(dia.data);
  const wd = dt.getUTCDay();
  const weekend = wd === 0 || wd === 5 || wd === 6;
  const total = dia.inscritos.length;
  const full = isFull(dia), past = isPast(dia), mineIn = amIn(dia);
  const sel = state.selected.has(dia.data);

  const lines = [];
  for (let i = 0; i < dia.capacidade; i++) {
    const p = dia.inscritos[i];
    if (!p) {
      const livres = dia.capacidade - i;
      if (i - total < 2 || livres === 1) { lines.push(`<li class="free">vaga livre</li>`); continue; }
      lines.push(`<li class="free more">+ ${livres} vagas livres</li>`);
      break;
    }
    const mine = isMine(p);
    let acao = "";
    if (!past && state.admin) acao = `<button class="rm" data-rm="${p.id}" data-date="${dia.data}">${state.mine[p.id] ? "cancelar" : "remover"}</button>`;
    else if (!past && state.mine[p.id]) {
      acao = podeCancelar(dia.data)
        ? `<button class="rm" data-rm="${p.id}" data-date="${dia.data}" title="Pode cancelar até ${fmt(limiteCancelamento(dia.data))}">cancelar</button>`
        : `<span class="lock" title="Cancelamento só até ${fmt(limiteCancelamento(dia.data))}. Fale com a coordenação.">🔒 prazo encerrado</span>`;
    }
    lines.push(`<li class="${mine ? "mine" : ""}">
      <span class="who">${esc(p.nome)} <span class="mat">· ${esc(p.matricula)}</span></span>
      <span class="badge h-${esc(p.horario)}">${esc(hLabel(p.horario))}</span>
      ${acao}
    </li>`);
  }

  let btn;
  if (past) btn = `<button class="pick" disabled>Encerrado</button>`;
  else if (mineIn) btn = `<button class="pick in" disabled>✓ Você está na escala</button>`;
  else if (full) btn = `<button class="pick" disabled>Lotado</button>`;
  else {
    const escolhido = state.selected.get(dia.data);
    btn = `<p class="pick-label">${sel ? "✓ Selecionado — toque de novo para desmarcar" : "Escolha o horário:"}</p>
      <div class="shifts">${Object.entries(state.horarios)
        .map(([code, h]) => `<button class="shift ${escolhido === code ? "on" : ""}" data-pick="${dia.data}" data-h="${code}" aria-pressed="${escolhido === code}">
            <b>${h.inicio}–${h.fim}</b><small>${h.tipo} · ${h.horas}h</small></button>`)
        .join("")}</div>`;
  }

  const porHorario = Object.keys(state.horarios)
    .map((code) => [code, dia.inscritos.filter((p) => p.horario === code).length])
    .filter(([, n]) => n > 0)
    .map(([code, n]) => `${hLabel(code)}: <b>${n}</b>`)
    .join(" · ");

  return `<article class="day ${weekend ? "weekend" : ""} ${sel ? "selected" : ""} ${full ? "full" : ""} ${past ? "closed" : ""}">
    <div class="day-head">
      <div><span class="wd">${WD_FULL[wd]}</span><br><span class="date">${WD[wd]} ${fmt(dia.data)}</span></div>
      <span class="count">${total}/${dia.capacidade}</span>
    </div>
    <div class="bar"><div style="width:${Math.min(100, (total / dia.capacidade) * 100)}%"></div></div>
    ${porHorario ? `<div class="split">${porHorario}</div>` : ""}
    <ol class="slots">${lines.join("")}</ol>
    <div class="day-foot">${btn}</div>
  </article>`;
}

// ---------- ações ----------
$("#weeks").addEventListener("click", async (ev) => {
  const pick = ev.target.closest("[data-pick]");
  if (pick) {
    const d = pick.dataset.pick, h = pick.dataset.h;
    state.selected.get(d) === h ? state.selected.delete(d) : state.selected.set(d, h);
    render();
    return;
  }
  const rm = ev.target.closest("[data-rm]");
  if (rm) {
    const id = rm.dataset.rm;
    const aviso = state.admin ? "" : "\n\nA vaga será liberada para outro colega.";
    if (!confirm(`Remover esta inscrição do dia ${fmt(rm.dataset.date)}?${aviso}`)) return;
    try {
      const headers = state.admin ? { "X-Admin-Key": state.admin } : { "X-Token": state.mine[id] };
      await api(`/api/inscricoes/${id}`, { method: "DELETE", headers });
      delete state.mine[id];
      save("he-mine", state.mine);
      toast("Inscrição removida. A vaga foi liberada.");
    } catch (e) {
      toast(e.message, true);
    }
    refresh();
  }
});

$("#btn-clear").addEventListener("click", () => { state.selected.clear(); render(); });

$("#btn-submit").addEventListener("click", async () => {
  const nome = nomeEl.value.trim();
  const matricula = matEl.value.trim();
  if (nome.length < 3) { nomeEl.classList.add("invalid"); nomeEl.focus(); return toast("Preencha seu nome antes de confirmar.", true); }
  if (!matricula) { matEl.classList.add("invalid"); matEl.focus(); return toast("Preencha sua matrícula antes de confirmar.", true); }
  if (state.busy) return;

  const dias = [...state.selected].sort();
  const linhas = dias.map(([d, h]) => `• ${dayLabel(d)} (${hLabel(h)}) — cancelar até ${fmt(limiteCancelamento(d))}${podeCancelar(d) ? "" : " ⚠️ prazo já encerrado"}`);
  const semCancelar = dias.some(([d]) => !podeCancelar(d));
  const msg =
    `ATENÇÃO: você só pode cancelar até ${state.prazo} dias antes da data da HE.\n\n` +
    linhas.join("\n") +
    (semCancelar ? `\n\nOs dias marcados com ⚠️ NÃO poderão ser cancelados por você.` : "") +
    `\n\nConfirma sua inscrição?`;
  if (!confirm(msg)) return;

  state.busy = true;
  $("#btn-submit").disabled = true;
  try {
    const itens = [...state.selected].sort().map(([data, horario]) => ({ data, horario }));
    const { resultados } = await api("/api/inscricoes", { method: "POST", body: JSON.stringify({ nome, matricula, itens }) });
    for (const r of resultados) if (r.ok) state.mine[r.id] = r.token;
    save("he-mine", state.mine);
    state.selected.clear();

    const ok = resultados.filter((r) => r.ok), fail = resultados.filter((r) => !r.ok);
    toast(
      `<strong>${ok.length ? "Inscrição registrada!" : "Nenhum dia confirmado."}</strong><ul>` +
        ok.map((r) => `<li class="ok">✓ ${dayLabel(r.data)} · ${hLabel(r.horario)} confirmado <small>(cancelamento até ${fmt(limiteCancelamento(r.data))})</small></li>`).join("") +
        fail.map((r) => `<li class="fail">✗ ${dayLabel(r.data)} · ${hLabel(r.horario)}: ${esc(r.motivo)}</li>`).join("") +
        `</ul>`,
      ok.length === 0,
      true
    );
  } catch (e) {
    toast(e.message, true);
  } finally {
    state.busy = false;
    $("#btn-submit").disabled = false;
    refresh();
  }
});

const dayLabel = (iso) => `${WD[parse(iso).getUTCDay()]} ${fmt(iso)}`;

// ---------- coordenação ----------
function syncAdmin() { $("#admin-bar").hidden = !state.admin; render(); }

$("#btn-admin").addEventListener("click", async () => {
  const key = prompt("Senha da coordenação:");
  if (!key) return;
  try {
    await api("/api/admin/check", { headers: { "X-Admin-Key": key } });
    state.admin = key;
    saveSession("he-admin", key);
    syncAdmin();
    toast("Modo coordenação ativado. Você pode remover qualquer nome e baixar a planilha.");
  } catch {
    toast("Senha incorreta.", true);
  }
});
$("#btn-admin-out").addEventListener("click", () => { state.admin = ""; saveSession("he-admin", ""); syncAdmin(); });
$("#btn-csv").addEventListener("click", async () => {
  try {
    const blob = await api("/api/export.xlsx", { headers: { "X-Admin-Key": state.admin } });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "escala-he-natal-2026.xlsx" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    toast(e.message, true);
  }
});

$("#btn-sheets").addEventListener("click", async () => {
  const formula = `=IMPORTDATA("${location.origin}/api/escala.csv")`;
  try {
    await navigator.clipboard.writeText(formula);
    toast(`<strong>Fórmula copiada!</strong><ul><li>1. Abra uma planilha nova no Google Sheets</li><li>2. Clique na célula A1 e cole (Ctrl+V)</li><li>3. A planilha se atualiza sozinha (o Google atualiza em até ~1h)</li></ul><small>${esc(formula)}</small>`, false, true);
  } catch {
    prompt("Copie esta fórmula e cole na célula A1 de uma planilha do Google Sheets:", formula);
  }
});

// ---------- toast ----------
let toastTimer;
function toast(html, error = false, long = false) {
  const el = $("#toast");
  el.innerHTML = html;
  el.className = "toast" + (error ? " error" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), long ? 9000 : 4500);
}
$("#toast").addEventListener("click", () => ($("#toast").hidden = true));

// ---------- neve ----------
(function snow() {
  const box = document.querySelector(".snow");
  const n = window.innerWidth < 600 ? 18 : 36;
  for (let i = 0; i < n; i++) {
    const f = document.createElement("i");
    f.textContent = Math.random() > 0.5 ? "❄" : "•";
    f.style.left = Math.random() * 100 + "vw";
    f.style.fontSize = 6 + Math.random() * 12 + "px";
    f.style.animationDuration = 9 + Math.random() * 14 + "s";
    f.style.animationDelay = -Math.random() * 20 + "s";
    f.style.setProperty("--drift", (Math.random() * 80 - 40).toFixed(0) + "px");
    box.appendChild(f);
  }
})();

// ---------- início ----------
syncAdmin();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
