import { describe, expect, it } from 'vitest';
import { blankProgress, freshState, mergeStates } from './study';
import { readRemoteSnapshot, RemoteStateError, stateFingerprint } from './sync';

describe('private state synchronization safeguards', () => {
  it('recognizes only an empty object as an uninitialized remote space', () => {
    expect(readRemoteSnapshot({ state: {}, revision: 0 })).toEqual({ state: null, revision: 0 });
    for (const state of [undefined, null, [], '', { version: 2 }, { version: 1 }, { unexpected: true }]) {
      expect(() => readRemoteSnapshot({ state, revision: 0 })).toThrow(RemoteStateError);
    }
  });

  it('rejects damaged data and invalid revisions instead of permitting an overwrite', () => {
    expect(() => readRemoteSnapshot({ state: { ...freshState(), events: 'damaged' }, revision: 8 })).toThrow(RemoteStateError);
    for (const revision of [-1, 1.5, NaN, '8', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => readRemoteSnapshot({ state: freshState(), revision })).toThrow(RemoteStateError);
    }
    expect(readRemoteSnapshot({ state: freshState(), revision: 8 }).revision).toBe(8);
  });

  it('does not treat object key order or an omitted optional value as a change', () => {
    const original = freshState();
    const reordered = { ...original, session: undefined, settings: Object.fromEntries(Object.entries(original.settings).reverse()) };
    const validated = readRemoteSnapshot({ state: reordered, revision: 3 }).state!;
    expect(stateFingerprint(validated)).toBe(stateFingerprint(original));
  });

  it('repeated merges remain unchanged but a concurrent offline edit still needs a write', () => {
    const initial = freshState();
    initial.progress.reading = { ...blankProgress(), draft: 'First draft', updatedAt: '2026-10-03T00:00:00.000Z' };
    const remote = mergeStates(initial, initial);
    expect(stateFingerprint(mergeStates(remote, remote))).toBe(stateFingerprint(remote));
    const local = structuredClone(remote);
    local.progress.reading.note = 'A new note from this device';
    local.progress.reading.fieldUpdatedAt!.note = '2026-10-04T00:00:00.000Z';
    const merged = mergeStates(local, remote);
    expect(stateFingerprint(merged)).not.toBe(stateFingerprint(remote));
    expect(merged.progress.reading.note).toBe('A new note from this device');
    expect(merged.progress.reading.draft).toBe('First draft');
  });
});
