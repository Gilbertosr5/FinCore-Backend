import { and, asc, eq, lte, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { cardPurchases, creditCards, transactions } from '../../db/schema.js';
import { currentUserId } from '../../http/security.js';
import { recordAudit, type AuditAction } from '../../shared/audit.js';
import type { IsoDate } from '../../shared/dates.js';
import { conflict, notFound, unprocessable } from '../../shared/errors.js';
import { displayMoney, formatMoney, money, sumMoney } from '../../shared/money.js';
import {
  assertSameId,
  idField,
  idParams,
  isoDateField,
  nullableId,
  parseInput,
  positiveMoneyField,
  requiredText,
} from '../../shared/validation.js';
import { findAccount } from '../accounts/accounts.module.js';
import { findCategory } from '../categories/categories.module.js';

const dayField = z.number().int().min(1, 'Dia entre 1 e 31.').max(31, 'Dia entre 1 e 31.');

export const creditCardSchema = z.object({
  id: idField.refine((id) => id !== 'purchases', 'Identificador reservado.'),
  name: requiredText(60),
  institution: z.string().trim().max(80),
  brand: z.enum(['visa', 'mastercard', 'elo', 'amex', 'hipercard', 'other']),
  limit: positiveMoneyField,
  closingDay: dayField,
  dueDay: dayField,
  paymentAccountId: idField,
  status: z.enum(['active', 'blocked', 'cancelled']),
});
type CreditCardInput = z.output<typeof creditCardSchema>;

export const MAX_CARD_INSTALLMENTS = 48;

export const cardPurchaseSchema = z.object({
  id: idField,
  cardId: idField,
  description: requiredText(140),
  categoryId: nullableId,
  totalAmount: positiveMoneyField,
  purchaseDate: isoDateField,
  installmentCount: z
    .number()
    .int()
    .min(1, 'Mínimo de 1 parcela.')
    .max(MAX_CARD_INSTALLMENTS, `Máximo de ${MAX_CARD_INSTALLMENTS} parcelas.`),
  status: z.enum(['active', 'cancelled']),
});
type CardPurchaseInput = z.output<typeof cardPurchaseSchema>;

type CardRow = typeof creditCards.$inferSelect;
type PurchaseRow = typeof cardPurchases.$inferSelect;

export function toCreditCardDto(row: CardRow) {
  return {
    id: row.id,
    name: row.name,
    institution: row.institution,
    brand: row.brand,
    limit: formatMoney(row.limit),
    closingDay: row.closingDay,
    dueDay: row.dueDay,
    paymentAccountId: row.paymentAccountId,
    status: row.status,
  };
}

export function toCardPurchaseDto(row: PurchaseRow) {
  return {
    id: row.id,
    cardId: row.cardId,
    description: row.description,
    categoryId: row.categoryId,
    totalAmount: formatMoney(row.totalAmount),
    purchaseDate: row.purchaseDate,
    installmentCount: row.installmentCount,
    status: row.status,
  };
}

export async function findCard(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(creditCards)
    .where(and(eq(creditCards.userId, userId), eq(creditCards.id, id)))
    .limit(1);
  return row ?? null;
}

async function findPurchase(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(cardPurchases)
    .where(and(eq(cardPurchases.userId, userId), eq(cardPurchases.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * Dívida do cartão em `asOf` — mesma regra do frontend (computeCardDebt):
 * compras ativas até a data − pagamentos de fatura pagos até a data (mínimo 0).
 */
async function cardDebt(
  db: Db,
  userId: string,
  cardId: string,
  asOf: IsoDate,
  excludePurchaseId: string,
) {
  const purchases = await db
    .select({ amount: cardPurchases.totalAmount })
    .from(cardPurchases)
    .where(
      and(
        eq(cardPurchases.userId, userId),
        eq(cardPurchases.cardId, cardId),
        eq(cardPurchases.status, 'active'),
        lte(cardPurchases.purchaseDate, asOf),
        ne(cardPurchases.id, excludePurchaseId),
      ),
    );
  const payments = await db
    .select({ amount: transactions.amount })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, userId),
        eq(transactions.kind, 'card_payment'),
        eq(transactions.cardPaymentCardId, cardId),
        eq(transactions.status, 'paid'),
        lte(transactions.paidDate, asOf),
      ),
    );
  const debt = sumMoney(purchases.map((p) => p.amount)).minus(
    sumMoney(payments.map((p) => p.amount)),
  );
  return debt.isNegative() ? money(0) : debt;
}

function cardAction(existing: CardRow | null, input: CreditCardInput): [AuditAction, string] {
  if (!existing) return ['created', `Cartão criado com limite de ${displayMoney(input.limit)}.`];
  if (existing.status !== input.status) {
    if (input.status === 'cancelled') return ['cancelled', 'Cartão cancelado.'];
    if (input.status === 'blocked') return ['updated', 'Cartão bloqueado.'];
    return ['restored', 'Cartão reativado.'];
  }
  return ['updated', 'Cartão atualizado.'];
}

async function saveCard(db: Db, userId: string, input: CreditCardInput) {
  return db.transaction(async (tx) => {
    if (!(await findAccount(tx, userId, input.paymentAccountId))) {
      throw unprocessable(
        'Conta de pagamento inexistente.',
        'ACCOUNT_NOT_FOUND',
        'paymentAccountId',
      );
    }
    const existing = await findCard(tx, userId, input.id);
    const values = { ...input, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(creditCards)
      .values(values)
      .onConflictDoUpdate({ target: [creditCards.userId, creditCards.id], set: values })
      .returning();
    const [action, summary] = cardAction(existing, input);
    await recordAudit(tx, userId, [
      { entityType: 'credit_card', entityId: input.id, action, summary },
    ]);
    if (!row) throw new Error('Falha ao gravar o cartão.');
    return toCreditCardDto(row);
  });
}

async function deleteCard(db: Db, userId: string, id: string) {
  await db.transaction(async (tx) => {
    const card = await findCard(tx, userId, id);
    if (!card) throw notFound('Cartão não encontrado.');
    const [purchase] = await tx
      .select({ id: cardPurchases.id })
      .from(cardPurchases)
      .where(and(eq(cardPurchases.userId, userId), eq(cardPurchases.cardId, id)))
      .limit(1);
    const [payment] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.cardPaymentCardId, id)))
      .limit(1);
    if (purchase || payment) {
      throw conflict(
        'O cartão possui compras ou pagamentos. Cancele-o em vez de excluir.',
        'CARD_IN_USE',
      );
    }
    await tx.delete(creditCards).where(and(eq(creditCards.userId, userId), eq(creditCards.id, id)));
    await recordAudit(tx, userId, [
      {
        entityType: 'credit_card',
        entityId: id,
        action: 'deleted',
        summary: `Cartão excluído: ${card.name}.`,
      },
    ]);
  });
}

async function savePurchase(db: Db, userId: string, input: CardPurchaseInput, today: IsoDate) {
  return db.transaction(async (tx) => {
    const card = await findCard(tx, userId, input.cardId);
    if (!card) throw unprocessable('Cartão inexistente.', 'CARD_NOT_FOUND', 'cardId');
    if (input.categoryId !== null) {
      const category = await findCategory(tx, userId, input.categoryId);
      if (!category || category.kind !== 'expense') {
        throw unprocessable(
          'Informe uma categoria de despesa válida.',
          'CATEGORY_INVALID',
          'categoryId',
        );
      }
    }
    if (input.purchaseDate > today) {
      throw unprocessable(
        'A data da compra não pode ser futura.',
        'PURCHASE_FUTURE_DATE',
        'purchaseDate',
      );
    }
    const existing = await findPurchase(tx, userId, input.id);
    if (existing && existing.cardId !== input.cardId) {
      throw unprocessable(
        'Não é possível mover a compra para outro cartão.',
        'PURCHASE_CARD_LOCKED',
        'cardId',
      );
    }

    if (input.status === 'active') {
      const changesBalance =
        !existing ||
        existing.status !== 'active' ||
        money(input.totalAmount).greaterThan(existing.totalAmount) ||
        input.purchaseDate !== existing.purchaseDate;
      if (changesBalance) {
        if (card.status !== 'active') {
          throw unprocessable('O cartão não está ativo.', 'CARD_INACTIVE', 'cardId');
        }
        const debt = await cardDebt(tx, userId, card.id, today, input.id);
        const available = money(card.limit).minus(debt);
        if (money(input.totalAmount).greaterThan(available)) {
          throw unprocessable(
            `Limite insuficiente: disponível ${displayMoney(available.isNegative() ? money(0) : available)}.`,
            'CARD_LIMIT_EXCEEDED',
            'totalAmount',
          );
        }
      }
    }

    const values = { ...input, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(cardPurchases)
      .values(values)
      .onConflictDoUpdate({ target: [cardPurchases.userId, cardPurchases.id], set: values })
      .returning();

    let action: AuditAction = 'updated';
    let summary = `Compra atualizada: ${input.description}.`;
    if (!existing) {
      action = 'created';
      summary = `Compra registrada: ${input.description} — ${displayMoney(input.totalAmount)} em ${input.installmentCount}x.`;
    } else if (existing.status !== input.status) {
      action = input.status === 'cancelled' ? 'cancelled' : 'restored';
      summary =
        input.status === 'cancelled' ? 'Compra cancelada (estorno integral).' : 'Compra reativada.';
    }
    await recordAudit(tx, userId, [
      { entityType: 'card_purchase', entityId: input.id, action, summary },
    ]);
    if (!row) throw new Error('Falha ao gravar a compra.');
    return toCardPurchaseDto(row);
  });
}

export function creditCardRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  app.get('/credit-cards', async (request) => {
    const rows = await db()
      .select()
      .from(creditCards)
      .where(eq(creditCards.userId, currentUserId(request)))
      .orderBy(asc(creditCards.name));
    return rows.map(toCreditCardDto);
  });

  // Rotas estáticas têm prioridade sobre `/credit-cards/:id` no roteador.
  app.get('/credit-cards/purchases', async (request) => {
    const rows = await db()
      .select()
      .from(cardPurchases)
      .where(eq(cardPurchases.userId, currentUserId(request)))
      .orderBy(asc(cardPurchases.purchaseDate), asc(cardPurchases.id));
    return rows.map(toCardPurchaseDto);
  });

  app.get('/credit-cards/purchases/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const row = await findPurchase(db(), currentUserId(request), id);
    if (!row) throw notFound('Compra não encontrada.');
    return toCardPurchaseDto(row);
  });

  app.put('/credit-cards/purchases/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(cardPurchaseSchema, request.body);
    assertSameId(id, input.id);
    return savePurchase(db(), currentUserId(request), input, app.deps.clock.today());
  });

  app.get('/credit-cards/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const row = await findCard(db(), currentUserId(request), id);
    if (!row) throw notFound('Cartão não encontrado.');
    return toCreditCardDto(row);
  });

  app.put('/credit-cards/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(creditCardSchema, request.body);
    assertSameId(id, input.id);
    return saveCard(db(), currentUserId(request), input);
  });

  app.delete('/credit-cards/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteCard(db(), currentUserId(request), id);
    return reply.status(204).send();
  });
}
