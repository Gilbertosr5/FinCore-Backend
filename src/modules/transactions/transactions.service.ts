import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import {
  accounts,
  assets,
  categories,
  creditCards,
  recurrences,
  transactions,
} from '../../db/schema.js';
import { recordAudit, type AuditInput } from '../../shared/audit.js';
import { displayDate } from '../../shared/dates.js';
import { AppError, type FieldError } from '../../shared/errors.js';
import { displayMoney, formatMoney } from '../../shared/money.js';

import type { BatchInput, RecurrenceInput, TransactionInput } from './transactions.schemas.js';

type TransactionRow = typeof transactions.$inferSelect;
type RecurrenceRow = typeof recurrences.$inferSelect;

// ---------------------------------------------------------------------------
// Mapeamento linha ↔ contrato
// ---------------------------------------------------------------------------

export function toTransactionDto(row: TransactionRow) {
  return {
    id: row.id,
    kind: row.kind,
    description: row.description,
    amount: formatMoney(row.amount),
    accountId: row.accountId,
    categoryId: row.categoryId,
    competenceDate: row.competenceDate,
    dueDate: row.dueDate,
    paidDate: row.paidDate,
    status: row.status,
    transfer:
      row.transferId && row.transferDirection && row.transferCounterpartAccountId
        ? {
            id: row.transferId,
            direction: row.transferDirection,
            counterpartAccountId: row.transferCounterpartAccountId,
          }
        : null,
    cardPayment:
      row.cardPaymentCardId && row.cardPaymentInvoiceMonth
        ? { cardId: row.cardPaymentCardId, invoiceMonth: row.cardPaymentInvoiceMonth }
        : null,
    investment:
      row.investmentAssetId && row.investmentDirection
        ? { assetId: row.investmentAssetId, direction: row.investmentDirection }
        : null,
    recurrenceId: row.recurrenceId,
    installment:
      row.installmentGroupId && row.installmentNumber !== null && row.installmentTotal !== null
        ? {
            groupId: row.installmentGroupId,
            number: row.installmentNumber,
            total: row.installmentTotal,
          }
        : null,
    tags: row.tags,
    notes: row.notes,
  };
}

function toTransactionValues(userId: string, tx: TransactionInput) {
  return {
    userId,
    id: tx.id,
    kind: tx.kind,
    description: tx.description,
    amount: tx.amount,
    accountId: tx.accountId,
    categoryId: tx.categoryId,
    competenceDate: tx.competenceDate,
    dueDate: tx.dueDate,
    paidDate: tx.paidDate,
    status: tx.status,
    transferId: tx.transfer?.id ?? null,
    transferDirection: tx.transfer?.direction ?? null,
    transferCounterpartAccountId: tx.transfer?.counterpartAccountId ?? null,
    cardPaymentCardId: tx.cardPayment?.cardId ?? null,
    cardPaymentInvoiceMonth: tx.cardPayment?.invoiceMonth ?? null,
    investmentAssetId: tx.investment?.assetId ?? null,
    investmentDirection: tx.investment?.direction ?? null,
    recurrenceId: tx.recurrenceId,
    installmentGroupId: tx.installment?.groupId ?? null,
    installmentNumber: tx.installment?.number ?? null,
    installmentTotal: tx.installment?.total ?? null,
    tags: tx.tags,
    notes: tx.notes,
    updatedAt: new Date(),
  };
}

export function toRecurrenceDto(row: RecurrenceRow) {
  return {
    id: row.id,
    frequency: row.frequency,
    startDate: row.startDate,
    endDate: row.endDate,
    template: {
      kind: row.templateKind,
      description: row.templateDescription,
      amount: formatMoney(row.templateAmount),
      accountId: row.templateAccountId,
      categoryId: row.templateCategoryId,
      tags: row.templateTags,
      notes: row.templateNotes,
    },
    excludedDates: row.excludedDates,
  };
}

function toRecurrenceValues(userId: string, rec: RecurrenceInput) {
  return {
    userId,
    id: rec.id,
    frequency: rec.frequency,
    startDate: rec.startDate,
    endDate: rec.endDate,
    templateKind: rec.template.kind,
    templateDescription: rec.template.description,
    templateAmount: rec.template.amount,
    templateAccountId: rec.template.accountId,
    templateCategoryId: rec.template.categoryId,
    templateTags: rec.template.tags,
    templateNotes: rec.template.notes,
    excludedDates: [...new Set(rec.excludedDates)].sort(),
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

export async function listTransactions(db: Db, userId: string) {
  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(transactions.competenceDate, transactions.id);
  return rows.map(toTransactionDto);
}

export async function findTransaction(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, userId), eq(transactions.id, id)))
    .limit(1);
  return row ?? null;
}

export async function listRecurrences(db: Db, userId: string) {
  const rows = await db
    .select()
    .from(recurrences)
    .where(eq(recurrences.userId, userId))
    .orderBy(recurrences.startDate, recurrences.id);
  return rows.map(toRecurrenceDto);
}

// ---------------------------------------------------------------------------
// Validação de referências (o cliente não é barreira de segurança)
// ---------------------------------------------------------------------------

const unique = (values: (string | null | undefined)[]) => [
  ...new Set(values.filter((value): value is string => typeof value === 'string')),
];

async function existingIds(
  db: Db,
  userId: string,
  table: typeof accounts | typeof creditCards | typeof assets,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.userId, userId), inArray(table.id, ids)));
  return new Set(rows.map((row) => row.id));
}

async function validateReferences(db: Db, userId: string, batch: BatchInput): Promise<void> {
  const errors: FieldError[] = [];
  const accountIds = unique([
    ...batch.upsert.flatMap((tx) => [tx.accountId, tx.transfer?.counterpartAccountId]),
    ...batch.upsertRecurrences.map((rec) => rec.template.accountId),
  ]);
  const categoryIds = unique([
    ...batch.upsert.map((tx) => tx.categoryId),
    ...batch.upsertRecurrences.map((rec) => rec.template.categoryId),
  ]);
  const cardIds = unique(batch.upsert.map((tx) => tx.cardPayment?.cardId));
  const assetIds = unique(batch.upsert.map((tx) => tx.investment?.assetId));

  const [knownAccounts, knownCards, knownAssets, categoryRows] = await Promise.all([
    existingIds(db, userId, accounts, accountIds),
    existingIds(db, userId, creditCards, cardIds),
    existingIds(db, userId, assets, assetIds),
    categoryIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: categories.id, kind: categories.kind })
          .from(categories)
          .where(and(eq(categories.userId, userId), inArray(categories.id, categoryIds))),
  ]);
  const categoryKinds = new Map(categoryRows.map((row) => [row.id, row.kind]));

  const checkCategory = (field: string, kind: string, categoryId: string | null) => {
    if (categoryId === null) return;
    const categoryKind = categoryKinds.get(categoryId);
    if (categoryKind === undefined) {
      errors.push({ field, message: 'Categoria inexistente.' });
    } else if ((kind === 'income' || kind === 'expense') && categoryKind !== kind) {
      errors.push({
        field,
        message:
          kind === 'income'
            ? 'Receitas exigem uma categoria de receita.'
            : 'Despesas exigem uma categoria de despesa.',
      });
    }
  };

  batch.upsert.forEach((tx, index) => {
    const at = (field: string) => `upsert[${index}].${field}`;
    if (!knownAccounts.has(tx.accountId)) {
      errors.push({ field: at('accountId'), message: 'Conta inexistente.' });
    }
    if (tx.transfer && !knownAccounts.has(tx.transfer.counterpartAccountId)) {
      errors.push({
        field: at('transfer.counterpartAccountId'),
        message: 'Conta de contrapartida inexistente.',
      });
    }
    if (tx.cardPayment && !knownCards.has(tx.cardPayment.cardId)) {
      errors.push({ field: at('cardPayment.cardId'), message: 'Cartão inexistente.' });
    }
    if (tx.investment && !knownAssets.has(tx.investment.assetId)) {
      errors.push({ field: at('investment.assetId'), message: 'Ativo inexistente.' });
    }
    checkCategory(at('categoryId'), tx.kind, tx.categoryId);
  });

  batch.upsertRecurrences.forEach((rec, index) => {
    const at = (field: string) => `upsertRecurrences[${index}].template.${field}`;
    if (!knownAccounts.has(rec.template.accountId)) {
      errors.push({ field: at('accountId'), message: 'Conta inexistente.' });
    }
    checkCategory(at('categoryId'), rec.template.kind, rec.template.categoryId);
  });

  const upsertIds = batch.upsert.map((tx) => tx.id);
  if (new Set(upsertIds).size !== upsertIds.length) {
    errors.push({ field: 'upsert', message: 'O lote contém lançamentos com id repetido.' });
  }
  if (batch.remove.some((id) => upsertIds.includes(id))) {
    errors.push({
      field: 'remove',
      message: 'Um lançamento não pode ser gravado e removido no mesmo lote.',
    });
  }

  if (errors.length > 0) {
    throw new AppError({
      status: 422,
      title: 'Dados inválidos',
      detail: errors[0]?.message,
      code: 'TRANSACTION_INVALID_REFERENCE',
      errors,
    });
  }
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------

function transactionAudit(existing: TransactionRow | null, tx: TransactionInput): AuditInput {
  const label = `${tx.description} — ${displayMoney(tx.amount)}`;
  const base = { entityType: 'transaction' as const, entityId: tx.id };
  if (!existing) return { ...base, action: 'created', summary: `Lançamento criado: ${label}.` };
  if (existing.status !== tx.status) {
    if (tx.status === 'paid') {
      return {
        ...base,
        action: 'paid',
        summary: `Pago em ${displayDate(tx.paidDate ?? tx.competenceDate)}.`,
      };
    }
    if (tx.status === 'cancelled')
      return { ...base, action: 'cancelled', summary: 'Lançamento cancelado.' };
    if (existing.status === 'paid') {
      return { ...base, action: 'unpaid', summary: 'Pagamento desfeito (voltou a pendente).' };
    }
    return { ...base, action: 'restored', summary: 'Lançamento reativado.' };
  }
  return { ...base, action: 'updated', summary: `Lançamento atualizado: ${label}.` };
}

// ---------------------------------------------------------------------------
// Lote atômico
// ---------------------------------------------------------------------------

/**
 * `POST /transactions/batch`: grava e remove lançamentos e recorrências em
 * uma única transação do banco (tudo ou nada), com o histórico junto.
 * Gravações são "cria ou substitui" (idempotentes).
 */
export async function commitBatch(db: Db, userId: string, batch: BatchInput): Promise<void> {
  await db.transaction(async (tx) => {
    await validateReferences(tx, userId, batch);
    const audit: AuditInput[] = [];

    // Recorrências primeiro: ocorrências podem referenciá-las.
    for (const rec of batch.upsertRecurrences) {
      const [existing] = await tx
        .select({ id: recurrences.id })
        .from(recurrences)
        .where(and(eq(recurrences.userId, userId), eq(recurrences.id, rec.id)))
        .limit(1);
      const values = toRecurrenceValues(userId, rec);
      await tx
        .insert(recurrences)
        .values(values)
        .onConflictDoUpdate({ target: [recurrences.userId, recurrences.id], set: values });
      audit.push({
        entityType: 'recurrence',
        entityId: rec.id,
        action: existing ? 'updated' : 'created',
        summary: existing
          ? `Recorrência atualizada: ${rec.template.description}.`
          : `Recorrência criada: ${rec.template.description} — ${displayMoney(rec.template.amount)}.`,
      });
    }

    const upsertIds = batch.upsert.map((item) => item.id);
    const existingRows =
      upsertIds.length === 0
        ? []
        : await tx
            .select()
            .from(transactions)
            .where(and(eq(transactions.userId, userId), inArray(transactions.id, upsertIds)));
    const existingById = new Map(existingRows.map((row) => [row.id, row]));

    for (const item of batch.upsert) {
      const values = toTransactionValues(userId, item);
      await tx
        .insert(transactions)
        .values(values)
        .onConflictDoUpdate({ target: [transactions.userId, transactions.id], set: values });
      audit.push(transactionAudit(existingById.get(item.id) ?? null, item));
    }

    if (batch.remove.length > 0) {
      const removed = await tx
        .delete(transactions)
        .where(and(eq(transactions.userId, userId), inArray(transactions.id, batch.remove)))
        .returning({ id: transactions.id, description: transactions.description });
      for (const row of removed) {
        audit.push({
          entityType: 'transaction',
          entityId: row.id,
          action: 'deleted',
          summary: `Lançamento excluído: ${row.description}.`,
        });
      }
    }

    if (batch.removeRecurrences.length > 0) {
      const removed = await tx
        .delete(recurrences)
        .where(
          and(eq(recurrences.userId, userId), inArray(recurrences.id, batch.removeRecurrences)),
        )
        .returning({ id: recurrences.id, description: recurrences.templateDescription });
      for (const row of removed) {
        audit.push({
          entityType: 'recurrence',
          entityId: row.id,
          action: 'deleted',
          summary: `Recorrência excluída: ${row.description}.`,
        });
      }
    }

    await recordAudit(tx, userId, audit);
  });
}
