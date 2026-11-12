import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config/env.js';
import { createDatabase, type Database } from './db/client.js';
import type { AppDeps, Clock, Mailer } from './http/context.js';
import { registerErrorHandling } from './http/error-handler.js';
import { authenticate, registerCsrf } from './http/security.js';
import { accountRoutes } from './modules/accounts/accounts.module.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { budgetRoutes } from './modules/budgets/budgets.module.js';
import { categoryRoutes } from './modules/categories/categories.module.js';
import { creditCardRoutes } from './modules/credit-cards/credit-cards.module.js';
import { goalRoutes } from './modules/goals/goals.module.js';
import { investmentRoutes } from './modules/investments/investments.module.js';
import { marketRoutes } from './modules/investments/market.routes.js';
import { transactionRoutes } from './modules/transactions/transactions.routes.js';
import { todayIn } from './shared/dates.js';
import { AppError } from './shared/errors.js';

export const API_PREFIX = '/api/v1';

export interface BuildAppOptions {
  config: AppConfig;
  database?: Database;
  clock?: Clock;
  mailer?: Mailer;
}

export function systemClock(timezone: string): Clock {
  return { now: () => new Date(), today: () => todayIn(timezone) };
}

/**
 * Mailer de desenvolvimento: registra o link no log. Em produção, troque por
 * um provedor real (SMTP/SES etc.) implementando a interface `Mailer`.
 */
function logMailer(app: () => FastifyInstance): Mailer {
  return {
    sendPasswordReset({ to, link }) {
      app().log.warn(
        { to, link },
        'Redefinição de senha (mailer de desenvolvimento — e-mail não enviado)',
      );
      return Promise.resolve();
    },
  };
}

/** Composição da aplicação (usada pelo servidor e pelos testes). */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            redact: [
              'req.headers.cookie',
              'req.headers["x-xsrf-token"]',
              'res.headers["set-cookie"]',
            ],
          },
    genReqId: (request) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
        ? incoming
        : randomUUID();
    },
    trustProxy: config.env === 'production',
    bodyLimit: 1024 * 1024,
  });

  const database = options.database ?? createDatabase(config.databaseUrl);
  if (config.migrateOnStart) await database.migrate();

  const deps: AppDeps = {
    config,
    database,
    clock: options.clock ?? systemClock(config.timezone),
    mailer: options.mailer ?? logMailer(() => app),
  };
  app.decorate('deps', deps);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('X-Request-Id', request.id);
  });
  app.addHook('onClose', async () => {
    if (!options.database) await database.close();
  });

  registerErrorHandling(app);
  await app.register(helmet, { contentSecurityPolicy: false });
  if (config.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsOrigins,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
    });
  }
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      new AppError({
        status: 429,
        title: 'Muitas requisições',
        detail: 'Muitas tentativas. Aguarde alguns instantes e tente novamente.',
        code: 'RATE_LIMITED',
        headers: { 'Retry-After': String(Math.ceil(context.ttl / 1000)) },
      }),
  });

  app.get('/health', () => ({ status: 'ok' }));

  await app.register(
    async (api) => {
      registerCsrf(api);
      authRoutes(api);

      // Tudo abaixo exige sessão válida.
      await api.register((privateApi) => {
        privateApi.addHook('onRequest', authenticate(privateApi));
        accountRoutes(privateApi);
        categoryRoutes(privateApi);
        transactionRoutes(privateApi);
        creditCardRoutes(privateApi);
        budgetRoutes(privateApi);
        goalRoutes(privateApi);
        investmentRoutes(privateApi);
        marketRoutes(privateApi);
        auditRoutes(privateApi);
        return Promise.resolve();
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}
