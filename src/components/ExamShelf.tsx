import { useState } from 'react';
import { ArrowRight, Plus, Play, FileText, ArrowUpRight } from 'lucide-react';
import { examPapers } from '../data/examPapers';
import type { ExamPaper } from '../data/examPapers';
import { useStore } from '../lib/store';
import { isPastPaperExercise, paperPracticeResumeId } from '../lib/practice';
import { kindLabels } from '../types';
import { Empty } from './UI';

export default function ExamShelf({add,startPractice,openLesson}:{add:(paper?:ExamPaper)=>void;startPractice:(ids:string[])=>void;openLesson:(id:string)=>void}){
 const {state}=useStore();
 const related=(paper:ExamPaper)=>state.imports.filter(lesson=>lesson.tags.includes(`paper:${paper.id}`));
 // A source URL alone is not a practice. Only show papers that can actually be
 // answered here; keep the research catalogue as provenance, not a dead-end UI.
 const ready=examPapers.map(paper=>({paper,exercises:related(paper).filter(isPastPaperExercise),originals:related(paper).filter(l=>l.tags.includes('原卷阅读')&&l.originalFile)})).filter(item=>item.exercises.length>0);
 const [exam,setExam]=useState<ExamPaper['exam']|'all'>('all'),[year,setYear]=useState('all');
 const available=ready.filter(item=>exam==='all'||item.paper.exam===exam);
 const years=[...new Set(available.map(item=>item.paper.year))].sort((a,b)=>b-a);
 const papers=available.filter(item=>year==='all'||String(item.paper.year)===year).sort((a,b)=>b.paper.year-a.paper.year);
 const questionCount=ready.reduce((n,item)=>n+item.exercises.reduce((sum,l)=>sum+(l.questions?.length??0),0),0);
 const taskCount=ready.reduce((n,item)=>n+item.exercises.filter(l=>!l.questions?.length).length,0);
 return <section aria-label="历年真题资料架">
  <div className="exam-filters"><div className="exam-filter-switch" aria-label="选择考试">{([['all','全部'],['cet6','英语六级'],['postgraduate','考研英语一']] as const).map(([key,label])=><button key={key} className={exam===key?'active':''} aria-pressed={exam===key} onClick={()=>{setExam(key);setYear('all');}}>{label}</button>)}</div><select aria-label="真题年份" value={year} onChange={e=>setYear(e.target.value)}><option value="all">全部年份</option>{years.map(y=><option key={y} value={y}>{y} 年</option>)}</select></div>
  <div className="exam-intro"><p><strong>{ready.length} 套真题可直接练习 · {questionCount} 道选择题{taskCount?` · ${taskCount} 项写作与翻译`:''}</strong><br/>选一套就能在这里作答，也已加入日常练习。选项、草稿和进度都会保存。</p><button className="button secondary" onClick={()=>add()}><Plus size={16}/>添加自己的真题</button></div>
  <div className="section-label"><p>{papers.length} 套可练真题</p><span>按考试与年份选择</span></div>
  <div className="exam-list">{papers.map(({paper,exercises,originals})=>{
   const pending=exercises.filter(l=>!state.progress[l.id]?.completed);
   const inProgress=pending.find(l=>Object.keys(state.progress[l.id]?.answers??{}).length>0||state.progress[l.id]?.draft.trim());
   const queue=inProgress?[inProgress,...pending.filter(l=>l.id!==inProgress.id)]:pending.length?pending:exercises;
   const resumeId=paperPracticeResumeId(state,exercises.map(l=>l.id));
   const questions=exercises.reduce((n,l)=>n+(l.questions?.length??0),0);
   const completed=exercises.length-pending.length;
   const kinds=[...new Set(exercises.map(l=>kindLabels[l.kind]))];
   return <article className="exam-row is-collected" key={paper.id}>
    <div className="exam-year">{paper.year}</div>
    <div className="exam-copy"><span className="source-badge">站内真题练习</span><h3>{paper.title}</h3><p>{kinds.join(' · ')}{questions?` · ${questions} 道选择题`:''} · {exercises.length} 份练习</p>
     <p className="exam-availability">{completed?`已完成 ${completed} / ${exercises.length} 份${pending.length?'，可以接着上次继续':'，也可以重新练习'}`:'从第一篇开始，随时可以暂停。'}</p>
     <details className="paper-exercise-list"><summary>选择本卷练习</summary>{exercises.map(lesson=><button className="paper-exercise-link" key={lesson.id} onClick={()=>openLesson(lesson.id)}><span>{lesson.title}<small>{lesson.questions?.length?`${lesson.questions.length} 道题`:'自由作答'}{state.progress[lesson.id]?.completed?' · 已练过':''}</small></span><ArrowRight size={15}/></button>)}</details>
     <details className="paper-provenance"><summary>来源与收录范围</summary><p>当前可以直接作答的内容以上方练习为准。答案来自机构整理，仅供学习核对。</p><p>来源：{exercises[0].source.title}</p>{originals.map(lesson=><button key={lesson.id} className="text-button" onClick={()=>openLesson(lesson.id)}><FileText size={14}/>在站内查看完整原卷</button>)}<a className="text-button exam-source-link" href={originals[0]?.source.url||exercises[0].source.url||paper.url} target="_blank" rel="noreferrer">资料出处（可选）<ArrowUpRight size={13}/></a></details>
    </div>
    <div className="exam-actions"><button className="button primary" onClick={()=>resumeId?openLesson(resumeId):startPractice(queue.map(l=>l.id))}><Play size={14}/>{resumeId?'继续做题':!pending.length?'再练一遍':inProgress||completed?'继续做题':'开始做题'}</button><span className="paper-action-note">在本站作答 · 自动保存</span></div>
   </article>;
  })}</div>
  {!papers.length&&<Empty title={ready.length?'这个筛选下还没有可练真题':'真题正在等你收进学习室'} action={<button className="button secondary" onClick={()=>add()}>添加真题</button>}>{ready.length?'换个考试或年份，就可以继续练。':'已连接学习室时会自动同步已收录的题目，也可以添加自己的题目。'}</Empty>}
 </section>;
}
