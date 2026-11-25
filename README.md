# 🎄 Escala de Hora Extra — Natal 2026 · GM Novo Hamburgo

Página onde os Guardas Municipais se inscrevem nos dias em que podem fazer HE no evento de Natal.
Quem preenche primeiro fica com a vaga e, quando o dia lota, ninguém mais consegue entrar.

- **Período:** 27/11 a 26/12/2026
- **Sex, Sáb e Dom:** 20 vagas por dia · **Seg a Qui:** 6 vagas por dia
- Atualiza sozinha a cada 5 s, então todos veem as vagas em tempo real
- Quem se inscreveu pode **cancelar** a própria inscrição pelo mesmo celular
- **Coordenação** (link no rodapé + senha): remove qualquer nome e baixa a planilha `.csv` (abre no Excel)

```
web/      → front estático (Vercel)
worker/   → API + banco D1 (Cloudflare Workers)
```

## Deploy (uma vez só)

### 1. Banco + API na Cloudflare

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create escala-natal-gm      # copie o database_id para o wrangler.toml
npm run db:migrate                          # cria as tabelas e os 30 dias
npx wrangler secret put ADMIN_KEY           # senha da coordenação
npm run deploy                              # mostra a URL: https://escala-natal-gm.<sub>.workers.dev
```

### 2. Front na Vercel

1. Em `web/vercel.json`, troque `SEU-SUBDOMINIO` pela URL que o deploy do Worker mostrou.
2. Na Vercel: **Add New → Project →** importe este repositório e defina **Root Directory = `web`**
   (Framework: *Other*, sem build command).
3. Cada push no GitHub publica automaticamente.

Opcional: no `worker/wrangler.toml`, troque `ALLOWED_ORIGIN = "*"` pelo domínio da Vercel e rode `npm run deploy` de novo.

## Ajustes comuns

**Mudar vagas de um dia** (ex.: 15 vagas no dia 24/12):

```bash
npx wrangler d1 execute escala-natal-gm --remote --command "UPDATE days SET capacity = 15 WHERE date = '2026-12-24'"
```

**Adicionar um dia:**

```bash
npx wrangler d1 execute escala-natal-gm --remote --command "INSERT INTO days (date, capacity) VALUES ('2026-12-27', 20)"
```

**Remover um dia da escala:**

```bash
npx wrangler d1 execute escala-natal-gm --remote --command "DELETE FROM days WHERE date = '2026-12-25'"
```

## Rodar local

```bash
cd worker && echo 'ADMIN_KEY="natal-local"' > .dev.vars && npm run db:migrate:local && npm run dev
# em outro terminal:
cd web && python3 -m http.server 5500
# abra http://localhost:5500/?api=http://localhost:8787
```

## Como o limite de vagas é garantido

Cada inscrição é um único `INSERT ... WHERE (inscritos do dia) < capacidade`. O D1 executa as escritas
em série, então se 15 pessoas clicarem ao mesmo tempo na última vaga, só uma entra (testado).
A matrícula é única por dia, então ninguém ocupa duas linhas no mesmo dia.
