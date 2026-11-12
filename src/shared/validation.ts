import { z } from 'zod';

import { isIsoDate, isMonthKey } from './dates.js';
import { AppError, type FieldError } from './errors.js';
import { money } from './money.js';

/**
 * Campos reutilizáveis dos DTOs — espelham src/lib/schemas/record-fields.ts do
 * frontend, mas o servidor é mais estrito (é a barreira de segurança).
 */

/**
 * Ids gerados no cliente: UUID v4 ou ids compostos como `${recorrencia}_${data}`.
 * Restrito a caracteres seguros para URL e logs.
 */
export const idField = z
  .union([z.string(), z.number().int().nonnegative()])
  .transform(String)
  .pipe(
    z
      .string()
      .min(1, 'Identificador obrigatório.')
      .max(120, 'Identificador muito longo.')
      .regex(/^[A-Za-z0-9_.:-]+$/, 'Identificador inválido.'),
  );

export const nullableId = idField.nullish().transform((value) => value ?? null);

/** Valor monetário não negativo: "1234.56" (até 12 dígitos inteiros e 2 casas). */
export const moneyField = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Valor monetário inválido.')
  .transform((value) => money(value).toFixed(2));

export const positiveMoneyField = moneyField.refine(
  (value) => money(value).greaterThan(0),
  'O valor deve ser maior que zero.',
);

export const isoDateField = z.string().refine(isIsoDate, 'Data inválida (use AAAA-MM-DD).');
export const nullableIsoDate = isoDateField.nullish().transform((value) => value ?? null);
export const monthKeyField = z.string().refine(isMonthKey, 'Mês inválido (use AAAA-MM).');

export const requiredText = (max: number) =>
  z.string().trim().min(1, 'Campo obrigatório.').max(max, `Máximo de ${max} caracteres.`);

export const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Máximo de ${max} caracteres.`)
    .nullish()
    .transform((value) => (value === undefined || value === null || value === '' ? null : value));

export const tagsField = z
  .array(z.string().trim().min(1).max(200, 'Etiqueta muito longa.'))
  .max(100, 'Máximo de 100 etiquetas.')
  .default([]);

/** Converte erros do Zod no formato `errors[]` do Problem Details. */
export function toFieldErrors(error: z.ZodError, prefix = ''): FieldError[] {
  return error.issues.map((issue) => {
    const path = issue.path
      .map((part, index) =>
        typeof part === 'number' ? `[${part}]` : `${index === 0 ? '' : '.'}${String(part)}`,
      )
      .join('');
    const field = prefix && path ? `${prefix}.${path}` : prefix || path;
    return { field: field === '' ? '(corpo)' : field, message: issue.message };
  });
}

/** Valida o corpo/consulta. Falha com 422 + `errors[]` por campo. */
export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const errors = toFieldErrors(result.error);
    throw new AppError({
      status: 422,
      title: 'Dados inválidos',
      detail: errors[0]?.message ?? 'Os dados enviados são inválidos.',
      code: 'VALIDATION_FAILED',
      errors,
    });
  }
  return result.data;
}

/** Parâmetro `:id` da rota. */
export const idParams = z.object({ id: idField });

/** O id do corpo precisa ser igual ao da URL em `PUT /recurso/{id}`. */
export function assertSameId(pathId: string, bodyId: string): void {
  if (pathId !== bodyId) {
    throw new AppError({
      status: 422,
      title: 'Dados inválidos',
      detail: 'O id do corpo difere do id da URL.',
      code: 'ID_MISMATCH',
      errors: [{ field: 'id', message: 'Deve ser igual ao id da URL.' }],
    });
  }
}
