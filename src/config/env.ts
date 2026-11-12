import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default('pglite:./.data/pglite'),
  DB_MIGRATE_ON_START: booleanString.default(true),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    ),
  COOKIE_SECURE: booleanString.optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).default(60),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(12),
  APP_TIMEZONE: z.string().min(1).default('America/Sao_Paulo'),
  APP_PUBLIC_URL: z.url().default('http://localhost:5173'),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  migrateOnStart: boolean;
  corsOrigins: string[];
  cookieSecure: boolean;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  timezone: string;
  publicUrl: string;
  authRateLimitPerMinute: number;
}

/** Lê e valida as variáveis de ambiente. Falha cedo com mensagem clara. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração inválida: ${issues}`);
  }
  const env = parsed.data;
  const config: AppConfig = {
    env: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    migrateOnStart: env.DB_MIGRATE_ON_START,
    corsOrigins: env.CORS_ORIGINS,
    cookieSecure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    sessionIdleMinutes: env.SESSION_IDLE_MINUTES,
    sessionAbsoluteHours: env.SESSION_ABSOLUTE_HOURS,
    timezone: env.APP_TIMEZONE,
    publicUrl: env.APP_PUBLIC_URL.replace(/\/+$/, ''),
    authRateLimitPerMinute: env.AUTH_RATE_LIMIT_PER_MINUTE,
  };
  if (config.env === 'production') {
    if (!config.cookieSecure) {
      throw new Error('Configuração inválida: COOKIE_SECURE deve ser true em produção.');
    }
    if (config.databaseUrl.startsWith('pglite:')) {
      throw new Error('Configuração inválida: use PostgreSQL (postgres://) em produção.');
    }
  }
  return config;
}

/** Configuração para testes: banco em memória, sem migração automática externa. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'pglite:memory', LOG_LEVEL: 'silent' }),
    ...overrides,
  };
}
