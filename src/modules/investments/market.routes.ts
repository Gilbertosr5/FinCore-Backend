import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';

/**
 * `GET /market/indicators` — contrato futuro (CDI, IPCA, Selic, Ibovespa).
 * Enquanto não houver integração com um provedor de dados de mercado,
 * responde 501; o frontend trata 404/501 como "indisponível".
 */
export function marketRoutes(app: FastifyInstance): void {
  app.get('/market/indicators', () => {
    throw new AppError({
      status: 501,
      title: 'Não implementado',
      detail: 'Indicadores de mercado ainda não estão disponíveis.',
      code: 'MARKET_DATA_UNAVAILABLE',
    });
  });
}
