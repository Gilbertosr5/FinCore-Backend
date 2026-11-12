import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, eq, ne } from 'drizzle-orm';

import type { Db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';

export interface SessionPolicy {
  idleMinutes: number;
  absoluteHours: number;
}

export interface SessionMeta {
  userAgent: string | null;
  ip: string | null;
}

export interface ActiveSession {
  sessionId: string;
  userId: string;
  absoluteExpiresAt: Date;
}

/** Token opaco de 256 bits; só o hash SHA-256 vai para o banco. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const minutes = (value: number) => value * 60_000;

/** Só regrava `last_seen_at` se passou mais de 1 minuto (evita escrita a cada requisição). */
const TOUCH_INTERVAL_MS = 60_000;

export async function createSession(
  db: Db,
  userId: string,
  policy: SessionPolicy,
  meta: SessionMeta,
  now = new Date(),
): Promise<{ token: string; session: ActiveSession }> {
  const token = newToken();
  const absoluteExpiresAt = new Date(now.getTime() + minutes(policy.absoluteHours * 60));
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    userId,
    tokenHash: hashToken(token),
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: new Date(now.getTime() + minutes(policy.idleMinutes)),
    absoluteExpiresAt,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ip: meta.ip,
  });
  return { token, session: { sessionId: id, userId, absoluteExpiresAt } };
}

/** Sessão válida para o token (expiração por inatividade deslizante). */
export async function resolveSession(
  db: Db,
  token: string,
  policy: SessionPolicy,
  now = new Date(),
): Promise<ActiveSession | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return null;
  if (row.idleExpiresAt <= now || row.absoluteExpiresAt <= now) {
    await db.delete(sessions).where(eq(sessions.id, row.id));
    return null;
  }
  if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(sessions)
      .set({
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + minutes(policy.idleMinutes)),
      })
      .where(eq(sessions.id, row.id));
  }
  return { sessionId: row.id, userId: row.userId, absoluteExpiresAt: row.absoluteExpiresAt };
}

/**
 * Renovação (`POST /auth/refresh`): troca o token (rotação) e estende a
 * inatividade, sem ultrapassar o limite absoluto da sessão.
 */
export async function rotateSession(
  db: Db,
  token: string,
  policy: SessionPolicy,
  now = new Date(),
): Promise<{ token: string; session: ActiveSession } | null> {
  const current = await resolveSession(db, token, policy, now);
  if (!current) return null;
  const next = newToken();
  await db
    .update(sessions)
    .set({
      tokenHash: hashToken(next),
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + minutes(policy.idleMinutes)),
    })
    .where(eq(sessions.id, current.sessionId));
  return { token: next, session: current };
}

export async function deleteSessionByToken(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Encerra todas as sessões do usuário (opcionalmente mantendo a atual). */
export async function deleteUserSessions(
  db: Db,
  userId: string,
  exceptSessionId?: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(
      exceptSessionId === undefined
        ? eq(sessions.userId, userId)
        : and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId)),
    );
}
