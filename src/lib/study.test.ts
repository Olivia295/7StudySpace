import {describe,it,expect} from 'vitest';
import {addStudyEvent,freshState,mergeStates,mergeProgress,nextReview,vocabularyQueue,localDate} from './study';
import type {StudyEvent,Word,Progress} from '../types';
const event=(id:string,at:string,rating:StudyEvent['rating']='good'):StudyEvent=>({id,at,itemId:'one',title:'approach',kind:'vocabulary',rating});
describe('learning state across devices',()=>{
 it('preserves concurrent reviews and makes merging idempotent',()=>{const base=freshState();const a=addStudyEvent(base,event('a','2026-10-01T01:00:00Z'));const b=addStudyEvent(base,event('b','2026-10-02T01:00:00Z','hard'));const merged=mergeStates(a,b);expect(merged.events.map(e=>e.id)).toEqual(['a','b']);expect(merged.reviews.one.successes).toBe(1);expect(mergeStates(merged,b)).toEqual(merged);expect(mergeStates(b,a)).toEqual(merged);});
 it('does not record a retry of the same action twice',()=>{const e=event('once','2026-10-01T01:00:00Z');const a=addStudyEvent(freshState(),e);expect(addStudyEvent(a,e)).toBe(a);});
 it('keeps the latest draft and settings without losing older events',()=>{const a=freshState(),b=freshState();a.progress.x={draft:'old',note:'',answers:{},position:0,completed:false,updatedAt:'2026-10-01T00:00:00Z'};b.progress.x={...a.progress.x,draft:'new',updatedAt:'2026-10-02T00:00:00Z'};b.settings={...b.settings,budget:10,updatedAt:'2026-10-02T00:00:00Z'};expect(mergeStates(a,b).progress.x.draft).toBe('new');expect(mergeStates(a,b).settings.budget).toBe(10);});
 it('preserves a reverted plan adjustment across stale replicas',()=>{const a=freshState(),b=freshState();const change={id:'c',reportId:'r',title:'read',at:'2026-10-01T00:00:00Z',before:{budget:40 as const},after:{budget:10 as const}};a.planChanges=[{...change,revertedAt:'2026-10-02T00:00:00Z'}];b.planChanges=[change];expect(mergeStates(a,b).planChanges?.[0].revertedAt).toBeTruthy();});
 it('uses shorter intervals after failed retrieval and longer ones after success',()=>{const initial=nextReview(undefined,'good','2026-10-01T00:00:00Z');const failed=nextReview(initial,'again','2026-10-02T00:00:00Z');const success=nextReview(initial,'good','2026-10-02T00:00:00Z');expect(failed.interval).toBeLessThan(initial.interval);expect(success.interval).toBeGreaterThan(initial.interval);});
 it('gives due items priority and never presents a future review as overdue',()=>{const words=['one','two','three'].map(id=>({id,word:id,meaning:id,example:'',pos:'',tags:[],source:''}) satisfies Word);const state=freshState();state.reviews.one=nextReview(undefined,'good','2000-01-01T00:00:00Z');state.reviews.two=nextReview(undefined,'good','2099-01-01T00:00:00Z');expect(vocabularyQueue(words,state,10).map(w=>w.id)).toEqual(['one','three']);expect(vocabularyQueue(words,state,10,true).map(w=>w.id)).toEqual(['one']);});
 it('groups evening UTC events on the correct China day',()=>expect(localDate('2026-10-03T19:00:00Z')).toBe('2026-10-04'));
});

describe('independent progress fields across devices',()=>{
 const t0='2026-10-04T09:00:00.000Z',t1='2026-10-04T10:00:00.000Z',t2='2026-10-04T10:01:00.000Z',t3='2026-10-04T10:02:00.000Z';
 const base=():Progress=>({draft:'',note:'',answers:{},position:0,completed:false,updatedAt:t0,fieldUpdatedAt:{draft:t0,note:t0,answers:t0,position:t0,completed:t0}});
 it('does not let later phone playback overwrite an iPad draft, answers, or completion',()=>{
  const a=freshState(),b=freshState();
  a.progress.lesson={...base(),draft:'My new essay',answers:{q1:2},completed:true,updatedAt:t1,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t1,answers:t1,completed:t1}};
  b.progress.lesson={...base(),note:'A note from my phone',position:25,updatedAt:t3,fieldUpdatedAt:{...base().fieldUpdatedAt,note:t2,position:t3}};
  const result=mergeStates(a,b).progress.lesson;
  expect(result).toMatchObject({draft:'My new essay',note:'A note from my phone',answers:{q1:2},position:25,completed:true,updatedAt:t3});
  expect(result.fieldUpdatedAt).toEqual({draft:t1,note:t2,answers:t1,position:t3,completed:t1});
  expect(result.conflicts).toBeUndefined();
  expect(mergeStates(b,a).progress.lesson).toEqual(result);
 });
 it('keeps a losing offline draft and note as recoverable copies',()=>{
  const a:Progress={...base(),draft:'Tablet draft',note:'Tablet note',updatedAt:t1,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t1,note:t1}};
  const b:Progress={...base(),draft:'Phone draft',note:'Phone note',updatedAt:t2,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t2,note:t2}};
  const merged=mergeProgress(a,b);
  expect(merged.draft).toBe('Phone draft');expect(merged.note).toBe('Phone note');
  expect(merged.conflicts).toEqual([{field:'draft',text:'Tablet draft',at:t1},{field:'note',text:'Tablet note',at:t1}]);
  expect(mergeProgress(merged,a)).toEqual(merged);
  expect(mergeProgress(merged,b)).toEqual(merged);
 });
 it('falls back to record timestamps for legacy data and preserves the older text',()=>{
  const a:Progress={draft:'Earlier draft',note:'',answers:{},position:0,completed:false,updatedAt:t0};
  const b:Progress={...a,draft:'Later draft',updatedAt:t1};
  const merged=mergeProgress(a,b);
  expect(merged.draft).toBe('Later draft');
  expect(merged.fieldUpdatedAt).toEqual({draft:t1,note:t1,answers:t1,position:t1,completed:t1});
  expect(merged.conflicts).toEqual([{field:'draft',text:'Earlier draft',at:t0}]);
 });
 it('combines legacy text with newer per-field playback without pretending the text was edited',()=>{
  const legacy:Progress={draft:'Saved before upgrade',note:'',answers:{},position:0,completed:false,updatedAt:t1};
  const phone:Progress={...base(),position:19,updatedAt:t2,fieldUpdatedAt:{...base().fieldUpdatedAt,position:t2}};
  const merged=mergeProgress(legacy,phone);
  expect(merged.draft).toBe('Saved before upgrade');expect(merged.position).toBe(19);
  expect(merged.fieldUpdatedAt?.draft).toBe(t1);expect(merged.fieldUpdatedAt?.position).toBe(t2);
 });
 it('converges on equal timestamps and preserves both nonempty text versions',()=>{
  const a:Progress={...base(),draft:'Alpha',updatedAt:t1,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t1}};
  const b:Progress={...a,draft:'Beta'};
  const forward=mergeProgress(a,b),reverse=mergeProgress(b,a);
  expect(forward).toEqual(reverse);
  expect(new Set([forward.draft,...(forward.conflicts??[]).map(c=>c.text)])).toEqual(new Set(['Alpha','Beta']));
  expect(mergeProgress(forward,a)).toEqual(forward);
 });
 it('honours a newer explicit reset while retaining prior text for recovery',()=>{
  const old:Progress={...base(),draft:'Previous attempt',completed:true,updatedAt:t1,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t1,completed:t1}};
  const reset:Progress={...base(),updatedAt:t2,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t2,completed:t2}};
  const merged=mergeProgress(old,reset);
  expect(merged.draft).toBe('');expect(merged.completed).toBe(false);
  expect(merged.conflicts).toEqual([{field:'draft',text:'Previous attempt',at:t1}]);
 });
 it('deduplicates recoverable text and does not create a conflict for identical text',()=>{
  const a:Progress={...base(),draft:'Current',updatedAt:t2,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t2},conflicts:[{field:'draft',text:'Earlier',at:t0}]};
  const b:Progress={...a,conflicts:[{field:'draft',text:'Earlier',at:t1},{field:'draft',text:'Current',at:t0}]};
  const merged=mergeProgress(a,b);
  expect(merged.conflicts).toEqual([{field:'draft',text:'Earlier',at:t1}]);
  expect(mergeProgress(merged,b)).toEqual(merged);
 });
 it('preserves all text across three replicas without mutating the inputs',()=>{
  const a:Progress={...base(),draft:'First version',updatedAt:t1,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t1}};
  const b:Progress={...base(),draft:'Second version',updatedAt:t2,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t2}};
  const c:Progress={...base(),draft:'Third version',updatedAt:t3,fieldUpdatedAt:{...base().fieldUpdatedAt,draft:t3}};
  const before=structuredClone([a,b,c]);
  const merged=mergeProgress(mergeProgress(a,b),c);
  expect(merged).toEqual(mergeProgress(a,mergeProgress(b,c)));
  expect(new Set([merged.draft,...(merged.conflicts??[]).map(x=>x.text)])).toEqual(new Set(['First version','Second version','Third version']));
  expect([a,b,c]).toEqual(before);
 });
});
