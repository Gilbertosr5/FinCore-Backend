import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  SESSION_COOKIE,
  clearSessionCookie,
  currentUserId,
  loadAuth,
  setSessionCookie,
  authenticate,
} from '../../http/security.js';
import { unauthorized } from '../../shared/errors.js';
import { parseInput } from '../../shared/validation.js';

import {
  authenticateUser,
  changePassword,
  changeSchema,
  createPasswordReset,
  findUser,
  forgotSchema,
  loginSchema,
  registerSchema,
  registerUser,
  resetPassword,
  resetSchema,
} from './auth.service.js';
import { createSession, deleteSessionByToken, rotateSession } from './session.service.js';

/** Endpoints de docs/auth-contract.md (prefixo /api/v1/auth). */
export function authRoutes(app: FastifyInstance): void {
  const { config, clock, mailer } = app.deps;
  const db = () => app.deps.database.db;
  const policy = {
    idleMinutes: config.sessionIdleMinutes,
    absoluteHours: config.sessionAbsoluteHours,
  };
  const rateLimited = {
    rateLimit: { max: config.authRateLimitPerMinute, timeWindow: '1 minute' },
  };

  async function startSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
    const { token, session } = await createSession(
      db(),
      userId,
      policy,
      { userAgent: request.headers['user-agent'] ?? null, ip: request.ip },
      clock.now(),
    );
    setSessionCookie(app, reply, token, session.absoluteExpiresAt);
  }

  app.post('/auth/register', { config: rateLimited }, async (request, reply) => {
    const input = parseInput(registerSchema, request.body);
    const user = await registerUser(db(), input);
    await startSession(request, reply, user.id);
    return reply.status(201).send(user);
  });

  app.post('/auth/login', { config: rateLimited }, async (request, reply) => {
    const input = parseInput(loginSchema, request.body);
    const user = await authenticateUser(db(), input);
    // Encerra a sessão anterior deste navegador, se houver (evita fixação).
    const previous = request.cookies[SESSION_COOKIE];
    if (previous) await deleteSessionByToken(db(), previous);
    await startSession(request, reply, user.id);
    return reply.status(200).send(user);
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSessionByToken(db(), token);
    clearSessionCookie(app, reply);
    return reply.status(204).send();
  });

  app.get('/auth/me', async (request) => {
    const auth = await loadAuth(app, request);
    const user = auth ? await findUser(db(), auth.userId) : null;
    if (!user) throw unauthorized();
    return user;
  });

  app.post('/auth/refresh', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const rotated = token ? await rotateSession(db(), token, policy, clock.now()) : null;
    if (!rotated) {
      clearSessionCookie(app, reply);
      throw unauthorized('A sessão não pode ser renovada.', 'SESSION_EXPIRED');
    }
    setSessionCookie(app, reply, rotated.token, rotated.session.absoluteExpiresAt);
    return reply.status(204).send();
  });

  app.post('/auth/password/forgot', { config: rateLimited }, async (request, reply) => {
    const { email } = parseInput(forgotSchema, request.body);
    const reset = await createPasswordReset(db(), email, clock.now());
    if (reset) {
      const link = `${config.publicUrl}/redefinir-senha?token=${encodeURIComponent(reset.token)}`;
      try {
        await mailer.sendPasswordReset({ to: reset.user.email, name: reset.user.name, link });
      } catch (error) {
        request.log.error({ err: error }, 'falha ao enviar e-mail de redefinição');
      }
    }
    // Sempre 202: não revela se o e-mail existe.
    return reply.status(202).send();
  });

  app.post('/auth/password/reset', { config: rateLimited }, async (request, reply) => {
    const input = parseInput(resetSchema, request.body);
    await resetPassword(db(), input, clock.now());
    clearSessionCookie(app, reply);
    return reply.status(204).send();
  });

  app.post(
    '/auth/password/change',
    { config: rateLimited, onRequest: authenticate(app) },
    async (request, reply) => {
      const input = parseInput(changeSchema, request.body);
      const userId = currentUserId(request);
      const sessionId = request.auth?.sessionId ?? '';
      await changePassword(db(), userId, sessionId, input, clock.now());
      return reply.status(204).send();
    },
  );
}
