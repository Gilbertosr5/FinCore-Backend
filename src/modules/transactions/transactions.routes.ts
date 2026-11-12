import type { FastifyInstance } from 'fastify';

import { currentUserId } from '../../http/security.js';
import { notFound } from '../../shared/errors.js';
import { idParams, parseInput } from '../../shared/validation.js';

import { batchSchema } from './transactions.schemas.js';
import {
  commitBatch,
  findTransaction,
  listRecurrences,
  listTransactions,
  toTransactionDto,
} from './transactions.service.js';

export function transactionRoutes(app: FastifyInstance): void {
  const db = () => app.deps.database.db;

  app.get('/transactions', async (request) => listTransactions(db(), currentUserId(request)));

  app.get('/transactions/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const row = await findTransaction(db(), currentUserId(request), id);
    if (!row) throw notFound('Lançamento não encontrado.');
    return toTransactionDto(row);
  });

  app.post('/transactions/batch', { bodyLimit: 5 * 1024 * 1024 }, async (request, reply) => {
    const batch = parseInput(batchSchema, request.body);
    await commitBatch(db(), currentUserId(request), batch, app.deps.clock.today());
    return reply.status(204).send();
  });

  app.get('/recurrences', async (request) => listRecurrences(db(), currentUserId(request)));
}
