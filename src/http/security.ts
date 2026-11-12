import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { resolveSession } from '../modules/auth/session.service.js';
import { AppError, unauthorized } from '../shared/errors.js';

import type { AuthContext } from './context.js';

export const SESSION_COOKIE = 'fincore_session';
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'x-xsrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * CSRF por "double submit cookie" (mesmo padrão do CookieCsrfTokenRepository
 * do Spring, já usado pelo axios do frontend): o cookie XSRF-TOKEN é legível
 * pelo JS e deve voltar no header X-XSRF-TOKEN em toda requisição que altera
 * estado. O cookie é emitido na primeira resposta (ex.: GET /auth/me).
 */
export function registerCsrf(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const { config } = app.deps;
    const cookieToken = request.cookies[CSRF_COOKIE];
    if (!cookieToken) {
      void reply.setCookie(CSRF_COOKIE, randomBytes(24).toString('base64url'), {
        path: '/',
        httpOnly: false,
        sameSite: 'lax',
        secure: config.cookieSecure,
      });
    }
    if (SAFE_METHODS.has(request.method)) return;
    const header = request.headers[CSRF_HEADER];
    // Sem cookie prévio a requisição ainda não tem como provar a origem.
    if (!cookieToken || typeof header !== 'string' || !safeEqual(header, cookieToken)) {
      throw new AppError({
        status: 403,
        title: 'Acesso negado',
        detail: 'Token CSRF ausente ou inválido. Recarregue a página e tente novamente.',
        code: 'CSRF_TOKEN_INVALID',
      });
    }
  });
}

export function sessionCookieOptions(app: FastifyInstance, expires?: Date) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: app.deps.config.cookieSecure,
    ...(expires ? { expires } : {}),
  };
}

export function setSessionCookie(
  app: FastifyInstance,
  reply: FastifyReply,
  token: string,
  expires: Date,
): void {
  void reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(app, expires));
}

export function clearSessionCookie(app: FastifyInstance, reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(app));
}

/** Resolve a sessão do cookie (sem exigir). */
export async function loadAuth(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<AuthContext | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const { database, config, clock } = app.deps;
  const session = await resolveSession(
    database.db,
    token,
    { idleMinutes: config.sessionIdleMinutes, absoluteHours: config.sessionAbsoluteHours },
    clock.now(),
  );
  return session ? { userId: session.userId, sessionId: session.sessionId } : null;
}

/** Hook para rotas protegidas: 401 sem sessão válida. */
export function authenticate(app: FastifyInstance) {
  return async (request: FastifyRequest) => {
    request.auth = await loadAuth(app, request);
    if (!request.auth) throw unauthorized();
  };
}

/** Usuário autenticado da requisição (após o hook `authenticate`). */
export function currentUserId(request: FastifyRequest): string {
  if (!request.auth) throw unauthorized();
  return request.auth.userId;
}
