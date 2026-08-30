/** Kurus hatalarini onlemek icin tum parasal degerler 2 haneye yuvarlanir. */
export function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function sum(list, selector) {
  return round2(list.reduce((acc, item) => acc + num(selector(item)), 0));
}
