import { useEffect, useRef, useState } from 'react';
import { Download, Smartphone, RefreshCw, Upload, Copy, Check, ShieldCheck } from 'lucide-react';
import { useStore } from '../lib/store';
import { api } from '../lib/storage';
import { exportBackup, parseBackup, restoreFiles } from '../lib/imports';
import { mergeStates } from '../lib/study';
import { kindLabels } from '../types';
import type { Kind } from '../types';
import { Modal, Notice } from './UI';

export default function Settings({onClose,restoreMode=false,connectMode=false}:{onClose:()=>void;restoreMode?:boolean;connectMode?:boolean}){
 const {state,settings,saved,syncState,syncError,authenticated,synchronize,mutate,storageError,recover}=useStore();
 const [message,setMessage]=useState(''),[code,setCode]=useState(''),[expires,setExpires]=useState(''),[claim,setClaim]=useState(''),[pairing,setPairing]=useState(connectMode),[busy,setBusy]=useState(false);
 const upload=useRef<HTMLInputElement>(null);const [needsSetup,setNeedsSetup]=useState(false),[setup,setSetup]=useState('');
 useEffect(()=>{void api<{needsBootstrap:boolean}>('/session').then(s=>setNeedsSetup(s.needsBootstrap)).catch(()=>{});},[]);
 function showSyncResult(result:Awaited<ReturnType<typeof synchronize>>){
  setMessage(result==='synced'?'':result==='unpaired'?'尚未连接私人学习室，请输入有效的配对码。':result==='offline'?'暂时离线，本机记录仍然保留。联网后可以再次同步。':result==='busy'?'已有同步正在处理，请稍后查看连接状态。':'同步尚未完成，本机记录仍然保留，请稍后重试。');
 }
 async function syncNow(){try{setBusy(true);showSyncResult(await synchronize());}catch{setMessage('同步尚未完成，本机记录仍然保留，请稍后重试。');}finally{setBusy(false);}}
 async function initialize(){try{setBusy(true);await api('/bootstrap',{method:'POST',body:JSON.stringify({token:setup})});setSetup('');setNeedsSetup(false);showSyncResult(await synchronize());}catch{setMessage('初始化口令未能使用，请在运行学习室的电脑上重新检查。');}finally{setBusy(false);}}
 async function generate(){try{setBusy(true);const result=await api<{code:string;expiresAt:string}>('/pairing',{method:'POST',body:'{}'});setCode(result.code);setExpires(new Date(result.expiresAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}));}catch{setMessage('暂时无法创建配对码，请先确认当前设备已连接私人学习空间。');}finally{setBusy(false);}}
 async function connect(){try{setBusy(true);await api('/pairing/claim',{method:'POST',body:JSON.stringify({code:claim.trim()})});setPairing(false);setClaim('');showSyncResult(await synchronize());}catch{setMessage('没有配对成功。请核对配对码，过期后可在原设备重新生成。');}finally{setBusy(false);}}
 async function backup(){try{setBusy(true);await exportBackup(state);setMessage('备份已准备好，请保存到“文件”中。');}catch{setMessage('备份未完成，请稍后再试。');}finally{setBusy(false);}}
 async function restore(file:File){try{setBusy(true);const parsed=parseBackup(await file.text());await restoreFiles(parsed.files);if(storageError)recover(parsed.state);else mutate(s=>mergeStates(s,parsed.state));setMessage('备份已合并，现有学习记录也保留了。');}catch{setMessage('这份备份无法读取，请选择学习室导出的完整 JSON 备份。');}finally{setBusy(false);}}
 const connectionStatus=authenticated&&syncState==='synced'?'已连接，真题和学习记录已同步':syncState==='syncing'?'正在检查连接与同步资料…':syncState==='offline'?'暂时离线 · 本机记录仍然保留':syncState==='error'?(syncError||'同步尚未完成 · 本机记录仍然保留'):!authenticated?'此浏览器尚未连接私人学习室':saved;
 return <Modal title={restoreMode?'恢复学习记录':connectMode?'连接私人学习室':'把学习室调成你喜欢的样子'} onClose={onClose}>
  <div className="save-status"><ShieldCheck size={21}/><span role="status">{connectionStatus}</span><button className="text-button" disabled={busy} onClick={()=>void syncNow()}><RefreshCw size={17}/>同步</button></div>
  {!restoreMode&&<>
   {!connectMode&&<div className="settings-fields"><label>最近想多练一点<select value={state.settings.focus??''} onChange={e=>settings({focus:(e.target.value||null) as Kind|null})}><option value="">均衡安排</option>{Object.entries(kindLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>怎么称呼你<input value={state.settings.name} maxLength={30} onChange={e=>settings({name:e.target.value||'77'})}/></label><label>学习搭子的名字<input value={state.settings.companion} maxLength={30} onChange={e=>settings({companion:e.target.value})}/></label><label>喜欢的讲解方式<select value={state.settings.tone} onChange={e=>settings({tone:e.target.value})}><option>温柔、耐心，解释清楚</option><option>简洁直接，重点明确</option><option>先提问引导，再给解释</option></select></label><label>想让它记住的小偏好<textarea value={state.settings.instruction} onChange={e=>settings({instruction:e.target.value})} maxLength={1500}/></label><label className="toggle-label"><span>每周回望学习路线<small>有新的学习记录时生成，下次打开时看。</small></span><input type="checkbox" checked={state.settings.weeklyReview} onChange={e=>settings({weeklyReview:e.target.checked})}/></label></div>}
   {needsSetup&&<section className="settings-section"><h3>首次准备私人空间</h3><p>由为你准备学习室的人完成一次，之后直接使用。</p><label>一次性初始化口令<input type="password" value={setup} onChange={e=>setSetup(e.target.value)} autoComplete="off"/></label><button className="button secondary" disabled={busy||!setup} onClick={()=>void initialize()}>完成初始化</button></section>}
   <section className="settings-section"><h3>{connectMode?'同步已收录的真题和学习记录':'在手机和 iPad 之间接着学'}</h3><p>{connectMode?'在已经连接的浏览器中打开“设置 → 配对另一台设备”，将生成的配对码输入这里。每个浏览器只需首次连接。':'每台设备只需首次配对。学习记录属于同一个私人空间。'}</p><div className="button-group">{authenticated&&<button className="button secondary" disabled={busy} onClick={()=>void generate()}><Smartphone size={18}/>配对另一台设备</button>}<button className="button secondary" disabled={busy} onClick={()=>setPairing(!pairing)}>{pairing?'收起配对码输入':'输入配对码'}</button></div>
    {code&&<div className="pair-code"><small>在另一台设备输入 · {expires} 前有效</small><strong>{code}</strong><button className="text-button" onClick={()=>navigator.clipboard.writeText(code).then(()=>setMessage('配对码已复制')).catch(()=>setMessage('请手动选中并复制上方配对码'))}><Copy size={16}/>复制配对码</button></div>}
    {pairing&&<div className="pair-input"><label>另一台设备上的配对码<input autoFocus={connectMode} value={claim} onChange={e=>setClaim(e.target.value)} autoComplete="off" placeholder="输入配对码"/></label><button className="button primary" disabled={busy||!claim.trim()} onClick={()=>void connect()}>完成配对<Check size={17}/></button></div>}
   </section>
  </>}
  {message&&<Notice>{message}</Notice>}
  <section className="settings-section"><h3>给记录留一份备份</h3><p>备份包含学习记录、笔记和本机保存的原始资料。恢复时会合并记录。</p><div className="button-group"><button className="button secondary" disabled={busy} onClick={()=>void backup()}><Download size={18}/>导出备份</button><button className="button secondary" disabled={busy} onClick={()=>upload.current?.click()}><Upload size={18}/>选择备份恢复</button></div><input hidden ref={upload} type="file" accept=".json" onChange={e=>{const file=e.target.files?.[0];if(file)void restore(file);e.target.value='';}}/></section>
  <p className="small muted">在国内使用时，日期与学习记录按北京时间展示。</p>
 </Modal>;
}
