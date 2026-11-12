import { z } from 'zod';

import { money } from '../../shared/money.js';
import {
  idField,
  isoDateField,
  moneyField,
  monthKeyField,
  nullableId,
  nullableIsoDate,
  nullableText,
  requiredText,
  tagsField,
} from '../../shared/validation.js';

export const TRANSACTION_KINDS = [
  'income',
  'expense',
  'transfer',
  'card_payment',
  'investment',
] as const;

export const FREQUENCIES = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'bimonthly',
  'quarterly',
  'semiannual',
  'yearly',
] as const;

const nullableObject = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? null);

/** Transação (docs/api-contract.md → "Transação"). */
export const transactionSchema = z
  .object({
    id: idField,
    kind: z.enum(TRANSACTION_KINDS),
    description: requiredText(140),
    amount: moneyField,
    accountId: idField,
    categoryId: nullableId,
    competenceDate: isoDateField,
    dueDate: nullableIsoDate,
    paidDate: nullableIsoDate,
    status: z.enum(['pending', 'paid', 'cancelled']),
    transfer: nullableObject(
      z.object({
        id: idField,
        direction: z.enum(['in', 'out']),
        counterpartAccountId: idField,
      }),
    ),
    cardPayment: nullableObject(z.object({ cardId: idField, invoiceMonth: monthKeyField })),
    investment: nullableObject(
      z.object({ assetId: idField, direction: z.enum(['application', 'redemption']) }),
    ),
    recurrenceId: nullableId,
    installment: nullableObject(
      z.object({
        groupId: idField,
        number: z.number().int().min(1).max(480),
        total: z.number().int().min(1).max(480),
      }),
    ),
    tags: tagsField,
    notes: nullableText(1000),
  })
  .superRefine((tx, ctx) => {
    if (!money(tx.amount).greaterThan(0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'O valor deve ser maior que zero.',
      });
    }
    if ((tx.kind === 'transfer') !== (tx.transfer !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['transfer'],
        message: 'Transferências exigem o vínculo com a conta de contrapartida.',
      });
    }
    if (tx.transfer && tx.transfer.counterpartAccountId === tx.accountId) {
      ctx.addIssue({
        code: 'custom',
        path: ['transfer', 'counterpartAccountId'],
        message: 'A conta de contrapartida deve ser diferente da conta do lançamento.',
      });
    }
    if ((tx.kind === 'card_payment') !== (tx.cardPayment !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cardPayment'],
        message: 'Pagamentos de fatura exigem o cartão e o mês da fatura.',
      });
    }
    if ((tx.kind === 'investment') !== (tx.investment !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['investment'],
        message: 'Movimentações de investimento exigem o ativo e o sentido.',
      });
    }
    if (tx.installment && tx.installment.number > tx.installment.total) {
      ctx.addIssue({
        code: 'custom',
        path: ['installment', 'number'],
        message: 'O número da parcela não pode exceder o total.',
      });
    }
    if (tx.status === 'paid' && tx.paidDate === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['paidDate'],
        message: 'Lançamentos pagos exigem a data de pagamento.',
      });
    }
  });
export type TransactionInput = z.output<typeof transactionSchema>;

/** Recorrência (docs/api-contract.md → "Recorrência"). */
export const recurrenceSchema = z
  .object({
    id: idField,
    frequency: z.enum(FREQUENCIES),
    startDate: isoDateField,
    endDate: nullableIsoDate,
    template: z.object({
      kind: z.enum(['income', 'expense']),
      description: requiredText(140),
      amount: moneyField.refine(
        (value) => money(value).greaterThan(0),
        'O valor deve ser maior que zero.',
      ),
      accountId: idField,
      categoryId: nullableId,
      tags: tagsField,
      notes: nullableText(1000),
    }),
    excludedDates: z.array(isoDateField).max(1000).default([]),
  })
  .refine((rec) => rec.endDate === null || rec.endDate >= rec.startDate, {
    path: ['endDate'],
    message: 'A data final deve ser posterior à inicial.',
  });
export type RecurrenceInput = z.output<typeof recurrenceSchema>;

/** Lote atômico: tudo ou nada. */
export const batchSchema = z.object({
  upsert: z.array(transactionSchema).max(2000).default([]),
  remove: z.array(idField).max(2000).default([]),
  upsertRecurrences: z.array(recurrenceSchema).max(200).default([]),
  removeRecurrences: z.array(idField).max(200).default([]),
});
export type BatchInput = z.output<typeof batchSchema>;
