-- Contador de versão da escala. Qualquer mudança em inscrições ou dias incrementa o contador
-- (via gatilhos). A API lê só esta linha a cada atualização das páginas e só relê a escala
-- inteira quando a versão muda — economiza o limite diário de leituras do D1.
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (k, v) VALUES ('versao', 1);
CREATE TRIGGER IF NOT EXISTS trg_signups_ins AFTER INSERT ON signups BEGIN UPDATE meta SET v = v + 1 WHERE k = 'versao'; END;
CREATE TRIGGER IF NOT EXISTS trg_signups_upd AFTER UPDATE ON signups BEGIN UPDATE meta SET v = v + 1 WHERE k = 'versao'; END;
CREATE TRIGGER IF NOT EXISTS trg_signups_del AFTER DELETE ON signups BEGIN UPDATE meta SET v = v + 1 WHERE k = 'versao'; END;
CREATE TRIGGER IF NOT EXISTS trg_days_ins AFTER INSERT ON days BEGIN UPDATE meta SET v = v + 1 WHERE k = 'versao'; END;
CREATE TRIGGER IF NOT EXISTS trg_days_upd AFTER UPDATE ON days BEGIN UPDATE meta SET v = v + 1 WHERE k = 'versao'; END;
CREATE TRIGGER IF NOT EXISTS trg_days_del AFTER DELETE ON days BEGIN UPDATE meta SET v = v + 1 WHERE k = 'versao'; END;
