import { randomUUID } from 'node:crypto';

import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export const AUDIT_ENTITY_TYPES = [
  'transaction',
  'recurrence',
  'account',
  'category',
  'credit_card',
  'card_purchase',
  'budget',
  'goal',
  'asset',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export type AuditAction =
  'created' | 'updated' | 'deleted' | 'cancelled' | 'paid' | 'unpaid' | 'archived' | 'restored';

export interface AuditInput {
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  summary: string;
}

/**
 * Registra entradas do histórico. Deve ser chamado com a mesma transação da
 * alteração (`tx`) — o histórico nunca diverge dos dados.
 */
export async function recordAudit(tx: Db, userId: string, entries: AuditInput[]): Promise<void> {
  if (entries.length === 0) return;
  const at = new Date();
  await tx.insert(auditLog).values(
    entries.map((entry) => ({
      id: randomUUID(),
      userId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      at,
      summary: entry.summary,
    })),
  );
}

/** Ação para uma gravação "cria ou substitui" de registros com situação. */
export function statusAction<TStatus extends string>(
  existing: { status: TStatus } | null,
  next: TStatus,
  map: Partial<Record<TStatus, AuditAction>>,
): AuditAction {
  if (!existing) return 'created';
  if (existing.status !== next) return map[next] ?? 'updated';
  return 'updated';
}
