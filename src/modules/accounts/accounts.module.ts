import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { accounts } from '../../db/schema.js';
import { currentUserId } from '../../http/security.js';
import { recordAudit, type AuditAction } from '../../shared/audit.js';
import { displayMoney, formatMoney } from '../../shared/money.js';
import { notFound } from '../../shared/errors.js';
import {
  assertSameId,
  idField,
  idParams,
  isoDateField,
  nullableText,
  parseInput,
  requiredText,
} from '../../shared/validation.js';

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'cash',
  'digital_wallet',
  'investment',
  'other',
] as const;

/** Saldo inicial pode ser negativo (ex.: cheque especial). */
const signedMoney = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Valor monetário inválido.')
  .transform((value) => formatMoney(value));

export const accountSchema = z.object({
  id: idField,
  name: requiredText(80),
  type: z.enum(ACCOUNT_TYPES),
  institution: nullableText(80),
  initialBalance: signedMoney,
  initialBalanceDate: isoDateField,
  archived: z.boolean().default(false),
});
export type AccountInput = z.output<typeof accountSchema>;

type AccountRow = typeof accounts.$inferSelect;

export function toAccountDto(row: AccountRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    institution: row.institution,
    initialBalance: formatMoney(row.initialBalance),
    initialBalanceDate: row.initialBalanceDate,
    archived: row.archived,
  };
}

export async function findAccount(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.id, id)))
    .limit(1);
  return row ?? null;
}

function accountAction(existing: AccountRow | null, input: AccountInput): AuditAction {
  if (!existing) return 'created';
  if (!existing.archived && input.archived) return 'archived';
  if (existing.archived && !input.archived) return 'restored';
  return 'updated';
}

export async function saveAccount(db: Db, userId: string, input: AccountInput) {
  return db.transaction(async (tx) => {
    const existing = await findAccount(tx, userId, input.id);
    const values = { ...input, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(accounts)
      .values(values)
      .onConflictDoUpdate({ target: [accounts.userId, accounts.id], set: values })
      .returning();
    const action = accountAction(existing, input);
    const summaries: Record<AuditAction, string> = {
      created: `Conta criada com saldo inicial de ${displayMoney(input.initialBalance)}.`,
      archived: 'Conta arquivada.',
      restored: 'Conta reativada.',
      updated: 'Conta atualizada.',
      deleted: 'Conta excluída.',
      cancelled: 'Conta cancelada.',
      paid: 'Conta atualizada.',
      unpaid: 'Conta atualizada.',
    };
    await recordAudit(tx, userId, [
      { entityType: 'account', entityId: input.id, action, summary: summaries[action] },
    ]);
    if (!row) throw new Error('Falha ao gravar a conta.');
    return toAccountDto(row);
  });
}

export function accountRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  app.get('/accounts', async (request) => {
    const rows = await db()
      .select()
      .from(accounts)
      .where(eq(accounts.userId, currentUserId(request)))
      .orderBy(asc(accounts.name));
    return rows.map(toAccountDto);
  });

  app.get('/accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const row = await findAccount(db(), currentUserId(request), id);
    if (!row) throw notFound('Conta não encontrada.');
    return toAccountDto(row);
  });

  app.put('/accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(accountSchema, request.body);
    assertSameId(id, input.id);
    return saveAccount(db(), currentUserId(request), input);
  });
}
