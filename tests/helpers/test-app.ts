import { randomUUID } from 'node:crypto';

import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import { API_PREFIX, buildApp } from '../../src/app.js';
import { testConfig, type AppConfig } from '../../src/config/env.js';
import type { Clock, Mailer } from '../../src/http/context.js';

/** Data fixa dos testes (mesma referência dos testes do frontend). */
export const TODAY = '2026-11-06';

export interface SentMail {
  to: string;
  name: string;
  link: string;
}

export interface TestApp {
  app: FastifyInstance;
  mails: SentMail[];
  clock: { now: Date };
  client: () => TestClient;
  close: () => Promise<void>;
}

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const mails: SentMail[] = [];
  const clockState = { now: new Date(`${TODAY}T12:00:00-03:00`) };
  const clock: Clock = { now: () => clockState.now, today: () => TODAY };
  const mailer: Mailer = {
    sendPasswordReset: (mail) => {
      mails.push(mail);
      return Promise.resolve();
    },
  };
  const app = await buildApp({
    config: testConfig({ authRateLimitPerMinute: 1000, ...overrides }),
    clock,
    mailer,
  });
  await app.ready();
  return {
    app,
    mails,
    clock: clockState,
    client: () => new TestClient(app),
    close: () => app.close(),
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Cliente com "pote" de cookies e envio automático do X-XSRF-TOKEN (como o axios). */
export class TestClient {
  readonly cookies = new Map<string, string>();
  sendCsrf = true;

  constructor(private readonly app: FastifyInstance) {}

  async request(method: Method, path: string, body?: unknown): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const csrf = this.cookies.get('XSRF-TOKEN');
    if (this.sendCsrf && csrf) headers['x-xsrf-token'] = csrf;
    const options: InjectOptions = { method, url: `${API_PREFIX}${path}`, headers };
    if (body !== undefined) options.payload = body as InjectOptions['payload'];
    const response = await this.app.inject(options);
    for (const cookie of response.cookies) {
      const expires = cookie.expires instanceof Date ? cookie.expires.getTime() : null;
      // clearCookie usa expires = 1970; o relógio dos testes é fixo, então não compare com agora.
      if (cookie.value === '' || (expires !== null && expires <= 0)) {
        this.cookies.delete(cookie.name);
      } else {
        this.cookies.set(cookie.name, cookie.value);
      }
    }
    return response;
  }

  get = (path: string) => this.request('GET', path);
  post = (path: string, body?: unknown) => this.request('POST', path, body ?? {});
  put = (path: string, body: unknown) => this.request('PUT', path, body);
  delete = (path: string) => this.request('DELETE', path);

  /** Obtém o cookie XSRF-TOKEN (como o frontend faz ao carregar /auth/me). */
  async bootstrap(): Promise<this> {
    await this.get('/auth/me');
    return this;
  }

  /** Cadastra um usuário novo e deixa a sessão aberta. */
  async register(name = 'Ana Silva'): Promise<{ id: string; email: string; password: string }> {
    await this.bootstrap();
    const email = `user-${randomUUID()}@exemplo.com`;
    const password = 'Senha123';
    const response = await this.post('/auth/register', { name, email, password });
    if (response.statusCode !== 201) {
      throw new Error(`Falha no cadastro: ${response.statusCode} ${response.body}`);
    }
    const user = response.json<{ id: string }>();
    return { id: user.id, email, password };
  }
}

export const uuid = (): string => randomUUID();

/** Fixtures mínimos no formato do contrato. */
export function accountBody(id: string = uuid(), overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: 'Conta corrente',
    type: 'checking',
    institution: 'Banco Exemplo',
    initialBalance: '1000.00',
    initialBalanceDate: '2026-01-01',
    archived: false,
    ...overrides,
  };
}

export function transactionBody(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    kind: 'expense',
    description: 'Mercado',
    amount: '150.25',
    accountId,
    categoryId: null,
    competenceDate: '2026-11-05',
    dueDate: null,
    paidDate: null,
    status: 'pending',
    transfer: null,
    cardPayment: null,
    investment: null,
    recurrenceId: null,
    installment: null,
    tags: [],
    notes: null,
    ...overrides,
  };
}

export function batch(body: Record<string, unknown>) {
  return { upsert: [], remove: [], upsertRecurrences: [], removeRecurrences: [], ...body };
}
