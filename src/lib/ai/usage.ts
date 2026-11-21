// AI usage helpers. Costs are ESTIMATES: tokens recorded by Optizen x per-million prices the owner entered. They are not the provider's invoice and are shown only when prices are set.
export type Prices = { input_per_mtok: number | null; output_per_mtok: number | null; currency: string } | null;
export function estimateCost(inputTokens: number, outputTokens: number, prices: Prices): number | null {
  if (!prices || (prices.input_per_mtok === null && prices.output_per_mtok === null)) return null;
  const v = (inputTokens / 1e6) * (prices.input_per_mtok ?? 0) + (outputTokens / 1e6) * (prices.output_per_mtok ?? 0);
  return Math.round(v * 10000) / 10000;
}
export const fmtCost = (v: number | null, cur: string) => (v === null ? '—' : `${cur} ${v.toFixed(v < 1 ? 4 : 2)}`);
export const pct = (used: number, limit: number | null) => (limit ? Math.min(100, Math.round((used / limit) * 100)) : null);
