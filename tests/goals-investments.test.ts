import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  accountBody,
  createTestApp,
  uuid,
  type TestApp,
  type TestClient,
} from './helpers/test-app.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});

async function newUser(): Promise<TestClient> {
  const client = ctx.client();
  await client.register();
  return client;
}

function goalBody(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: 'Reserva de emergência',
    description: null,
    category: 'emergency_fund',
    targetAmount: '10000.00',
    startDate: '2026-01-01',
    targetDate: '2026-12-31',
    priority: 'high',
    accountId: null,
    status: 'active',
    ...overrides,
  };
}

const contribution = (goalId: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid(),
  goalId,
  date: '2026-10-01',
  amount: '1000.00',
  type: 'deposit',
  transferId: null,
  ...overrides,
});

describe('metas', () => {
  it('valida datas e conta arquivada', async () => {
    const client = await newUser();
    const id = uuid();
    const badDates = await client.put(`/goals/${id}`, goalBody(id, { targetDate: '2026-01-01' }));
    expect(badDates.statusCode).toBe(422);

    const archived = uuid();
    await client.put(`/accounts/${archived}`, accountBody(archived, { archived: true }));
    const response = await client.put(`/goals/${id}`, goalBody(id, { accountId: archived }));
    expect(response.json()).toMatchObject({ code: 'GOAL_ACCOUNT_ARCHIVED' });
  });

  it('aportes: retirada acima do acumulado, datas, exclusões', async () => {
    const client = await newUser();
    const goalId = uuid();
    await client.put(`/goals/${goalId}`, goalBody(goalId));

    const deposit = contribution(goalId);
    expect((await client.put(`/goals/contributions/${deposit.id}`, deposit)).statusCode).toBe(200);

    const tooMuch = contribution(goalId, {
      type: 'withdrawal',
      amount: '1500.00',
      date: '2026-10-15',
    });
    const refused = await client.put(`/goals/contributions/${tooMuch.id}`, tooMuch);
    expect(refused.json()).toMatchObject({ code: 'GOAL_WITHDRAWAL_EXCEEDS_BALANCE' });

    const withdrawal = contribution(goalId, {
      type: 'withdrawal',
      amount: '400.00',
      date: '2026-10-15',
    });
    expect((await client.put(`/goals/contributions/${withdrawal.id}`, withdrawal)).statusCode).toBe(
      200,
    );

    const future = contribution(goalId, { date: '2026-11-07' });
    expect((await client.put(`/goals/contributions/${future.id}`, future)).json()).toMatchObject({
      code: 'CONTRIBUTION_FUTURE_DATE',
    });
    const beforeStart = contribution(goalId, { date: '2025-12-31' });
    expect(
      (await client.put(`/goals/contributions/${beforeStart.id}`, beforeStart)).json(),
    ).toMatchObject({
      code: 'CONTRIBUTION_BEFORE_START',
    });

    const blocked = await client.delete(`/goals/contributions/${deposit.id}`);
    expect(blocked.json()).toMatchObject({
      status: 409,
      code: 'CONTRIBUTION_REQUIRED_BY_WITHDRAWALS',
    });
    expect((await client.delete(`/goals/${goalId}`)).json()).toMatchObject({
      code: 'GOAL_HAS_CONTRIBUTIONS',
    });

    expect((await client.delete(`/goals/contributions/${withdrawal.id}`)).statusCode).toBe(204);
    expect((await client.get('/goals/contributions')).json<unknown[]>()).toHaveLength(1);

    await client.put(`/goals/${goalId}`, goalBody(goalId, { status: 'cancelled' }));
    const inactive = contribution(goalId);
    expect(
      (await client.put(`/goals/contributions/${inactive.id}`, inactive)).json(),
    ).toMatchObject({
      code: 'GOAL_INACTIVE',
    });
  });
});

describe('investimentos', () => {
  const asset = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: 'Itaúsa',
    ticker: 'ITSA4',
    assetClass: 'stocks',
    institution: 'Corretora',
    notes: null,
    ...overrides,
  });
  const movement = (assetId: string, overrides: Record<string, unknown> = {}) => ({
    id: uuid(),
    assetId,
    type: 'buy',
    date: '2026-10-01',
    quantity: '100',
    amount: '1000.00',
    transactionId: null,
    ...overrides,
  });

  it('ticker único (409) e exclusão com movimentações (409)', async () => {
    const client = await newUser();
    const id = uuid();
    expect((await client.put(`/investments/assets/${id}`, asset(id))).statusCode).toBe(200);
    const other = uuid();
    const duplicate = await client.put(
      `/investments/assets/${other}`,
      asset(other, { ticker: 'itsa4' }),
    );
    expect(duplicate.json()).toMatchObject({ status: 409, code: 'ASSET_TICKER_TAKEN' });

    const buy = movement(id);
    await client.put(`/investments/movements/${buy.id}`, buy);
    expect((await client.delete(`/investments/assets/${id}`)).json()).toMatchObject({
      code: 'ASSET_HAS_MOVEMENTS',
    });
  });

  it('tipo × classe, quantidade obrigatória e venda acima da carteira', async () => {
    const client = await newUser();
    const id = uuid();
    await client.put(`/investments/assets/${id}`, asset(id));

    const wrongType = movement(id, { type: 'contribution', quantity: null });
    expect(
      (await client.put(`/investments/movements/${wrongType.id}`, wrongType)).json(),
    ).toMatchObject({
      code: 'MOVEMENT_TYPE_NOT_ALLOWED',
    });
    const noQuantity = movement(id, { quantity: null });
    expect(
      (await client.put(`/investments/movements/${noQuantity.id}`, noQuantity)).json(),
    ).toMatchObject({
      code: 'MOVEMENT_QUANTITY_REQUIRED',
    });

    const buy = movement(id);
    const saved = await client.put(`/investments/movements/${buy.id}`, buy);
    expect(saved.json()).toMatchObject({ quantity: '100', amount: '1000.00' });

    const oversell = movement(id, { type: 'sell', quantity: '150', date: '2026-10-10' });
    expect(
      (await client.put(`/investments/movements/${oversell.id}`, oversell)).json(),
    ).toMatchObject({
      code: 'MOVEMENT_OVERSELL',
    });
    const sell = movement(id, {
      type: 'sell',
      quantity: '60.5',
      amount: '700.00',
      date: '2026-10-10',
    });
    expect((await client.put(`/investments/movements/${sell.id}`, sell)).statusCode).toBe(200);
    expect((await client.delete(`/investments/movements/${buy.id}`)).json()).toMatchObject({
      status: 409,
      code: 'MOVEMENT_REQUIRED_BY_SALES',
    });
  });

  it('avaliações: uma por data e market_quote só pelo servidor', async () => {
    const client = await newUser();
    const id = uuid();
    await client.put(`/investments/assets/${id}`, asset(id, { ticker: null, assetClass: 'cdb' }));
    const valuation = (overrides: Record<string, unknown> = {}) => ({
      id: uuid(),
      assetId: id,
      date: '2026-10-31',
      value: '1050.00',
      source: 'manual',
      ...overrides,
    });
    const first = valuation();
    expect((await client.put(`/investments/valuations/${first.id}`, first)).statusCode).toBe(200);
    const sameDate = valuation();
    expect(
      (await client.put(`/investments/valuations/${sameDate.id}`, sameDate)).json(),
    ).toMatchObject({
      code: 'VALUATION_DATE_TAKEN',
    });
    const quote = valuation({ date: '2026-11-01', source: 'market_quote' });
    expect((await client.put(`/investments/valuations/${quote.id}`, quote)).json()).toMatchObject({
      code: 'VALUATION_SOURCE_NOT_ALLOWED',
    });
    expect((await client.delete(`/investments/valuations/${first.id}`)).statusCode).toBe(204);

    const history = await client.get(`/audit-log?entityType=asset&entityId=${id}`);
    expect(history.json<unknown[]>()).toHaveLength(3);
  });

  it('indicadores de mercado ainda indisponíveis (501)', async () => {
    const client = await newUser();
    const response = await client.get('/market/indicators');
    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE' });
  });
});
