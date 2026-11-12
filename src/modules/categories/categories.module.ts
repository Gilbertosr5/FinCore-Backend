import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { budgets, cardPurchases, categories, recurrences, transactions } from '../../db/schema.js';
import { currentUserId } from '../../http/security.js';
import { recordAudit } from '../../shared/audit.js';
import { conflict, notFound } from '../../shared/errors.js';
import {
  assertSameId,
  idField,
  idParams,
  parseInput,
  requiredText,
} from '../../shared/validation.js';

export const categorySchema = z.object({
  id: idField,
  name: requiredText(60),
  kind: z.enum(['income', 'expense']),
  nature: z.enum(['fixed', 'variable']).default('variable'),
});
export type CategoryInput = z.output<typeof categorySchema>;

type CategoryRow = typeof categories.$inferSelect;

export function toCategoryDto(row: CategoryRow) {
  return { id: row.id, name: row.name, kind: row.kind, nature: row.nature };
}

const nameKey = (name: string) => name.trim().toLocaleLowerCase('pt-BR');

export async function findCategory(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, id)))
    .limit(1);
  return row ?? null;
}

export async function saveCategory(db: Db, userId: string, input: CategoryInput) {
  return db.transaction(async (tx) => {
    const existing = await findCategory(tx, userId, input.id);
    const key = nameKey(input.name);
    const [duplicate] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.userId, userId),
          eq(categories.kind, input.kind),
          eq(categories.nameKey, key),
        ),
      )
      .limit(1);
    if (duplicate && duplicate.id !== input.id) {
      throw conflict('Já existe uma categoria com este nome.', 'CATEGORY_NAME_TAKEN');
    }
    if (existing && existing.kind !== input.kind && (await isCategoryInUse(tx, userId, input.id))) {
      throw conflict(
        'Não é possível trocar o tipo de uma categoria em uso.',
        'CATEGORY_KIND_LOCKED',
      );
    }
    const values = { ...input, nameKey: key, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(categories)
      .values(values)
      .onConflictDoUpdate({ target: [categories.userId, categories.id], set: values })
      .returning();
    await recordAudit(tx, userId, [
      {
        entityType: 'category',
        entityId: input.id,
        action: existing ? 'updated' : 'created',
        summary: existing
          ? `Categoria atualizada: ${input.name}.`
          : `Categoria criada: ${input.name}.`,
      },
    ]);
    if (!row) throw new Error('Falha ao gravar a categoria.');
    return toCategoryDto(row);
  });
}

async function isCategoryInUse(db: Db, userId: string, id: string): Promise<boolean> {
  const checks = await Promise.all([
    db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.categoryId, id)))
      .limit(1),
    db
      .select({ id: recurrences.id })
      .from(recurrences)
      .where(and(eq(recurrences.userId, userId), eq(recurrences.templateCategoryId, id)))
      .limit(1),
    db
      .select({ id: cardPurchases.id })
      .from(cardPurchases)
      .where(and(eq(cardPurchases.userId, userId), eq(cardPurchases.categoryId, id)))
      .limit(1),
    db
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(eq(budgets.userId, userId), eq(budgets.categoryId, id)))
      .limit(1),
  ]);
  return checks.some((rows) => rows.length > 0);
}

export async function deleteCategory(db: Db, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await findCategory(tx, userId, id);
    if (!existing) throw notFound('Categoria não encontrada.');
    if (await isCategoryInUse(tx, userId, id)) {
      throw conflict(
        'Esta categoria possui lançamentos, recorrências, compras ou orçamentos e não pode ser excluída.',
        'CATEGORY_IN_USE',
      );
    }
    await tx.delete(categories).where(and(eq(categories.userId, userId), eq(categories.id, id)));
    await recordAudit(tx, userId, [
      {
        entityType: 'category',
        entityId: id,
        action: 'deleted',
        summary: `Categoria excluída: ${existing.name}.`,
      },
    ]);
  });
}

export function categoryRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  app.get('/categories', async (request) => {
    const rows = await db()
      .select()
      .from(categories)
      .where(eq(categories.userId, currentUserId(request)))
      .orderBy(asc(categories.kind), asc(categories.name));
    return rows.map(toCategoryDto);
  });

  app.put('/categories/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(categorySchema, request.body);
    assertSameId(id, input.id);
    return saveCategory(db(), currentUserId(request), input);
  });

  app.delete('/categories/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteCategory(db(), currentUserId(request), id);
    return reply.status(204).send();
  });
}
