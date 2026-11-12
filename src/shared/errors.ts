/**
 * Erros de aplicação convertidos em Problem Details (RFC 9457) pelo
 * tratador global (src/http/error-handler.ts). Formato esperado pelo frontend:
 * docs/api-contract.md do projeto fincore.
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface ProblemOptions {
  status: number;
  title: string;
  detail?: string;
  /** Código estável de negócio (ex.: CATEGORY_IN_USE). */
  code?: string;
  errors?: FieldError[];
  /** Sufixo de https://fincore.app/problems/... */
  type?: string;
  headers?: Record<string, string>;
}

export class AppError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly code: string | undefined;
  readonly errors: FieldError[] | undefined;
  readonly type: string;
  readonly headers: Record<string, string> | undefined;

  constructor(options: ProblemOptions) {
    super(options.detail ?? options.title);
    this.name = 'AppError';
    this.status = options.status;
    this.title = options.title;
    this.detail = options.detail;
    this.code = options.code;
    this.errors = options.errors;
    this.type = options.type ?? defaultType(options.status);
    this.headers = options.headers;
  }
}

function defaultType(status: number): string {
  switch (status) {
    case 400:
      return 'bad-request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not-found';
    case 409:
      return 'conflict';
    case 422:
      return 'validation';
    case 429:
      return 'rate-limited';
    default:
      return status >= 500 ? 'server-error' : 'about-blank';
  }
}

export const badRequest = (detail: string, code?: string) =>
  new AppError({ status: 400, title: 'Requisição inválida', detail, code });

export const unauthorized = (detail = 'Sessão inexistente ou expirada.', code?: string) =>
  new AppError({ status: 401, title: 'Não autenticado', detail, code });

export const forbidden = (detail: string, code?: string) =>
  new AppError({ status: 403, title: 'Acesso negado', detail, code });

export const notFound = (detail = 'Recurso não encontrado.', code?: string) =>
  new AppError({ status: 404, title: 'Não encontrado', detail, code });

export const conflict = (detail: string, code: string) =>
  new AppError({ status: 409, title: 'Conflito', detail, code });

/** 422 com erro de negócio (opcionalmente associado a um campo). */
export const unprocessable = (detail: string, code: string, field?: string) =>
  new AppError({
    status: 422,
    title: 'Dados inválidos',
    detail,
    code,
    errors: field === undefined ? undefined : [{ field, message: detail }],
  });
