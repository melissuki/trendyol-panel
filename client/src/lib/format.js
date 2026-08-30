const currency = new Intl.NumberFormat('tr-TR', {
  style: 'currency',
  currency: 'TRY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const integer = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });

export const formatCurrency = (value) => currency.format(Number(value) || 0);
export const formatNumber = (value) => integer.format(Number(value) || 0);
export const formatPercent = (value) => `%${(Number(value) || 0).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;

/** 'YYYY-MM-DD' -> 'dd.MM.yyyy' */
export const formatDay = (value) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value ?? '';
  const [y, m, d] = value.split('-');
  return `${d}.${m}.${y}`;
};

/** Bugünün tarihini yerel saate göre YYYY-MM-DD üretir (UTC kayması olmadan). */
export const toInputDate = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};
