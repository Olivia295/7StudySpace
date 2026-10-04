import { useState } from 'react';
import { Search, Plus, ChevronRight, Play } from 'lucide-react';
import { useStore } from '../lib/store';
import { dailyPracticePool, rankDailyLessons, isPastPaperExercise } from '../lib/practice';
import { kindLabels } from '../types';
import type { Kind } from '../types';
import type { ExamPaper } from '../data/examPapers';
import { Empty, KindIcon, Notice, Modal } from '../components/UI';
import ExamShelf from '../components/ExamShelf';
import './workspace.css';

export default function Library({initialKind,openLesson,startWord,startPractice,add,connect}:{initialKind:Kind|'all'|'papers'|'imported';openLesson:(id:string)=>void;startWord:(id:string)=>void;startPractice:(ids:string[])=>void;add:(paper?:ExamPaper)=>void;connect:()=>void}){
 const {words,lessons,state,contentError,reloadContent,syncState,syncError,authenticated,synchronize}=useStore();
 const [retrying,setRetrying]=useState(false);
 const [sources,setSources]=useState(false),[view,setView]=useState<'practice'|'papers'|'imported'>(initialKind==='papers'?'papers':initialKind==='imported'?'imported':'practice');
 const [kind,setKind]=useState<Kind|'all'>(initialKind==='papers'||initialKind==='imported'?'all':initialKind),[query,setQuery]=useState(''),[level,setLevel]=useState('全部难度'),[limit,setLimit]=useState(16);
 const practiceLessons=dailyPracticePool(lessons,kind==='all'?undefined:kind);
 const availableLessons=view==='imported'?lessons.filter(l=>l.id.startsWith('import-')):rankDailyLessons(practiceLessons,state);
 const matching=availableLessons.filter(l=>(level==='全部难度'||l.level===level||(level==='真题'&&(l.tags.includes('原卷阅读')||isPastPaperExercise(l))))&&`${l.title} ${l.subtitle} ${l.tags.join(' ')} ${l.body}`.toLowerCase().includes(query.toLowerCase()));
 const filtered=view==='imported'?[...matching].reverse():matching;
 const trueExercises=practiceLessons.filter(isPastPaperExercise);
 const trueQuestions=trueExercises.reduce((n,l)=>n+(l.questions?.length??0),0);
 const filteredWords=words.filter(w=>(view!=='imported'||w.id.startsWith('import-'))&&`${w.word} ${w.meaning}`.toLowerCase().includes(query.toLowerCase()));
 const objective=filtered.filter(l=>(l.questions?.length??0)>0&&!l.tags.includes('原卷阅读'));
 const practicePool=objective.length?objective:filtered.filter(l=>!l.tags.includes('原卷阅读'));
 const fresh=practicePool.filter(l=>!state.progress[l.id]?.completed);
 const queue=[...fresh,...practicePool.filter(l=>state.progress[l.id]?.completed)].slice(0,3);
 const queueQuestions=queue.reduce((count,l)=>count+(l.questions?.length??0),0);
 const showWords=kind==='vocabulary'&&view==='practice';
 const hasPrivatePapers=state.imports.some(isPastPaperExercise);
 const connectionMessage=syncState==='syncing'?'正在检查连接并同步学习资料，已保存的内容仍可使用。':syncState==='offline'?'暂时离线，当前显示本机已保存的资料。联网后可同步私人学习室中的真题和记录。':syncState==='error'?(syncError||'私人学习室暂时没能同步，本机已保存的资料和记录仍然保留。'):!hasPrivatePapers&&(!authenticated||syncState==='local')?'此浏览器尚未连接私人学习室，当前显示内置练习；连接后同步已收录的真题和记录。':'';
 async function retrySync(){setRetrying(true);try{await synchronize();}finally{setRetrying(false);}}
 return <>
  <div className="page-heading"><div><h1>学习资料</h1><p>真题和专项练习，点开就能做。进度会自动保存。</p></div><button className="button secondary" onClick={()=>add()}><Plus size={19}/>添加资料</button></div>
  {connectionMessage&&<aside className="library-connection" role="status"><p>{connectionMessage}</p>{syncState==='error'||syncState==='offline'?<button className="button secondary" disabled={retrying} onClick={()=>void retrySync()}>{retrying?'正在重试…':'重试同步'}</button>:syncState!=='syncing'&&<button className="button primary" onClick={connect}>连接私人学习室<ChevronRight size={16}/></button>}</aside>}
  <div className="library-mode-tabs" aria-label="资料类型">{([['practice','日常练习'],['papers','历年真题'],['imported','我的资料']] as const).map(([key,label])=><button key={key} className={view===key?'active':''} aria-pressed={view===key} onClick={()=>{setView(key);setLimit(16);setQuery('');setLevel('全部难度');}}>{label}</button>)}</div>
  {view==='papers'?<ExamShelf add={add} startPractice={startPractice} openLesson={openLesson}/>:<>
   <div className="library-tools"><label className="search"><Search size={20}/><input aria-label="搜索学习资料" placeholder={view==='imported'?'搜索自己的资料或词表':'搜索单词、主题或资料'} value={query} onChange={e=>{setQuery(e.target.value);setLimit(16);}}/></label><select aria-label="筛选难度" value={level} onChange={e=>{setLevel(e.target.value);setLimit(16);}}><option>全部难度</option><option>基础</option><option>进阶</option><option>挑战</option><option>真题</option><option>自选</option></select></div>
   {view==='practice'&&<div className="filter-tabs" aria-label="学习方向">{(['all','vocabulary','reading','listening','sentence','writing','translation'] as const).map(k=><button key={k} className={kind===k?'active':''} aria-pressed={kind===k} onClick={()=>{setKind(k);setLimit(16);}}>{k==='all'?'全部':kindLabels[k]}</button>)}</div>}
   {contentError&&<Notice error>{contentError}<button className="text-button" onClick={reloadContent}>重新打开资料</button></Notice>}
   {showWords?<><div className="section-label"><p>{filteredWords.length.toLocaleString()} 个词条</p><button className="text-button" onClick={()=>setSources(true)}>词库来源</button></div><div className="word-list">{filteredWords.slice(0,limit).map(word=><button className="word-row" key={word.id} onClick={()=>startWord(word.id)}><span><strong>{word.word}</strong><small>{word.phonetic||word.pos}</small></span><span className="word-meaning">{word.meaning}</span><ChevronRight size={18}/></button>)}</div>{limit<filteredWords.length&&<button className="button load-more" onClick={()=>setLimit(l=>l+40)}>再看一些词汇</button>}{!filteredWords.length&&!contentError&&<Empty title="换个词试试">也可以把自己的词表添加进来。</Empty>}</>:<>
    <div className="library-start-row"><p>{filtered.length} 份{view==='practice'?'练习资料':'个人资料'}{view==='practice'&&trueQuestions>0?` · 已接入 ${trueQuestions} 道真题`:''}<br/>{queueQuestions?`这一组 ${queueQuestions} 道选择题，逐题练习与对照。`:queue.length?'选择一篇开始，或连续练习一组。':filtered.length?'打开原卷，按自己的节奏逐页阅读。':'换个主题或筛选条件，再找找。'}</p>{queue.length>0&&<button className="button primary" onClick={()=>startPractice(queue.map(l=>l.id))}><Play size={15}/>开始这组练习</button>}</div>
    <div className="lesson-list">{filtered.slice(0,limit).map(lesson=>{
     const original=lesson.tags.includes('原卷阅读'),closeReading=isPastPaperExercise(lesson);
     return <button className="lesson-row" key={lesson.id} onClick={()=>openLesson(lesson.id)}><span className={`lesson-icon ${lesson.kind}`}><KindIcon kind={lesson.kind}/></span><span className="lesson-copy"><span className="lesson-meta"><span className="source-badge">{original?'真题原卷':closeReading?'历年真题':lesson.id.startsWith('import-')?'个人导入':'原创练习'}</span>{original?'PDF · 可分次阅读':<>{kindLabels[lesson.kind]}<span>·</span>{lesson.questions?.length?`${lesson.questions.length} 题`:lesson.level}<span>·</span>约 {lesson.minutes} 分钟</>}</span><strong>{lesson.title}</strong><small>{lesson.subtitle.startsWith('源自原创阅读')?'从短文中拆解句子结构':lesson.subtitle}</small></span>{state.progress[lesson.id]?.completed&&<span className="quiet-label">已练过</span>}<ChevronRight size={19}/></button>;
    })}</div>
    {limit<filtered.length&&<button className="button load-more" onClick={()=>setLimit(l=>l+24)}>再看一些资料</button>}
    {!filtered.length&&!(view==='imported'&&filteredWords.length)&&!contentError&&<Empty title={view==='imported'?'把自己的资料收在这里':'暂时没有找到这份资料'} action={view==='imported'?<button className="button secondary" onClick={()=>add()}>添加第一份资料</button>:undefined}>图片、PDF、文字、题目和词表都可以添加。</Empty>}
   </>}
   {view==='imported'&&filteredWords.length>0&&<><div className="section-label"><h2>我的词表</h2><span>{filteredWords.length} 个词条</span></div><div className="word-list">{filteredWords.slice(0,limit).map(word=><button className="word-row" key={word.id} onClick={()=>startWord(word.id)}><span><strong>{word.word}</strong></span><span className="word-meaning">{word.meaning}</span><ChevronRight size={18}/></button>)}</div>{limit<filteredWords.length&&<button className="button load-more" onClick={()=>setLimit(l=>l+40)}>再看一些单词</button>}</>}
  </>}
  {sources&&<Modal title="这份词库从哪里来" onClose={()=>setSources(false)}><p>3,200 个精选基础词条，面向通用英语与学术阅读；帮助日常积累，不代表覆盖完整考试大纲。</p><p>1,878 个词条配有英中例句，其中 435 组为原创，1,443 组来自 Tatoeba 社区。每张单词卡保留来源、作者与许可。</p><h3>开放资料与署名</h3><p>中文词义来自中文维基词典贡献者，经 Kaikki / Wiktextract 提取、筛选与部分修订，按 CC BY-SA 4.0 使用。词库经过规则检查和抽样复核，尚未全部逐条专业审校。</p><p><a href="https://zh.wiktionary.org/" target="_blank" rel="noreferrer">中文维基词典</a> · <a href="https://tatoeba.org/" target="_blank" rel="noreferrer">Tatoeba</a></p><p className="small muted">原创练习与真题来源分别标注。听力原创短练习采用合成语音。</p></Modal>}
 </>;
}
