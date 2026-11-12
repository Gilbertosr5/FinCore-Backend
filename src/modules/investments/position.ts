import type { IsoDate } from '../../shared/dates.js';
import { MoneyDecimal, money, type MoneyValue } from '../../shared/money.js';

/**
 * Valor atual de uma posição — porte de `computePosition`
 * (`fincore/src/features/investments/domain/services/portfolio.ts`, ADR 0012):
 *
 * - com avaliação até a data: última avaliação + aplicações − retiradas
 *   POSTERIORES a ela (mínimo 0);
 * - sem avaliação: custo da posição (custo médio);
 * - posição com quantidade zerada vale 0.
 */

export const CAPITAL_IN = new Set<string>(['contribution', 'buy']);
export const CAPITAL_OUT = new Set<string>(['sell', 'redemption']);

/** Ordem no mesmo dia: entradas antes de saídas (igual ao frontend). */
export const TYPE_ORDER: Record<string, number> = {
  contribution: 0,
  buy: 0,
  fee: 1,
  dividend: 2,
  interest: 2,
  income: 2,
  tax: 3,
  sell: 4,
  redemption: 4,
};

export interface MovementLike {
  type: string;
  date: IsoDate;
  quantity: string | null;
  amount: string;
}

export interface ValuationLike {
  date: IsoDate;
  value: string;
}

export function sortMovements<T extends { type: string; date: IsoDate }>(
  movements: readonly T[],
): T[] {
  return [...movements].sort((a, b) =>
    a.date === b.date
      ? (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
      : a.date < b.date
        ? -1
        : 1,
  );
}

const ZERO = () => new MoneyDecimal(0);
const max0 = (value: MoneyValue) => (value.isNegative() ? ZERO() : value);

/** Custo da posição pelo custo médio e quantidade em carteira (null sem quantidade). */
function replay(movements: readonly MovementLike[]) {
  const usesQuantity = movements.some(
    (item) => item.quantity !== null && (CAPITAL_IN.has(item.type) || CAPITAL_OUT.has(item.type)),
  );
  let quantity: MoneyValue | null = usesQuantity ? ZERO() : null;
  let cost = ZERO();
  for (const item of sortMovements(movements)) {
    const amount = money(item.amount);
    if (CAPITAL_IN.has(item.type) || item.type === 'fee') {
      cost = cost.plus(amount);
      if (quantity && item.quantity !== null && item.type !== 'fee') {
        quantity = quantity.plus(item.quantity);
      }
    } else if (CAPITAL_OUT.has(item.type)) {
      let removed: MoneyValue;
      if (quantity && item.quantity !== null && quantity.greaterThan(0)) {
        const sold = MoneyDecimal.min(new MoneyDecimal(item.quantity), quantity);
        removed = sold.equals(quantity) ? cost : cost.times(sold.dividedBy(quantity));
        quantity = quantity.minus(sold);
      } else {
        removed = MoneyDecimal.min(cost, amount);
      }
      cost = cost.minus(removed);
    }
  }
  return { quantity, cost };
}

export function positionValue(
  movements: readonly MovementLike[],
  valuations: readonly ValuationLike[],
  asOf: IsoDate,
): MoneyValue {
  const own = movements.filter((item) => item.date <= asOf);
  const ledger = replay(own);
  const latest = valuations
    .filter((item) => item.date <= asOf)
    .reduce<ValuationLike | null>(
      (best, item) => (best === null || item.date > best.date ? item : best),
      null,
    );

  let value: MoneyValue;
  if (latest) {
    let current = money(latest.value);
    for (const item of own) {
      if (item.date <= latest.date) continue;
      if (CAPITAL_IN.has(item.type)) current = current.plus(item.amount);
      else if (CAPITAL_OUT.has(item.type)) current = current.minus(item.amount);
    }
    value = max0(current);
  } else {
    value = max0(ledger.cost);
  }
  if (ledger.quantity?.isZero() === true) return ZERO();
  return money(value);
}
