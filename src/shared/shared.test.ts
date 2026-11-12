import { describe, expect, it } from 'vitest';

import { hasNegativeBalance } from '../modules/goals/goals.module.js';
import { allowedMovementTypes, findOversell } from '../modules/investments/investments.module.js';

import { isIsoDate, isMonthKey, todayIn } from './dates.js';
import { displayMoney, formatMoney, money, sumMoney } from './money.js';

describe('money', () => {
  it('usa arredondamento bancário (HALF_EVEN) e 2 casas', () => {
    expect(money('0.125').toFixed(2)).toBe('0.12');
    expect(money('0.135').toFixed(2)).toBe('0.14');
    expect(formatMoney('10')).toBe('10.00');
    expect(sumMoney(['0.10', '0.20']).toFixed(2)).toBe('0.30');
  });

  it('formata para exibição em pt-BR', () => {
    expect(displayMoney('1234567.8')).toBe('R$ 1.234.567,80');
    expect(displayMoney('-5')).toBe('-R$ 5,00');
  });
});

describe('dates', () => {
  it('valida datas de calendário e meses', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isMonthKey('2026-11')).toBe(true);
    expect(isMonthKey('2026-00')).toBe(false);
  });

  it('calcula "hoje" no fuso configurado', () => {
    // 02:00 UTC de 07/11 ainda é 06/11 em São Paulo (UTC−3).
    const instant = new Date('2026-11-07T02:00:00Z');
    expect(todayIn('America/Sao_Paulo', instant)).toBe('2026-11-06');
    expect(todayIn('UTC', instant)).toBe('2026-11-07');
  });
});

describe('regras de metas e investimentos', () => {
  it('saldo de meta nunca negativo (depósitos antes de retiradas no mesmo dia)', () => {
    expect(
      hasNegativeBalance([
        { date: '2026-01-01', amount: '100', type: 'withdrawal' },
        { date: '2026-01-01', amount: '100', type: 'deposit' },
      ]),
    ).toBe(false);
    expect(hasNegativeBalance([{ date: '2026-01-01', amount: '0.01', type: 'withdrawal' }])).toBe(
      true,
    );
  });

  it('tipos por classe e venda acima da quantidade', () => {
    expect(allowedMovementTypes('stocks')).toContain('buy');
    expect(allowedMovementTypes('cdb')).toContain('contribution');
    expect(allowedMovementTypes('cdb')).not.toContain('buy');
    const buy = { id: 'b', type: 'buy', date: '2026-01-02', quantity: '10' };
    const sell = { id: 's', type: 'sell', date: '2026-01-02', quantity: '10' };
    expect(findOversell([sell, buy])).toBeNull();
    expect(findOversell([sell])).toBe(sell);
  });
});
