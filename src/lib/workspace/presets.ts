import raw from '../../../config/presets.json' with { type: 'json' };
import type { Preset } from './types.ts';

export const presets = raw as Preset[];
export const getPreset = (key: unknown): Preset | undefined => (typeof key === 'string' ? presets.find(p => p.key === key) : undefined);

/** Keyword match of a free-text description against the optional presets. A convenience hint, not a classifier and not AI. */
export function suggestPresets(description: string): Preset[] {
  const text = description.toLowerCase();
  return presets.map(p => ({ p, score: p.keywords.filter(k => text.includes(k)).length })).filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.p);
}
