// API da escala de hora extra (HE) — Natal 2026 · GM Novo Hamburgo
// Cloudflare Worker + D1
//
// GET    /api/dias                 -> todos os dias com as vagas e os inscritos
// POST   /api/inscricoes           -> { nome, matricula, itens: [{ data: "2026-11-27", horario: "15-01" }, ...] }
// DELETE /api/inscricoes/:id       -> header X-Token (da própria inscrição) ou X-Admin-Key
// GET    /api/escala.csv           -> público, CSV com vírgula para o Google Sheets (=IMPORTDATA)
// GET    /api/export.xlsx          -> header X-Admin-Key (ou ?key=) — planilha formatada (Excel / Google Sheets)
// GET    /api/export.csv           -> header X-Admin-Key (ou ?key=) — planilha para o coordenador

import { buildXlsx, colName, S } from "./xlsx.js";

const MAX_DATES_PER_REQUEST = 40;

// O próprio GM só pode cancelar até N dias antes da data da HE (a coordenação pode sempre).
const PRAZO_CANCELAMENTO_DIAS = 5;

// Horários de HE. Todos dividem o mesmo limite de vagas do dia.
const HORARIOS = {
  "15-01": { inicio: "15h", fim: "01h", tipo: "Folga", descricao: "Dia/noite contrário", horas: 10 },
  "18-00": { inicio: "18h", fim: "00h", tipo: "Extensão", descricao: "Estender o turno", horas: 6 },
  "19-01": { inicio: "19h", fim: "01h", tipo: "Extensão", descricao: "Estender o turno", horas: 6 },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), env);

    try {
      let res;
      if (url.pathname === "/api/dias" && request.method === "GET") {
        res = await listDays(env);
      } else if (url.pathname === "/api/inscricoes" && request.method === "POST") {
        res = await createSignups(request, env);
      } else if (url.pathname.startsWith("/api/inscricoes/") && request.method === "DELETE") {
        res = await deleteSignup(request, env, url.pathname.split("/").pop());
      } else if (url.pathname === "/api/escala.csv" && request.method === "GET") {
        res = await escalaCsv(env);
      } else if (url.pathname === "/api/export.xlsx" && request.method === "GET") {
        res = await exportXlsx(request, env, url);
      } else if (url.pathname === "/api/export.csv" && request.method === "GET") {
        res = await exportCsv(request, env, url);
      } else if (url.pathname === "/api/admin/check" && request.method === "GET") {
        res = isAdmin(request, env, url) ? json({ ok: true }) : json({ erro: "Senha inválida." }, 401);
      } else {
        res = json({ erro: "Não encontrado." }, 404);
      }
      return withCors(res, env);
    } catch (err) {
      console.error(err);
      return withCors(json({ erro: "Erro interno. Tente novamente." }, 500), env);
    }
  },
};

// ---------------------------------------------------------------------------

async function listDays(env) {
  const [days, signups] = await env.DB.batch([
    env.DB.prepare("SELECT date, capacity FROM days ORDER BY date"),
    env.DB.prepare("SELECT id, date, name, registration, shift, created_at FROM signups ORDER BY created_at, id"),
  ]);

  const byDate = new Map(days.results.map((d) => [d.date, { data: d.date, capacidade: d.capacity, inscritos: [] }]));
  for (const s of signups.results) {
    byDate.get(s.date)?.inscritos.push({ id: s.id, nome: s.name, matricula: s.registration, horario: s.shift, em: s.created_at });
  }
  return json({ hoje: todayBR(), prazoCancelamentoDias: PRAZO_CANCELAMENTO_DIAS, horarios: HORARIOS, dias: [...byDate.values()] }, 200, { "Cache-Control": "no-store" });
}

async function createSignups(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ erro: "Requisição inválida." }, 400);
  }

  const nome = cleanName(body?.nome);
  const matricula = String(body?.matricula ?? "").trim().replace(/\s+/g, "").toUpperCase();
  // um horário por dia: se o mesmo dia vier repetido, vale o último
  const porDia = new Map();
  for (const it of Array.isArray(body?.itens) ? body.itens : []) porDia.set(String(it?.data ?? ""), String(it?.horario ?? ""));
  const datas = [...porDia.keys()];

  if (nome.length < 3 || nome.length > 60) return json({ erro: "Informe seu nome (3 a 60 caracteres)." }, 400);
  if (!/^[0-9A-Z.\-]{1,20}$/.test(matricula)) return json({ erro: "Informe uma matrícula válida." }, 400);
  if (datas.length === 0) return json({ erro: "Selecione pelo menos um dia." }, 400);
  if (datas.length > MAX_DATES_PER_REQUEST) return json({ erro: "Dias demais selecionados." }, 400);
  if (!datas.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) return json({ erro: "Data inválida." }, 400);
  if (![...porDia.values()].every((h) => HORARIOS[h])) return json({ erro: "Escolha um horário válido para cada dia." }, 400);

  const today = todayBR();

  // Cada INSERT só acontece se ainda houver vaga no dia. O D1 executa as escritas
  // em série, então duas pessoas nunca conseguem pegar a mesma última linha.
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO signups (date, name, registration, token, shift)
     SELECT d.date, ?2, ?3, ?4, ?6 FROM days d
      WHERE d.date = ?1
        AND d.date >= ?5
        AND (SELECT COUNT(*) FROM signups s WHERE s.date = d.date) < d.capacity
     RETURNING id, date, token, shift`
  );

  const batch = datas.map((d) => stmt.bind(d, nome, matricula, crypto.randomUUID(), today, porDia.get(d)));
  const results = await env.DB.batch(batch);

  // Para os que não entraram, descobre o motivo.
  const resultados = [];
  for (let i = 0; i < datas.length; i++) {
    const row = results[i].results?.[0];
    if (row) {
      resultados.push({ data: datas[i], horario: row.shift, ok: true, id: row.id, token: row.token });
      continue;
    }
    const info = await env.DB.prepare(
      `SELECT d.capacity,
              (SELECT COUNT(*) FROM signups s WHERE s.date = d.date) AS total,
              (SELECT COUNT(*) FROM signups s WHERE s.date = d.date AND s.registration = ?2) AS meu
         FROM days d WHERE d.date = ?1`
    )
      .bind(datas[i], matricula)
      .first();

    let motivo = "Não foi possível inscrever.";
    if (!info) motivo = "Dia fora da escala.";
    else if (info.meu > 0) motivo = "Você já está inscrito neste dia.";
    else if (datas[i] < today) motivo = "Este dia já passou.";
    else if (info.total >= info.capacity) motivo = "Lotado — escolha outro dia.";
    resultados.push({ data: datas[i], horario: porDia.get(datas[i]), ok: false, motivo });
  }

  return json({ resultados });
}

async function deleteSignup(request, env, idRaw) {
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return json({ erro: "Inscrição inválida." }, 400);

  if (isAdmin(request, env)) {
    const r = await env.DB.prepare("DELETE FROM signups WHERE id = ?1").bind(id).run();
    return r.meta.changes ? json({ ok: true }) : json({ erro: "Inscrição não encontrada." }, 404);
  }

  const token = request.headers.get("X-Token") || "";
  if (!token) return json({ erro: "Sem permissão para remover." }, 403);
  const insc = await env.DB.prepare("SELECT date FROM signups WHERE id = ?1 AND token = ?2").bind(id, token).first();
  if (!insc) return json({ erro: "Sem permissão ou inscrição já removida." }, 403);
  const limite = prazoCancelamento(insc.date);
  if (todayBR() > limite) {
    return json(
      { erro: `Prazo de cancelamento encerrado: era possível cancelar até ${brDate(limite).slice(0, 5)} (${PRAZO_CANCELAMENTO_DIAS} dias antes da HE). Fale com a coordenação.` },
      403
    );
  }
  const r = await env.DB.prepare("DELETE FROM signups WHERE id = ?1 AND token = ?2").bind(id, token).run();
  return r.meta.changes ? json({ ok: true }) : json({ erro: "Sem permissão ou inscrição já removida." }, 403);
}

async function exportCsv(request, env, url) {
  if (!isAdmin(request, env, url)) return json({ erro: "Senha inválida." }, 401);
  const { results } = await env.DB.prepare(
    `SELECT s.date, s.name, s.registration, s.shift, s.created_at,
            ROW_NUMBER() OVER (PARTITION BY s.date ORDER BY s.created_at, s.id) AS linha
       FROM signups s ORDER BY s.date, linha`
  ).all();

  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [["Data", "Dia", "Linha", "Nome", "Matrícula", "Horário", "Tipo", "Horas HE", "Inscrito em (UTC)"].map(esc).join(";")];
  for (const r of results) {
    const [y, m, d] = r.date.split("-");
    lines.push([`${d}/${m}/${y}`, weekdayPt(r.date), r.linha, r.name, r.registration, ...horarioCsv(r.shift), r.created_at].map(esc).join(";"));
  }
  // BOM para o Excel abrir com acentos corretos
  return new Response("﻿" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="escala-he-natal-2026.csv"',
    },
  });
}

// CSV público (mesmos dados que a página já mostra) no formato que o IMPORTDATA do Google Sheets lê.
// Ordenado por data, horário e ordem de inscrição.
async function escalaCsv(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.date, s.name, s.registration, s.shift, d.capacity,
            ROW_NUMBER() OVER (PARTITION BY s.date ORDER BY s.created_at, s.id) AS ordem
       FROM signups s JOIN days d ON d.date = s.date`
  ).all();
  const codes = Object.keys(HORARIOS);
  results.sort((a, b) => a.date.localeCompare(b.date) || codes.indexOf(a.shift) - codes.indexOf(b.shift) || a.ordem - b.ordem);
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [["Data", "Dia", "Horário", "Tipo", "Horas HE", "Nome", "Matrícula", "Ordem no dia", "Vagas do dia"].map(q).join(",")];
  for (const r of results) {
    const h = HORARIOS[r.shift];
    lines.push([brDate(r.date), weekdayPt(r.date), h ? `${h.inicio} às ${h.fim}` : r.shift, h?.tipo ?? "", h?.horas ?? "", r.name, r.registration, r.ordem, r.capacity].map(q).join(","));
  }
  return new Response(lines.join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function exportXlsx(request, env, url) {
  if (!isAdmin(request, env, url)) return json({ erro: "Senha inválida." }, 401);

  const [daysRes, signupsRes] = await env.DB.batch([
    env.DB.prepare("SELECT date, capacity FROM days ORDER BY date"),
    env.DB.prepare("SELECT id, date, name, registration, shift, created_at FROM signups ORDER BY created_at, id"),
  ]);
  const days = daysRes.results;
  const signups = signupsRes.results;

  const byDate = new Map(days.map((d) => [d.date, []]));
  for (const s of signups) byDate.get(s.date)?.push(s);
  // posição de cada inscrição na ordem de chegada do dia
  const ordem = new Map();
  for (const list of byDate.values()) list.forEach((s, i) => ordem.set(s.id, i + 1));

  const codes = Object.keys(HORARIOS);
  const hTxt = (c) => (HORARIOS[c] ? `${HORARIOS[c].inicio} às ${HORARIOS[c].fim}` : c);
  const hHoras = (c) => HORARIOS[c]?.horas ?? 0;
  const t = (v, s = S.cell) => ({ v, s });
  const n = (v, s = S.cellCenter) => ({ v, s });

  const agora = new Date(Date.now() - 3 * 3600 * 1000);
  const geradoEm = `Gerado em ${agora.toISOString().slice(8, 10)}/${agora.toISOString().slice(5, 7)}/${agora.toISOString().slice(0, 4)} às ${agora.toISOString().slice(11, 16)} (horário de Brasília)`;

  // ---------- Aba 1: escala por dia, agrupada por horário ----------
  const esc1 = { name: "Escala por dia", cols: [7, 38, 14, 16, 11], rows: [], merges: [] };
  const W = 5;
  const add = (cells, height) => esc1.rows.push({ cells, height });
  const mergeRow = () => esc1.merges.push(`A${esc1.rows.length}:${colName(W - 1)}${esc1.rows.length}`);
  const fill = (first, style) => [first, ...Array.from({ length: W - 1 }, () => ({ s: style }))];

  add(fill(t("Escala de Hora Extra · Natal 2026 · GM Novo Hamburgo", S.title), S.title), 30);
  mergeRow();
  add([t(geradoEm, S.subtitle)]);
  add([t(`Total: ${signups.length} inscrições · ${signups.reduce((a, s) => a + hHoras(s.shift), 0)} horas de HE`, S.subtitle)]);

  for (const d of days) {
    const list = byDate.get(d.date);
    const wd = weekdayPt(d.date);
    const weekend = ["Sexta", "Sábado", "Domingo"].includes(wd);
    add([]);
    add(fill(t(`${wd.toUpperCase()} · ${brDate(d.date)}  —  ${list.length} de ${d.capacity} vagas preenchidas`, weekend ? S.dayWeekend : S.dayWeekday), weekend ? S.dayWeekend : S.dayWeekday), 24);
    mergeRow();
    if (!list.length) {
      add(fill(t("Nenhum inscrito", S.empty), S.empty));
      mergeRow();
      continue;
    }
    add(["Nº", "Nome", "Matrícula", "Horário", "Horas HE"].map((h) => t(h, S.head)));
    for (const code of codes) {
      const grupo = list.filter((s) => s.shift === code);
      if (!grupo.length) continue;
      const h = HORARIOS[code];
      const st = h.tipo === "Folga" ? S.groupFolga : S.groupExt;
      add(fill(t(`${h.tipo} · ${h.inicio} às ${h.fim} · ${h.horas}h de HE  —  ${grupo.length} GM${grupo.length > 1 ? "s" : ""}`, st), st), 20);
      mergeRow();
      grupo.forEach((s, i) => add([n(i + 1), t(s.name), n(s.registration), n(hTxt(s.shift)), n(hHoras(s.shift))]));
    }
  }

  // ---------- Aba 2: lista completa com filtro ----------
  const lista = {
    name: "Lista completa",
    cols: [12, 11, 14, 11, 10, 36, 13, 13, 19],
    rows: [],
    freezeRows: 1,
    autoFilter: "A1:I1",
    landscape: true,
  };
  lista.rows.push({ height: 22, cells: ["Data", "Dia", "Horário", "Tipo", "Horas HE", "Nome", "Matrícula", "Ordem no dia", "Inscrito em"].map((h) => t(h, S.head)) });
  const sorted = [...signups].sort((a, b) => a.date.localeCompare(b.date) || codes.indexOf(a.shift) - codes.indexOf(b.shift) || ordem.get(a.id) - ordem.get(b.id));
  sorted.forEach((s, i) => {
    const z = i % 2 === 1;
    lista.rows.push({
      cells: [
        n(excelDate(s.date), z ? S.dateZebra : S.date),
        n(weekdayPt(s.date), z ? S.cellCenterZebra : S.cellCenter),
        n(hTxt(s.shift), z ? S.cellCenterZebra : S.cellCenter),
        n(HORARIOS[s.shift]?.tipo ?? "", z ? S.cellCenterZebra : S.cellCenter),
        n(hHoras(s.shift), z ? S.cellCenterZebra : S.cellCenter),
        t(s.name, z ? S.cellZebra : S.cell),
        n(s.registration, z ? S.cellCenterZebra : S.cellCenter),
        n(ordem.get(s.id), z ? S.cellCenterZebra : S.cellCenter),
        n(brDateTime(s.created_at), z ? S.cellCenterZebra : S.cellCenter),
      ],
    });
  });

  // ---------- Aba 3: totais por GM ----------
  const porGm = new Map();
  for (const s of signups) {
    const g = porGm.get(s.registration) || { nome: s.name, mat: s.registration, dias: 0, folga: 0, ext: 0, horas: 0 };
    g.nome = s.name;
    g.dias++;
    HORARIOS[s.shift]?.tipo === "Folga" ? g.folga++ : g.ext++;
    g.horas += hHoras(s.shift);
    porGm.set(s.registration, g);
  }
  const totais = { name: "Totais por GM", cols: [36, 13, 9, 17, 14, 12], rows: [], freezeRows: 1, autoFilter: "A1:F1" };
  totais.rows.push({ height: 22, cells: ["Nome", "Matrícula", "Dias", "Folgas (15h–01h)", "Extensões", "Horas HE"].map((h) => t(h, S.head)) });
  const gms = [...porGm.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  gms.forEach((g, i) => {
    const z = i % 2 === 1;
    const c = z ? S.cellCenterZebra : S.cellCenter;
    totais.rows.push({ cells: [t(g.nome, z ? S.cellZebra : S.cell), n(g.mat, c), n(g.dias, c), n(g.folga, c), n(g.ext, c), n(g.horas, c)] });
  });
  const sum = (k) => gms.reduce((a, g) => a + g[k], 0);
  totais.rows.push({ cells: [t(`TOTAL · ${gms.length} GMs`, S.totalLabel), t("", S.totalNum), n(sum("dias"), S.totalNum), n(sum("folga"), S.totalNum), n(sum("ext"), S.totalNum), n(sum("horas"), S.totalNum)] });

  const bytes = buildXlsx([esc1, lista, totais]);
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="escala-he-natal-2026.xlsx"',
    },
  });
}

// último dia em que o próprio GM ainda pode cancelar (AAAA-MM-DD)
function prazoCancelamento(iso) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - PRAZO_CANCELAMENTO_DIAS);
  return d.toISOString().slice(0, 10);
}

const brDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
// número de série de data do Excel (dias desde 30/12/1899)
const excelDate = (iso) => Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000);
function brDateTime(utcIso) {
  const d = new Date(new Date(utcIso).getTime() - 3 * 3600 * 1000).toISOString();
  return `${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}`;
}

// ---------------------------------------------------------------------------

function isAdmin(request, env, url) {
  const key = request.headers.get("X-Admin-Key") || url?.searchParams.get("key") || "";
  return Boolean(env.ADMIN_KEY) && key.length > 0 && timingSafeEqual(key, env.ADMIN_KEY);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cleanName(v) {
  return String(v ?? "")
    .replace(/[\u0000-\u001f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Data de hoje no horário de Brasília (sem horário de verão: UTC-3)
function todayBR() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function horarioCsv(code) {
  const h = HORARIOS[code];
  return h ? [`${h.inicio} às ${h.fim}`, h.tipo, h.horas] : [code, "", ""];
}

function weekdayPt(iso) {
  const names = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  return names[new Date(iso + "T12:00:00Z").getUTCDay()];
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

function withCors(res, env) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, X-Token, X-Admin-Key");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
