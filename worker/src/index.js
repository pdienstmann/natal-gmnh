// API da escala de hora extra (HE) — Natal 2026 · GM Novo Hamburgo
// Cloudflare Worker + D1
//
// GET    /api/dias                 -> todos os dias com as vagas e os inscritos
// POST   /api/inscricoes           -> { nome, matricula, itens: [{ data: "2026-11-27", horario: "15-01" }, ...] }
// DELETE /api/inscricoes/:id       -> header X-Token (da própria inscrição) ou X-Admin-Key
// GET    /api/export.csv           -> header X-Admin-Key (ou ?key=) — planilha para o coordenador

const MAX_DATES_PER_REQUEST = 40;

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
  return json({ hoje: todayBR(), horarios: HORARIOS, dias: [...byDate.values()] }, 200, { "Cache-Control": "no-store" });
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
