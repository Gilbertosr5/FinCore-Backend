/**
 * Datas de calendário trafegam como "YYYY-MM-DD" e meses como "YYYY-MM"
 * (ADR 0004 do frontend). Comparação lexicográfica é segura nesse formato.
 */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

export function isMonthKey(value: string): boolean {
  return MONTH_KEY.test(value);
}

/** "Hoje" no fuso configurado (ex.: America/Sao_Paulo). */
export function todayIn(timezone: string, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "2026-11-10" -> "10/11/2026" (mensagens do histórico). */
export function displayDate(value: IsoDate): string {
  const [y, m, d] = value.split('-');
  return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
}
