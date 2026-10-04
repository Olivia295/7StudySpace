import { describe, expect, it, vi } from 'vitest';
import type { AIJob, ChatMessage, StudyState } from '../types';

// Pure state helpers should not open IndexedDB or require a mounted provider.
vi.mock('./store', () => ({ useStore: vi.fn() }));
vi.mock('./storage', () => ({ api: vi.fn() }));

import { applyAIJob, jobText, nextAIPoll, shouldStartWeeklyReview } from './ai';
import { freshState } from './study';

const requestedAt = '2026-10-04T10:00:00.000Z';
const completedAt = '2026-10-04T10:01:00.000Z';
const week = 7 * 86400000;
const message = (review = false): ChatMessage => ({
 id: 'reply', role: 'assistant', text: '正在等待回复。', status: 'queued',
 at: requestedAt, through: requestedAt, review,
});
const job = (status: AIJob['status'], result?: AIJob['result']): AIJob => ({
 id: 'job-one', kind: 'review', status, result,
 createdAt: requestedAt, updatedAt: completedAt,
});
const eligibleState = (): StudyState => ({
 ...freshState(),
 events: Array.from({ length: 6 }, (_, index) => ({
  id: `event-${index}`, at: `2026-09-${20 + index}T10:00:00.000Z`,
  itemId: `lesson-${index}`, title: 'Reading practice', kind: 'reading',
 })),
});

describe('AI polling when the worker is disconnected', () => {
 const waiting={authenticated:true,visible:true,pendingCount:1,workerEnabled:false,lastProbeAt:1000,at:6000};
 it('does not send repeated job requests while the worker is unavailable', () => {
  for(let elapsed=5000;elapsed<5*60*1000;elapsed+=5000){
   expect(nextAIPoll({...waiting,at:1000+elapsed})).toBe('none');
  }
  expect(nextAIPoll({...waiting,at:301000})).toBe('status');
 });
 it('can discover a newly enabled local worker and then poll the saved jobs', () => {
  expect(nextAIPoll({...waiting,workerEnabled:null})).toBe('status');
  expect(nextAIPoll({...waiting,forceStatus:true})).toBe('status');
  expect(nextAIPoll({...waiting,workerEnabled:true})).toBe('jobs');
 });
 it('makes no polling requests from signed-out or hidden pages or without pending work', () => {
  for(const patch of [{authenticated:false},{visible:false},{pendingCount:0}]){
   expect(nextAIPoll({...waiting,...patch,workerEnabled:true,forceStatus:true})).toBe('none');
  }
 });
});

describe('AI job results from POST and polling', () => {
 it('immediately renders a completed POST result with the server object shape', () => {
  const state = freshState();
  const result = applyAIJob(state, message(), job('completed', { text: '先找到句子的主干。' }), completedAt);
  expect(result.chats).toHaveLength(1);
  expect(result.chats?.[0]).toMatchObject({ text: '先找到句子的主干。', status: 'completed', jobId: 'job-one' });
  expect(result.reports).toEqual([]);
  expect(state.chats).toBeUndefined();
 });

 it('immediately saves a completed review and never duplicates its report', () => {
  const pending = message(true);
  const state = { ...freshState(), chats: [pending] };
  const completed = job('completed', { text: JSON.stringify({
   summary: '最近完成了六篇阅读。',
   suggestions: [{ title: '核对原文', reason: '再看一遍定位句。', focus: 'reading' }],
  }) });
  const result = applyAIJob(state, pending, completed, completedAt);
  expect(result.chats?.[0].text).toBe('最近完成了六篇阅读。');
  expect(result.reports).toEqual([{
   id: 'review:job-one', jobId: 'job-one', at: completedAt, through: requestedAt,
   text: '最近完成了六篇阅读。',
   suggestions: [{ title: '核对原文', reason: '再看一遍定位句。', focus: 'reading' }],
  }]);
  expect(applyAIJob(result, pending, completed, '2026-10-04T11:00:00.000Z')).toEqual(result);
  const duplicateRequest = applyAIJob(result, { ...pending, id: 'another-reply' }, completed, completedAt);
  expect(duplicateRequest.reports).toHaveLength(1);
  expect(duplicateRequest.chats?.[1].text).toBe('最近完成了六篇阅读。');
  expect(state.reports).toEqual([]);
 });

 it('uses the same result handling when a pending job finishes during polling', () => {
  const pending = message(true);
  const waiting = applyAIJob(freshState(), pending, job('queued'), requestedAt);
  const running = applyAIJob(waiting, pending, job('running'), completedAt);
  const result = applyAIJob(running, pending, job('completed', { text: '有依据的复盘正文。' }), completedAt);
  expect(result.chats).toHaveLength(1);
  expect(result.chats?.[0]).toMatchObject({ status: 'completed', text: '有依据的复盘正文。', through: requestedAt });
  expect(result.reports[0].text).toBe('有依据的复盘正文。');
 });

 it('supports legacy string results as well as the current object shape', () => {
  expect(jobText(job('completed', 'Legacy reply'))).toBe('Legacy reply');
  expect(jobText(job('completed', { text: 'Current reply' }))).toBe('Current reply');
  expect(jobText(job('failed', null))).toBe('');
 });

 it('shows failure immediately instead of leaving a terminal job waiting forever', () => {
  const result = applyAIJob(freshState(), message(true), job('failed'), completedAt);
  expect(result.chats?.[0]).toMatchObject({ status: 'failed', text: '这次分析没有完成，你可以稍后手动再试。' });
  expect(result.reports).toEqual([]);
 });

 it('distinguishes a saved unavailable job from a completed response', () => {
  const result = applyAIJob(freshState(), message(true), job('unavailable'), completedAt);
  expect(result.chats?.[0].text).toContain('请求已保存');
  expect(result.chats?.[0].status).toBe('unavailable');
  expect(result.reports).toEqual([]);
 });

 it('does not create an empty report when a completed job has no readable result', () => {
  const result = applyAIJob(freshState(), message(true), job('completed', null), completedAt);
  expect(result.chats?.[0].text).toContain('没有包含可读取的内容');
  expect(result.reports).toEqual([]);
 });
});

describe('automatic weekly review attempts', () => {
 it('allows an eligible first review after seven days of records', () => {
  expect(shouldStartWeeklyReview(eligibleState(), Date.parse(requestedAt))).toBe(true);
 });

 it('blocks repeated failed POST results for seven days, including after a reload', () => {
  const failed = applyAIJob(eligibleState(), message(true), job('failed'), completedAt);
  const restored = JSON.parse(JSON.stringify(failed)) as StudyState;
  expect(shouldStartWeeklyReview(restored, Date.parse(completedAt))).toBe(false);
  expect(shouldStartWeeklyReview(restored, Date.parse(requestedAt) + week - 1)).toBe(false);
  expect(shouldStartWeeklyReview(restored, Date.parse(requestedAt) + week)).toBe(true);
 });

 it('also records a request that failed before receiving a server job ID', () => {
  const state = eligibleState();
  state.chats = [{ ...message(true), status: 'failed', text: '没有送达。' }];
  expect(state.chats[0].jobId).toBeUndefined();
  expect(shouldStartWeeklyReview(state, Date.parse(completedAt))).toBe(false);
  // Ordinary study and chat updates must not create an automatic retry loop.
  state.chats.push({ id: 'question', role: 'user', text: '另一个问题', at: completedAt });
  state.settings.name = '77';
  expect(shouldStartWeeklyReview(state, Date.parse(completedAt))).toBe(false);
 });

 it('keeps the attempt time stable when polling changes the visible message time', () => {
  const state = applyAIJob(eligibleState(), message(true), job('failed'), '2026-10-10T10:00:00.000Z');
  expect(state.chats?.[0].at).toBe('2026-10-10T10:00:00.000Z');
  expect(state.chats?.[0].through).toBe(requestedAt);
  expect(shouldStartWeeklyReview(state, Date.parse(requestedAt) + week)).toBe(true);
 });

 it('waits for an existing queued job instead of creating a second automatic job', () => {
  const state = applyAIJob(eligibleState(), message(true), job('queued'), requestedAt);
  expect(shouldStartWeeklyReview(state, Date.parse(requestedAt) + 2 * week)).toBe(false);
 });

 it('still accepts an explicit manual review while automatic attempts are paused', () => {
  const failed = applyAIJob(eligibleState(), message(true), job('failed'), completedAt);
  expect(shouldStartWeeklyReview(failed, Date.parse(completedAt))).toBe(false);
  const manual = applyAIJob(failed, { ...message(true), id: 'manual' }, { ...job('completed', { text: '手动复盘结果。' }), id: 'manual-job' }, completedAt);
  expect(manual.reports[0].text).toBe('手动复盘结果。');
 });

 it('requires new learning records and respects the automatic-review setting', () => {
  const state = eligibleState();
  state.reports = [{ id: 'prior', jobId: 'prior', at: requestedAt, through: requestedAt, text: '已复盘。' }];
  expect(shouldStartWeeklyReview(state, Date.parse(requestedAt) + week)).toBe(false);
  state.reports = [];
  state.settings.weeklyReview = false;
  expect(shouldStartWeeklyReview(state, Date.parse(requestedAt) + week)).toBe(false);
 });
});
