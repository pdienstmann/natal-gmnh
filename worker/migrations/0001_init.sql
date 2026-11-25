-- Estrutura + dias do evento de Natal 2026 (27/11 a 26/12)
CREATE TABLE IF NOT EXISTS days (
  date      TEXT PRIMARY KEY,          -- AAAA-MM-DD
  capacity  INTEGER NOT NULL           -- número de linhas/vagas do dia
);

CREATE TABLE IF NOT EXISTS signups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT NOT NULL REFERENCES days(date) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  registration  TEXT NOT NULL,         -- matrícula
  token         TEXT NOT NULL,         -- permite a própria pessoa cancelar
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (date, registration)
);

CREATE INDEX IF NOT EXISTS idx_signups_date ON signups(date);

-- Sex/Sáb/Dom = 20 vagas · Seg a Qui = 6 vagas
INSERT OR IGNORE INTO days (date, capacity) VALUES
  ('2026-11-27', 20),
  ('2026-11-28', 20),
  ('2026-11-29', 20),
  ('2026-11-30', 6),
  ('2026-12-01', 6),
  ('2026-12-02', 6),
  ('2026-12-03', 6),
  ('2026-12-04', 20),
  ('2026-12-05', 20),
  ('2026-12-06', 20),
  ('2026-12-07', 6),
  ('2026-12-08', 6),
  ('2026-12-09', 6),
  ('2026-12-10', 6),
  ('2026-12-11', 20),
  ('2026-12-12', 20),
  ('2026-12-13', 20),
  ('2026-12-14', 6),
  ('2026-12-15', 6),
  ('2026-12-16', 6),
  ('2026-12-17', 6),
  ('2026-12-18', 20),
  ('2026-12-19', 20),
  ('2026-12-20', 20),
  ('2026-12-21', 6),
  ('2026-12-22', 6),
  ('2026-12-23', 6),
  ('2026-12-24', 6),
  ('2026-12-25', 20),
  ('2026-12-26', 20);
