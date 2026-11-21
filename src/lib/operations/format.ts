/** Display-only currency formatting. Amounts themselves are always computed by the database. */
export const money = (v: string | number, cur: string) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).format(Number(v)); } catch { return `${cur} ${v}`; } };
