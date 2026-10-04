import { z } from 'zod';
import { useEffect, useRef } from 'react';
import { useStore } from './store';
import { api } from './storage';
import { now } from './study';
import { recommendationSchema } from './schema';
import type { AIJob, ChatMessage, Recommendation, StudyState } from '../types';
export const reviewPrompt='请根据最近7天真实记录，回顾有依据的变化与反复困难，最多给三条建议。数据不足请说明，不预测考试分数、不催促、不空泛夸奖。只输出JSON：{"summary":"可读中文复盘","suggestions":[{"title":"建议标题","reason":"具体记录依据与做法","budget":40,"focus":"reading"}]}。budget可省略或为10/40/70；focus可省略或为vocabulary/reading/listening/sentence/writing/translation。不要无依据调整时长。';
export function readReview(text:string):{text:string;suggestions?:Recommendation[]}{try{const data=z.object({summary:z.string().max(50000),suggestions:z.array(recommendationSchema).max(3)}).parse(JSON.parse(text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,'')));return{text:data.summary,suggestions:data.suggestions};}catch{return{text};}}
export function jobText(job:AIJob){return typeof job.result==='string'?job.result:job.result?.text??'';}
// Both a deduplicated POST and a poll can return a terminal job.
export function applyAIJob(state:StudyState,message:ChatMessage,job:AIJob,at=now()):StudyState {
 const previous=state.chats?.find(m=>m.id===message.id)??message;
 const parsed=previous.review?readReview(jobText(job)):{text:jobText(job)};
 const text=job.status==='completed'?(parsed.text||'这次回复没有包含可读取的内容，你可以稍后重新提问。')
  :job.status==='failed'?'这次分析没有完成，你可以稍后手动再试。'
  :job.status==='unavailable'?'学习搭子目前还没有连接。这项请求已保存，工作端启用后会继续处理。'
  :previous.text;
 const next:ChatMessage={...previous,jobId:job.id,status:job.status,text,at:job.status!==previous.status||text!==previous.text?at:previous.at};
 const chats=(state.chats??[]).some(m=>m.id===next.id)?state.chats!.map(m=>m.id===next.id?next:m):[...(state.chats??[]),next];
 const reports=job.status==='completed'&&previous.review&&parsed.text&&!state.reports.some(r=>r.jobId===job.id)
  ?[...state.reports,{id:`review:${job.id}`,jobId:job.id,at,through:previous.through??previous.at,...parsed}]:state.reports;
 return {...state,chats,reports};
}
export function shouldStartWeeklyReview(state:StudyState,at=Date.now()):boolean {
 if(!state.settings.weeklyReview||state.events.length<5)return false;
 const week=7*86400000;
 // `through` is the original request time and is unchanged by polling or sync.
 // Persisting the attempt as a chat also covers failed POSTs and page reloads.
 const attempts=(state.chats??[]).filter(m=>m.role==='assistant'&&m.review);
 if(attempts.some(m=>at-Date.parse(m.through??m.at)<week))return false;
 if(attempts.some(m=>m.jobId&&['queued','running','unavailable'].includes(m.status??'')))return false;
 const since=state.reports.length?Math.max(...state.reports.map(r=>Date.parse(r.through))):Math.min(...state.events.map(e=>Date.parse(e.at)));
 return at-since>=week&&state.events.filter(e=>Date.parse(e.at)>since).length>=5;
}
export function nextAIPoll({authenticated,visible,pendingCount,workerEnabled,lastProbeAt,at,forceStatus=false}:{authenticated:boolean;visible:boolean;pendingCount:number;workerEnabled:boolean|null;lastProbeAt:number;at:number;forceStatus?:boolean}):'none'|'status'|'jobs' {
 if(!authenticated||!visible||!pendingCount)return 'none';
 if(forceStatus||workerEnabled===null||at-lastProbeAt>=5*60*1000)return 'status';
 return workerEnabled?'jobs':'none';
}
export function useAIJobs(){
 const {state,mutate,authenticated}=useStore();const live=useRef(state);live.current=state;
 useEffect(()=>{
   if(!authenticated)return;
   let busy=false,stopped=false,lastProbeAt=0,workerEnabled:boolean|null=null;
   const poll=async(forceStatus=false)=>{
     if(busy||stopped)return;
     const pending=(live.current.chats??[]).filter(m=>m.jobId&&['queued','running','unavailable'].includes(m.status??''));
     const action=nextAIPoll({authenticated,visible:document.visibilityState==='visible',pendingCount:pending.length,workerEnabled,lastProbeAt,at:Date.now(),forceStatus});
     if(action==='none')return;
     busy=true;
     try{
       if(action==='status'){
         lastProbeAt=Date.now();
         try{const status=await api<{enabled:boolean}>('/ai/status');workerEnabled=status.enabled===true;}catch{workerEnabled=false;}
       }
       if(!workerEnabled||stopped||document.visibilityState!=='visible')return;
       for(const message of pending){
         if(stopped||document.visibilityState!=='visible')break;
         try{
           const {job,worker}=await api<{job:AIJob;worker?:{enabled:boolean}}>(`/ai/jobs/${message.jobId}`);
           if(stopped)break;
           mutate(s=>applyAIJob(s,message,job));
           if(worker?.enabled===false){workerEnabled=false;lastProbeAt=Date.now();break;}
         }catch{
           // Retain jobs, but do not repeatedly query a disconnected service.
           workerEnabled=false;lastProbeAt=Date.now();break;
         }
       }
     }finally{busy=false;}
   };
   const refresh=()=>void poll(true);
   void poll();const timer=setInterval(()=>void poll(),5000);
   window.addEventListener('focus',refresh);window.addEventListener('online',refresh);document.addEventListener('visibilitychange',refresh);
   return()=>{stopped=true;clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[mutate,authenticated]);
}
