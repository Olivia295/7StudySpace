import type { Review, StudyState, StudyEvent, Word, Progress } from '../types';
export const now = () => new Date().toISOString();
export const freshState = (): StudyState => ({ version: 1, settings: { name: '77', budget: 40, companion: '小叶', tone: '温柔、耐心，解释清楚', instruction: '先给一点提示，再按需要展开。用具体学习记录反馈，不空泛夸奖，不催促。', weeklyReview: true, updatedAt: '2026-01-01T00:00:00.000Z' }, events: [], reviews: {}, progress: {}, imports: [], reports: [] });
export const blankProgress = (): Progress => ({ draft: '', note: '', answers: {}, position: 0, completed: false, updatedAt: now() });
export function nextReview(previous: Review | undefined, rating: 'again' | 'hard' | 'good', at: string): Review {
  const old = previous?.interval ?? 0;
  // Transparent adaptive intervals, not an estimated probability of remembering.
  const interval = rating === 'again' ? 0.007 : rating === 'hard' ? Math.max(1, Math.round(old * 1.2)) : old < 1 ? 1 : Math.min(90, Math.round(old * 2.2));
  return { due: new Date(Date.parse(at) + interval * 86400000).toISOString(), interval, lapses: (previous?.lapses ?? 0) + Number(rating === 'again'), successes: (previous?.successes ?? 0) + Number(rating === 'good'), updatedAt: at };
}
export function addStudyEvent(state: StudyState, event: StudyEvent): StudyState {
  if (state.events.some(e => e.id === event.id)) return state;
  const rating = event.rating ?? (event.total && (event.correct ?? 0) / event.total < .67 ? 'hard' : 'good');
  return { ...state, events: [...state.events, event], reviews: { ...state.reviews, [event.itemId]: nextReview(state.reviews[event.itemId], rating, event.at) } };
}
const progressFields = ['draft', 'note', 'answers', 'position', 'completed'] as const;
type ProgressField = typeof progressFields[number];
const progressTime = (progress: Progress, field: ProgressField) => progress.fieldUpdatedAt?.[field] ?? progress.updatedAt;
const compareTime = (a: string, b: string) => Date.parse(a) - Date.parse(b) || a.localeCompare(b);
function progressValue(progress: Progress, field: ProgressField): string {
  // Object insertion order is not a meaningful difference between answer sets.
  return JSON.stringify(field === 'answers' ? Object.entries(progress.answers).sort(([a], [b]) => a.localeCompare(b)) : progress[field]);
}
export function mergeProgress(a: Progress, b: Progress): Progress {
  const selected = {} as Record<ProgressField, Progress>;
  const fieldUpdatedAt: Record<string, string> = {};
  for (const field of progressFields) {
    const time = compareTime(progressTime(a, field), progressTime(b, field));
    // Stable ties make two devices converge even when their clocks match exactly.
    selected[field] = time > 0 || (time === 0 && progressValue(a, field) >= progressValue(b, field)) ? a : b;
    fieldUpdatedAt[field] = progressTime(selected[field], field);
  }
  const merged: Progress = {
    draft: selected.draft.draft,
    note: selected.note.note,
    answers: { ...selected.answers.answers },
    position: selected.position.position,
    completed: selected.completed.completed,
    updatedAt: compareTime(a.updatedAt, b.updatedAt) >= 0 ? a.updatedAt : b.updatedAt,
    fieldUpdatedAt,
  };
  const conflicts = new Map<string, NonNullable<Progress['conflicts']>[number]>();
  const retain = (conflict: NonNullable<Progress['conflicts']>[number]) => {
    if (!conflict.text.trim() || conflict.text === merged[conflict.field]) return;
    const key = JSON.stringify([conflict.field, conflict.text]);
    const previous = conflicts.get(key);
    if (!previous || compareTime(conflict.at, previous.at) > 0) conflicts.set(key, { ...conflict });
  };
  for (const conflict of [...(a.conflicts ?? []), ...(b.conflicts ?? [])]) retain(conflict);
  for (const field of ['draft', 'note'] as const) {
    const other = selected[field] === a ? b : a;
    // Without shared revision ancestry, differing text may be an offline edit.
    // Preserve the other nonempty version instead of silently discarding it.
    retain({ field, text: other[field], at: progressTime(other, field) });
  }
  if (conflicts.size) merged.conflicts = [...conflicts.values()].sort((x, y) => compareTime(x.at, y.at) || x.field.localeCompare(y.field) || x.text.localeCompare(y.text));
  return merged;
}
export function mergeStates(a: StudyState, b: StudyState): StudyState {
  const latest = <T extends { updatedAt: string }>(left: T, right: T) => left.updatedAt >= right.updatedAt ? left : right;
  const progress = { ...a.progress };
  for (const [id, value] of Object.entries(b.progress)) progress[id] = progress[id] ? mergeProgress(progress[id], value) : value;
  const events = [...new Map([...a.events, ...b.events].map(e => [e.id, e])).values()].sort((x,y) => x.at.localeCompare(y.at) || x.id.localeCompare(y.id));
  // Replay the union: concurrent reviews must both influence the schedule.
  const reviews: Record<string, Review> = {};
  for (const e of events) reviews[e.itemId] = nextReview(reviews[e.itemId], e.rating ?? (e.total && (e.correct ?? 0) / e.total < .67 ? 'hard' : 'good'), e.at);
  const imports = new Map(a.imports.map(x => [x.id, x]));
  b.imports.forEach(x => { if (!imports.has(x.id) || (x.updatedAt ?? '') > (imports.get(x.id)?.updatedAt ?? '')) imports.set(x.id, x); });
  const chats=new Map((a.chats??[]).map(m=>[m.id,m]));for(const m of b.chats??[]){const old=chats.get(m.id);if(!old||m.at>old.at)chats.set(m.id,m);}
  return { version: 1, settings: latest(a.settings, b.settings), events, reviews, progress, imports: [...imports.values()], importedWords:[...new Map([...(a.importedWords??[]),...(b.importedWords??[])].map(w=>[w.id,w])).values()], planChanges:[...new Map([...(a.planChanges??[]),...(b.planChanges??[])].sort((x,y)=>(x.revertedAt??x.at).localeCompare(y.revertedAt??y.at)).map(c=>[c.id,c])).values()], reports: [...new Map([...a.reports, ...b.reports].map(x => [x.id,x])).values()], chats:[...chats.values()].sort((x,y)=>x.at.localeCompare(y.at)), session: a.session && b.session ? latest(a.session,b.session) : a.session ?? b.session };
}
export function vocabularyQueue(words: Word[], state: StudyState, count: number, onlyDue = false): Word[] {
  const due = words.filter(w => state.reviews[w.id] && Date.parse(state.reviews[w.id].due) <= Date.now()).sort((a,b) => state.reviews[a.id].due.localeCompare(state.reviews[b.id].due));
  if (onlyDue) return due.slice(0,count);
  const starters = ['approach','evidence','consider','significant','benefit','develop','maintain','focus','research','improve'];
  const fresh = words.filter(w => !state.reviews[w.id]);
  const ranked = [...fresh.filter(w => starters.includes(w.word)).sort((a,b) => starters.indexOf(a.word)-starters.indexOf(b.word)), ...fresh.filter(w => !starters.includes(w.word))];
  return [...due, ...ranked].slice(0,count);
}
export function localDate(at: string | Date = new Date()) { return new Intl.DateTimeFormat('en-CA',{ timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(at)); }
export function friendlyDate(at: string) { return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(at)); }
export function reviewSummary(state: StudyState) {
  const start=Date.now()-7*86400000; const events=state.events.filter(e=>Date.parse(e.at)>=start);
  return { period:'最近7天', attemptCount:events.length, days:new Set(events.map(e=>localDate(e.at))).size, records:events.slice(-180), preferences:state.settings, previousRecommendations:state.reports.slice(-2).map(r=>r.text) };
}
