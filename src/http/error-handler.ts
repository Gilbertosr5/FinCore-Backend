import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { AppError, type FieldError } from '../shared/errors.js';
import { toFieldErrors } from '../shared/validation.js';

const PROBLEM_BASE = 'https://fincore.app/problems/';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  code?: string;
  errors?: FieldError[];
  requestId: string;
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, error: AppError) {
  const body: ProblemBody = {
    type: `${PROBLEM_BASE}${error.type}`,
    title: error.title,
    status: error.status,
    instance: request.url.split('?')[0] ?? request.url,
    requestId: request.id,
  };
  if (error.detail !== undefined) body.detail = error.detail;
  if (error.code !== undefined) body.code = error.code;
  if (error.errors !== undefined) body.errors = error.errors;
  if (error.headers) void reply.headers(error.headers);
  return reply.status(error.status).type('application/problem+json').send(body);
}

/** Erros do PostgreSQL que viram respostas de negócio (defesa em profundidade). */
function fromDatabaseError(error: unknown): AppError | null {
  const candidate = (error as { cause?: unknown }).cause ?? error;
  const code = (candidate as { code?: unknown }).code;
  if (code === '23505') {
    return new AppError({
      status: 409,
      title: 'Conflito',
      detail: 'Já existe um registro com estes dados.',
      code: 'DUPLICATE',
    });
  }
  if (code === '23503') {
    return new AppError({
      status: 409,
      title: 'Conflito',
      detail: 'O registro está vinculado a outros dados ou referencia um registro inexistente.',
      code: 'REFERENCE_CONFLICT',
    });
  }
  return null;
}

function toAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    const errors = toFieldErrors(error);
    return new AppError({
      status: 422,
      title: 'Dados inválidos',
      detail: errors[0]?.message,
      code: 'VALIDATION_FAILED',
      errors,
    });
  }
  const db = fromDatabaseError(error);
  if (db) return db;

  const fastifyError = error as Partial<FastifyError>;
  const status = fastifyError.statusCode;
  if (status === 429) {
    return new AppError({
      status: 429,
      title: 'Muitas requisições',
      detail: 'Muitas tentativas. Aguarde alguns instantes e tente novamente.',
      code: 'RATE_LIMITED',
    });
  }
  if (status === 413) {
    return new AppError({
      status: 413,
      title: 'Corpo muito grande',
      detail: 'O corpo da requisição excede o tamanho permitido.',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }
  if (status === 415) {
    return new AppError({
      status: 415,
      title: 'Tipo de mídia não suportado',
      detail: 'Envie o corpo como application/json.',
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new AppError({
      status: 400,
      title: 'Requisição inválida',
      detail: 'A requisição não pôde ser interpretada (verifique o JSON enviado).',
      code: 'BAD_REQUEST',
    });
  }
  return null;
}

/** Tratador global: toda resposta de erro segue a RFC 9457 (Problem Details). */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    if (appError) {
      if (appError.status >= 500) request.log.error({ err: error }, 'erro de aplicação');
      return sendProblem(request, reply, appError);
    }
    request.log.error({ err: error }, 'erro inesperado');
    // Detalhes internos nunca são expostos ao cliente.
    return sendProblem(
      request,
      reply,
      new AppError({
        status: 500,
        title: 'Erro interno',
        detail: 'Ocorreu um erro inesperado. Informe o código da requisição ao suporte.',
        code: 'INTERNAL_ERROR',
      }),
    );
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(
      request,
      reply,
      new AppError({
        status: 404,
        title: 'Não encontrado',
        detail: `Rota inexistente: ${request.method} ${request.url.split('?')[0] ?? ''}`,
        code: 'ROUTE_NOT_FOUND',
      }),
    ),
  );
}
