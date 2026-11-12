import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { budgets } from '../../db/schema.js';
import { currentUserId } from '../../http/security.js';
import { recordAudit, type AuditAction } from '../../shared/audit.js';
import { conflict, notFound, unprocessable } from '../../shared/errors.js';
import { displayMoney, formatMoney } from '../../shared/money.js';
import {
  assertSameId,
  idField,
  idParams,
  nullableId,
  parseInput,
  positiveMoneyField,
  requiredText,
} from '../../shared/validation.js';
import { findCategory } from '../categories/categories.module.js';

export const budgetSchema = z.object({
  id: idField,
  name: requiredText(80),
  categoryId: nullableId,
  amount: positiveMoneyField,
  period: z.enum(['monthly', 'yearly']),
  alertThresholdPercent: z.number().min(1).max(100).default(80),
  active: z.boolean().default(true),
});
type BudgetInput = z.output<typeof budgetSchema>;
type BudgetRow = typeof budgets.$inferSelect;

export function toBudgetDto(row: BudgetRow) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.categoryId,
    amount: formatMoney(row.amount),
    period: row.period,
    alertThresholdPercent: row.alertThresholdPercent,
    active: row.active,
  };
}

async function findBudget(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.userId, userId), eq(budgets.id, id)))
    .limit(1);
  return row ?? null;
}

async function saveBudget(db: Db, userId: string, input: BudgetInput) {
  return db.transaction(async (tx) => {
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
    if (input.active) {
      const [duplicate] = await tx
        .select({ id: budgets.id })
        .from(budgets)
        .where(
          and(
            eq(budgets.userId, userId),
            eq(budgets.active, true),
            eq(budgets.period, input.period),
            ne(budgets.id, input.id),
            input.categoryId === null
              ? isNull(budgets.categoryId)
              : eq(budgets.categoryId, input.categoryId),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw conflict(
          'Já existe um orçamento ativo para esta categoria e período.',
          'BUDGET_ALREADY_ACTIVE',
        );
      }
    }
    const existing = await findBudget(tx, userId, input.id);
    const values = { ...input, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(budgets)
      .values(values)
      .onConflictDoUpdate({ target: [budgets.userId, budgets.id], set: values })
      .returning();
    let action: AuditAction = 'updated';
    let summary = `Orçamento atualizado: ${input.name} — ${displayMoney(input.amount)}.`;
    if (!existing) {
      action = 'created';
      summary = `Orçamento criado: ${input.name} — ${displayMoney(input.amount)}.`;
    } else if (existing.active !== input.active) {
      action = input.active ? 'restored' : 'archived';
      summary = input.active ? 'Orçamento reativado.' : 'Orçamento desativado.';
    }
    await recordAudit(tx, userId, [{ entityType: 'budget', entityId: input.id, action, summary }]);
    if (!row) throw new Error('Falha ao gravar o orçamento.');
    return toBudgetDto(row);
  });
}

async function deleteBudget(db: Db, userId: string, id: string) {
  await db.transaction(async (tx) => {
    const existing = await findBudget(tx, userId, id);
    if (!existing) throw notFound('Orçamento não encontrado.');
    await tx.delete(budgets).where(and(eq(budgets.userId, userId), eq(budgets.id, id)));
    await recordAudit(tx, userId, [
      {
        entityType: 'budget',
        entityId: id,
        action: 'deleted',
        summary: `Orçamento excluído: ${existing.name}.`,
      },
    ]);
  });
}

export function budgetRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  app.get('/budgets', async (request) => {
    const rows = await db()
      .select()
      .from(budgets)
      .where(eq(budgets.userId, currentUserId(request)))
      .orderBy(asc(budgets.name));
    return rows.map(toBudgetDto);
  });

  app.get('/budgets/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const row = await findBudget(db(), currentUserId(request), id);
    if (!row) throw notFound('Orçamento não encontrado.');
    return toBudgetDto(row);
  });

  app.put('/budgets/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(budgetSchema, request.body);
    assertSameId(id, input.id);
    return saveBudget(db(), currentUserId(request), input);
  });

  app.delete('/budgets/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteBudget(db(), currentUserId(request), id);
    return reply.status(204).send();
  });
}
