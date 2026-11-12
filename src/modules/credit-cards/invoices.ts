import { MoneyDecimal, money, sumMoney, type MoneyValue } from '../../shared/money.js';
import type { IsoDate } from '../../shared/dates.js';

/**
 * Calendário de faturas — porte fiel de
 * `fincore/src/features/credit-cards/domain/services/invoice-schedule.ts` e
 * `invoices.ts` (ADR 0007/0010 do frontend). Faturas nunca são gravadas: são
 * derivadas das compras e dos pagamentos.
 *
 * - A fatura M fecha no dia `closingDay` de M e vence no dia `dueDay` de M
 *   (se dueDay > closingDay) ou de M+1.
 * - Compra antes do fechamento entra na fatura do mês; no dia do fechamento ou
 *   depois, na seguinte. A parcela i (0-based) vai para a fatura (primeira + i).
 * - Parcelas: centavos divididos por igual, o resto nas primeiras.
 */

export type MonthKey = string;

interface CardDays {
  closingDay: number;
  dueDay: number;
}

interface PurchaseLike {
  totalAmount: string;
  purchaseDate: IsoDate;
  installmentCount: number;
  status: string;
}

const pad = (value: number) => String(value).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthParts(month: MonthKey): { year: number; month: number } {
  const [y = '0', m = '1'] = month.split('-');
  return { year: Number(y), month: Number(m) };
}

export function addMonthsToKey(month: MonthKey, amount: number): MonthKey {
  const parts = monthParts(month);
  const index = parts.year * 12 + (parts.month - 1) + amount;
  return `${String(Math.floor(index / 12))}-${pad((index % 12) + 1)}`;
}

/** Dia do mês limitado ao último dia (ex.: dia 31 em fevereiro → 28/29). */
export function dayOfMonth(month: MonthKey, day: number): IsoDate {
  const parts = monthParts(month);
  const safeDay = Math.min(Math.max(day, 1), daysInMonth(parts.year, parts.month));
  return `${month}-${pad(safeDay)}`;
}

export function invoiceDates(card: CardDays, month: MonthKey) {
  const closingDate = dayOfMonth(month, card.closingDay);
  const dueMonth = card.dueDay > card.closingDay ? month : addMonthsToKey(month, 1);
  return { closingDate, dueDate: dayOfMonth(dueMonth, card.dueDay) };
}

export function invoiceMonthForPurchase(card: CardDays, purchaseDate: IsoDate): MonthKey {
  const month = purchaseDate.slice(0, 7);
  return purchaseDate < invoiceDates(card, month).closingDate ? month : addMonthsToKey(month, 1);
}

/** Fatura aberta hoje: aquela em que uma compra feita hoje entraria. */
export function openInvoiceMonth(card: CardDays, today: IsoDate): MonthKey {
  return invoiceMonthForPurchase(card, today);
}

/** Divide o total em `parts` parcelas cuja soma é exatamente o total. */
export function allocate(total: string, parts: number): MoneyValue[] {
  const cents = money(total).times(100);
  const base = cents.dividedToIntegerBy(parts);
  let remainder = cents.minus(base.times(parts));
  return Array.from({ length: parts }, () => {
    let share = base;
    if (remainder.greaterThan(0)) {
      share = share.plus(1);
      remainder = remainder.minus(1);
    }
    return share.dividedBy(100);
  });
}

/** Total das parcelas de compras ativas que caem na fatura `month`. */
export function invoiceTotal(
  card: CardDays,
  purchases: readonly PurchaseLike[],
  month: MonthKey,
): MoneyValue {
  const amounts: MoneyValue[] = [];
  for (const purchase of purchases) {
    if (purchase.status !== 'active') continue;
    const first = invoiceMonthForPurchase(card, purchase.purchaseDate);
    const shares = allocate(purchase.totalAmount, purchase.installmentCount);
    shares.forEach((share, index) => {
      if (addMonthsToKey(first, index) === month) amounts.push(share);
    });
  }
  return amounts.length === 0 ? new MoneyDecimal(0) : sumMoney(amounts);
}
