// Escala em tempo real — visão da coordenação/escala diária (somente leitura)
const API = new URLSearchParams(location.search).get("api") || "";
const POLL_MS = 15000;
const WD_FULL = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira", "Sexta-feira", "Sábado"];
const WD = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const $ = (s) => document.querySelector(s);
const state = { dias: [], horarios: {}, hoje: "", sel: null, todos: false, loaded: false };

// estado da visão fica no endereço (#2026-12-05 ou #todos), assim dá pra compartilhar/atualizar a página
function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h === "todos") state.todos = true;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(h)) { state.sel = h; state.todos = false; }
}
function writeHash() {
  const h = state.todos ? "#todos" : state.sel ? `#${state.sel}` : "";
  if (location.hash !== h) history.replaceState(null, "", h || location.pathname + location.search);
}

const parse = (iso) => new Date(iso + "T12:00:00Z");
const fmt = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const addDays = (iso, n) => { const d = parse(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function defaultDay() {
  const datas = state.dias.map((d) => d.data);
  if (datas.includes(state.hoje)) return state.hoje;
  return datas.find((d) => d >= state.hoje) || datas[datas.length - 1];
}

async function refresh() {
  try {
    const res = await fetch(API + "/api/dias", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.dias = data.dias;
    state.horarios = data.horarios || {};
    state.hoje = data.hoje;
    if (!state.sel || !state.dias.some((d) => d.data === state.sel)) state.sel = defaultDay();
    state.loaded = true;
    $("#live").classList.remove("off");
    $("#status").textContent = `Ao vivo · atualizado às ${new Date().toLocaleTimeString("pt-BR")} · atualiza a cada ${POLL_MS / 1000}s`;
    render();
  } catch {
    $("#live").classList.add("off");
    $("#status").textContent = "Sem conexão — tentando de novo…";
  }
}

function render() {
  if (!state.loaded) return;
  // seletor de dia
  const sel = $("#dia");
  const opts = state.dias
    .map((d) => {
      const wd = parse(d.data).getUTCDay();
      return `<option value="${d.data}">${WD[wd]} ${fmt(d.data)} · ${d.inscritos.length}/${d.capacidade}${d.data === state.hoje ? " · hoje" : ""}</option>`;
    })
    .join("");
  if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; }
  sel.value = state.sel;
  sel.disabled = state.todos;
  $("#prev").disabled = state.todos;
  $("#next").disabled = state.todos;
  $("#todos").classList.toggle("on", state.todos);
  $("#hoje").classList.toggle("on", !state.todos && state.sel === state.hoje);
  $("#amanha").classList.toggle("on", !state.todos && state.sel === addDays(state.hoje, 1));

  const lista = state.todos ? state.dias : state.dias.filter((d) => d.data === state.sel);
  $("#conteudo").innerHTML = lista.length ? lista.map(dayBlock).join("") : `<p class="msg">Nenhum dia nesta escala.</p>`;
  document.title = state.todos ? "Escala completa · HE Natal" : `Escala ${fmt(state.sel)} · HE Natal`;
  writeHash();
}

function dayBlock(dia) {
  const wd = parse(dia.data).getUTCDay();
  const weekend = wd === 0 || wd === 5 || wd === 6;
  const total = dia.inscritos.length;
  const horas = dia.inscritos.reduce((s, p) => s + (state.horarios[p.horario]?.horas || 0), 0);
  const livres = Math.max(0, dia.capacidade - total);

  const grupos = Object.entries(state.horarios)
    .map(([code, h]) => {
      const gms = dia.inscritos.filter((p) => p.horario === code);
      const linhas = gms.length
        ? `<table>${gms.map((p, i) => `<tr><td class="n">${i + 1}</td><td class="nome">${esc(p.nome)}</td><td class="mat">${esc(p.matricula)}</td></tr>`).join("")}</table>`
        : `<div class="vazio">Ninguém neste horário</div>`;
      return `<section class="group ${h.tipo === "Folga" ? "folga" : "ext"}">
        <h3><span>${h.inicio}–${h.fim} · ${esc(h.tipo)}</span><small>${gms.length} GM${gms.length === 1 ? "" : "s"}</small></h3>
        ${linhas}
      </section>`;
    })
    .join("");

  return `<article class="day ${weekend ? "weekend" : ""}">
    <div class="day-head">
      <h2>${WD_FULL[wd]}, ${fmt(dia.data)}</h2>
      ${dia.data === state.hoje ? `<span class="hoje">HOJE</span>` : ""}
      <span class="meta"><b>${total}</b> de <b>${dia.capacidade}</b> vagas · <b>${livres}</b> livre${livres === 1 ? "" : "s"} · <b>${horas}h</b> de HE</span>
    </div>
    <div class="progress"><div style="width:${Math.min(100, (total / dia.capacidade) * 100)}%"></div></div>
    <div class="groups">${grupos}</div>
  </article>`;
}

function go(iso) { state.todos = false; state.sel = iso; render(); }
function step(n) {
  const i = state.dias.findIndex((d) => d.data === state.sel);
  const j = Math.min(state.dias.length - 1, Math.max(0, i + n));
  go(state.dias[j].data);
}

$("#dia").addEventListener("change", (e) => go(e.target.value));
$("#prev").addEventListener("click", () => step(-1));
$("#next").addEventListener("click", () => step(1));
$("#hoje").addEventListener("click", () => go(defaultDay()));
$("#amanha").addEventListener("click", () => {
  const alvo = addDays(state.hoje, 1);
  go(state.dias.some((d) => d.data === alvo) ? alvo : defaultDay());
});
$("#todos").addEventListener("click", () => { state.todos = !state.todos; render(); });
$("#imprimir").addEventListener("click", () => window.print());
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "SELECT") return;
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});
window.addEventListener("hashchange", () => { readHash(); render(); });

readHash();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
