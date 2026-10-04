import { describe, expect, it } from 'vitest';
import type { StudyEvent } from '../types';
import { activityIntensity, calendarDays, previousActivity, shiftDay, summarizeActivity } from './activity';

function event(id: string, at: string, changes: Partial<StudyEvent> = {}): StudyEvent {
  return { id, at, itemId: id, title: id, kind: 'vocabulary', rating: 'good', ...changes };
}

describe('daily learning evidence', () => {
  it('groups by Beijing midnight and deduplicates synced event IDs', () => {
    const first = event('first', '2026-10-03T15:59:59Z');
    const second = event('second', '2026-10-03T16:00:00Z');
    const days = summarizeActivity([first, second, first]);
    expect(days.get('2026-10-03')?.records).toBe(1);
    expect(days.get('2026-10-04')?.records).toBe(1);
  });

  it('separates repeated recall from distinct words and objective answers', () => {
    const at = '2026-10-04T04:00:00Z';
    const days = summarizeActivity([
      event('word-a', at, { itemId: 'approach', rating: 'again' }),
      event('word-b', at, { itemId: 'approach', rating: 'good' }),
      event('word-c', at, { itemId: 'focus', rating: 'hard' }),
      event('quiz', at, { kind: 'reading', correct: 2, total: 3, rating: undefined }),
      event('essay', at, { kind: 'writing', rating: undefined }),
    ]);
    expect(days.get('2026-10-04')).toMatchObject({ records: 5, wordReviews: 3, uniqueWords: 2, questionCount: 3, correctCount: 2, lessonAttempts: 2, quizAttempts: 1 });
    expect(days.get('2026-10-04')?.accuracy).toBeCloseTo(2 / 3);
  });

  it('weights accuracy by question count and counts retakes across days', () => {
    const days = summarizeActivity([
      event('repeat', '2026-10-04T04:00:00Z', { itemId: 'passage', kind: 'reading', correct: 3, total: 3 }),
      event('new', '2026-10-04T05:00:00Z', { kind: 'listening', correct: 1, total: 2 }),
      event('original', '2026-10-02T04:00:00Z', { itemId: 'passage', kind: 'reading', correct: 1, total: 3 }),
    ]);
    expect(days.get('2026-10-04')).toMatchObject({ quizAttempts: 2, repeatedQuizAttempts: 1, questionCount: 5, correctCount: 4, accuracy: .8 });
    expect(days.get('2026-10-02')?.repeatedQuizAttempts).toBe(0);
  });

  it('uses the previous active day, leaving gaps and first-day comparisons honest', () => {
    const days = summarizeActivity([event('a', '2026-09-20T04:00:00Z'), event('b', '2026-10-02T04:00:00Z'), event('c', '2026-10-04T04:00:00Z')]);
    expect(previousActivity(days, '2026-10-04')?.date).toBe('2026-10-02');
    expect(previousActivity(days, '2026-10-03')?.date).toBe('2026-10-02');
    expect(previousActivity(days, '2026-09-20')).toBeUndefined();
  });

  it('does not invent objective scores for writing, vocabulary self-ratings, or invalid scores', () => {
    const at = '2026-10-04T04:00:00Z';
    const days = summarizeActivity([
      event('word', at, { correct: 1, total: 1 }),
      event('essay', at, { kind: 'writing' }),
      event('missing', at, { kind: 'reading', total: 3 }),
      event('over', at, { kind: 'reading', total: 3, correct: 4 }),
      event('zero', at, { kind: 'reading', total: 0, correct: 0 }),
      event('invalid-date', 'invalid'),
    ]);
    expect(days.get('2026-10-04')).toMatchObject({ records: 5, questionCount: 0, correctCount: 0, accuracy: null });
  });
});

describe('learning calendar', () => {
  it('shows sixteen full Monday-first weeks and marks future days unavailable', () => {
    const byDate = summarizeActivity([event('future', '2026-10-09T04:00:00Z')]);
    const days = calendarDays(byDate, '2026-10-07', 16);
    expect(days).toHaveLength(112);
    expect(new Date(`${days[0].date}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(days.at(-1)?.date).toBe('2026-10-11');
    expect(days.filter(day => day.future)).toHaveLength(4);
    expect(days.find(day => day.date === '2026-10-09')).toMatchObject({ records: 0, intensity: 0, future: true });
  });

  it('keeps empty days empty and intensity tied to actual record counts', () => {
    expect(calendarDays(new Map(), '2026-10-04')).toHaveLength(182);
    expect(calendarDays(new Map(), '2026-10-04').every(day => day.records === 0 && day.intensity === 0)).toBe(true);
    expect([0, 1, 4, 5, 14, 15, 29, 30].map(activityIntensity)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });

  it('handles month, year and leap-day boundaries without device timezone assumptions', () => {
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDay('2026-09-30', 1)).toBe('2026-10-01');
  });
});
