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

async function userWithAccount(): Promise<{ client: TestClient; accountId: string }> {
  const client = ctx.client();
  await client.register();
  const accountId = uuid();
  const response = await client.put(`/accounts/${accountId}`, accountBody(accountId));
  expect(response.statusCode).toBe(200);
  return { client, accountId };
}

async function categoryId(client: TestClient, name: string): Promise<string> {
  const list = (await client.get('/categories')).json<{ id: string; name: string }[]>();
  const found = list.find((item) => item.name === name);
  if (!found) throw new Error(`Categoria ${name} não encontrada`);
  return found.id;
}

describe('contas', () => {
  it('cria, lê e arquiva (PUT idempotente) com histórico', async () => {
    const { client, accountId } = await userWithAccount();
    const get = await client.get(`/accounts/${accountId}`);
    expect(get.json()).toEqual({
      id: accountId,
      name: 'Conta corrente',
      type: 'checking',
      institution: 'Banco Exemplo',
      initialBalance: '1000.00',
      initialBalanceDate: '2026-01-01',
      archived: false,
    });

    const archived = await client.put(
      `/accounts/${accountId}`,
      accountBody(accountId, { archived: true }),
    );
    expect(archived.json()).toMatchObject({ archived: true });

    const history = await client.get(`/audit-log?entityType=account&entityId=${accountId}`);
    expect(history.json<{ action: string }[]>().map((entry) => entry.action)).toEqual([
      'archived',
      'created',
    ]);
  });

  it('valida id da URL, formato do dinheiro e 404', async () => {
    const { client } = await userWithAccount();
    const id = uuid();
    const mismatch = await client.put(`/accounts/${id}`, accountBody(uuid()));
    expect(mismatch.json()).toMatchObject({ status: 422, code: 'ID_MISMATCH' });
    const badMoney = await client.put(`/accounts/${id}`, accountBody(id, { initialBalance: 10.5 }));
    expect(badMoney.statusCode).toBe(422);
    expect((await client.get(`/accounts/${uuid()}`)).statusCode).toBe(404);
  });

  it('isola os dados entre usuários mesmo com o mesmo id', async () => {
    const a = await userWithAccount();
    const b = ctx.client();
    await b.register('Bruno');
    expect((await b.get(`/accounts/${a.accountId}`)).statusCode).toBe(404);
    expect((await b.get('/accounts')).json()).toEqual([]);

    // B grava o mesmo id: cria um registro próprio, sem tocar no de A.
    await b.put(`/accounts/${a.accountId}`, accountBody(a.accountId, { name: 'Conta do B' }));
    const fromA = await a.client.get(`/accounts/${a.accountId}`);
    expect(fromA.json()).toMatchObject({ name: 'Conta corrente' });
  });
});

describe('categorias', () => {
  it('nome único por tipo (409) e exclusão bloqueada se em uso (409)', async () => {
    const { client, accountId } = await userWithAccount();
    const dup = await client.put(`/categories/${uuid()}`, {
      id: uuid(),
      name: 'x',
      kind: 'expense',
      nature: 'fixed',
    });
    expect(dup.json()).toMatchObject({ code: 'ID_MISMATCH' });

    const id = uuid();
    const taken = await client.put(`/categories/${id}`, { id, name: ' moradia ', kind: 'expense' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'CATEGORY_NAME_TAKEN' });

    const sameNameOtherKind = await client.put(`/categories/${id}`, {
      id,
      name: 'Moradia',
      kind: 'income',
    });
    expect(sameNameOtherKind.statusCode).toBe(200);

    const food = await categoryId(client, 'Alimentação');
    await client.post(
      '/transactions/batch',
      batch({ upsert: [transactionBody(accountId, { categoryId: food })] }),
    );
    const inUse = await client.delete(`/categories/${food}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toMatchObject({ code: 'CATEGORY_IN_USE' });

    expect((await client.delete(`/categories/${id}`)).statusCode).toBe(204);
    expect((await client.delete(`/categories/${id}`)).statusCode).toBe(404);
  });
});

describe('POST /transactions/batch', () => {
  it('grava transferência (duas pernas), lista e lê por id', async () => {
    const { client, accountId } = await userWithAccount();
    const savings = uuid();
    await client.put(
      `/accounts/${savings}`,
      accountBody(savings, { name: 'Poupança', type: 'savings' }),
    );
    const transferId = uuid();
    const out = transactionBody(accountId, {
      kind: 'transfer',
      description: 'Reserva',
      amount: '500',
      status: 'paid',
      paidDate: '2026-11-05',
      transfer: { id: transferId, direction: 'out', counterpartAccountId: savings },
    });
    const into = transactionBody(savings, {
      kind: 'transfer',
      description: 'Reserva',
      amount: '500',
      status: 'paid',
      paidDate: '2026-11-05',
      transfer: { id: transferId, direction: 'in', counterpartAccountId: accountId },
    });
    const response = await client.post('/transactions/batch', batch({ upsert: [out, into] }));
    expect(response.statusCode).toBe(204);

    const list = (await client.get('/transactions')).json<{ id: string }[]>();
    expect(list).toHaveLength(2);
    const one = await client.get(`/transactions/${out.id}`);
    expect(one.json()).toEqual({ ...out, amount: '500.00' });
  });

  it('é atômico: referência inválida → 422 e nada é gravado', async () => {
    const { client, accountId } = await userWithAccount();
    const valid = transactionBody(accountId);
    const invalid = transactionBody(uuid());
    const response = await client.post('/transactions/batch', batch({ upsert: [valid, invalid] }));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'TRANSACTION_INVALID_REFERENCE',
      errors: [{ field: 'upsert[1].accountId', message: 'Conta inexistente.' }],
    });
    expect((await client.get('/transactions')).json()).toEqual([]);
  });

  it('valida regras do lançamento (valor, vínculos, tipo da categoria)', async () => {
    const { client, accountId } = await userWithAccount();
    const salary = await categoryId(client, 'Salário');
    const cases = [
      transactionBody(accountId, { amount: '0' }),
      transactionBody(accountId, { kind: 'transfer' }),
      transactionBody(accountId, { status: 'paid', paidDate: null }),
    ];
    for (const tx of cases) {
      const response = await client.post('/transactions/batch', batch({ upsert: [tx] }));
      expect(response.statusCode).toBe(422);
    }
    const wrongKind = await client.post(
      '/transactions/batch',
      batch({ upsert: [transactionBody(accountId, { categoryId: salary })] }),
    );
    expect(wrongKind.json<{ errors: { message: string }[] }>().errors[0]?.message).toBe(
      'Despesas exigem uma categoria de despesa.',
    );
  });

  it('registra pagamento, estorno e exclusão no histórico', async () => {
    const { client, accountId } = await userWithAccount();
    const tx = transactionBody(accountId);
    await client.post('/transactions/batch', batch({ upsert: [tx] }));
    await client.post(
      '/transactions/batch',
      batch({ upsert: [{ ...tx, status: 'paid', paidDate: '2026-11-06' }] }),
    );
    await client.post(
      '/transactions/batch',
      batch({ upsert: [{ ...tx, status: 'pending', paidDate: null }] }),
    );
    await client.post('/transactions/batch', batch({ remove: [tx.id] }));

    const history = await client.get(`/audit-log?entityType=transaction&entityId=${tx.id}`);
    const entries = history.json<{ action: string; summary: string; at: string }[]>();
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'created',
      'deleted',
      'paid',
      'unpaid',
    ]);
    expect(entries.find((entry) => entry.action === 'paid')?.summary).toBe('Pago em 06/11/2026.');
    expect((await client.get(`/transactions/${tx.id}`)).statusCode).toBe(404);
  });

  it('grava e remove recorrências com ocorrências no formato `${id}_${data}`', async () => {
    const { client, accountId } = await userWithAccount();
    const housing = await categoryId(client, 'Moradia');
    const recurrence = {
      id: uuid(),
      frequency: 'monthly',
      startDate: '2026-01-10',
      endDate: null,
      template: {
        kind: 'expense',
        description: 'Aluguel',
        amount: '2200.00',
        accountId,
        categoryId: housing,
        tags: [],
        notes: null,
      },
      excludedDates: ['2026-03-10'],
    };
    const occurrence = transactionBody(accountId, {
      id: `${recurrence.id}_2026-11-10`,
      description: 'Aluguel',
      amount: '2200.00',
      categoryId: housing,
      competenceDate: '2026-11-10',
      recurrenceId: recurrence.id,
    });
    const response = await client.post(
      '/transactions/batch',
      batch({ upsert: [occurrence], upsertRecurrences: [recurrence] }),
    );
    expect(response.statusCode).toBe(204);
    expect((await client.get('/recurrences')).json()).toEqual([recurrence]);

    await client.post('/transactions/batch', batch({ removeRecurrences: [recurrence.id] }));
    expect((await client.get('/recurrences')).json()).toEqual([]);
  });

  it('valida o filtro do histórico', async () => {
    const { client } = await userWithAccount();
    expect((await client.get('/audit-log?entityType=foo&entityId=1')).statusCode).toBe(422);
  });
});
