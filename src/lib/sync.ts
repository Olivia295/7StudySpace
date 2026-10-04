import { z } from 'zod';
import type { StudyState } from '../types';
import { stateSchema } from './schema';

const snapshotSchema = z.object({ state: z.unknown(), revision: z.number().int().nonnegative().safe() });
export class RemoteStateError extends Error {
  constructor() {
    super('云端记录暂时无法安全读取，原记录已保留。请更新页面后重试。');
    this.name = 'RemoteStateError';
  }
}

export function readRemoteSnapshot(value: unknown): { state: StudyState | null; revision: number } {
  const snapshot = snapshotSchema.safeParse(value);
  if (!snapshot.success) throw new RemoteStateError();
  const { state, revision } = snapshot.data;
  // Only an actual empty object represents a newly created space. In particular,
  // never replace future-version or damaged records with this device's state.
  if (state && typeof state === 'object' && !Array.isArray(state) && Object.keys(state).length === 0) {
    return { state: null, revision };
  }
  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) throw new RemoteStateError();
  return { state: parsed.data, revision };
}

export function stateFingerprint(state: StudyState): string {
  // JSON object key order and omitted optional values are not learning changes.
  // Preserve array order and every serialized value so real edits still sync.
  return JSON.stringify(state, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    }
    return value;
  });
}
