import type { Kind, Lesson, Progress, Session, StudyEvent, StudyState } from '../types';

/** A paper scan is a reference document; a task needs text or actual questions. */
export function isPracticeLesson(lesson: Lesson): boolean {
  return !lesson.tags.includes('原卷阅读') && (lesson.body.trim().length > 0 ||
    !!lesson.questions?.some(question => question.prompt.trim() && question.options.length >= 2));
}

export function isPastPaperExercise(lesson: Lesson): boolean {
  return isPracticeLesson(lesson) && lesson.tags.some(tag => tag.startsWith('paper:') && tag.length > 6);
}

export function dailyPracticePool(lessons: Lesson[], kind?: Kind): Lesson[] {
  return lessons.filter(lesson => (!kind || lesson.kind === kind) && isPracticeLesson(lesson) &&
    (!lesson.id.startsWith('import-') || isPastPaperExercise(lesson)));
}

function latestAttempts(state: StudyState): Map<string, number> {
  const attempts = new Map<string, number>();
  for (const event of state.events) {
    const at = Date.parse(event.at);
    if (Number.isFinite(at)) attempts.set(event.itemId, Math.max(attempts.get(event.itemId) ?? 0, at));
  }
  return attempts;
}

function orderByPractice(lessons: Lesson[], state: StudyState, preferPastPapers: boolean): Lesson[] {
  const attempts = latestAttempts(state);
  const lastPracticed = (lesson: Lesson) => attempts.get(lesson.id) ?? (Date.parse(state.progress[lesson.id]?.updatedAt ?? '') || 0);
  return [...lessons].sort((a, b) => {
    const aCompleted = !!state.progress[a.id]?.completed, bCompleted = !!state.progress[b.id]?.completed;
    if (aCompleted !== bCompleted) return Number(aCompleted) - Number(bCompleted);
    // A completed paper never hides unseen original practice. Once everything
    // has been practised, rotate by the oldest actual attempt, regardless of source.
    if (aCompleted) return lastPracticed(a) - lastPracticed(b);
    return preferPastPapers ? Number(isPastPaperExercise(b)) - Number(isPastPaperExercise(a)) : 0;
  });
}

export function rankDailyLessons(lessons: Lesson[], state: StudyState, kind?: Kind): Lesson[] {
  return orderByPractice(dailyPracticePool(lessons, kind), state, true);
}

export function nextDailyLesson(lessons: Lesson[], state: StudyState, kind?: Kind): Lesson | undefined {
  const ranked = rankDailyLessons(lessons, state, kind);
  const session = state.session;
  if (session?.kind === 'lesson' && !session.finished) {
    const available = new Map(ranked.map(lesson => [lesson.id, lesson]));
    // A queue has no day boundary: return to its unfinished work before starting
    // another recommendation. Drafts and the original group start time stay intact.
    const pending = session.ids.slice(session.index).find(id => available.has(id) && !state.progress[id]?.completed);
    if (pending) return available.get(pending);
  }
  return ranked[0];
}

export function resetLessonProgress(previous: Progress, at: string): Progress {
  const conflicts = [...(previous.conflicts ?? [])];
  if (previous.draft.trim() && !conflicts.some(c => c.field === 'draft' && c.text === previous.draft)) {
    conflicts.push({ field: 'draft', text: previous.draft, at: previous.fieldUpdatedAt?.draft ?? previous.updatedAt });
  }
  return { ...previous, draft: '', answers: {}, completed: false, position: 0, updatedAt: at, conflicts,
    fieldUpdatedAt: { ...previous.fieldUpdatedAt, draft: at, answers: at, completed: at, position: at, note: previous.fieldUpdatedAt?.note ?? previous.updatedAt } };
}

export function sessionAtLesson(session: Session | undefined, id: string, at: string): Session {
  const index = session?.kind === 'lesson' ? session.ids.indexOf(id) : -1;
  if (session && index >= 0) return index === session.index ? session : { ...session, index, finished: false, updatedAt: at };
  return { ids: [id], index: 0, kind: 'lesson', startedAt: at, updatedAt: at, finished: false };
}

/** A paper's Continue action resumes its existing group, including completed work. */
export function paperPracticeResumeId(state: StudyState, exerciseIds: string[]): string | undefined {
  const session = state.session;
  if (session?.kind !== 'lesson' || session.finished) return undefined;
  const available = new Set(exerciseIds);
  if (!session.ids.every(id => available.has(id))) return undefined;
  return session.ids.slice(session.index).find(id => !state.progress[id]?.completed) ?? session.ids[session.index];
}

/** Keep one reading/listening context together, and move on to a fresh context. */
export function lessonQueue(lessons: Lesson[], state: StudyState, firstId: string, size = 3, includeCompleted = false): string[] {
  const first = lessons.find(lesson => lesson.id === firstId);
  if (!first) return [];
  if (first.tags.includes('原卷阅读')) return [first.id];
  const paper = first.tags.find(tag => tag.startsWith('paper:'));
  const imported = first.id.startsWith('import-');
  const candidates = lessons.filter(lesson => lesson.id !== first.id && lesson.kind === first.kind && isPracticeLesson(lesson) &&
    (includeCompleted || !state.progress[lesson.id]?.completed) &&
    (paper ? lesson.tags.includes(paper) : !lesson.tags.some(tag => tag.startsWith('paper:')) && lesson.id.startsWith('import-') === imported));
  const ordered = orderByPractice(candidates, state, false);
  return [first.id, ...ordered.map(lesson => lesson.id)].slice(0, size);
}

export function sessionSummary(events: StudyEvent[], session?: Session) {
  const latest = new Map<string, StudyEvent>();
  if (session?.kind === 'lesson') {
    const ids = new Set(session.ids);
    for (const event of events) {
      if (!ids.has(event.itemId) || event.at < session.startedAt || event.kind === 'vocabulary') continue;
      const previous = latest.get(event.itemId);
      if (!previous || event.at >= previous.at) latest.set(event.itemId, event);
    }
  }
  return [...latest.values()].reduce((summary, event) => ({
    attempts: summary.attempts + 1,
    correct: summary.correct + (event.correct ?? 0),
    total: summary.total + (event.total ?? 0),
  }), { attempts: 0, correct: 0, total: 0 });
}
