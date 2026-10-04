import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Eye, EyeOff, RotateCcw, BookmarkPlus, ArrowUpRight, Pause, ListChecks } from 'lucide-react';
import type { Lesson } from '../types';
import { kindLabels } from '../types';
import { useStore } from '../lib/store';
import { blankProgress, now } from '../lib/study';
import { resetLessonProgress } from '../lib/practice';
import { getOrFetchFile } from '../lib/storage';
import { CompanionPrompt, Notice } from '../components/UI';
import OriginalDocument from '../components/OriginalDocument';
import './practice.css';

function LessonAudio({lesson}:{lesson:Lesson}) {
  const {state,updateProgress}=useStore();
  const ref=useRef<HTMLAudioElement>(null),last=useRef(0);
  const [source,setSource]=useState(lesson.audio?.startsWith('file:')?'':lesson.audio??''),[message,setMessage]=useState('');
  const [a,setA]=useState<number|null>(null),[b,setB]=useState<number|null>(null),[rate,setRate]=useState(1);
  useEffect(()=>{
    const controller=new AbortController();
    let url='',cancelled=false;
    setMessage('');
    if(lesson.audio?.startsWith('file:')) {
      setSource('');
      getOrFetchFile(lesson.audio.slice(5),controller.signal).then(blob=>{
        if(cancelled)return;
        url=URL.createObjectURL(blob);setSource(url);
      }).catch(()=>{if(!cancelled)setMessage('音频暂时没能打开，请联网后重新打开这篇练习，或重新添加原音频。');});
    }else setSource(lesson.audio??'');
    return()=>{cancelled=true;controller.abort();if(url)URL.revokeObjectURL(url);};
  },[lesson.audio]);
  return <div className="audio-player">
    <audio ref={ref} src={source||undefined} controls preload="metadata"
      onLoadedMetadata={()=>{if(ref.current){ref.current.currentTime=Math.min(state.progress[lesson.id]?.position??0,ref.current.duration||0);ref.current.playbackRate=rate;}}}
      onTimeUpdate={()=>{const el=ref.current;if(!el)return;if(a!==null&&b!==null&&el.currentTime>=b)el.currentTime=a;if(Math.abs(el.currentTime-last.current)>3){last.current=el.currentTime;updateProgress(lesson.id,{position:el.currentTime});}}}
      onPause={()=>{if(ref.current)updateProgress(lesson.id,{position:ref.current.currentTime});}}
      onError={()=>setMessage('音频暂时没能打开，请检查网络，或重新添加原音频。')}/>
    <div className="audio-tools">
      <label>语速 <select aria-label="播放速度" value={rate} onChange={e=>{const value=Number(e.target.value);setRate(value);if(ref.current)ref.current.playbackRate=value;}}>{[.75,1,1.25].map(v=><option key={v} value={v}>{v} 倍</option>)}</select></label>
      <button className="text-button" onClick={()=>{setA(ref.current?.currentTime??0);setB(null);}}>从这里重听{a!==null?` (${Math.round(a)}秒)`:''}</button>
      {a!==null&&<button className="text-button" onClick={()=>{const end=ref.current?.currentTime??0;if(end>a+1){setB(end);if(ref.current)ref.current.currentTime=a;}else setMessage('请再播放一小段，然后设置结束位置。');}}>到这里结束</button>}
      {b!==null&&<button className="text-button" onClick={()=>{setA(null);setB(null);}}>取消片段循环</button>}
    </div>
    {message&&<Notice>{message}</Notice>}
    <small>可以暂停、拖动进度，或圈定一小段反复听。</small>
  </div>;
}

interface LessonStudyProps {
  lesson:Lesson;
  exit:()=>void;
  ask:(context:string)=>void;
  onNext:()=>void;
  onRestart:()=>void;
  queueIndex:number;
  queueSize:number;
  queueFinished:boolean;
  queueSummary:{attempts:number;correct:number;total:number};
}

export default function LessonStudy({lesson,exit,ask,onNext,onRestart,queueIndex,queueSize,queueFinished,queueSummary}:LessonStudyProps) {
  const {state,updateProgress,record,saved}=useStore();
  const progress=state.progress[lesson.id]??blankProgress();
  const questions=lesson.questions??[];
  const isQuestion=questions.length>0;
  const isOriginalPaper=!isQuestion&&!!lesson.originalFile&&lesson.tags.includes('原卷阅读');
  const firstUnanswered=questions.findIndex(q=>progress.answers[q.id]===undefined);
  const [revealed,setRevealed]=useState(progress.completed);
  const [transcript,setTranscript]=useState(lesson.kind!=='listening');
  const [notice,setNotice]=useState(''),[original,setOriginal]=useState('');
  const [originalError,setOriginalError]=useState('');
  const [questionIndex,setQuestionIndex]=useState(firstUnanswered<0?0:firstUnanswered);
  const [onlyWrong,setOnlyWrong]=useState(false);
  const [showReference,setShowReference]=useState(false);
  const [mobilePane,setMobilePane]=useState<'material'|'questions'>(progress.completed||questions.some(q=>progress.answers[q.id]!==undefined)?'questions':'material');
  const questionPane=useRef<HTMLElement>(null);
  const submissionSaved=useRef(progress.completed);
  const answered=questions.filter(q=>progress.answers[q.id]!==undefined).length;
  const correct=questions.filter(q=>progress.answers[q.id]===q.answer).length;
  const wrongIndices=questions.flatMap((q,i)=>progress.answers[q.id]!==q.answer?[i]:[]);
  const visibleIndices=onlyWrong&&revealed?wrongIndices:questions.map((_,i)=>i);
  const activeIndex=visibleIndices.includes(questionIndex)?questionIndex:(visibleIndices[0]??0);
  const question=questions[activeIndex];
  const position=visibleIndices.indexOf(activeIndex);

  useEffect(()=>{
    const controller=new AbortController();
    let url='',cancelled=false;
    setOriginal('');setOriginalError('');
    if(lesson.originalFile&&!isOriginalPaper)getOrFetchFile(lesson.originalFile,controller.signal).then(blob=>{
      if(cancelled)return;
      url=URL.createObjectURL(blob);setOriginal(url);
    }).catch(()=>{if(!cancelled)setOriginalError('原文件暂时没有下载完整，请联网后重新打开这篇资料。');});
    return()=>{cancelled=true;controller.abort();if(url)URL.revokeObjectURL(url);};
  },[lesson.originalFile,isOriginalPaper]);

  // Completion arriving from the other device should be reflected before another submission.
  useEffect(()=>{if(progress.completed){setRevealed(true);submissionSaved.current=true;}},[progress.completed]);

  function showQuestion(index:number) {
    setQuestionIndex(index);
    setMobilePane('questions');
    if(window.matchMedia('(max-width: 760px)').matches) {
      requestAnimationFrame(()=>questionPane.current?.scrollIntoView({block:'start',behavior:'instant'}));
    }
  }
  function showPane(pane:'material'|'questions') {
    setMobilePane(pane);
    requestAnimationFrame(()=>document.querySelector('.mobile-pane-switch')?.scrollIntoView({block:'start',behavior:'instant'}));
  }
  function submit() {
    if(isOriginalPaper||submissionSaved.current)return;
    if(isQuestion&&answered<questions.length) {
      const missing=questions.findIndex(q=>progress.answers[q.id]===undefined);
      setNotice(`还有 ${questions.length-answered} 题未答，已帮你回到第 ${missing+1} 题。也可以保存并暂停，下次继续。`);
      showQuestion(missing);
      return;
    }
    if(!isQuestion&&!progress.draft.trim()) {
      setNotice('先留下一点自己的理解，再看看参考内容。哪怕一句话也可以。');
      return;
    }
    setNotice('');
    setRevealed(true);
    if(isQuestion) {
      submissionSaved.current=true;
      record({itemId:lesson.id,title:lesson.title,kind:lesson.kind,correct,total:questions.length,answers:{...progress.answers},response:progress.note});
      updateProgress(lesson.id,{completed:true});
      showQuestion(0);
    }
  }
  function complete() {
    if(submissionSaved.current)return;
    if(!progress.draft.trim()){setNotice(isOriginalPaper?'先写下你的作答，再收进学习记录。':'保存前，先留下一点自己的理解。');return;}
    submissionSaved.current=true;
    setRevealed(true);
    record({itemId:lesson.id,title:lesson.title,kind:lesson.kind,response:progress.draft});
    updateProgress(lesson.id,{completed:true});
    setNotice('作答已收进记录，之后还可以回来对照。');
  }
  function retry() {
    submissionSaved.current=false;
    updateProgress(lesson.id,resetLessonProgress(progress,now()));
    setRevealed(false);setOnlyWrong(false);setQuestionIndex(0);
    setNotice('上次的作答仍保存在记录里，这次可以重新尝试。');
  }
  function addSelection() {
    const text=window.getSelection()?.toString().trim();
    if(!text){setNotice('先长按或拖动选中原文中的句子，再点“收进笔记”。');return;}
    updateProgress(lesson.id,{note:`${progress.note}${progress.note?'\n\n':''}${text}`});
    setNotice('这句话已收进你的笔记。');
  }

  if(queueFinished)return <div className="lesson-page queue-finish">
    <div className="practice-header"><button className="text-button" onClick={exit}><ArrowLeft/>回到学习</button></div>
    <div className="queue-finish-content">
      <span className="queue-finish-icon"><ListChecks size={32} strokeWidth={1.5}/></span>
      <p className="eyebrow">这一组的学习记录</p>
      <h1>在这里，留一个小结。</h1>
      <p className="muted">每一次作答和笔记都已留下。想继续，或先休息，都可以。</p>
      <div className="queue-finish-stats">
        <div><strong>{queueSummary.attempts}</strong><span>篇材料</span></div>
        {queueSummary.total>0&&<div><strong>{queueSummary.correct}<small> / {queueSummary.total}</small></strong><span>答对题数</span></div>}
      </div>
      <p className="queue-finish-note">{queueSummary.total>0?`每篇取本组最近一次作答，共 ${queueSummary.total} 道选择题，${queueSummary.total-queueSummary.correct} 道可以在记录里再对照。`:'自由作答保留了你的原文，方便之后再看自己的表达。'}{queueSummary.attempts===0?' 这组浏览的是之前已完成的内容，没有新增练习记录。':''}</p>
      <div className="center-actions"><button className="button primary" onClick={onRestart}>再练一组<ArrowRight size={18}/></button><button className="button secondary" onClick={exit}>先到这里</button></div>
    </div>
  </div>;

  return <div className={`lesson-page guided-practice ${isOriginalPaper?'original-paper-study':''} mobile-show-${mobilePane}`}>
    <div className="practice-header">
      <button className="text-button" onClick={exit}><ArrowLeft/>{kindLabels[lesson.kind]}</button>
      <button className="button soft" onClick={exit}><Pause size={16}/>保存并暂停</button>
    </div>
    <div className="practice-queue-bar">
      <span>{isOriginalPaper?'原卷阅读':'连续练习'} <strong>{queueIndex+1} / {queueSize}</strong> 篇</span>
      <div className="practice-queue-track" role="progressbar" aria-label="本组练习位置" aria-valuemin={0} aria-valuemax={queueSize} aria-valuenow={queueIndex+(progress.completed?1:0)}>{Array.from({length:queueSize},(_,i)=><span key={i} className={i<queueIndex||(i===queueIndex&&progress.completed)?'done':i===queueIndex?'current':''}/>)}</div>
      <small>{saved}</small>
    </div>
    <div className="lesson-title"><p className="muted">{lesson.level} · 约 {lesson.minutes} 分钟{isQuestion?` · ${questions.length} 道题`:''}</p><h1>{lesson.title}</h1><p>{lesson.subtitle}</p></div>
    <div className="mobile-pane-switch" role="group" aria-label="切换材料与题目">
      <button className={mobilePane==='material'?'active':''} aria-pressed={mobilePane==='material'} onClick={()=>showPane('material')}><BookOpen size={17}/>{isOriginalPaper?'原卷':lesson.kind==='listening'?'听力与原文':'阅读材料'}</button>
      <button className={mobilePane==='questions'?'active':''} aria-pressed={mobilePane==='questions'} onClick={()=>showPane('questions')}><ListChecks size={17}/>{isQuestion?`题目 ${answered}/${questions.length}`:'我的作答'}</button>
    </div>
    <div className={`lesson-layout ${lesson.kind==='sentence'?'sentence-layout':''}`}>
      <section className="reading-pane" aria-label="学习材料">
        {lesson.audio&&<LessonAudio lesson={lesson}/>}
        {isOriginalPaper?<><OriginalDocument fileId={lesson.originalFile!} filename={lesson.originalName} initialPage={progress.position||1} onPageChange={page=>updateProgress(lesson.id,{position:page})}/>{lesson.referenceFile&&<div className="original-paper-reference"><button className="button secondary" aria-expanded={showReference} onClick={()=>setShowReference(!showReference)}>{showReference?<EyeOff size={17}/>:<Eye size={17}/>} {showReference?'收起参考答案':'查看机构参考答案'}</button>{showReference&&<><p className="original-reference-note">机构整理的参考答案，仅供对照，不是官方评分标准。打开参考答案不会记录分数。</p><OriginalDocument fileId={lesson.referenceFile} filename={lesson.referenceName} label="参考答案"/></>}</div>}<div className="original-paper-description">{lesson.body.split(/\n\s*\n/).filter(Boolean).map((paragraph,i)=><p key={i}>{paragraph}</p>)}</div></>:<><div className="article-toolbar"><span><BookOpen size={18}/>{lesson.kind==='listening'?'听力原文':'学习材料'}</span>{lesson.kind==='listening'?<button className="text-button" onClick={()=>setTranscript(!transcript)}>{transcript?<EyeOff size={17}/>:<Eye size={17}/>} {transcript?'收起原文':'看看原文'}</button>:<button className="text-button" onClick={addSelection}><BookmarkPlus size={17}/>收进笔记</button>}</div>
        {transcript?<article className="english-article">{lesson.body.split(/\n\s*\n/).filter(Boolean).map((p,i)=><p key={i}>{p}</p>)}</article>:<div className="transcript-hidden"><EyeOff size={25}/><p>先听听看，抓住大意。</p><small>需要时，随时可以打开原文。</small></div>}</>}
        {lesson.translation&&revealed&&<details className="translation"><summary>对照中文理解<ChevronDown size={16}/></summary><p>{lesson.translation}</p></details>}
        <details className="source"><summary>资料来源与说明</summary><p>{lesson.source.title}</p>{lesson.source.license&&<p>{lesson.source.license}</p>}{lesson.source.url&&/^https?:/.test(lesson.source.url)&&<a href={lesson.source.url} target="_blank" rel="noreferrer">查看原始来源<ArrowUpRight size={15}/></a>}{original&&<a href={original} target="_blank" rel="noreferrer">查看原文件：{lesson.originalName}</a>}{originalError&&<p role="status">{originalError}</p>}</details>
        <button className="button primary material-continue" onClick={()=>showPane('questions')}>{isQuestion?revealed?'看看作答解析':answered?'继续作答':'开始作答':'写下我的理解'}<ArrowRight size={18}/></button>
      </section>
      <section className="exercise-pane" ref={questionPane} aria-label="作答与解析">
        {isQuestion?<>
          {revealed?<div className="practice-result" aria-live="polite"><div><span>本篇答对</span><strong>{correct}<small> / {questions.length}</small></strong></div><p>{correct===questions.length?'可以回到原文对照，看看自己的思路是否一致。':`${questions.length-correct} 道题可以再看看，结合原文与参考答案核对。`}</p></div>:<div className="question-section-heading"><h2>一次想清楚一道题</h2><p className="muted">选好后再往下，提交整篇时一起对照。</p></div>}
          <div className="question-map-heading"><span>{revealed?'对照答案':`已答 ${answered} / ${questions.length}`}</span>{revealed&&wrongIndices.length>0&&<button className="text-button" aria-pressed={onlyWrong} onClick={()=>{const next=!onlyWrong;setOnlyWrong(next);showQuestion(next?wrongIndices[0]:0);}}>{onlyWrong?'查看全部题目':`只看错题 (${wrongIndices.length})`}</button>}</div>
          <nav className="question-map" aria-label="本篇答题卡">{visibleIndices.map(i=>{
            const q=questions[i],hasAnswer=progress.answers[q.id]!==undefined,isCorrect=progress.answers[q.id]===q.answer;
            const status=revealed?(isCorrect?'答对':'答错'):(hasAnswer?'已作答':'未作答');
            return <button key={q.id} aria-label={`第 ${i+1} 题，${status}`} aria-current={activeIndex===i?'step':undefined} className={`${activeIndex===i?'active':''} ${revealed?(isCorrect?'right':'wrong'):hasAnswer?'answered':''}`} onClick={()=>showQuestion(i)}><span>{i+1}</span>{revealed?<small>{isCorrect?'对':'错'}</small>:hasAnswer?<Check size={12}/>:null}</button>;
          })}</nav>
          {question&&<fieldset key={question.id} className="question focused-question"><legend><span>{String(activeIndex+1).padStart(2,'0')}</span>{question.prompt}</legend>{question.options.map((option,i)=><label key={i} className={`answer-option ${progress.answers[question.id]===i?'chosen':''} ${revealed&&question.answer===i?'correct':''} ${revealed&&progress.answers[question.id]===i&&question.answer!==i?'incorrect':''}`}><input type="radio" name={question.id} value={i} checked={progress.answers[question.id]===i} disabled={revealed} onChange={()=>{setNotice('');updateProgress(lesson.id,{answers:{...progress.answers,[question.id]:i}});}}/><span className="option-letter">{String.fromCharCode(65+i)}</span><span>{option}</span>{revealed&&question.answer===i&&<Check size={18} aria-label="正确答案"/>}</label>)}{revealed&&<div className="answer-explanation"><strong>{progress.answers[question.id]===question.answer?'你的选择与答案一致':`你的选择 ${progress.answers[question.id]===undefined?'未作答':String.fromCharCode(65+progress.answers[question.id])} · 参考答案 ${String.fromCharCode(65+question.answer)}`}</strong><p>{question.explanation||'这道题尚未附解析，可以结合原文和参考答案继续思考。'}</p>{question.evidence&&<blockquote>{question.evidence}</blockquote>}</div>}</fieldset>}
          <div className="question-navigation"><button className="button secondary" disabled={position<=0} onClick={()=>showQuestion(visibleIndices[position-1])}><ChevronLeft size={17}/>上一题</button>{position<visibleIndices.length-1?<button className={`button ${revealed?'secondary':'primary'}`} onClick={()=>showQuestion(visibleIndices[position+1])}>下一题<ChevronRight size={17}/></button>:!revealed?<button className="button primary" onClick={submit}>提交本篇<Check size={17}/></button>:<span className="question-end">{onlyWrong?'本篇错题已看到最后':'本篇解析已看到最后'}</span>}</div>
          {!revealed&&answered===questions.length&&position<questions.length-1&&<button className="text-button submit-from-map" onClick={submit}>已全部作答，提交本篇<ArrowRight size={15}/></button>}
        </>:<>
          <h2>{isOriginalPaper?'我的作答':lesson.kind==='sentence'?'先说说你的理解':'把想法写下来'}</h2><p className="muted">{isOriginalPaper?'可以按原卷题号写答案，或留下自己的思路。文字会自动保存。':'先尝试，再对照。这里会自动保存。'}</p>
          <textarea className="draft-area" aria-label="我的作答" readOnly={isOriginalPaper&&progress.completed} value={progress.draft} placeholder={isOriginalPaper?'例如：1. B；2. C。也可以写下作文、翻译或暂时没想通的地方……':lesson.kind==='sentence'?'可以先写句子主干，或用中文说说它的意思……':'在这里写下你的表达或理解……'} onChange={e=>updateProgress(lesson.id,{draft:e.target.value})}/>
          <p className="draft-count">{isOriginalPaper&&progress.completed?'这次作答已收进记录 · 未自动评分':`${progress.draft.trim()?progress.draft.trim().split(/\s+/).length:0} 个空格分词 · 草稿自动保存`}</p>
          {isOriginalPaper?<p className="original-draft-hint">{progress.completed?'这份作答已保留。想再做一次，可以点击下方“重新练”，原有记录不会被覆盖。':'草稿会自动保存。写完后，可以把这次作答收进学习记录；这里只记录自由作答，不自动判分。'}</p>:!revealed&&<button className="button primary" onClick={submit}>看看参考与解析</button>}
        </>}
        {(revealed||isOriginalPaper)&&<>
          {!isOriginalPaper&&!!lesson.analysis?.length&&<details className="analysis-disclosure" open={!isQuestion}><summary>一步步看清楚<ChevronDown size={16}/></summary><div className="analysis-block">{lesson.analysis.map((a,i)=><p key={i}>{a}</p>)}</div></details>}
          {!isOriginalPaper&&lesson.sample&&<div className="sample-block"><h3>参考表达</h3><p>{lesson.sample}</p><small>参考表达并非唯一答案。可以回到上方修改自己的版本。</small></div>}
          {!isQuestion&&!isOriginalPaper&&!lesson.sample&&!lesson.analysis?.length&&<Notice>这份资料没有参考答案。可以留下笔记，或请学习搭子一起分析。</Notice>}
          {progress.completed?<div className="lesson-next-panel"><div className="lesson-saved-line"><Check size={16}/><span>{isOriginalPaper?'这次作答已收进记录':'本篇已收进记录'}</span><button className="text-button" onClick={retry}><RotateCcw size={14}/>重新练</button></div><button className="button primary" onClick={onNext}>{queueIndex+1<queueSize?'继续下一篇':'看看本组记录'}<ArrowRight size={18}/></button><small>{queueIndex+1<queueSize?'不用回到资料库，接着练下一篇。':'记录里可以随时回看本次作答。'}</small></div>:<button className="button primary original-record-action" onClick={complete}>{isOriginalPaper?'把这次作答收进记录':'保存这次练习'}<Check size={18}/></button>}
        </>}
        {isOriginalPaper&&!progress.completed&&<div className="original-paper-next"><button className="button secondary" onClick={queueIndex+1<queueSize?onNext:exit}>{queueIndex+1<queueSize?'阅读下一份原卷':'返回资料库'}<ArrowRight size={17}/></button><small>作答和笔记已随输入自动保存。</small></div>}
        {notice&&<div role="status"><Notice>{notice}</Notice></div>}
        {progress.conflicts?.length?<details className="source"><summary>保留的历史文字</summary>{progress.conflicts.map((c,i)=><div key={i}><small>{c.field==='draft'?'作答':'笔记'} · {new Date(c.at).toLocaleString('zh-CN')}</small><p>{c.text}</p><button className="text-button" onClick={()=>updateProgress(lesson.id,{[c.field]:c.text})}>使用这个版本</button></div>)}</details>:null}
        <details className="practice-notes"><summary><BookmarkPlus size={16}/>我的笔记{progress.note&&<span>已有记录</span>}<ChevronDown size={16}/></summary><label className="notes-label">这次发现了什么？<textarea value={progress.note} placeholder="哪句话没读懂？试着用自己的话写下来。" onChange={e=>updateProgress(lesson.id,{note:e.target.value})}/></label></details>
      </section>
    </div>
    <CompanionPrompt onClick={()=>ask(`学习材料：${lesson.title}\n${lesson.body}\n题目：${JSON.stringify(lesson.questions??[])}\n我的作答：${progress.draft||JSON.stringify(progress.answers)}\n笔记：${progress.note}`)}/>
  </div>;
}
