import type { StudyEvent } from '../types';
import { localDate } from './study';

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const shortDateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric' });
const fullDateFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });

export interface DayActivity {
  date: string;
  records: number;
  wordReviews: number;
  uniqueWords: number;
  lessonAttempts: number;
  quizAttempts: number;
  repeatedQuizAttempts: number;
  questionCount: number;
  correctCount: number;
  accuracy: number | null;
}

export interface ActivityDay extends DayActivity {
  future: boolean;
  intensity: 0 | 1 | 2 | 3 | 4;
}

export function emptyActivity(date: string): DayActivity {
  return { date, records: 0, wordReviews: 0, uniqueWords: 0, lessonAttempts: 0, quizAttempts: 0, repeatedQuizAttempts: 0, questionCount: 0, correctCount: 0, accuracy: null };
}

// Date-only arithmetic uses UTC deliberately: the keys already represent China days.
export function shiftDay(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function summarizeActivity(events: StudyEvent[]): Map<string, DayActivity> {
  const byDate = new Map<string, DayActivity>();
  const wordsByDate = new Map<string, Set<string>>();
  const seenQuizzes = new Set<string>();
  const unique = [...new Map(events.map(event => [event.id, event])).values()]
    .filter(event => Number.isFinite(Date.parse(event.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));

  for (const event of unique) {
    const date = dayFormatter.format(new Date(event.at));
    const day = byDate.get(date) ?? emptyActivity(date);
    day.records++;
    if (event.kind === 'vocabulary') {
      day.wordReviews++;
      const words = wordsByDate.get(date) ?? new Set<string>();
      words.add(event.itemId);
      wordsByDate.set(date, words);
      day.uniqueWords = words.size;
    } else {
      day.lessonAttempts++;
      // A vocabulary self-rating or a missing score is never treated as correctness.
      if (Number.isInteger(event.total) && (event.total ?? 0) > 0 &&
        Number.isInteger(event.correct) && (event.correct ?? -1) >= 0 && event.correct! <= event.total!) {
        day.quizAttempts++;
        day.repeatedQuizAttempts += Number(seenQuizzes.has(event.itemId));
        seenQuizzes.add(event.itemId);
        day.questionCount += event.total!;
        day.correctCount += event.correct!;
      }
    }
    day.accuracy = day.questionCount ? day.correctCount / day.questionCount : null;
    byDate.set(date, day);
  }
  return byDate;
}

export function previousActivity(byDate: Map<string, DayActivity>, date: string): DayActivity | undefined {
  const previous = [...byDate.keys()].filter(day => day < date).sort().at(-1);
  return previous ? byDate.get(previous) : undefined;
}

export function activityIntensity(records: number): ActivityDay['intensity'] {
  return records <= 0 ? 0 : records < 5 ? 1 : records < 15 ? 2 : records < 30 ? 3 : 4;
}

export function calendarDays(byDate: Map<string, DayActivity>, today = localDate(), weeks = 26): ActivityDay[] {
  const count = Number.isFinite(weeks) ? Math.max(1, Math.min(52, Math.floor(weeks))) : 26;
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = shiftDay(today, -((weekday + 6) % 7));
  const start = shiftDay(monday, -(count - 1) * 7);
  return Array.from({ length: count * 7 }, (_, index) => {
    const date = shiftDay(start, index);
    const future = date > today;
    const activity = future ? emptyActivity(date) : byDate.get(date) ?? emptyActivity(date);
    return { ...activity, future, intensity: activityIntensity(activity.records) };
  });
}

export function activityDateLabel(date: string, includeYear = false): string {
  return (includeYear ? fullDateFormatter : shortDateFormatter).format(new Date(`${date}T00:00:00Z`));
}
