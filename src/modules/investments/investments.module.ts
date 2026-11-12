import { and, asc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { assetValuations, assets, investmentMovements, transactions } from '../../db/schema.js';
import { currentUserId } from '../../http/security.js';
import { recordAudit } from '../../shared/audit.js';
import { displayDate, type IsoDate } from '../../shared/dates.js';
import { conflict, notFound, unprocessable } from '../../shared/errors.js';
import {
  displayMoney,
  formatMoney,
  formatQuantity,
  money,
  MoneyDecimal,
} from '../../shared/money.js';
import {
  assertSameId,
  idField,
  idParams,
  isoDateField,
  moneyField,
  nullableId,
  nullableText,
  parseInput,
  positiveMoneyField,
  requiredText,
} from '../../shared/validation.js';
import { transactionSchema, type TransactionInput } from '../transactions/transactions.schemas.js';
import { applyBatch } from '../transactions/transactions.service.js';

import { CAPITAL_IN, CAPITAL_OUT, positionValue, sortMovements } from './position.js';

// ---------------------------------------------------------------------------
// Regras (ADR 0012 do frontend)
// ---------------------------------------------------------------------------

export const ASSET_CLASSES = [
  'fixed_income',
  'treasury',
  'cdb',
  'lci',
  'lca',
  'stocks',
  'reits',
  'etf',
  'funds',
  'crypto',
  'other',
] as const;

export const MOVEMENT_TYPES = [
  'contribution',
  'buy',
  'sell',
  'redemption',
  'dividend',
  'interest',
  'income',
  'fee',
  'tax',
] as const;
type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Classes negociadas em quantidade: compra/venda exigem quantidade. */
export const QUANTITY_ASSET_CLASSES: ReadonlySet<string> = new Set([
  'stocks',
  'reits',
  'etf',
  'crypto',
]);

export function allowedMovementTypes(assetClass: string): MovementType[] {
  const capital: MovementType[] = QUANTITY_ASSET_CLASSES.has(assetClass)
    ? ['buy', 'sell']
    : ['contribution', 'redemption'];
  return [...capital, 'dividend', 'interest', 'income', 'fee', 'tax'];
}

interface QuantityFlow {
  id: string;
  type: string;
  date: IsoDate;
  quantity: string | null;
}

/** Primeira venda que excede a quantidade em carteira; null se a sequência é válida. */
export function findOversell<T extends QuantityFlow>(movements: readonly T[]): T | null {
  const ordered = sortMovements(movements);
  let held = new MoneyDecimal(0);
  for (const item of ordered) {
    if (item.quantity === null) continue;
    if (CAPITAL_IN.has(item.type)) held = held.plus(item.quantity);
    else if (CAPITAL_OUT.has(item.type)) {
      held = held.minus(item.quantity);
      if (held.isNegative()) return item;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const quantityField = z
  .string()
  .regex(/^\d{1,18}(\.\d{1,10})?$/, 'Quantidade inválida.')
  .nullish()
  .transform((value) => value ?? null);

export const assetSchema = z.object({
  id: idField,
  name: requiredText(100),
  ticker: nullableText(20),
  assetClass: z.enum(ASSET_CLASSES),
  institution: z.string().trim().max(80),
  notes: nullableText(1000),
});
type AssetInput = z.output<typeof assetSchema>;

export const movementSchema = z.object({
  id: idField,
  assetId: idField,
  type: z.enum(MOVEMENT_TYPES),
  date: isoDateField,
  quantity: quantityField,
  amount: positiveMoneyField,
  transactionId: nullableId,
});
type MovementInput = z.output<typeof movementSchema>;

/**
 * Corpo do `PUT /investments/movements/{id}`: a movimentação e, opcionalmente, o
 * lançamento da conta (aplicação/resgate/proventos) gravados na mesma transação.
 */
const movementWriteSchema = movementSchema.extend({
  transaction: transactionSchema.nullish().transform((value) => value ?? null),
});
type MovementWrite = z.output<typeof movementWriteSchema>;

const INCOME_MOVEMENTS = new Set<string>(['dividend', 'interest', 'income']);

/** O lançamento enviado precisa corresponder exatamente à movimentação. */
function assertLinkedTransaction(input: MovementInput, linked: TransactionInput): void {
  const fail = (detail: string) =>
    unprocessable(detail, 'MOVEMENT_TRANSACTION_MISMATCH', 'transaction');
  if (input.transactionId !== linked.id) {
    throw fail('O lançamento deve ter o id informado em transactionId.');
  }
  if (!money(linked.amount).equals(money(input.amount)) || linked.status !== 'paid') {
    throw fail('O lançamento deve estar pago e ter o mesmo valor da movimentação.');
  }
  if (linked.paidDate !== input.date) {
    throw fail('O lançamento deve ser pago na data da movimentação.');
  }
  if (INCOME_MOVEMENTS.has(input.type)) {
    if (linked.kind !== 'income') throw fail('Proventos geram um lançamento de receita.');
    return;
  }
  const direction = CAPITAL_IN.has(input.type)
    ? 'application'
    : CAPITAL_OUT.has(input.type)
      ? 'redemption'
      : null;
  if (direction === null) {
    throw fail('Taxas e impostos não geram lançamento na conta.');
  }
  if (
    linked.kind !== 'investment' ||
    linked.investment?.assetId !== input.assetId ||
    linked.investment.direction !== direction
  ) {
    throw fail('O lançamento deve ser uma movimentação de investimento do mesmo ativo.');
  }
}

export const valuationSchema = z.object({
  id: idField,
  assetId: idField,
  date: isoDateField,
  value: moneyField,
  source: z.enum(['manual', 'market_quote', 'estimate']),
});
type ValuationInput = z.output<typeof valuationSchema>;

type AssetRow = typeof assets.$inferSelect;
type MovementRow = typeof investmentMovements.$inferSelect;
type ValuationRow = typeof assetValuations.$inferSelect;

export const toAssetDto = (row: AssetRow) => ({
  id: row.id,
  name: row.name,
  ticker: row.ticker,
  assetClass: row.assetClass,
  institution: row.institution,
  notes: row.notes,
});

export const toMovementDto = (row: MovementRow) => ({
  id: row.id,
  assetId: row.assetId,
  type: row.type,
  date: row.date,
  quantity: row.quantity === null ? null : formatQuantity(row.quantity),
  amount: formatMoney(row.amount),
  transactionId: row.transactionId,
});

export const toValuationDto = (row: ValuationRow) => ({
  id: row.id,
  assetId: row.assetId,
  date: row.date,
  value: formatMoney(row.value),
  source: row.source,
});

// ---------------------------------------------------------------------------
// Serviços
// ---------------------------------------------------------------------------

async function findAsset(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.id, id)))
    .limit(1);
  return row ?? null;
}

async function assetMovements(db: Db, userId: string, assetId: string) {
  return db
    .select()
    .from(investmentMovements)
    .where(and(eq(investmentMovements.userId, userId), eq(investmentMovements.assetId, assetId)));
}

const tickerKey = (ticker: string | null) => (ticker === null ? null : ticker.toUpperCase());

async function saveAsset(db: Db, userId: string, input: AssetInput) {
  return db.transaction(async (tx) => {
    const key = tickerKey(input.ticker);
    if (key !== null) {
      const [duplicate] = await tx
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.userId, userId), eq(assets.tickerKey, key), ne(assets.id, input.id)))
        .limit(1);
      if (duplicate) throw conflict('Já existe um ativo com este ticker.', 'ASSET_TICKER_TAKEN');
    }
    const existing = await findAsset(tx, userId, input.id);
    if (existing && existing.assetClass !== input.assetClass) {
      const allowed = new Set(allowedMovementTypes(input.assetClass));
      const movements = await assetMovements(tx, userId, input.id);
      if (movements.some((movement) => !allowed.has(movement.type as MovementType))) {
        throw unprocessable(
          'A nova classe é incompatível com as movimentações já registradas.',
          'ASSET_CLASS_INCOMPATIBLE',
          'assetClass',
        );
      }
    }
    const values = { ...input, tickerKey: key, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(assets)
      .values(values)
      .onConflictDoUpdate({ target: [assets.userId, assets.id], set: values })
      .returning();
    await recordAudit(tx, userId, [
      {
        entityType: 'asset',
        entityId: input.id,
        action: existing ? 'updated' : 'created',
        summary: existing ? `Ativo atualizado: ${input.name}.` : `Ativo cadastrado: ${input.name}.`,
      },
    ]);
    if (!row) throw new Error('Falha ao gravar o ativo.');
    return toAssetDto(row);
  });
}

async function deleteAsset(db: Db, userId: string, id: string) {
  await db.transaction(async (tx) => {
    const existing = await findAsset(tx, userId, id);
    if (!existing) throw notFound('Ativo não encontrado.');
    if ((await assetMovements(tx, userId, id)).length > 0) {
      throw conflict(
        'O ativo possui movimentações e não pode ser excluído.',
        'ASSET_HAS_MOVEMENTS',
      );
    }
    await tx
      .delete(assetValuations)
      .where(and(eq(assetValuations.userId, userId), eq(assetValuations.assetId, id)));
    await tx.delete(assets).where(and(eq(assets.userId, userId), eq(assets.id, id)));
    await recordAudit(tx, userId, [
      {
        entityType: 'asset',
        entityId: id,
        action: 'deleted',
        summary: `Ativo excluído: ${existing.name}.`,
      },
    ]);
  });
}

const MOVEMENT_LABELS: Record<MovementType, string> = {
  contribution: 'Aporte',
  buy: 'Compra',
  sell: 'Venda',
  redemption: 'Resgate',
  dividend: 'Dividendos',
  interest: 'Juros',
  income: 'Rendimentos',
  fee: 'Taxas',
  tax: 'Impostos',
};

async function saveMovement(db: Db, userId: string, body: MovementWrite, today: IsoDate) {
  const { transaction: linked, ...input } = body;
  return db.transaction(async (tx) => {
    const asset = await findAsset(tx, userId, input.assetId);
    if (!asset) throw unprocessable('Ativo inexistente.', 'ASSET_NOT_FOUND', 'assetId');
    if (input.date > today) {
      throw unprocessable('A data não pode ser futura.', 'MOVEMENT_FUTURE_DATE', 'date');
    }
    if (!allowedMovementTypes(asset.assetClass).includes(input.type)) {
      throw unprocessable(
        'Tipo de movimentação incompatível com a classe do ativo.',
        'MOVEMENT_TYPE_NOT_ALLOWED',
        'type',
      );
    }
    const needsQuantity =
      QUANTITY_ASSET_CLASSES.has(asset.assetClass) &&
      (input.type === 'buy' || input.type === 'sell');
    if (
      needsQuantity &&
      (input.quantity === null || !new MoneyDecimal(input.quantity).greaterThan(0))
    ) {
      throw unprocessable(
        'Informe a quantidade (maior que zero).',
        'MOVEMENT_QUANTITY_REQUIRED',
        'quantity',
      );
    }
    const [existing] = await tx
      .select()
      .from(investmentMovements)
      .where(and(eq(investmentMovements.userId, userId), eq(investmentMovements.id, input.id)))
      .limit(1);
    if (existing && existing.assetId !== input.assetId) {
      throw unprocessable(
        'Não é possível mover a movimentação para outro ativo.',
        'MOVEMENT_ASSET_LOCKED',
        'assetId',
      );
    }
    const others = (await assetMovements(tx, userId, input.assetId)).filter(
      (m) => m.id !== input.id,
    );
    if (findOversell([...others, input])) {
      throw unprocessable(
        'A venda excede a quantidade em carteira.',
        'MOVEMENT_OVERSELL',
        'quantity',
      );
    }
    if (input.type === 'redemption') {
      const valuations = await tx
        .select({ date: assetValuations.date, value: assetValuations.value })
        .from(assetValuations)
        .where(and(eq(assetValuations.userId, userId), eq(assetValuations.assetId, input.assetId)));
      const available = positionValue(others, valuations, input.date);
      if (money(input.amount).greaterThan(available)) {
        throw unprocessable(
          `O resgate excede o valor da posição em ${displayDate(input.date)} (${displayMoney(available)}). Atualize o valor atual antes.`,
          'MOVEMENT_EXCEEDS_POSITION',
          'amount',
        );
      }
    }
    if (linked) {
      assertLinkedTransaction(input, linked);
      await applyBatch(
        tx,
        userId,
        { upsert: [linked], remove: [], upsertRecurrences: [], removeRecurrences: [] },
        today,
      );
    }
    const values = { ...input, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(investmentMovements)
      .values(values)
      .onConflictDoUpdate({
        target: [investmentMovements.userId, investmentMovements.id],
        set: values,
      })
      .returning();
    await recordAudit(tx, userId, [
      {
        entityType: 'asset',
        entityId: input.assetId,
        action: existing ? 'updated' : 'created',
        summary: `${MOVEMENT_LABELS[input.type]} de ${displayMoney(input.amount)} em ${displayDate(input.date)} ${existing ? 'atualizada' : 'registrada'}.`,
      },
    ]);
    if (!row) throw new Error('Falha ao gravar a movimentação.');
    return toMovementDto(row);
  });
}

/** Exclui a movimentação e o lançamento vinculado (se ainda existir) juntos. */
async function deleteMovement(db: Db, userId: string, id: string, today: IsoDate) {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(investmentMovements)
      .where(and(eq(investmentMovements.userId, userId), eq(investmentMovements.id, id)))
      .limit(1);
    if (!existing) throw notFound('Movimentação não encontrada.');
    const remaining = (await assetMovements(tx, userId, existing.assetId)).filter(
      (m) => m.id !== id,
    );
    if (findOversell(remaining)) {
      throw conflict(
        'Excluir esta movimentação deixaria vendas posteriores sem quantidade.',
        'MOVEMENT_REQUIRED_BY_SALES',
      );
    }
    await tx
      .delete(investmentMovements)
      .where(and(eq(investmentMovements.userId, userId), eq(investmentMovements.id, id)));
    if (existing.transactionId !== null) {
      const [linked] = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.id, existing.transactionId)))
        .limit(1);
      if (linked) {
        await applyBatch(
          tx,
          userId,
          { upsert: [], remove: [linked.id], upsertRecurrences: [], removeRecurrences: [] },
          today,
        );
      }
    }
    await recordAudit(tx, userId, [
      {
        entityType: 'asset',
        entityId: existing.assetId,
        action: 'deleted',
        summary: `${MOVEMENT_LABELS[existing.type as MovementType]} de ${displayMoney(existing.amount)} em ${displayDate(existing.date)} excluída.`,
      },
    ]);
  });
}

async function saveValuation(db: Db, userId: string, input: ValuationInput) {
  return db.transaction(async (tx) => {
    if (input.source === 'market_quote') {
      throw unprocessable(
        'Cotações de mercado são registradas apenas pelo servidor.',
        'VALUATION_SOURCE_NOT_ALLOWED',
        'source',
      );
    }
    if (!(await findAsset(tx, userId, input.assetId))) {
      throw unprocessable('Ativo inexistente.', 'ASSET_NOT_FOUND', 'assetId');
    }
    const [sameDate] = await tx
      .select({ id: assetValuations.id })
      .from(assetValuations)
      .where(
        and(
          eq(assetValuations.userId, userId),
          eq(assetValuations.assetId, input.assetId),
          eq(assetValuations.date, input.date),
          ne(assetValuations.id, input.id),
        ),
      )
      .limit(1);
    if (sameDate) {
      throw conflict('Já existe uma avaliação deste ativo nesta data.', 'VALUATION_DATE_TAKEN');
    }
    const [existing] = await tx
      .select()
      .from(assetValuations)
      .where(and(eq(assetValuations.userId, userId), eq(assetValuations.id, input.id)))
      .limit(1);
    if (existing && existing.assetId !== input.assetId) {
      throw unprocessable(
        'Não é possível mover a avaliação para outro ativo.',
        'VALUATION_ASSET_LOCKED',
        'assetId',
      );
    }
    const values = { ...input, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(assetValuations)
      .values(values)
      .onConflictDoUpdate({ target: [assetValuations.userId, assetValuations.id], set: values })
      .returning();
    await recordAudit(tx, userId, [
      {
        entityType: 'asset',
        entityId: input.assetId,
        action: existing ? 'updated' : 'created',
        summary: `Avaliação de ${displayMoney(input.value)} em ${displayDate(input.date)} ${existing ? 'atualizada' : 'registrada'}.`,
      },
    ]);
    if (!row) throw new Error('Falha ao gravar a avaliação.');
    return toValuationDto(row);
  });
}

async function deleteValuation(db: Db, userId: string, id: string) {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(assetValuations)
      .where(and(eq(assetValuations.userId, userId), eq(assetValuations.id, id)))
      .limit(1);
    if (!existing) throw notFound('Avaliação não encontrada.');
    await tx
      .delete(assetValuations)
      .where(and(eq(assetValuations.userId, userId), eq(assetValuations.id, id)));
    await recordAudit(tx, userId, [
      {
        entityType: 'asset',
        entityId: existing.assetId,
        action: 'deleted',
        summary: `Avaliação de ${displayDate(existing.date)} excluída.`,
      },
    ]);
  });
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

export function investmentRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  app.get('/investments/assets', async (request) => {
    const rows = await db()
      .select()
      .from(assets)
      .where(eq(assets.userId, currentUserId(request)))
      .orderBy(asc(assets.name));
    return rows.map(toAssetDto);
  });

  app.put('/investments/assets/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(assetSchema, request.body);
    assertSameId(id, input.id);
    return saveAsset(db(), currentUserId(request), input);
  });

  app.delete('/investments/assets/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteAsset(db(), currentUserId(request), id);
    return reply.status(204).send();
  });

  app.get('/investments/movements', async (request) => {
    const rows = await db()
      .select()
      .from(investmentMovements)
      .where(eq(investmentMovements.userId, currentUserId(request)))
      .orderBy(asc(investmentMovements.date), asc(investmentMovements.id));
    return rows.map(toMovementDto);
  });

  app.put('/investments/movements/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(movementWriteSchema, request.body);
    assertSameId(id, input.id);
    return saveMovement(db(), currentUserId(request), input, app.deps.clock.today());
  });

  app.delete('/investments/movements/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteMovement(db(), currentUserId(request), id, app.deps.clock.today());
    return reply.status(204).send();
  });

  app.get('/investments/valuations', async (request) => {
    const rows = await db()
      .select()
      .from(assetValuations)
      .where(eq(assetValuations.userId, currentUserId(request)))
      .orderBy(asc(assetValuations.date), asc(assetValuations.id));
    return rows.map(toValuationDto);
  });

  app.put('/investments/valuations/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(valuationSchema, request.body);
    assertSameId(id, input.id);
    return saveValuation(db(), currentUserId(request), input);
  });

  app.delete('/investments/valuations/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteValuation(db(), currentUserId(request), id);
    return reply.status(204).send();
  });
}
