import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  accountBody,
  batch,
  createTestApp,
  transactionBody,
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

interface Setup {
  client: TestClient;
  accountId: string;
  cardId: string;
}

function cardBody(id: string, accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: 'Roxinho',
    institution: 'Banco',
    brand: 'mastercard',
    limit: '1000.00',
    closingDay: 3,
    dueDay: 10,
    paymentAccountId: accountId,
    status: 'active',
    ...overrides,
  };
}

function purchaseBody(cardId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    cardId,
    description: 'Notebook',
    categoryId: null,
    totalAmount: '600.00',
    purchaseDate: '2026-11-01',
    installmentCount: 3,
    status: 'active',
    ...overrides,
  };
}

async function setup(): Promise<Setup> {
  const client = ctx.client();
  await client.register();
  const accountId = uuid();
  await client.put(`/accounts/${accountId}`, accountBody(accountId));
  const cardId = uuid();
  const card = await client.put(`/credit-cards/${cardId}`, cardBody(cardId, accountId));
  expect(card.statusCode).toBe(200);
  return { client, accountId, cardId };
}

describe('cartões', () => {
  it('valida dias, limite, conta de pagamento e id reservado', async () => {
    const { client, accountId } = await setup();
    const id = uuid();
    const badDay = await client.put(
      `/credit-cards/${id}`,
      cardBody(id, accountId, { closingDay: 32 }),
    );
    expect(badDay.statusCode).toBe(422);
    const zeroLimit = await client.put(
      `/credit-cards/${id}`,
      cardBody(id, accountId, { limit: '0' }),
    );
    expect(zeroLimit.statusCode).toBe(422);
    const noAccount = await client.put(`/credit-cards/${id}`, cardBody(id, uuid()));
    expect(noAccount.json()).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    const reserved = await client.put('/credit-cards/purchases', cardBody('purchases', accountId));
    expect(reserved.statusCode).toBe(422); // id reservado (rota de compras)
  });

  it('recusa compra acima do limite disponível e considera pagamentos', async () => {
    const { client, accountId, cardId } = await setup();
    expect(
      (await client.put(`/credit-cards/purchases/${uuid()}`, purchaseBody(cardId))).json(),
    ).toMatchObject({
      code: 'ID_MISMATCH',
    });

    const first = purchaseBody(cardId);
    expect((await client.put(`/credit-cards/purchases/${first.id}`, first)).statusCode).toBe(200);

    const second = purchaseBody(cardId, { totalAmount: '500.00' });
    const exceeded = await client.put(`/credit-cards/purchases/${second.id}`, second);
    expect(exceeded.statusCode).toBe(422);
    expect(exceeded.json()).toMatchObject({
      code: 'CARD_LIMIT_EXCEEDED',
      detail: 'Limite insuficiente: disponível R$ 400,00.',
    });

    // Pagamento de fatura libera limite.
    const payment = transactionBody(accountId, {
      kind: 'card_payment',
      description: 'Fatura',
      amount: '200.00',
      status: 'paid',
      paidDate: '2026-11-05',
      cardPayment: { cardId, invoiceMonth: '2026-11' },
    });
    expect(
      (await client.post('/transactions/batch', batch({ upsert: [payment] }))).statusCode,
    ).toBe(204);
    expect((await client.put(`/credit-cards/purchases/${second.id}`, second)).statusCode).toBe(200);
  });

  it('recusa data futura, cartão inativo e permite cancelar (estorno)', async () => {
    const { client, accountId, cardId } = await setup();
    const future = purchaseBody(cardId, { purchaseDate: '2026-11-07' });
    const response = await client.put(`/credit-cards/purchases/${future.id}`, future);
    expect(response.json()).toMatchObject({ code: 'PURCHASE_FUTURE_DATE' });

    const purchase = purchaseBody(cardId);
    await client.put(`/credit-cards/purchases/${purchase.id}`, purchase);
    await client.put(`/credit-cards/${cardId}`, cardBody(cardId, accountId, { status: 'blocked' }));

    const blocked = purchaseBody(cardId);
    const refused = await client.put(`/credit-cards/purchases/${blocked.id}`, blocked);
    expect(refused.json()).toMatchObject({ code: 'CARD_INACTIVE' });

    const cancel = await client.put(`/credit-cards/purchases/${purchase.id}`, {
      ...purchase,
      status: 'cancelled',
    });
    expect(cancel.json()).toMatchObject({ status: 'cancelled' });
    const history = await client.get(`/audit-log?entityType=card_purchase&entityId=${purchase.id}`);
    expect(history.json<{ action: string }[]>()[0]?.action).toBe('cancelled');
  });

  it('exclusão de cartão com compras → 409; sem uso → 204', async () => {
    const { client, accountId, cardId } = await setup();
    const purchase = purchaseBody(cardId);
    await client.put(`/credit-cards/purchases/${purchase.id}`, purchase);
    const inUse = await client.delete(`/credit-cards/${cardId}`);
    expect(inUse.json()).toMatchObject({ status: 409, code: 'CARD_IN_USE' });

    const spare = uuid();
    await client.put(`/credit-cards/${spare}`, cardBody(spare, accountId));
    expect((await client.delete(`/credit-cards/${spare}`)).statusCode).toBe(204);
    expect((await client.get('/credit-cards')).json<unknown[]>()).toHaveLength(1);
    expect((await client.get('/credit-cards/purchases')).json<unknown[]>()).toHaveLength(1);
  });
});

describe('orçamentos', () => {
  it('um único orçamento ativo por categoria e período (409)', async () => {
    const { client } = await setup();
    const body = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      name: 'Gastos do mês',
      categoryId: null,
      amount: '3000.00',
      period: 'monthly',
      alertThresholdPercent: 80,
      active: true,
      ...overrides,
    });
    const first = uuid();
    expect((await client.put(`/budgets/${first}`, body(first))).statusCode).toBe(200);
    const second = uuid();
    const duplicate = await client.put(`/budgets/${second}`, body(second));
    expect(duplicate.json()).toMatchObject({ status: 409, code: 'BUDGET_ALREADY_ACTIVE' });
    expect(
      (await client.put(`/budgets/${second}`, body(second, { period: 'yearly' }))).statusCode,
    ).toBe(200);
    expect(
      (await client.put(`/budgets/${second}`, body(second, { active: false }))).statusCode,
    ).toBe(200);

    const salary = (await client.get('/categories'))
      .json<{ id: string; kind: string }[]>()
      .find((category) => category.kind === 'income');
    const third = uuid();
    const incomeCategory = await client.put(
      `/budgets/${third}`,
      body(third, { categoryId: salary?.id }),
    );
    expect(incomeCategory.json()).toMatchObject({ code: 'CATEGORY_INVALID' });

    expect((await client.delete(`/budgets/${first}`)).statusCode).toBe(204);
    expect((await client.get(`/budgets/${first}`)).statusCode).toBe(404);
  });
});
