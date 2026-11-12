import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { goalContributions, goals, transactions } from '../../db/schema.js';
import { currentUserId } from '../../http/security.js';
import { recordAudit, type AuditAction } from '../../shared/audit.js';
import { displayDate, type IsoDate } from '../../shared/dates.js';
import { conflict, notFound, unprocessable } from '../../shared/errors.js';
import { displayMoney, formatMoney, money, MoneyDecimal } from '../../shared/money.js';
import {
  assertSameId,
  idField,
  idParams,
  isoDateField,
  nullableId,
  nullableIsoDate,
  nullableText,
  parseInput,
  positiveMoneyField,
  requiredText,
} from '../../shared/validation.js';
import { findAccount } from '../accounts/accounts.module.js';
import { transactionSchema, type TransactionInput } from '../transactions/transactions.schemas.js';
import { applyBatch } from '../transactions/transactions.service.js';

export const goalSchema = z
  .object({
    id: idField.refine((id) => id !== 'contributions', 'Identificador reservado.'),
    name: requiredText(80),
    description: nullableText(500),
    category: z.enum([
      'emergency_fund',
      'vehicle',
      'travel',
      'property',
      'equipment',
      'financial_independence',
      'other',
    ]),
    targetAmount: positiveMoneyField,
    startDate: isoDateField,
    targetDate: nullableIsoDate,
    priority: z.enum(['low', 'medium', 'high']),
    accountId: nullableId,
    status: z.enum(['active', 'completed', 'cancelled']),
  })
  .refine((goal) => goal.targetDate === null || goal.targetDate > goal.startDate, {
    path: ['targetDate'],
    message: 'A data final deve ser posterior à data inicial.',
  });
type GoalInput = z.output<typeof goalSchema>;

export const contributionSchema = z.object({
  id: idField,
  goalId: idField,
  date: isoDateField,
  amount: positiveMoneyField,
  type: z.enum(['deposit', 'withdrawal']),
  transferId: nullableId,
});
type ContributionInput = z.output<typeof contributionSchema>;

/**
 * Corpo do `PUT /goals/contributions/{id}`: o aporte e, opcionalmente, as duas
 * pernas da transferência entre contas gravadas na mesma transação do banco.
 */
const contributionWriteSchema = contributionSchema.extend({
  transactions: z.array(transactionSchema).max(2).default([]),
});
type ContributionWrite = z.output<typeof contributionWriteSchema>;

/** As pernas enviadas precisam ser a transferência do aporte, envolvendo a conta da meta. */
function assertTransferLegs(
  input: ContributionInput,
  goalAccountId: string | null,
  legs: readonly TransactionInput[],
): void {
  const fail = (detail: string) =>
    unprocessable(detail, 'CONTRIBUTION_TRANSFER_MISMATCH', 'transactions');
  if (input.transferId === null) throw fail('Informe transferId para gravar a transferência.');
  if (goalAccountId === null) throw fail('A meta não tem conta vinculada.');
  const [first, second] = legs;
  if (legs.length !== 2 || !first || !second) {
    throw fail('A transferência deve ter as duas pernas.');
  }
  for (const leg of legs) {
    if (leg.kind !== 'transfer' || leg.transfer?.id !== input.transferId) {
      throw fail('As pernas devem pertencer à transferência informada em transferId.');
    }
    if (!money(leg.amount).equals(money(input.amount))) {
      throw fail('A transferência deve ter o mesmo valor do aporte.');
    }
  }
  // Aporte: dinheiro entra na conta da meta; retirada: sai dela.
  const goalSide = input.type === 'deposit' ? 'in' : 'out';
  const goalLeg = legs.find((leg) => leg.transfer?.direction === goalSide);
  if (goalLeg?.accountId !== goalAccountId) {
    throw fail(
      input.type === 'deposit'
        ? 'A transferência do aporte deve entrar na conta da meta.'
        : 'A transferência da retirada deve sair da conta da meta.',
    );
  }
}

type GoalRow = typeof goals.$inferSelect;
type ContributionRow = typeof goalContributions.$inferSelect;

export function toGoalDto(row: GoalRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    targetAmount: formatMoney(row.targetAmount),
    startDate: row.startDate,
    targetDate: row.targetDate,
    priority: row.priority,
    accountId: row.accountId,
    status: row.status,
  };
}

export function toContributionDto(row: ContributionRow) {
  return {
    id: row.id,
    goalId: row.goalId,
    date: row.date,
    amount: formatMoney(row.amount),
    type: row.type,
    transferId: row.transferId,
  };
}

async function findGoal(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.id, id)))
    .limit(1);
  return row ?? null;
}

async function findContribution(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(goalContributions)
    .where(and(eq(goalContributions.userId, userId), eq(goalContributions.id, id)))
    .limit(1);
  return row ?? null;
}

interface Flow {
  date: IsoDate;
  amount: string;
  type: string;
}

/** Saldo acumulado nunca pode ficar negativo (depósitos antes de retiradas no mesmo dia). */
export function hasNegativeBalance(flows: readonly Flow[]): boolean {
  const ordered = [...flows].sort((a, b) =>
    a.date === b.date
      ? a.type === b.type
        ? 0
        : a.type === 'deposit'
          ? -1
          : 1
      : a.date < b.date
        ? -1
        : 1,
  );
  let balance = new MoneyDecimal(0);
  for (const flow of ordered) {
    balance = flow.type === 'deposit' ? balance.plus(flow.amount) : balance.minus(flow.amount);
    if (balance.isNegative()) return true;
  }
  return false;
}

async function goalFlows(db: Db, userId: string, goalId: string) {
  return db
    .select()
    .from(goalContributions)
    .where(and(eq(goalContributions.userId, userId), eq(goalContributions.goalId, goalId)));
}

function goalAction(existing: GoalRow | null, input: GoalInput): [AuditAction, string] {
  if (!existing)
    return ['created', `Meta criada: ${input.name} — ${displayMoney(input.targetAmount)}.`];
  if (existing.status !== input.status) {
    if (input.status === 'completed') return ['updated', 'Meta concluída.'];
    if (input.status === 'cancelled') return ['cancelled', 'Meta cancelada.'];
    return ['restored', 'Meta reativada.'];
  }
  return ['updated', 'Meta atualizada.'];
}

async function saveGoal(db: Db, userId: string, input: GoalInput) {
  return db.transaction(async (tx) => {
    const existing = await findGoal(tx, userId, input.id);
    if (input.accountId !== null) {
      const account = await findAccount(tx, userId, input.accountId);
      if (!account) throw unprocessable('Conta inexistente.', 'ACCOUNT_NOT_FOUND', 'accountId');
      const accountChanged = !existing || existing.accountId !== input.accountId;
      if (account.archived && accountChanged) {
        throw unprocessable(
          'A conta escolhida está arquivada.',
          'GOAL_ACCOUNT_ARCHIVED',
          'accountId',
        );
      }
    }
    const values = { ...input, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(goals)
      .values(values)
      .onConflictDoUpdate({ target: [goals.userId, goals.id], set: values })
      .returning();
    const [action, summary] = goalAction(existing, input);
    await recordAudit(tx, userId, [{ entityType: 'goal', entityId: input.id, action, summary }]);
    if (!row) throw new Error('Falha ao gravar a meta.');
    return toGoalDto(row);
  });
}

async function deleteGoal(db: Db, userId: string, id: string) {
  await db.transaction(async (tx) => {
    const existing = await findGoal(tx, userId, id);
    if (!existing) throw notFound('Meta não encontrada.');
    const flows = await goalFlows(tx, userId, id);
    if (flows.length > 0) {
      throw conflict(
        'A meta possui aportes. Cancele-a em vez de excluir.',
        'GOAL_HAS_CONTRIBUTIONS',
      );
    }
    await tx.delete(goals).where(and(eq(goals.userId, userId), eq(goals.id, id)));
    await recordAudit(tx, userId, [
      {
        entityType: 'goal',
        entityId: id,
        action: 'deleted',
        summary: `Meta excluída: ${existing.name}.`,
      },
    ]);
  });
}

async function saveContribution(db: Db, userId: string, body: ContributionWrite, today: IsoDate) {
  const { transactions: legs, ...input } = body;
  return db.transaction(async (tx) => {
    const goal = await findGoal(tx, userId, input.goalId);
    if (!goal) throw unprocessable('Meta inexistente.', 'GOAL_NOT_FOUND', 'goalId');
    if (goal.status !== 'active') {
      throw unprocessable('A meta não está ativa.', 'GOAL_INACTIVE', 'goalId');
    }
    if (input.date > today) {
      throw unprocessable('A data não pode ser futura.', 'CONTRIBUTION_FUTURE_DATE', 'date');
    }
    if (input.date < goal.startDate) {
      throw unprocessable(
        `A data não pode ser anterior ao início da meta (${displayDate(goal.startDate)}).`,
        'CONTRIBUTION_BEFORE_START',
        'date',
      );
    }
    const existing = await findContribution(tx, userId, input.id);
    if (existing && existing.goalId !== input.goalId) {
      throw unprocessable(
        'Não é possível mover o aporte para outra meta.',
        'CONTRIBUTION_GOAL_LOCKED',
        'goalId',
      );
    }
    const flows = (await goalFlows(tx, userId, input.goalId)).filter(
      (flow) => flow.id !== input.id,
    );
    if (hasNegativeBalance([...flows, input])) {
      throw unprocessable(
        'A retirada excede o valor acumulado na meta.',
        'GOAL_WITHDRAWAL_EXCEEDS_BALANCE',
        'amount',
      );
    }
    if (legs.length > 0) {
      assertTransferLegs(input, goal.accountId, legs);
      await applyBatch(
        tx,
        userId,
        { upsert: legs, remove: [], upsertRecurrences: [], removeRecurrences: [] },
        today,
      );
    }
    const values = { ...input, userId, updatedAt: new Date() };
    const [row] = await tx
      .insert(goalContributions)
      .values(values)
      .onConflictDoUpdate({ target: [goalContributions.userId, goalContributions.id], set: values })
      .returning();
    const verb = input.type === 'deposit' ? 'Aporte' : 'Retirada';
    await recordAudit(tx, userId, [
      {
        entityType: 'goal',
        entityId: input.goalId,
        action: existing ? 'updated' : 'created',
        summary: `${verb} de ${displayMoney(input.amount)} em ${displayDate(input.date)} ${existing ? 'atualizado' : 'registrado'}.`,
      },
    ]);
    if (!row) throw new Error('Falha ao gravar o aporte.');
    return toContributionDto(row);
  });
}

/** Exclui o aporte e as pernas da transferência vinculada (se ainda existirem) juntos. */
async function deleteContribution(db: Db, userId: string, id: string, today: IsoDate) {
  await db.transaction(async (tx) => {
    const existing = await findContribution(tx, userId, id);
    if (!existing) throw notFound('Aporte não encontrado.');
    const remaining = (await goalFlows(tx, userId, existing.goalId)).filter(
      (flow) => flow.id !== id,
    );
    if (hasNegativeBalance(remaining)) {
      throw conflict(
        'Excluir este aporte deixaria retiradas posteriores sem saldo.',
        'CONTRIBUTION_REQUIRED_BY_WITHDRAWALS',
      );
    }
    await tx
      .delete(goalContributions)
      .where(and(eq(goalContributions.userId, userId), eq(goalContributions.id, id)));
    if (existing.transferId !== null) {
      const legs = await tx
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(eq(transactions.userId, userId), eq(transactions.transferId, existing.transferId)),
        );
      if (legs.length > 0) {
        await applyBatch(
          tx,
          userId,
          {
            upsert: [],
            remove: legs.map((leg) => leg.id),
            upsertRecurrences: [],
            removeRecurrences: [],
          },
          today,
        );
      }
    }
    await recordAudit(tx, userId, [
      {
        entityType: 'goal',
        entityId: existing.goalId,
        action: 'deleted',
        summary: `${existing.type === 'deposit' ? 'Aporte' : 'Retirada'} de ${displayMoney(money(existing.amount))} excluído.`,
      },
    ]);
  });
}

export function goalRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  app.get('/goals', async (request) => {
    const rows = await db()
      .select()
      .from(goals)
      .where(eq(goals.userId, currentUserId(request)))
      .orderBy(asc(goals.name));
    return rows.map(toGoalDto);
  });

  app.get('/goals/contributions', async (request) => {
    const rows = await db()
      .select()
      .from(goalContributions)
      .where(eq(goalContributions.userId, currentUserId(request)))
      .orderBy(asc(goalContributions.date), asc(goalContributions.id));
    return rows.map(toContributionDto);
  });

  app.put('/goals/contributions/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(contributionWriteSchema, request.body);
    assertSameId(id, input.id);
    return saveContribution(db(), currentUserId(request), input, app.deps.clock.today());
  });

  app.delete('/goals/contributions/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteContribution(db(), currentUserId(request), id, app.deps.clock.today());
    return reply.status(204).send();
  });

  app.get('/goals/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const row = await findGoal(db(), currentUserId(request), id);
    if (!row) throw notFound('Meta não encontrada.');
    return toGoalDto(row);
  });

  app.put('/goals/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const input = parseInput(goalSchema, request.body);
    assertSameId(id, input.id);
    return saveGoal(db(), currentUserId(request), input);
  });

  app.delete('/goals/:id', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    await deleteGoal(db(), currentUserId(request), id);
    return reply.status(204).send();
  });
}
