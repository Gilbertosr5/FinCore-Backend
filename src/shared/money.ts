import { Decimal } from 'decimal.js';

/**
 * Aritmética monetária com decimal.js e arredondamento bancário (HALF_EVEN),
 * as mesmas regras do frontend (ADR 0003). Nunca use `number` para dinheiro.
 * Valores trafegam como string decimal com ponto e 2 casas: "1234.56".
 */
export const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
export type MoneyValue = InstanceType<typeof MoneyDecimal>;

export function money(value: string | number | MoneyValue): MoneyValue {
  return new MoneyDecimal(value).toDecimalPlaces(2);
}

export function sumMoney(values: readonly (string | MoneyValue)[]): MoneyValue {
  return values.reduce<MoneyValue>((total, value) => total.plus(value), new MoneyDecimal(0));
}

/** Formato do contrato: sempre 2 casas, ponto decimal. */
export function formatMoney(value: string | MoneyValue): string {
  return money(value).toFixed(2);
}

/** Exibição em mensagens (pt-BR), ex.: "R$ 1.234,56". */
export function displayMoney(value: string | MoneyValue): string {
  const [integer = '0', cents = '00'] = money(value).abs().toFixed(2).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${money(value).isNegative() ? '-' : ''}R$ ${grouped},${cents}`;
}

/** Quantidades (ações, cotas, cripto) — sem zeros à direita. */
export function formatQuantity(value: string | MoneyValue): string {
  return new MoneyDecimal(value).toString();
}
