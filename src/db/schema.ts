import {
  boolean,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Esquema do PostgreSQL. Nomes de colunas em snake_case (casing do Drizzle).
 *
 * Multi-inquilino: todo recurso financeiro pertence a um usuário e tem chave
 * primária composta (user_id, id). Os ids são gerados no cliente (UUID v4 ou
 * `${recorrencia}_${data}` para ocorrências), então a chave composta impede que
 * um usuário sobrescreva ou leia o registro de outro com o mesmo id.
 *
 * Dinheiro: numeric(14,2) — lido/gravado como string decimal (nunca float).
 */

const money = () => numeric({ precision: 14, scale: 2 });
const isoDate = () => date({ mode: 'string' });
const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Identidade e sessão
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid().primaryKey(),
  name: text().notNull(),
  /** Normalizado (trim + minúsculas). */
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 do token do cookie — o token em si nunca é armazenado. */
    tokenHash: text().notNull().unique(),
    createdAt: createdAt(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull(),
    idleExpiresAt: timestamp({ withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp({ withTimezone: true }).notNull(),
    userAgent: text(),
    ip: text(),
  },
  (t) => [index().on(t.userId)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId)],
);

// ---------------------------------------------------------------------------
// Contas e categorias
// ---------------------------------------------------------------------------

const ownerId = () =>
  uuid()
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' });

export const accounts = pgTable(
  'accounts',
  {
    userId: ownerId(),
    id: text().notNull(),
    name: text().notNull(),
    type: text().notNull(),
    institution: text(),
    initialBalance: money().notNull(),
    initialBalanceDate: isoDate().notNull(),
    archived: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

export const categories = pgTable(
  'categories',
  {
    userId: ownerId(),
    id: text().notNull(),
    name: text().notNull(),
    /** Nome normalizado (trim + minúsculas) para unicidade por tipo. */
    nameKey: text().notNull(),
    kind: text().notNull(),
    nature: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] }), unique().on(t.userId, t.kind, t.nameKey)],
);

// ---------------------------------------------------------------------------
// Lançamentos e recorrências
// ---------------------------------------------------------------------------

export const transactions = pgTable(
  'transactions',
  {
    userId: ownerId(),
    id: text().notNull(),
    kind: text().notNull(),
    description: text().notNull(),
    amount: money().notNull(),
    accountId: text().notNull(),
    categoryId: text(),
    competenceDate: isoDate().notNull(),
    dueDate: isoDate(),
    paidDate: isoDate(),
    status: text().notNull(),
    transferId: text(),
    transferDirection: text(),
    transferCounterpartAccountId: text(),
    cardPaymentCardId: text(),
    cardPaymentInvoiceMonth: text(),
    investmentAssetId: text(),
    investmentDirection: text(),
    recurrenceId: text(),
    installmentGroupId: text(),
    installmentNumber: integer(),
    installmentTotal: integer(),
    tags: text().array().notNull().default([]),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.accountId],
      foreignColumns: [accounts.userId, accounts.id],
    }),
    foreignKey({
      columns: [t.userId, t.categoryId],
      foreignColumns: [categories.userId, categories.id],
    }),
    foreignKey({
      columns: [t.userId, t.transferCounterpartAccountId],
      foreignColumns: [accounts.userId, accounts.id],
    }),
    index().on(t.userId, t.competenceDate),
    index().on(t.userId, t.accountId),
    index().on(t.userId, t.cardPaymentCardId),
  ],
);

export const recurrences = pgTable(
  'recurrences',
  {
    userId: ownerId(),
    id: text().notNull(),
    frequency: text().notNull(),
    startDate: isoDate().notNull(),
    endDate: isoDate(),
    templateKind: text().notNull(),
    templateDescription: text().notNull(),
    templateAmount: money().notNull(),
    templateAccountId: text().notNull(),
    templateCategoryId: text(),
    templateTags: text().array().notNull().default([]),
    templateNotes: text(),
    excludedDates: text().array().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.templateAccountId],
      foreignColumns: [accounts.userId, accounts.id],
    }),
    foreignKey({
      columns: [t.userId, t.templateCategoryId],
      foreignColumns: [categories.userId, categories.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Cartões e orçamentos
// ---------------------------------------------------------------------------

export const creditCards = pgTable(
  'credit_cards',
  {
    userId: ownerId(),
    id: text().notNull(),
    name: text().notNull(),
    institution: text().notNull(),
    brand: text().notNull(),
    limit: money().notNull(),
    closingDay: integer().notNull(),
    dueDay: integer().notNull(),
    paymentAccountId: text().notNull(),
    status: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.paymentAccountId],
      foreignColumns: [accounts.userId, accounts.id],
    }),
  ],
);

export const cardPurchases = pgTable(
  'card_purchases',
  {
    userId: ownerId(),
    id: text().notNull(),
    cardId: text().notNull(),
    description: text().notNull(),
    categoryId: text(),
    totalAmount: money().notNull(),
    purchaseDate: isoDate().notNull(),
    installmentCount: integer().notNull(),
    status: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.cardId],
      foreignColumns: [creditCards.userId, creditCards.id],
    }),
    foreignKey({
      columns: [t.userId, t.categoryId],
      foreignColumns: [categories.userId, categories.id],
    }),
    index().on(t.userId, t.cardId),
  ],
);

export const budgets = pgTable(
  'budgets',
  {
    userId: ownerId(),
    id: text().notNull(),
    name: text().notNull(),
    categoryId: text(),
    amount: money().notNull(),
    period: text().notNull(),
    alertThresholdPercent: doublePrecision().notNull(),
    active: boolean().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.categoryId],
      foreignColumns: [categories.userId, categories.id],
    }),
  ],
);

// ---------------------------------------------------------------------------
// Metas
// ---------------------------------------------------------------------------

export const goals = pgTable(
  'goals',
  {
    userId: ownerId(),
    id: text().notNull(),
    name: text().notNull(),
    description: text(),
    category: text().notNull(),
    targetAmount: money().notNull(),
    startDate: isoDate().notNull(),
    targetDate: isoDate(),
    priority: text().notNull(),
    accountId: text(),
    status: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.accountId],
      foreignColumns: [accounts.userId, accounts.id],
    }),
  ],
);

export const goalContributions = pgTable(
  'goal_contributions',
  {
    userId: ownerId(),
    id: text().notNull(),
    goalId: text().notNull(),
    date: isoDate().notNull(),
    amount: money().notNull(),
    type: text().notNull(),
    transferId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.goalId],
      foreignColumns: [goals.userId, goals.id],
    }),
    index().on(t.userId, t.goalId),
  ],
);

// ---------------------------------------------------------------------------
// Investimentos
// ---------------------------------------------------------------------------

export const assets = pgTable(
  'assets',
  {
    userId: ownerId(),
    id: text().notNull(),
    name: text().notNull(),
    ticker: text(),
    /** Ticker normalizado (trim + maiúsculas) para unicidade; null sem ticker. */
    tickerKey: text(),
    assetClass: text().notNull(),
    institution: text().notNull(),
    notes: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] }), unique().on(t.userId, t.tickerKey)],
);

export const investmentMovements = pgTable(
  'investment_movements',
  {
    userId: ownerId(),
    id: text().notNull(),
    assetId: text().notNull(),
    type: text().notNull(),
    date: isoDate().notNull(),
    quantity: numeric({ precision: 30, scale: 10 }),
    amount: money().notNull(),
    transactionId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.assetId],
      foreignColumns: [assets.userId, assets.id],
    }),
    index().on(t.userId, t.assetId),
  ],
);

export const assetValuations = pgTable(
  'asset_valuations',
  {
    userId: ownerId(),
    id: text().notNull(),
    assetId: text().notNull(),
    date: isoDate().notNull(),
    value: money().notNull(),
    source: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({
      columns: [t.userId, t.assetId],
      foreignColumns: [assets.userId, assets.id],
    }),
    unique().on(t.userId, t.assetId, t.date),
  ],
);

// ---------------------------------------------------------------------------
// Histórico (gravado na mesma transação da alteração)
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey(),
    userId: ownerId(),
    entityType: text().notNull(),
    entityId: text().notNull(),
    action: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    summary: text().notNull(),
  },
  (t) => [index().on(t.userId, t.entityType, t.entityId)],
);
