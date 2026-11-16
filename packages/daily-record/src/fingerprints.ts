import type { DailyMaterial, DailySourceReceipt } from '@runweave/shared/daily-record';
import { hash } from './data.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
/** Excludes export timestamps and performance counters, retains source identity/version. */
export function dailyFingerprints(materials: DailyMaterial[], sources: DailySourceReceipt[], days: string[]) {
  return days.map(day => ({ day,sources: sources.map(source => ({ provider: source.provider,status: source.status,
    inputHash: hash(canonical(materials.filter(item => item.day === day && item.provider === source.provider)
      .sort((a,b) => a.id.localeCompare(b.id)).map(item => Object.fromEntries(Object.entries(item).filter(([key,value]) => key !== "text" && value !== undefined))))) })) }));
}
