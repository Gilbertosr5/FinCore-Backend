import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { auditLog } from '../../db/schema.js';
import { currentUserId } from '../../http/security.js';
import { AUDIT_ENTITY_TYPES } from '../../shared/audit.js';
import { idField, parseInput } from '../../shared/validation.js';

const querySchema = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES),
  entityId: idField,
});

/** `GET /audit-log?entityType=&entityId=` — mais recentes primeiro. */
export function auditRoutes(app: FastifyInstance): void {
  app.get('/audit-log', async (request) => {
    const query = parseInput(querySchema, request.query);
    const rows = await app.deps.database.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, currentUserId(request)),
          eq(auditLog.entityType, query.entityType),
          eq(auditLog.entityId, query.entityId),
        ),
      )
      .orderBy(desc(auditLog.at))
      .limit(500);
    return rows.map((row) => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      action: row.action,
      at: row.at.toISOString(),
      summary: row.summary,
    }));
  });
}
