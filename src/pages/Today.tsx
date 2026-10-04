import { ArrowRight, ChevronRight, Leaf, BookOpen, Files, NotebookText } from 'lucide-react';
import { useStore } from '../lib/store';
import { nextDailyLesson, isPastPaperExercise } from '../lib/practice';
import { kindLabels } from '../types';
import type { Kind } from '../types';
import { KindIcon, Notice } from '../components/UI';
import { ActivityCalendar, DailyProgress } from '../components/Activity';
import './workspace.css';

export default function Today({startWords,openKind,resume,ask,openPapers,history}:{startWords:()=>void;openKind:(kind:Kind)=>void;resume:()=>void;ask:()=>void;openPapers:()=>void;history:()=>void}){
 const {state,settings,words,lessons,contentError,reloadContent}=useStore();
 const budget=state.settings.budget,session=state.session;
 const unfinished=session&&!session.finished&&session.index<session.ids.length;
 const resumeAvailable=!!unfinished&&(session.kind==='vocabulary'?words.some(w=>w.id===session.ids[session.index]):lessons.some(l=>l.id===session.ids[session.index]));
 const taskAvailable=(kind:Kind)=>kind==='vocabulary'?words.length>0:!!nextDailyLesson(lessons,state,kind);
 const day=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'}).format(new Date()).replace('日','日 · ');
 const tasks:{kind:Kind;title:string;subtitle:string;time:number}[]=budget===10?
 [{kind:'vocabulary',title:'回忆一组单词',subtitle:'先回忆，再看释义',time:5},{kind:'sentence',title:'读懂一个长句',subtitle:'找到主干，理清关系',time:5}]:
 [{kind:'vocabulary',title:'回忆一组单词',subtitle:'先回忆，再看释义',time:budget===70?15:10},{kind:'listening',title:'听一段英语',subtitle:'听大意，再对照细节',time:budget===70?20:15},{kind:'reading',title:'阅读与答题',subtitle:'逐题练习，带着依据选答案',time:budget===70?20:15},...(budget===70?[{kind:'writing' as const,title:'写下自己的表达',subtitle:'先尝试，再对照参考',time:15}]:[])];
 const nextReading=nextDailyLesson(lessons,state,'reading');
 const hasDailyPaper=!!nextReading&&isPastPaperExercise(nextReading);
 if(hasDailyPaper){const reading=tasks.find(t=>t.kind==='reading');if(reading){reading.title='做一篇真题';reading.subtitle=nextReading.title;if(!state.settings.focus){tasks.splice(tasks.indexOf(reading),1);tasks.unshift(reading);}}}
 if(state.settings.focus){const index=tasks.findIndex(t=>t.kind===state.settings.focus);if(index>0){const [focused]=tasks.splice(index,1);tasks.unshift(focused);}else if(index<0)tasks[tasks.length-1]={kind:state.settings.focus,title:kindLabels[state.settings.focus],subtitle:'按你选择的方向，先试一小段',time:tasks.at(-1)!.time};}
 function start(kind:Kind){if(kind==='vocabulary')startWords();else openKind(kind);}
 return <div className="home-workspace">
  {!words.length&&<Notice>{contentError||'正在准备学习资料…'}{contentError&&<button className="text-button" onClick={reloadContent}>重新准备</button>}</Notice>}
  <section className="welcome"><div><p className="date">{day}</p><h1>{state.settings.name}，今天从这里开始。</h1><p className="welcome-description">练一点，记下来。按自己的节奏就好。</p></div><button className="text-button companion-link" onClick={ask}><Leaf size={22}/>学习搭子</button></section>
  <div className="learning-dashboard">
   <section className="today-panel"><div className="workspace-section-heading"><h2>今天的安排</h2><span>建议时长 · 随时可停</span></div>
    <div className="time-options" aria-label="今天想学多久">{([10,40,70] as const).map((time,i)=><button key={time} aria-pressed={budget===time} className={budget===time?'selected':''} onClick={()=>settings({budget:time})}>{['轻学','日常','加练'][i]} <span>{time} 分钟</span></button>)}</div>
    <div className="task-list">{tasks.map(task=><button key={task.kind} className="task-row" disabled={!taskAvailable(task.kind)} onClick={()=>start(task.kind)}><KindIcon kind={task.kind} size={25}/><span className="task-copy"><strong>{task.title}</strong><small>{task.subtitle}</small></span><span className="task-time">{task.time} 分钟</span><ChevronRight size={18}/></button>)}</div>
    <div className="start-row"><button className="button primary" disabled={unfinished?!resumeAvailable:!taskAvailable(tasks[0].kind)} onClick={unfinished?resume:()=>start(tasks[0].kind)}>{unfinished?'接着上次练习':'开始学习'}<ArrowRight size={19}/></button><p>{unfinished?`已保存进度 · 第 ${session.index+1} / ${session.ids.length} ${session.kind==='lesson'?'篇':'词'}`:'进度自动保存'}</p></div>
   </section>
   <aside className="daily-panel"><div className="workspace-section-heading"><h2>今天的变化</h2><button className="text-button" onClick={history}>看记录<ChevronRight size={16}/></button></div><DailyProgress events={state.events} compact/><div className="daily-panel-note"><Leaf size={18}/><p>答案和重练都会保留，变化有迹可循。</p></div></aside>
  </div>
  <section className="footprint-panel"><div className="workspace-section-heading"><div><h2>学习足迹</h2><p>完成练习，格子就会留下颜色。空白的日子也没关系。</p></div><button className="text-button" onClick={history}>展开每日记录<ArrowRight size={17}/></button></div><ActivityCalendar events={state.events} embedded weeks={52}/></section>
  <section className="study-shortcuts" aria-label="学习入口"><button onClick={openPapers}><Files size={25}/><span><strong>历年真题</strong><small>六级 · 考研英语一 · 在这里直接作答</small></span><ChevronRight size={19}/></button><button onClick={()=>openKind('reading')}><BookOpen size={25}/><span><strong>{hasDailyPaper?'真题阅读练习':'连续阅读练习'}</strong><small>{hasDailyPaper?nextReading.title:'逐题作答，对照答案接着练'}</small></span><ChevronRight size={19}/></button><button onClick={()=>openKind('vocabulary')}><NotebookText size={25}/><span><strong>词汇与表达</strong><small>词义、语境与间隔复习</small></span><ChevronRight size={19}/></button></section>
 </div>;
}
