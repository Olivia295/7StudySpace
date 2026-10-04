import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Leaf, Settings as SettingsIcon, Sun, BookOpen, RotateCcw, NotebookText, Cloud, CloudOff } from 'lucide-react';
import { useStore } from './lib/store';
import { now, vocabularyQueue, reviewSummary } from './lib/study';
import type { Kind, Tab, AIJob, ChatMessage } from './types';
import type { ExamPaper } from './data/examPapers';
import { lessonQueue, sessionSummary, sessionAtLesson, resetLessonProgress, dailyPracticePool, rankDailyLessons, nextDailyLesson, isPracticeLesson, isPastPaperExercise } from './lib/practice';
import { api } from './lib/storage';
import { exportRawBackup } from './lib/imports';
import Today from './pages/Today';
import { Empty } from './components/UI';
import { useAIJobs, reviewPrompt, applyAIJob, shouldStartWeeklyReview } from './lib/ai';
const Library=lazy(()=>import('./pages/Library')),WordStudy=lazy(()=>import('./pages/WordStudy')),LessonStudy=lazy(()=>import('./pages/LessonStudy')),Review=lazy(()=>import('./pages/Review')),History=lazy(()=>import('./pages/History')),Settings=lazy(()=>import('./components/Settings')),Import=lazy(()=>import('./components/Import')),Tutor=lazy(()=>import('./components/Tutor'));
const tabs:{key:Tab;label:string;icon:typeof Sun}[]=[{key:'today',label:'今天',icon:Sun},{key:'library',label:'学习',icon:BookOpen},{key:'review',label:'复习',icon:RotateCcw},{key:'history',label:'记录',icon:NotebookText}];
export default function App(){
 const {state,words,lessons,ready,storageError,contentError,syncState,saved,mutate,reloadContent,authenticated}=useStore();const [route,setRoute]=useState(location.hash.slice(1)||'today'),[libraryKind,setLibraryKind]=useState<Kind|'all'|'papers'|'imported'>('all'),[modal,setModal]=useState<'settings'|'connect'|'import'|'tutor'|'restore'|null>(null),[context,setContext]=useState(''),[reviewMode,setReviewMode]=useState(false);const [importPaper,setImportPaper]=useState<ExamPaper|undefined>();const weeklyBusy=useRef(false);
 useAIJobs();
 useEffect(()=>{const handler=()=>{setRoute(location.hash.slice(1)||'today');window.scrollTo(0,0);};window.addEventListener('hashchange',handler);return()=>window.removeEventListener('hashchange',handler);},[]);
 useEffect(()=>{document.title=`7StudySpace · ${state.settings.name} 的学习室`;},[state.settings.name]);
 useEffect(()=>{if(!ready||storageError||!authenticated||weeklyBusy.current||!shouldStartWeeklyReview(state))return;
 weeklyBusy.current=true;const at=now();const attempt:ChatMessage={id:crypto.randomUUID(),role:'assistant',text:'本周复盘正在整理，完成后会保存在这里。',at,status:'queued',review:true,through:at};mutate(s=>({...s,chats:[...(s.chats??[]),attempt]}));
 api<{job:AIJob}>('/ai/jobs',{method:'POST',body:JSON.stringify({kind:'review',prompt:reviewPrompt,context:reviewSummary(state),persona:`你是${state.settings.companion}。${state.settings.tone}。${state.settings.instruction}`,dedupeKey:`weekly:${at}`})}).then(({job})=>{mutate(s=>applyAIJob(s,attempt,job));}).catch(()=>{mutate(s=>({...s,chats:(s.chats??[]).map(m=>m.id===attempt.id?{...m,status:'failed',text:'这次自动复盘暂时没有送达，学习记录仍然保留。连接恢复后可以手动发起复盘。',at:now()}:m)}));}).finally(()=>{weeklyBusy.current=false;});},[state,ready,storageError,authenticated,mutate]);
 function navigate(next:string){if(location.hash.slice(1)===next){setRoute(next);window.scrollTo(0,0);}else location.hash=next;}
 function startWords(id?:string,dueOnly=false){const selected=id?words.filter(w=>w.id===id):vocabularyQueue(words,state,10,dueOnly);if(!selected.length){navigate('review');return;}mutate(s=>({...s,session:{ids:selected.map(w=>w.id),index:0,kind:'vocabulary',startedAt:now(),updatedAt:now()}}));navigate('words');}
 function startPractice(ids:string[],resetCompleted=false){
  const valid=[...new Set(ids)].filter(id=>lessons.some(l=>l.id===id));if(!valid.length)return;
  mutate(s=>{const at=now();const progress={...s.progress};if(resetCompleted)for(const id of valid){const old=progress[id];if(old?.completed)progress[id]=resetLessonProgress(old,at);}
   return {...s,progress,session:{ids:valid,index:0,kind:'lesson',startedAt:at,updatedAt:at,finished:false}};});
  navigate(`lesson/${encodeURIComponent(valid[0])}`);
 }
 function openLesson(id:string){const session=state.session;if(session?.kind==='lesson'&&!session.finished&&session.ids.includes(id)){mutate(s=>({...s,session:sessionAtLesson(s.session,id,now())}));navigate(`lesson/${encodeURIComponent(id)}`);return;}startPractice(lessonQueue(lessons,state,id));}
 function advanceLesson(){const session=state.session;if(session?.kind!=='lesson')return;const next=session.index+1;mutate(s=>({...s,session:{...session,index:Math.min(next,session.ids.length-1),finished:next>=session.ids.length,updatedAt:now()}}));if(next<session.ids.length)navigate(`lesson/${encodeURIComponent(session.ids[next])}`);else window.scrollTo(0,0);}
 function restartPractice(){
  const previous=state.session?.ids??[],anchor=lessons.find(l=>l.id===previous[0]);
  const personal=anchor?.id.startsWith('import-')&&!dailyPracticePool([anchor]).length&&!anchor.tags.includes('原卷阅读');
  const candidates=personal?lessons.filter(l=>l.kind===anchor?.kind&&l.id.startsWith('import-')&&isPracticeLesson(l)&&!isPastPaperExercise(l)):rankDailyLessons(lessons,state,anchor?.kind);
  const first=candidates.find(l=>!previous.includes(l.id)&&!state.progress[l.id]?.completed)??candidates.find(l=>!state.progress[l.id]?.completed)??candidates.find(l=>!previous.includes(l.id))??candidates[0];
  if(first)startPractice(lessonQueue(lessons,state,first.id,3,!!state.progress[first.id]?.completed),true);
 }
 function openPapers(){setLibraryKind('papers');navigate('library');}
 function addMaterial(paper?:ExamPaper){setImportPaper(paper);setModal('import');}
 function openKind(kind:Kind){setLibraryKind(kind);navigate('library');}
 function nextLesson(kind:Kind){
  const next=nextDailyLesson(lessons,state,kind);if(!next){openKind(kind);return;}
  const session=state.session,index=session?.kind==='lesson'&&!session.finished?session.ids.indexOf(next.id):-1;
  if(session?.kind==='lesson'&&index>=session.index){mutate(s=>({...s,session:sessionAtLesson(s.session,next.id,now())}));navigate(`lesson/${encodeURIComponent(next.id)}`);return;}
  const repeat=!!state.progress[next.id]?.completed;startPractice(lessonQueue(lessons,state,next.id,3,repeat),repeat);
 }
 function ask(text='',review=false){setContext(text);setReviewMode(review);setModal('tutor');}
 function resume(){if(state.session?.kind==='vocabulary')navigate('words');else if(state.session?.ids[state.session.index])navigate(`lesson/${encodeURIComponent(state.session.ids[state.session.index])}`);}
 const lesson=route.startsWith('lesson/')?lessons.find(l=>l.id===decodeURIComponent(route.slice(7))):undefined;const studying=route==='words'||route.startsWith('lesson/');
 useEffect(()=>{if(!lesson)return;const session=state.session;if(session?.kind==='lesson'&&session.ids[session.index]===lesson.id)return;mutate(s=>({...s,session:sessionAtLesson(s.session,lesson.id,now())}));},[lesson?.id,mutate]);
 if(!ready)return <div className="loading-room"><Leaf size={38}/><p>正在打开学习室…</p></div>;
 if(storageError)return <main className="main-content"><Empty title="先帮记录留好备份" action={<div className="button-group"><button className="button primary" onClick={()=>void exportRawBackup()}>导出原始记录</button><button className="button secondary" onClick={()=>setModal('restore')}>恢复可用备份</button></div>}>{storageError} 学习室已暂停自动保存，以保护原记录。</Empty>{modal==='restore'&&<Suspense fallback={null}><Settings restoreMode onClose={()=>setModal(null)}/></Suspense>}</main>;
 return <><a className="skip-link" href="#main-content">跳到学习内容</a>{!studying&&<header className="app-header"><button className="brand" onClick={()=>navigate('today')} aria-label="回到今天"><Leaf size={32} strokeWidth={1.3}/><span>7StudySpace</span></button><nav className="desktop-nav" aria-label="主要导航">{tabs.map(tab=><button key={tab.key} className={route===tab.key?'active':''} aria-current={route===tab.key?'page':undefined} onClick={()=>navigate(tab.key)}>{tab.label}</button>)}</nav><div className="header-end"><button className="icon-button" aria-label="学习室设置" onClick={()=>setModal('settings')}><SettingsIcon size={22} strokeWidth={1.5}/></button><button className="avatar" aria-label="个人偏好" onClick={()=>setModal('settings')}>{state.settings.name.slice(0,2)}</button></div></header>}
 <main id="main-content" className={studying?'study-main':'main-content'}><Suspense fallback={<div className="loading-room"><Leaf/><p>正在打开…</p></div>}>{route==='today'&&<Today startWords={()=>startWords()} openKind={kind=>kind==='vocabulary'?openKind(kind):nextLesson(kind)} resume={resume} ask={()=>ask()} openPapers={openPapers} history={()=>navigate('history')}/>}{route==='library'&&<Library key={libraryKind} initialKind={libraryKind} openLesson={openLesson} startWord={id=>startWords(id)} startPractice={ids=>startPractice(ids,true)} add={addMaterial} connect={()=>setModal('connect')}/>}{route==='review'&&<Review startWords={()=>startWords(undefined,true)} openLesson={openLesson} library={()=>navigate('library')}/>}{route==='history'&&<History openItem={id=>words.some(w=>w.id===id)?startWords(id):openLesson(id)} restore={()=>setModal('restore')} review={()=>ask('',true)}/>}{route==='words'&&<WordStudy exit={()=>navigate('today')} ask={ask}/>}{lesson&&<LessonStudy key={`${lesson.id}:${state.session?.startedAt??'direct'}`} lesson={lesson} exit={()=>navigate('library')} ask={ask} onNext={advanceLesson} onRestart={restartPractice} queueIndex={state.session?.kind==='lesson'?state.session.index:0} queueSize={state.session?.kind==='lesson'?state.session.ids.length:1} queueFinished={state.session?.kind==='lesson'&&!!state.session.finished} queueSummary={sessionSummary(state.events,state.session)}/>}{route.startsWith('lesson/')&&!lesson&&<Empty title={contentError?'资料暂时没有打开':'正在准备这份资料'} action={<button className="button secondary" onClick={reloadContent}>重新加载资料</button>}>{contentError||'稍等一下，或回到资料库选择其他内容。'}</Empty>}{!['today','library','review','history','words'].includes(route)&&!route.startsWith('lesson/')&&<Empty title="这条小路还没通到学习室" action={<button className="button primary" onClick={()=>navigate('today')}>回到今天</button>}>学习记录仍然保存在这里。</Empty>}</Suspense></main>
 {!studying&&<><footer className="app-footer"><Leaf size={14}/><span>按自己的节奏，慢慢积累。</span><button onClick={()=>setModal('settings')}>{syncState==='synced'?<Cloud size={15}/>:<CloudOff size={15}/>}<span>{syncState==='synced'?'已同步':syncState==='syncing'?'正在同步':syncState==='error'?'本机已保存 · 同步待重试':saved}</span></button></footer><nav className="mobile-nav" aria-label="手机导航">{tabs.map(({key,label,icon:Icon})=><button key={key} className={route===key?'active':''} aria-current={route===key?'page':undefined} onClick={()=>navigate(key)}><Icon size={21} strokeWidth={1.6}/><span>{label}</span></button>)}</nav></>}
 <Suspense fallback={null}>{(modal==='settings'||modal==='connect'||modal==='restore')&&<Settings restoreMode={modal==='restore'} connectMode={modal==='connect'} onClose={()=>setModal(null)}/>} {modal==='import'&&<Import paper={importPaper} onClose={()=>setModal(null)} onSaved={()=>{setModal(null);setLibraryKind('imported');navigate('library');}}/>}{modal==='tutor'&&<Tutor context={context} reviewMode={reviewMode} onClose={()=>setModal(null)}/>}</Suspense></>;
}
