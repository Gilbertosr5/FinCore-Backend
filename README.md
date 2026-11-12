# FinCore API

Backend REST do **FinCore** (gestão financeira pessoal). Implementa os contratos
já definidos pelo frontend em [`../fincore/docs/api-contract.md`](../fincore/docs/api-contract.md)
e [`../fincore/docs/auth-contract.md`](../fincore/docs/auth-contract.md).

> Decisão (11/11/2026): o backend é **Node.js + TypeScript** (antes previsto em
> Java + Spring Boot). Os contratos HTTP não mudaram.

## Stack

| Item        | Escolha                                                       | Por quê                                                                                   |
| ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Runtime     | Node.js ≥ 22.12 (testado no 24), ESM                          | Mesmo ecossistema do frontend                                                             |
| HTTP        | **Fastify 5**                                                 | Rápido, tipado, plugins oficiais (cookie, CORS, rate limit, helmet), `inject` para testes |
| Validação   | **Zod 4**                                                     | Mesma biblioteca e mesmas regras dos schemas do frontend                                  |
| Banco       | **PostgreSQL** via **Drizzle ORM** (migrações SQL)            | SQL explícito, tipos inferidos do schema, transações                                      |
| Banco local | **PGlite** (PostgreSQL embutido em WASM)                      | Roda e testa sem instalar PostgreSQL nem Docker; mesmo dialeto                            |
| Dinheiro    | `decimal.js` (HALF_EVEN) + `numeric(14,2)`                    | ADR 0003 do frontend — nunca `number`                                                     |
| Senhas      | Argon2id (`@node-rs/argon2`, binário pré-compilado)           | Recomendação OWASP                                                                        |
| Testes      | Vitest + `app.inject` + PGlite em memória                     | Testes de integração reais (HTTP → regras → SQL), rápidos                                 |
| Qualidade   | TypeScript 6 strict, ESLint 9 (`strictTypeChecked`), Prettier | Mesmo padrão do frontend                                                                  |

## Como rodar

```bash
cd fincore-api
npm install
cp .env.example .env     # já vem com PGlite em ./.data/pglite (sem instalar nada)
npm run dev              # http://localhost:8080 — migrações aplicadas ao iniciar
```

- Saúde: `GET /health`. API: `/api/v1/...`.
- PostgreSQL real: `DATABASE_URL=postgres://usuario:senha@localhost:5432/fincore`.
- Migrações: `npm run db:migrate` (ou `DB_MIGRATE_ON_START=true`). Depois de mudar
  `src/db/schema.ts`, gere uma nova com `npm run db:generate -- --name <descricao>`.
- Produção: `npm run build && npm start` (exige `COOKIE_SECURE=true` e `postgres://`).
- E-mail de redefinição de senha: ainda **não há provedor** — o link sai no log
  (`Redefinição de senha (mailer de desenvolvimento…)`). Implemente a interface
  `Mailer` (`src/http/context.ts`) com SMTP/SES etc.

## Portão de qualidade

```bash
npm run check   # typecheck + lint (0 avisos) + prettier + testes
npm run build
```

## Ligando o frontend

Já configurado no frontend (11/11/2026) e testado no navegador:

```bash
cd fincore-api && npm run dev     # API em :8080
cd fincore && npm run dev:api     # front em http://localhost:5180 (usa fincore/.env.api)
```

O axios do frontend só envia o header `X-XSRF-TOKEN` para a **mesma origem**, então o
Vite encaminha `/api` para a API (`server.proxy` em `fincore/vite.config.ts`; outro
destino via `FINCORE_API_URL`) e o front usa `VITE_API_BASE_URL=http://localhost:5180/api/v1`.
Com front e API em origens diferentes as gravações seriam recusadas (403).

Em produção, sirva front e API sob o mesmo domínio (ex.: `app.exemplo.com` e
`app.exemplo.com/api`) ou configure `CORS_ORIGINS` e `withXSRFToken` no axios.

## Arquitetura

```
src/
  app.ts                 composição: plugins, hooks, rotas (usado pelo servidor e pelos testes)
  server.ts              inicialização e encerramento gracioso
  config/env.ts          variáveis de ambiente validadas com Zod (falha cedo)
  db/
    schema.ts            tabelas (Drizzle) — fonte das migrações em drizzle/
    client.ts            postgres:// (node-postgres) ou pglite: (embutido)
  http/
    context.ts           dependências injetadas (config, banco, relógio, mailer)
    security.ts          sessão por cookie, CSRF (double submit), autenticação
    error-handler.ts     tudo vira Problem Details (RFC 9457)
  shared/                dinheiro, datas, validação, histórico (audit), erros
  modules/<recurso>/     schemas Zod do contrato + regras + rotas
tests/                   integração (HTTP real + PGlite em memória); integrity.test.ts = ADR 0015
```

Princípios:

- **Multi-inquilino por construção:** toda tabela financeira tem chave primária
  `(user_id, id)` e toda consulta filtra por `user_id`. Os ids vêm do cliente
  (UUID ou `${recorrência}_${data}`); outro usuário com o mesmo id cria o próprio
  registro, nunca lê/sobrescreve o alheio.
- **Gravações "cria ou substitui"** (`PUT`) idempotentes; `POST /transactions/batch`
  é **atômico** (uma transação do banco, tudo ou nada).
- **Histórico** (`audit_log`) gravado **na mesma transação** da alteração.
- **O cliente não é barreira de segurança:** o servidor revalida formato e
  regras de negócio (lista abaixo) e responde `422` com `errors[]` por campo ou
  `409` com `code` estável.
- Erros do PostgreSQL de unicidade/chave estrangeira viram `409` (defesa em profundidade);
  erros inesperados viram `500` genérico com `requestId` (detalhes só no log).

## Segurança

| Item           | Implementação                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Sessão         | Cookie `fincore_session` HttpOnly + SameSite=Lax (+ Secure em produção). Token opaco de 256 bits; só o SHA-256 vai ao banco |
| Expiração      | Inatividade (`SESSION_IDLE_MINUTES`, padrão 60) e absoluta (`SESSION_ABSOLUTE_HOURS`, padrão 12)                            |
| Refresh        | `POST /auth/refresh` troca o token (rotação) e estende a inatividade                                                        |
| CSRF           | Cookie `XSRF-TOKEN` → header `X-XSRF-TOKEN` em POST/PUT/DELETE (emitido na 1ª resposta, ex.: `GET /auth/me`)                |
| Senhas         | Argon2id; 8–128 caracteres com letra e número; login com mensagem genérica e tempo constante                                |
| Redefinição    | Token aleatório de uso único, 30 min, só o hash é guardado; encerra todas as sessões                                        |
| Troca de senha | Exige a senha atual; encerra as outras sessões                                                                              |
| Rate limiting  | Login, cadastro, recuperação/redefinição/troca de senha: `AUTH_RATE_LIMIT_PER_MINUTE` por IP → `429` + `Retry-After`        |
| Cabeçalhos     | Helmet; `X-Request-Id` em toda resposta (aceita o do proxy se válido); cookies e CSRF omitidos dos logs                     |

## Endpoints

Prefixo `/api/v1`. Todos, exceto `/auth/*`, exigem sessão (`401` sem ela).

| Recurso                | Rotas                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Autenticação           | `POST /auth/register, /auth/login, /auth/logout, /auth/refresh`, `GET /auth/me`, `POST /auth/password/{forgot,reset,change}` |
| Contas                 | `GET /accounts`, `GET/PUT /accounts/{id}`                                                                                    |
| Categorias             | `GET /categories`, `PUT/DELETE /categories/{id}`                                                                             |
| Lançamentos            | `GET /transactions`, `GET /transactions/{id}`, `POST /transactions/batch`                                                    |
| Recorrências           | `GET /recurrences` (gravadas pelo lote)                                                                                      |
| Cartões                | `GET /credit-cards`, `GET/PUT/DELETE /credit-cards/{id}`                                                                     |
| Compras no cartão      | `GET /credit-cards/purchases`, `GET/PUT /credit-cards/purchases/{id}`                                                        |
| Orçamentos             | `GET /budgets`, `GET/PUT/DELETE /budgets/{id}`                                                                               |
| Metas                  | `GET /goals`, `GET/PUT/DELETE /goals/{id}`                                                                                   |
| Aportes                | `GET /goals/contributions`, `PUT/DELETE /goals/contributions/{id}` (com as pernas da transferência — atômico)                |
| Ativos                 | `GET /investments/assets`, `PUT/DELETE /investments/assets/{id}`                                                             |
| Movimentações          | `GET /investments/movements`, `PUT/DELETE /investments/movements/{id}` (com o lançamento da conta — atômico)                 |
| Avaliações             | `GET /investments/valuations`, `PUT/DELETE /investments/valuations/{id}`                                                     |
| Indicadores de mercado | `GET /market/indicators` → `501` (sem provedor ainda; o front trata como indisponível)                                       |
| Histórico              | `GET /audit-log?entityType=&entityId=`                                                                                       |

Novo usuário recebe as **14 categorias padrão** (as mesmas da demonstração).

### Regras de negócio aplicadas no servidor

- **Lançamentos:** valor > 0; vínculos obrigatórios por tipo (`transfer`,
  `cardPayment`, `investment`); contrapartida ≠ conta; pago exige `paidDate`;
  conta, contrapartida, cartão, ativo e categoria precisam existir; receita/despesa
  exigem categoria do mesmo tipo; ids únicos no lote.
- **Pagamento de fatura** (`card_payment` pago): fatura derivada das compras
  (`src/modules/credit-cards/invoices.ts`, porte do front); recusa data futura,
  fatura ainda não aberta, fatura sem saldo e valor acima do saldo em aberto
  (pagamentos do mesmo lote somam). Só revalida quando o pagamento passa a liquidar mais.
- **Categorias:** nome único por tipo (sem diferenciar maiúsculas); exclusão e troca
  de tipo bloqueadas se em uso (lançamentos, recorrências, compras, orçamentos).
- **Cartões:** dias 1–31, limite > 0, conta de pagamento existente; id `purchases`
  reservado; exclusão só sem compras/pagamentos.
- **Compras:** cartão ativo, data não futura, 1–48 parcelas, categoria de despesa,
  **limite disponível** (mesma conta do front: compras ativas − faturas pagas); cancelar
  sempre permitido.
- **Orçamentos:** um ativo por categoria (ou geral) e período; categoria de despesa.
- **Metas:** valor > 0, data final > inicial, conta existente e não arquivada; exclusão
  só sem aportes; id `contributions` reservado.
- **Aportes:** meta ativa, data entre o início da meta e hoje, saldo acumulado nunca
  negativo (inclusive ao excluir). Com `transactions` (pernas da transferência), aporte e
  transferência são gravados na mesma transação; o `DELETE` remove as pernas junto.
- **Investimentos:** ticker único; tipo de movimentação compatível com a classe;
  quantidade obrigatória em compra/venda de ações/FIIs/ETFs/cripto; data não futura;
  venda acima da carteira recusada (inclusive ao excluir uma compra); troca de classe
  só se compatível; uma avaliação por ativo/data; `market_quote` só pelo servidor;
  **resgate acima do valor da posição** recusado (`src/modules/investments/position.ts`).
  Com `transaction`, movimentação e lançamento são gravados juntos; o `DELETE` remove
  o lançamento vinculado. Decisões: ADR 0015 do frontend.

## Pendências do backend

- [x] Validar **pagamento de fatura** no lote e **resgate acima da posição** (12/11/2026).
- [x] Aporte + transferência e movimentação + lançamento atômicos (12/11/2026).
- [ ] Provedor de e-mail real (interface `Mailer`).
- [ ] Indicadores de mercado e cotações (`market_quote`).
- [ ] Paginação/filtros no servidor; header `Idempotency-Key` (hoje as gravações já são
      idempotentes por id).
- [ ] Rate limit distribuído (Redis) se houver mais de uma instância; limpeza periódica
      de sessões e tokens expirados.
- [x] Testes E2E automatizados no modo API: `npm run test:e2e:api` no `fincore` sobe esta
      API com PGlite em memória na porta 8090 (12/11/2026).
- [ ] `npm audit`: avisos moderados apenas em dependências de desenvolvimento do
      `drizzle-kit` (esbuild antigo); não vão para produção.
