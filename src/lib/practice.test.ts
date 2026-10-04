import { describe, expect, it } from 'vitest';
import { lessonQueue, sessionSummary, sessionAtLesson, resetLessonProgress, dailyPracticePool, isPastPaperExercise, rankDailyLessons, nextDailyLesson, paperPracticeResumeId } from './practice';
import { freshState } from './study';
import type { Lesson, Session, StudyEvent } from '../types';

const lesson = (id:string, kind:Lesson['kind']='reading', tags:string[]=[]):Lesson => ({ id, kind, title:id, subtitle:'', level:'基础', minutes:5, tags, body:'A real passage or task to work on.', source:{title:'原创'} });
const progress = (completed:boolean,at='2026-10-01T00:00:00Z') => ({draft:'',note:'',answers:{},position:0,completed,updatedAt:at});
describe('daily practice with past papers',()=>{
  it('includes original practice and imported paper questions and free-response tasks, but no scans or personal collections',()=>{
    const builtin=lesson('builtin');
    const reading={...lesson('import-paper-reading','reading',['paper:2025','真题精读']),body:'',questions:[{id:'q',prompt:'What is the main point?',options:['A','B'],answer:0,explanation:'',evidence:''}]};
    const writing=lesson('import-paper-writing','writing',['paper:2025','真题写作']);
    const translation=lesson('import-paper-translation','translation',['paper:2025','真题翻译']);
    const original=lesson('import-paper-pdf','reading',['paper:2025','原卷阅读']);
    const personal=lesson('import-personal');
    const empty={...lesson('import-empty','reading',['paper:2025']),body:''};
    const all=[builtin,reading,writing,translation,original,personal,empty];
    expect(dailyPracticePool(all).map(l=>l.id)).toEqual(['builtin','import-paper-reading','import-paper-writing','import-paper-translation']);
    expect(dailyPracticePool(all,'writing')).toEqual([writing]);
    expect(dailyPracticePool(all,'vocabulary')).toEqual([]);
    expect(isPastPaperExercise(writing)).toBe(true);
    expect(isPastPaperExercise(original)).toBe(false);
    expect(isPastPaperExercise(empty)).toBe(false);
  });
  it('prefers unfinished paper exercises and never lets completed papers hide unseen original lessons',()=>{
    const state=freshState();
    const all=[lesson('builtin'),lesson('import-done','reading',['paper:2024']),lesson('import-fresh','reading',['paper:2025'])];
    state.progress['import-done']=progress(true);
    expect(rankDailyLessons(all,state).map(l=>l.id)).toEqual(['import-fresh','builtin','import-done']);
    expect(nextDailyLesson(all,state)?.id).toBe('import-fresh');
    state.progress['import-fresh']=progress(true);
    expect(nextDailyLesson(all,state)?.id).toBe('builtin');
  });
  it('rotates fully completed practice by the oldest real attempt instead of always picking a paper',()=>{
    const state=freshState();
    const all=[lesson('import-paper','reading',['paper:2025']),lesson('builtin-old'),lesson('builtin-recent')];
    all.forEach(l=>{state.progress[l.id]=progress(true,'2026-10-05T00:00:00Z');});
    state.events=all.map((l,index)=>({id:`e-${l.id}`,itemId:l.id,title:l.title,kind:l.kind,at:['2026-10-04T00:00:00Z','2026-10-01T00:00:00Z','2026-10-03T00:00:00Z'][index],correct:1,total:1}));
    expect(rankDailyLessons(all,state).map(l=>l.id)).toEqual(['builtin-old','builtin-recent','import-paper']);
    expect(nextDailyLesson(all,state)?.id).toBe('builtin-old');
  });
  it('continues the unfinished queue across days without replacing its draft or start time',()=>{
    const state=freshState();
    const all=[lesson('import-new','reading',['paper:new']),lesson('original-a'),lesson('original-b')];
    state.session={kind:'lesson',ids:['original-a','original-b'],index:1,startedAt:'2026-09-30T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z',finished:false};
    state.progress['original-b']={...progress(false),draft:'A thought I left yesterday'};
    const before=structuredClone(state);
    expect(nextDailyLesson(all,state,'reading')?.id).toBe('original-b');
    expect(state).toEqual(before);
    state.progress['original-b'].completed=true;
    expect(nextDailyLesson(all,state,'reading')?.id).toBe('import-new');
  });
  it('continues the next pending material when a paused group is between two completed/submitted pages',()=>{
    const state=freshState();
    const all=[lesson('import-new','reading',['paper:new']),lesson('a'),lesson('b')];
    state.session={kind:'lesson',ids:['a','b'],index:0,startedAt:'2026-09-30T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'};
    state.progress.a=progress(true);
    expect(nextDailyLesson(all,state,'reading')?.id).toBe('b');
    expect(nextDailyLesson(all,state,'writing')).toBeUndefined();
  });
});
describe('continuous practice',()=>{
  it('resumes a paper from its shelf without dropping completed materials or restarting the group summary',()=>{
    const state=freshState();
    const ids=['paper-r1','paper-r2','paper-r3','paper-r4'];
    state.session={kind:'lesson',ids,index:0,startedAt:'2026-10-04T10:00:00Z',updatedAt:'2026-10-04T10:05:00Z',finished:false};
    state.progress[ids[0]]=progress(true);
    state.progress[ids[1]]={...progress(false),draft:'A saved thought',answers:{q2:1}};
    state.events=[{id:'first',itemId:ids[0],title:'Reading 1',kind:'reading',correct:4,total:5,at:'2026-10-04T10:05:00Z'}];
    const before=structuredClone(state);
    const resumeId=paperPracticeResumeId(state,ids);
    expect(resumeId).toBe('paper-r2');
    const resumed=sessionAtLesson(state.session,resumeId!,'2026-10-04T10:10:00Z');
    expect(resumed).toMatchObject({ids,index:1,startedAt:before.session!.startedAt,finished:false});
    expect(sessionSummary(state.events,resumed)).toEqual({attempts:1,correct:4,total:5});
    expect(state).toEqual(before);
    expect(paperPracticeResumeId(state,['other-paper'])).toBeUndefined();
    expect(paperPracticeResumeId({...state,session:{...state.session!,finished:true}},ids)).toBeUndefined();
  });
  it('keeps original paper reading separate from scored questions in the same paper',()=>{
    const all=[lesson('original','reading',['paper:p','原卷阅读']),lesson('text1','reading',['paper:p']),lesson('text2','reading',['paper:p'])];
    expect(lessonQueue(all,freshState(),'original')).toEqual(['original']);
    expect(lessonQueue(all,freshState(),'text1')).toEqual(['text1','text2']);
  });
  it('retains unpublished writing and older recovered versions when starting another attempt',()=>{
    const old={draft:'Edited after completion',note:'My note',answers:{q1:2},position:15,completed:true,updatedAt:'2026-10-04T00:00:00Z',conflicts:[{field:'draft' as const,text:'Earlier version',at:'2026-10-03T00:00:00Z'}]};
    const reset=resetLessonProgress(old,'2026-10-04T01:00:00Z');
    expect(reset).toMatchObject({draft:'',note:'My note',answers:{},completed:false,position:0});
    expect(reset.conflicts?.map(c=>c.text)).toEqual(['Earlier version','Edited after completion']);
    expect(resetLessonProgress(reset,'2026-10-04T02:00:00Z').conflicts).toEqual(reset.conflicts);
    expect(old.draft).toBe('Edited after completion');
  });
  it('preserves the queue and start time when browser history returns to an earlier material',()=>{
    const session:Session={kind:'lesson',ids:['a','b','c'],index:2,startedAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:10:00Z',finished:true};
    expect(sessionAtLesson(session,'a','2026-10-04T00:11:00Z')).toEqual({...session,index:0,finished:false,updatedAt:'2026-10-04T00:11:00Z'});
    expect(sessionAtLesson(session,'c','later')).toBe(session);
    expect(sessionAtLesson(session,'new','2026-10-04T00:12:00Z')).toMatchObject({ids:['new'],index:0,finished:false,startedAt:'2026-10-04T00:12:00Z'});
  });
  it('keeps the selected material first, stays within the same paper, and excludes completed followups',()=>{
    const state=freshState();state.progress.old={draft:'',note:'',answers:{},position:0,completed:true,updatedAt:'2026-10-01T00:00:00Z'};
    const all=[lesson('a','reading',['paper:p']),lesson('b'),lesson('old'),lesson('c','reading',['paper:p']),lesson('audio','listening')];
    expect(lessonQueue(all,state,'a')).toEqual(['a','c']);
    expect(lessonQueue(all,state,'missing')).toEqual([]);
  });
  it('only includes completed followups when a new attempt is explicitly requested, within the same paper and kind',()=>{
    const state=freshState();
    const all=[lesson('import-a','reading',['paper:2025']),lesson('import-b','reading',['paper:2025']),lesson('import-c','writing',['paper:2025']),lesson('import-d','reading',['paper:2024']),lesson('original')];
    state.progress['import-b']=progress(true);
    expect(lessonQueue(all,state,'import-a')).toEqual(['import-a']);
    expect(lessonQueue(all,state,'import-a',3,true)).toEqual(['import-a','import-b']);
    expect(lessonQueue(all,state,'original',3,true)).toEqual(['original']);
  });
  it('summarizes only the latest attempt per material made during this group',()=>{
    const session:Session={kind:'lesson',ids:['a','b'],index:1,startedAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:10:00Z'};
    const event=(id:string,itemId:string,at:string,correct:number):StudyEvent=>({id,itemId,at,title:itemId,kind:'reading',total:3,correct});
    const events=[event('old','a','2026-10-03T00:00:00Z',3),event('first','a','2026-10-04T01:00:00Z',1),event('retry','a','2026-10-04T02:00:00Z',2),event('other','c','2026-10-04T02:00:00Z',3),event('b','b','2026-10-04T03:00:00Z',3)];
    expect(sessionSummary(events,session)).toEqual({attempts:2,correct:5,total:6});
    expect(sessionSummary(events)).toEqual({attempts:0,correct:0,total:0});
  });
});
