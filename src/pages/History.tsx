import { useMemo, useState } from 'react';
import { Download, ArrowUpFromLine, ChevronRight, Leaf } from 'lucide-react';
import { useStore } from '../lib/store';
import { friendlyDate, localDate, now } from '../lib/study';
import { exportBackup } from '../lib/imports';
import { kindLabels } from '../types';
import type { Recommendation, PlanChange } from '../types';
import { Empty, KindIcon, Notice } from '../components/UI';
import { ActivityCalendar, DailyProgress } from '../components/Activity';
import './workspace.css';

export default function History({openItem,restore,review}:{openItem:(id:string)=>void;restore:()=>void;review:()=>void}){
 const {state,mutate,lessons}=useStore();
 const [limit,setLimit]=useState(20),[notice,setNotice]=useState(''),[date,setDate]=useState(localDate()),[showAll,setShowAll]=useState(false);
 const allEvents=useMemo(()=>[...state.events].sort((a,b)=>b.at.localeCompare(a.at)),[state.events]);
 const events=showAll?allEvents:allEvents.filter(e=>localDate(e.at)===date);
 async function backup(){try{setNotice('正在整理备份');await exportBackup(state);setNotice('备份已准备好，请在设备上保留一份。');}catch{setNotice('备份没有完成，请再试一次。');}}
 function adopt(reportId:string,suggestion:Recommendation){const after={budget:suggestion.budget??state.settings.budget,focus:suggestion.focus??state.settings.focus};mutate(s=>({...s,settings:{...s.settings,...after,updatedAt:now()},planChanges:[...(s.planChanges??[]),{id:crypto.randomUUID(),reportId,title:suggestion.title,at:now(),before:{budget:s.settings.budget,focus:s.settings.focus??null},after}]}));setNotice('已放进今天的安排，可以随时撤回。');}
 function revert(change:PlanChange){mutate(s=>({...s,settings:{...s.settings,...change.before,focus:change.before.focus??null,updatedAt:now()},planChanges:(s.planChanges??[]).map(c=>c.id===change.id?{...c,revertedAt:now()}:c)}));setNotice('已恢复采用建议前的安排。');}
 function selectDate(next:string){setDate(next);setShowAll(false);setLimit(20);}
 return <>
  <div className="page-heading"><div><h1>学习记录</h1><p>每天做了什么，哪里在变化，都有迹可循。</p></div><div className="button-group"><button className="button secondary" onClick={backup}><Download size={18}/>导出备份</button><button className="icon-button bordered" aria-label="恢复备份" onClick={restore}><ArrowUpFromLine size={20}/></button></div></div>
  {notice&&<Notice>{notice}</Notice>}
  <ActivityCalendar events={state.events} selectedDate={date} onSelect={selectDate} weeks={52}/>
  <DailyProgress events={state.events} date={date}/>
  <div className="record-detail-heading"><h2>{showAll?'全部练习':'逐次记录'}</h2><button className="text-button" onClick={()=>{setShowAll(!showAll);setLimit(20);}}>{showAll?'只看所选日期':'查看所有日期'}<ChevronRight size={16}/></button></div>
  <p className="small muted">北京时间 · 作答、重练与笔记都会保存</p>
  {events.length?<div className="history-list">{events.slice(0,limit).map(event=><details key={event.id} className="history-entry"><summary><KindIcon kind={event.kind} size={22}/><span><strong>{event.title}</strong><small>{friendlyDate(event.at)}</small></span><span className="event-result">{event.rating?({again:'还没想起',hard:'有点模糊',good:'独立想起'}[event.rating]):event.total!==undefined?`${event.correct} / ${event.total} 题答对`:'留下了一次练习'}</span></summary><div className="event-detail">{event.response&&<p>{event.response}</p>}{event.answers&&Object.keys(event.answers).length>0&&<p>当次选择：{(lessons.find(l=>l.id===event.itemId)?.questions??[]).flatMap((q,index)=>event.answers?.[q.id]===undefined?[]:[`${index+1}. ${String.fromCharCode(65+event.answers[q.id])}`]).join('　')}</p>}{event.reason&&<p>{event.reason}</p>}<button className="text-button" onClick={()=>openItem(event.itemId)}>查看材料与解析<ChevronRight size={16}/></button></div></details>)}</div>:<Empty title={state.events.length?'这一天留了白':'从第一份练习开始'}>{state.events.length?'可以点选有颜色的格子，或查看所有日期的练习。':'完成单词回忆或保存一次练习，记录和格子就会一起出现。'}</Empty>}
  {limit<events.length&&<button className="button load-more" onClick={()=>setLimit(l=>l+30)}>再看一些记录</button>}
  <button className="weekly-banner" onClick={review}><Leaf size={26}/><span><strong>一起回望学习路线</strong><small>根据真实记录，看看下一步怎么安排。</small></span><ChevronRight/></button>
  {state.reports.length>0&&<section className="reports"><h2>学习路线复盘</h2>{[...state.reports].reverse().map(report=><details key={report.id}><summary>{friendlyDate(report.at)} · 学习复盘</summary><p>{report.text}</p>{report.suggestions?.map((suggestion,i)=><div className="recommendation" key={i}><h3>{suggestion.title}</h3><p>{suggestion.reason}</p>{(suggestion.budget||suggestion.focus)&&<><small>{suggestion.budget?`日常安排 ${suggestion.budget} 分钟`:'保留当前时长'}{suggestion.focus?` · 优先${kindLabels[suggestion.focus]}`:''}</small><button className="button secondary" onClick={()=>adopt(report.id,suggestion)}>放进今天的安排</button></>}</div>)}</details>)}</section>}
  {(state.planChanges??[]).filter(c=>!c.revertedAt).length>0&&<section className="reports"><h2>采用过的调整</h2>{(state.planChanges??[]).filter(c=>!c.revertedAt).map(change=><div className="recommendation" key={change.id}><p>{change.title}</p>{state.settings.budget===change.after.budget&&state.settings.focus===change.after.focus?<button className="text-button" onClick={()=>revert(change)}>撤回这次调整</button>:<small>之后的安排已有新调整，这条保留作记录。</small>}</div>)}</section>}
 </>;
}
