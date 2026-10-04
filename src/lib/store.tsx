import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import type { StudyState, Lesson, Word, StudyEvent, Progress, Settings } from '../types';
import { freshState, mergeStates, addStudyEvent, blankProgress, now } from './study';
import { api, readSaved, saveState, syncFiles } from './storage';
import { stateSchema } from './schema';
import { readRemoteSnapshot, RemoteStateError, stateFingerprint } from './sync';
export type SyncResult = 'synced'|'unpaired'|'offline'|'error'|'busy';
interface Store { state:StudyState; words:Word[]; lessons:Lesson[]; ready:boolean; storageError:string; recover:(state:StudyState)=>void; contentError:string; saved:string; syncError:string; syncState:'local'|'syncing'|'synced'|'offline'|'error'; authenticated:boolean; mutate:(fn:(s:StudyState)=>StudyState)=>void; record:(event:Omit<StudyEvent,'id'|'at'>)=>void; updateProgress:(id:string,patch:Partial<Progress>)=>void; settings:(patch:Partial<Settings>)=>void; synchronize:()=>Promise<SyncResult>; reloadContent:()=>void; }
const Context=createContext<Store|null>(null);
export function StoreProvider({children}:{children:ReactNode}) {
 const [storageError,setStorageError]=useState('');const [state,setState]=useState(freshState); const live=useRef(state); const [ready,setReady]=useState(false);
 const [words,setWords]=useState<Word[]>([]); const [lessons,setLessons]=useState<Lesson[]>([]); const [contentError,setContentError]=useState('');
 const [saved,setSaved]=useState('正在打开学习室'); const [syncState,setSyncState]=useState<Store['syncState']>('syncing'); const [authenticated,setAuthenticated]=useState(false);const [syncError,setSyncError]=useState('');
 const revision=useRef(0),busy=useRef(false),saveChain=useRef(Promise.resolve()),change=useRef(0);
 const mutate=useCallback((fn:(s:StudyState)=>StudyState)=>{const next=fn(live.current);if(JSON.stringify(next)===JSON.stringify(live.current))return;live.current=next;change.current++;setState(next);},[]);
 const reloadContent=useCallback(()=>{
   setContentError(''); Promise.all([fetch('/content/vocabulary.json').then(r=>{if(!r.ok)throw Error();return r.json();}),fetch('/content/curriculum.json').then(r=>{if(!r.ok)throw Error();return r.json();})]).then(([v,c])=>{setWords(v);setLessons(c);}).catch(()=>setContentError('资料暂时没能打开。请检查连接后重试。'));
 },[]);
 useEffect(()=>{reloadContent();readSaved().then(s=>{if(s!==undefined){const parsed=stateSchema.parse(s);live.current=parsed;setState(parsed);}setReady(true);}).catch(()=>{setStorageError('这台设备的记录暂时无法读取，原始记录已保留。');setSaved('原记录已保留');setReady(true);});},[reloadContent]);
 useEffect(()=>{if(!ready||storageError)return;setSaved('正在保存');saveChain.current=saveChain.current.then(()=>saveState(state)).then(()=>setSaved('已保存在此设备')).catch(()=>setSaved('保存失败，请导出备份'));},[state,ready,storageError]);
 const synchronize=useCallback(async():Promise<SyncResult>=>{
   if(storageError)return 'error';
   if(busy.current || !ready)return 'busy'; busy.current=true;setSyncError('');
   try {
     if(!navigator.onLine){setSyncState('offline');return 'offline';}
     setSyncState('syncing');
     const session=await api<{authenticated:boolean}>('/session');setAuthenticated(session.authenticated);
     if(!session.authenticated){setSyncState('local');return 'unpaired';}
     const remote=readRemoteSnapshot(await api<unknown>('/state'));revision.current=remote.revision;
     let remoteFingerprint=remote.state ? stateFingerprint(remote.state) : null;
     if(remote.state) mutate(s=>mergeStates(s,remote.state!));
     for(let retry=0;retry<3;retry++) {
       const snapshot=live.current; const counter=change.current;
       try {
         const fingerprint=stateFingerprint(snapshot);
         if(fingerprint!==remoteFingerprint){
           const res=await api<{revision:number}>('/state',{method:'PUT',body:JSON.stringify({state:snapshot,revision:revision.current})});revision.current=res.revision;
           remoteFingerprint=fingerprint;
         }
         await syncFiles(live.current);const current=counter===change.current;setSyncState(current?'synced':'syncing');return current?'synced':'busy';
       }catch(error){const e=error as {status?:number;data?:unknown};if(e.status===409&&e.data){const latest=readRemoteSnapshot(e.data);revision.current=latest.revision;remoteFingerprint=latest.state?stateFingerprint(latest.state):null;if(latest.state)mutate(s=>mergeStates(s,latest.state!));}else throw error;}
     }
     setSyncState('error');return 'error';
   }catch(error){const e=error as {data?:{error?:string}};if(error instanceof RemoteStateError)setSyncError(error.message);else if(e.data?.error==='origin_forbidden')setSyncError('连接请求的来源与页面不一致。请暂停跨域或请求头修改类扩展对本站的处理，再重试同步。');const status=navigator.onLine?'error':'offline';setSyncState(status);return status;}finally{busy.current=false;}
 },[ready,mutate,storageError]);
 useEffect(()=>{if(!ready)return;const timer=setTimeout(()=>void synchronize(),1600);return()=>clearTimeout(timer);},[state,ready,synchronize]);
 useEffect(()=>{
   if(!ready)return;
   const refresh=()=>{if(document.visibilityState==='visible')void synchronize();};
   window.addEventListener('online',refresh);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
   const timer=setInterval(refresh,5*60*1000);
   return()=>{window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);clearInterval(timer);};
 },[ready,synchronize]);
 const record=useCallback((event:Omit<StudyEvent,'id'|'at'>)=>mutate(s=>addStudyEvent(s,{...event,id:crypto.randomUUID(),at:now()})),[mutate]);
 const updateProgress=useCallback((id:string,patch:Partial<Progress>)=>mutate(s=>{const old=s.progress[id]??blankProgress(),at=now();const times=Object.fromEntries(['draft','note','answers','position','completed'].map(key=>[key,old.fieldUpdatedAt?.[key]??old.updatedAt]));for(const key of Object.keys(patch))times[key]=at;return{...s,progress:{...s.progress,[id]:{...old,...patch,updatedAt:at,fieldUpdatedAt:times}}};}),[mutate]);
 const settings=useCallback((patch:Partial<Settings>)=>mutate(s=>({...s,settings:{...s.settings,...patch,updatedAt:now()}})),[mutate]);
 return <Context.Provider value={{state,storageError,recover:(restored)=>{const parsed=stateSchema.parse(restored);setStorageError('');mutate(()=>parsed);},words:[...words,...(state.importedWords??[])],lessons:[...lessons,...state.imports],ready,contentError,saved,syncState,syncError,authenticated,mutate,record,updateProgress,settings,synchronize,reloadContent}}>{children}</Context.Provider>;
}
export function useStore(){const value=useContext(Context);if(!value)throw Error('Missing StoreProvider');return value;}
