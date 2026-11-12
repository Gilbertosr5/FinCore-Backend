import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  allocate,
  invoiceMonthForPurchase,
  invoiceTotal,
  openInvoiceMonth,
} from '../src/modules/credit-cards/invoices.js';
import { positionValue } from '../src/modules/investments/position.js';

import {
  accountBody,
  batch,
  createTestApp,
  transactionBody,
  uuid,
  type TestApp,
  type TestClient,
} from './helpers/test-app.js';

/**
 * Regras que antes só o cliente aplicava (ADR 0015): pagamento de fatura,
 * resgate acima da posição e gravações atômicas de aporte/movimentação com
 * seus lançamentos.
 */

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

async function createAccount(client: TestClient, overrides: Record<string, unknown> = {}) {
  const id = uuid();
  const response = await client.put(`/accounts/${id}`, accountBody(id, overrides));
  expect(response.statusCode).toBe(200);
  return id;
}

async function transactionIds(client: TestClient): Promise<string[]> {
  return (await client.get('/transactions')).json<{ id: string }[]>().map((tx) => tx.id);
}

describe('calendário de faturas (porte do frontend)', () => {
  const card = { closingDay: 3, dueDay: 10 };

  it('compra antes do fechamento entra no mês; no fechamento ou depois, no seguinte', () => {
    expect(invoiceMonthForPurchase(card, '2026-11-02')).toBe('2026-11');
    expect(invoiceMonthForPurchase(card, '2026-11-03')).toBe('2026-12');
    expect(invoiceMonthForPurchase({ closingDay: 31, dueDay: 8 }, '2026-02-28')).toBe('2026-03');
    expect(openInvoiceMonth(card, '2026-12-20')).toBe('2027-01');
  });

  it('parcelas somam o total com o centavo residual nas primeiras', () => {
    expect(allocate('100.00', 3).map((value) => value.toFixed(2))).toEqual([
      '33.34',
      '33.33',
      '33.33',
    ]);
    const purchases = [
      { totalAmount: '100.00', purchaseDate: '2026-11-01', installmentCount: 3, status: 'active' },
      {
        totalAmount: '50.00',
        purchaseDate: '2026-11-01',
        installmentCount: 1,
        status: 'cancelled',
      },
    ];
    expect(invoiceTotal(card, purchases, '2026-11').toFixed(2)).toBe('33.34');
    expect(invoiceTotal(card, purchases, '2027-01').toFixed(2)).toBe('33.33');
    expect(invoiceTotal(card, purchases, '2027-02').toFixed(2)).toBe('0.00');
  });
});

describe('valor da posição (porte do frontend)', () => {
  it('usa a última avaliação mais o fluxo posterior; sem avaliação, o custo', () => {
    const movements = [
      { type: 'contribution', date: '2026-10-01', quantity: null, amount: '1000.00' },
      { type: 'contribution', date: '2026-11-02', quantity: null, amount: '200.00' },
    ];
    expect(positionValue(movements, [], '2026-11-06').toFixed(2)).toBe('1200.00');
    const valuations = [{ date: '2026-10-31', value: '1050.00' }];
    expect(positionValue(movements, valuations, '2026-11-06').toFixed(2)).toBe('1250.00');
    expect(positionValue(movements, valuations, '2026-10-31').toFixed(2)).toBe('1050.00');
  });
});

describe('pagamento de fatura no lote', () => {
  // Hoje = 2026-11-06; fecha dia 3 → fatura aberta = 2026-12.
  async function setup() {
    const client = await newUser();
    const accountId = await createAccount(client);
    const cardId = uuid();
    await client.put(`/credit-cards/${cardId}`, {
      id: cardId,
      name: 'Roxinho',
      institution: 'Banco',
      brand: 'mastercard',
      limit: '5000.00',
      closingDay: 3,
      dueDay: 10,
      paymentAccountId: accountId,
      status: 'active',
    });
    const purchaseId = uuid();
    const purchase = await client.put(`/credit-cards/purchases/${purchaseId}`, {
      id: purchaseId,
      cardId,
      description: 'Notebook',
      categoryId: null,
      totalAmount: '600.00',
      purchaseDate: '2026-11-01', // 3× 200: faturas 2026-11, 2026-12, 2027-01
      installmentCount: 3,
      status: 'active',
    });
    expect(purchase.statusCode).toBe(200);
    const payment = (invoiceMonth: string, overrides: Record<string, unknown> = {}) =>
      transactionBody(accountId, {
        kind: 'card_payment',
        description: 'Pagamento fatura',
        amount: '200.00',
        competenceDate: '2026-11-05',
        paidDate: '2026-11-05',
        status: 'paid',
        cardPayment: { cardId, invoiceMonth },
        ...overrides,
      });
    return { client, payment };
  }

  it('aceita parcial e antecipado; recusa acima do saldo, fatura futura e data futura', async () => {
    const { client, payment } = await setup();
    const partial = payment('2026-11', { amount: '150.00' });
    expect(
      (await client.post('/transactions/batch', batch({ upsert: [partial] }))).statusCode,
    ).toBe(204);
    // Regravar o mesmo pagamento (ex.: mudar a descrição) não revalida o saldo.
    const renamed = { ...partial, description: 'Fatura de novembro' };
    expect(
      (await client.post('/transactions/batch', batch({ upsert: [renamed] }))).statusCode,
    ).toBe(204);

    const tooMuch = await client.post(
      '/transactions/batch',
      batch({ upsert: [payment('2026-11', { amount: '50.01' })] }),
    );
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json()).toMatchObject({ code: 'CARD_PAYMENT_EXCEEDS_OUTSTANDING' });
    expect(tooMuch.json<{ detail: string }>().detail).toContain('R$ 50,00');

    const rest = payment('2026-11', { amount: '50.00' });
    expect((await client.post('/transactions/batch', batch({ upsert: [rest] }))).statusCode).toBe(
      204,
    );
    const settled = await client.post(
      '/transactions/batch',
      batch({ upsert: [payment('2026-11', { amount: '1.00' })] }),
    );
    expect(settled.json()).toMatchObject({ code: 'INVOICE_NOT_PAYABLE' });

    // Fatura aberta (2026-12) pode ser antecipada; a de 2027-01 ainda é futura.
    const early = payment('2026-12');
    expect((await client.post('/transactions/batch', batch({ upsert: [early] }))).statusCode).toBe(
      204,
    );
    const future = await client.post(
      '/transactions/batch',
      batch({ upsert: [payment('2027-01')] }),
    );
    expect(future.json()).toMatchObject({ code: 'INVOICE_NOT_OPEN' });

    const futureDate = await client.post(
      '/transactions/batch',
      batch({ upsert: [payment('2026-12', { paidDate: '2026-11-07', amount: '1.00' })] }),
    );
    expect(futureDate.json()).toMatchObject({ code: 'CARD_PAYMENT_FUTURE_DATE' });
  });

  it('soma os pagamentos do mesmo lote e libera saldo ao estornar', async () => {
    const { client, payment } = await setup();
    const first = payment('2026-11', { amount: '120.00' });
    const second = payment('2026-11', { amount: '100.00' });
    const both = await client.post('/transactions/batch', batch({ upsert: [first, second] }));
    expect(both.json()).toMatchObject({ code: 'CARD_PAYMENT_EXCEEDS_OUTSTANDING' });
    expect(await transactionIds(client)).toEqual([]); // tudo ou nada

    expect((await client.post('/transactions/batch', batch({ upsert: [first] }))).statusCode).toBe(
      204,
    );
    // Estorno (cancelado) + novo pagamento integral no mesmo lote.
    const reversed = { ...first, status: 'cancelled', paidDate: null };
    const full = payment('2026-11');
    const response = await client.post('/transactions/batch', batch({ upsert: [reversed, full] }));
    expect(response.statusCode).toBe(204);
  });
});

describe('resgate acima do valor da posição', () => {
  it('recusa resgate maior que a última avaliação ajustada', async () => {
    const client = await newUser();
    const assetId = uuid();
    await client.put(`/investments/assets/${assetId}`, {
      id: assetId,
      name: 'CDB Banco',
      ticker: null,
      assetClass: 'cdb',
      institution: 'Banco',
      notes: null,
    });
    const move = (overrides: Record<string, unknown>) => ({
      id: uuid(),
      assetId,
      type: 'contribution',
      date: '2026-10-01',
      quantity: null,
      amount: '1000.00',
      transactionId: null,
      ...overrides,
    });
    const contribution = move({});
    await client.put(`/investments/movements/${contribution.id}`, contribution);

    const aboveCost = move({ type: 'redemption', date: '2026-10-20', amount: '1000.01' });
    const refused = await client.put(`/investments/movements/${aboveCost.id}`, aboveCost);
    expect(refused.json()).toMatchObject({ status: 422, code: 'MOVEMENT_EXCEEDS_POSITION' });

    const valuationId = uuid();
    await client.put(`/investments/valuations/${valuationId}`, {
      id: valuationId,
      assetId,
      date: '2026-10-31',
      value: '1050.00',
      source: 'manual',
    });
    const tooMuch = move({ type: 'redemption', date: '2026-11-05', amount: '1050.01' });
    expect(
      (await client.put(`/investments/movements/${tooMuch.id}`, tooMuch)).json(),
    ).toMatchObject({ code: 'MOVEMENT_EXCEEDS_POSITION' });
    const all = move({ type: 'redemption', date: '2026-11-05', amount: '1050.00' });
    expect((await client.put(`/investments/movements/${all.id}`, all)).statusCode).toBe(200);
  });
});

describe('gravações atômicas', () => {
  it('movimentação + lançamento na mesma requisição; exclusão leva o lançamento', async () => {
    const client = await newUser();
    const accountId = await createAccount(client);
    const assetId = uuid();
    await client.put(`/investments/assets/${assetId}`, {
      id: assetId,
      name: 'Tesouro Selic',
      ticker: null,
      assetClass: 'treasury',
      institution: 'Tesouro',
      notes: null,
    });
    const transactionId = uuid();
    const linked = transactionBody(accountId, {
      id: transactionId,
      kind: 'investment',
      description: 'Aplicação — Tesouro Selic',
      amount: '500.00',
      competenceDate: '2026-11-03',
      paidDate: '2026-11-03',
      status: 'paid',
      investment: { assetId, direction: 'application' },
    });
    const movementId = uuid();
    const body = {
      id: movementId,
      assetId,
      type: 'contribution',
      date: '2026-11-03',
      quantity: null,
      amount: '500.00',
      transactionId,
    };

    const mismatch = await client.put(`/investments/movements/${movementId}`, {
      ...body,
      transaction: { ...linked, amount: '499.00' },
    });
    expect(mismatch.json()).toMatchObject({ code: 'MOVEMENT_TRANSACTION_MISMATCH' });
    // Lançamento com conta inexistente: nada é gravado (nem a movimentação).
    const badAccount = await client.put(`/investments/movements/${movementId}`, {
      ...body,
      transaction: { ...linked, accountId: uuid() },
    });
    expect(badAccount.statusCode).toBe(422);
    expect((await client.get('/investments/movements')).json<unknown[]>()).toHaveLength(0);
    expect(await transactionIds(client)).toEqual([]);

    const saved = await client.put(`/investments/movements/${movementId}`, {
      ...body,
      transaction: linked,
    });
    expect(saved.statusCode).toBe(200);
    expect(await transactionIds(client)).toEqual([transactionId]);

    expect((await client.delete(`/investments/movements/${movementId}`)).statusCode).toBe(204);
    expect(await transactionIds(client)).toEqual([]);
  });

  it('aporte + transferência na mesma requisição; exclusão leva as pernas', async () => {
    const client = await newUser();
    const goalAccount = await createAccount(client, { name: 'Reserva', type: 'savings' });
    const checking = await createAccount(client);
    const goalId = uuid();
    await client.put(`/goals/${goalId}`, {
      id: goalId,
      name: 'Reserva de emergência',
      description: null,
      category: 'emergency_fund',
      targetAmount: '10000.00',
      startDate: '2026-01-01',
      targetDate: null,
      priority: 'high',
      accountId: goalAccount,
      status: 'active',
    });
    const transferId = uuid();
    const leg = (accountId: string, counterpart: string, direction: 'in' | 'out') =>
      transactionBody(accountId, {
        kind: 'transfer',
        description: 'Aporte na meta "Reserva de emergência"',
        amount: '300.00',
        competenceDate: '2026-11-04',
        paidDate: '2026-11-04',
        status: 'paid',
        transfer: { id: transferId, direction, counterpartAccountId: counterpart },
      });
    const legs = [leg(checking, goalAccount, 'out'), leg(goalAccount, checking, 'in')];
    const contributionId = uuid();
    const body = {
      id: contributionId,
      goalId,
      date: '2026-11-04',
      amount: '300.00',
      type: 'deposit',
      transferId,
    };

    // Transferência ao contrário (saindo da conta da meta) não serve para um aporte.
    const reversed = [leg(goalAccount, checking, 'out'), leg(checking, goalAccount, 'in')];
    const wrong = await client.put(`/goals/contributions/${contributionId}`, {
      ...body,
      transactions: reversed,
    });
    expect(wrong.json()).toMatchObject({ code: 'CONTRIBUTION_TRANSFER_MISMATCH' });
    expect(await transactionIds(client)).toEqual([]);

    const saved = await client.put(`/goals/contributions/${contributionId}`, {
      ...body,
      transactions: legs,
    });
    expect(saved.statusCode).toBe(200);
    expect((await transactionIds(client)).sort()).toEqual(legs.map((item) => item.id).sort());

    expect((await client.delete(`/goals/contributions/${contributionId}`)).statusCode).toBe(204);
    expect(await transactionIds(client)).toEqual([]);
    expect((await client.get('/goals/contributions')).json<unknown[]>()).toHaveLength(0);
  });
});
