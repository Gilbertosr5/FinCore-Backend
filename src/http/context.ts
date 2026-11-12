import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/client.js';
import type { IsoDate } from '../shared/dates.js';

export interface Clock {
  now(): Date;
  /** "Hoje" no fuso da aplicação (regras de data futura etc.). */
  today(): IsoDate;
}

export interface Mailer {
  sendPasswordReset(input: { to: string; name: string; link: string }): Promise<void>;
}

/** Dependências compartilhadas (composição em src/app.ts). */
export interface AppDeps {
  config: AppConfig;
  database: Database;
  clock: Clock;
  mailer: Mailer;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}
