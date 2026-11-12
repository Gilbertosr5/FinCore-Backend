import { randomUUID } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../../db/client.js';
import { categories, passwordResetTokens, users } from '../../db/schema.js';
import { AppError, conflict, unauthorized } from '../../shared/errors.js';

import { deleteUserSessions, hashToken, newToken } from './session.service.js';

// ---------------------------------------------------------------------------
// Regras (docs/auth-contract.md)
// ---------------------------------------------------------------------------

export const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'E-mail muito longo.')
  .pipe(z.email('E-mail inválido.'));

export const passwordField = z
  .string()
  .min(8, 'A senha deve ter ao menos 8 caracteres.')
  .max(128, 'A senha deve ter no máximo 128 caracteres.')
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: 'A senha deve conter ao menos uma letra e um número.',
  });

export const nameField = z
  .string()
  .trim()
  .min(2, 'O nome deve ter ao menos 2 caracteres.')
  .max(100, 'O nome deve ter no máximo 100 caracteres.');

export const registerSchema = z.object({
  name: nameField,
  email: emailField,
  password: passwordField,
});
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(128),
});
export const forgotSchema = z.object({ email: z.string().trim().toLowerCase().max(254) });
export const resetSchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: passwordField,
});
export const changeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordField,
});

export interface UserDto {
  id: string;
  name: string;
  email: string;
}

const RESET_TOKEN_MINUTES = 30;

// Parâmetros do Argon2id (OWASP: m=19 MiB, t=2, p=1).
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, ARGON2);

/** Hash fixo usado quando o e-mail não existe — iguala o tempo de resposta. */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword('fincore-dummy-password-1'));

function toDto(row: { id: string; name: string; email: string }): UserDto {
  return { id: row.id, name: row.name, email: row.email };
}

/** Categorias iniciais de um usuário novo (as mesmas da demonstração). */
const DEFAULT_CATEGORIES: { name: string; kind: 'income' | 'expense'; nature: string }[] = [
  { name: 'Salário', kind: 'income', nature: 'fixed' },
  { name: 'Freelances', kind: 'income', nature: 'variable' },
  { name: 'Rendimentos', kind: 'income', nature: 'variable' },
  { name: 'Bonificações', kind: 'income', nature: 'variable' },
  { name: 'Moradia', kind: 'expense', nature: 'fixed' },
  { name: 'Alimentação', kind: 'expense', nature: 'variable' },
  { name: 'Transporte', kind: 'expense', nature: 'variable' },
  { name: 'Saúde', kind: 'expense', nature: 'fixed' },
  { name: 'Educação', kind: 'expense', nature: 'fixed' },
  { name: 'Lazer', kind: 'expense', nature: 'variable' },
  { name: 'Assinaturas', kind: 'expense', nature: 'fixed' },
  { name: 'Compras', kind: 'expense', nature: 'variable' },
  { name: 'Impostos', kind: 'expense', nature: 'fixed' },
  { name: 'Outros', kind: 'expense', nature: 'variable' },
];

export async function registerUser(
  db: Db,
  input: z.output<typeof registerSchema>,
): Promise<UserDto> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing) throw conflict('Este e-mail já está cadastrado.', 'EMAIL_ALREADY_REGISTERED');
    const id = randomUUID();
    const [row] = await tx
      .insert(users)
      .values({ id, name: input.name, email: input.email, passwordHash })
      .returning();
    await tx.insert(categories).values(
      DEFAULT_CATEGORIES.map((category) => ({
        userId: id,
        id: randomUUID(),
        name: category.name,
        nameKey: category.name.toLowerCase(),
        kind: category.kind,
        nature: category.nature,
      })),
    );
    if (!row) throw new Error('Falha ao criar o usuário.');
    return toDto(row);
  });
}

/** Mensagem genérica: não revela se o e-mail existe. */
export async function authenticateUser(
  db: Db,
  input: z.output<typeof loginSchema>,
): Promise<UserDto> {
  const [row] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
  const valid = row
    ? await verify(row.passwordHash, input.password)
    : (await verify(await getDummyHash(), input.password), false);
  if (!row || !valid) throw unauthorized('E-mail ou senha inválidos.', 'INVALID_CREDENTIALS');
  return toDto(row);
}

export async function findUser(db: Db, userId: string): Promise<UserDto | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ? toDto(row) : null;
}

/**
 * Cria um token de redefinição (uso único, 30 min). Retorna null se o e-mail
 * não existir — a rota responde 202 do mesmo jeito.
 */
export async function createPasswordReset(
  db: Db,
  email: string,
  now: Date,
): Promise<{ token: string; user: UserDto } | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!row) return null;
  const token = newToken();
  await db.insert(passwordResetTokens).values({
    id: randomUUID(),
    userId: row.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + RESET_TOKEN_MINUTES * 60_000),
  });
  return { token, user: toDto(row) };
}

const invalidResetToken = () =>
  new AppError({
    status: 400,
    title: 'Link inválido',
    detail: 'O link de redefinição é inválido, expirou ou já foi usado.',
    code: 'INVALID_RESET_TOKEN',
  });

/** Redefine a senha e encerra todas as sessões do usuário. */
export async function resetPassword(
  db: Db,
  input: z.output<typeof resetSchema>,
  now: Date,
): Promise<void> {
  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(input.token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .limit(1);
    if (!token) throw invalidResetToken();
    await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(eq(passwordResetTokens.userId, token.userId));
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, token.userId));
    await deleteUserSessions(tx, token.userId);
  });
}

/** Troca de senha autenticada: mantém só a sessão atual. */
export async function changePassword(
  db: Db,
  userId: string,
  sessionId: string,
  input: z.output<typeof changeSchema>,
  now: Date,
): Promise<void> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw unauthorized();
  if (!(await verify(row.passwordHash, input.currentPassword))) {
    throw new AppError({
      status: 400,
      title: 'Senha atual incorreta',
      detail: 'A senha atual não confere.',
      code: 'INVALID_CURRENT_PASSWORD',
      errors: [{ field: 'currentPassword', message: 'A senha atual não confere.' }],
    });
  }
  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, userId));
    await deleteUserSessions(tx, userId, sessionId);
  });
}
