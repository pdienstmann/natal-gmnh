-- Horário escolhido em cada inscrição. Os horários dividem as vagas do dia.
--   15-01 = folga (dia/noite contrário), 15h às 01h, 10h de HE
--   18-00 = extensão, 18h às 00h, 6h de HE
--   19-01 = extensão, 19h às 01h, 6h de HE
ALTER TABLE signups ADD COLUMN shift TEXT NOT NULL DEFAULT '15-01';
