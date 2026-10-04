import { openDB } from 'idb';
import type { StudyState } from '../types';
import { fileTransport } from './fileTransport';
const database = openDB('7studyspace',2,{upgrade(db){for(const name of ['state','files','fileSync'])if(!db.objectStoreNames.contains(name))db.createObjectStore(name);}});
export const readSaved = async () => (await database).get('state','current') as Promise<StudyState|undefined>;
export const saveState = async (state:StudyState) => {await (await database).put('state',state,'current');};
export const saveFile = async (id:string,file:Blob) => {const db=await database;const tx=db.transaction(['files','fileSync'],'readwrite');await tx.objectStore('files').put(file,id);await tx.objectStore('fileSync').delete(id);await tx.done;};
export const getFile = async (id:string):Promise<Blob|undefined> => (await database).get('files',id);
export const cacheRemoteFile = async (id:string,file:Blob) => {const db=await database;const tx=db.transaction(['files','fileSync'],'readwrite');await tx.objectStore('files').put(file,id);await tx.objectStore('fileSync').put(true,id);await tx.done;};
export async function restoreFileBatch(files:{id:string;blob:Blob}[]){const db=await database;for(const file of files){const old=await getFile(file.id);if(old){const a=new Uint8Array(await old.arrayBuffer()),b=new Uint8Array(await file.blob.arrayBuffer());if(a.length!==b.length||a.some((n,i)=>n!==b[i]))throw Error('附件与现有文件冲突');}}const tx=db.transaction(['files','fileSync'],'readwrite');for(const file of files){await tx.objectStore('files').put(file.blob,file.id);await tx.objectStore('fileSync').delete(file.id);}await tx.done;}
export async function allFiles() { const db=await database; const keys=await db.getAllKeys('files'); return Promise.all(keys.map(async key=>({id:String(key),blob:await db.get('files',key) as Blob}))); }
export const requestFile = (id:string,signal?:AbortSignal) => fileTransport.requestFile(id,signal);
const downloads=new Map<string,{promise:Promise<Blob>;controller:AbortController;readers:number;settled:boolean}>();
export async function getOrFetchFile(id:string,signal?:AbortSignal):Promise<Blob> {
 if(signal?.aborted)throw signal.reason??new DOMException('请求已取消','AbortError');
 const local=await getFile(id);
 if(signal?.aborted)throw signal.reason??new DOMException('请求已取消','AbortError');
 if(local)return local;
 let pending=downloads.get(id);
 if(!pending){
  const controller=new AbortController();
  const promise=requestFile(id,controller.signal).then(async remote=>{
   if(controller.signal.aborted)throw controller.signal.reason;
   // Only complete, verified attachments are written to the local cache.
   await cacheRemoteFile(id,remote);return remote;
  }).finally(()=>{if(downloads.get(id)?.promise===promise)downloads.delete(id);});
  pending={promise,controller,readers:0,settled:false};downloads.set(id,pending);
  const current=pending;void promise.then(()=>{current.settled=true;},()=>{current.settled=true;});
 }
 // Opening a document while background sync runs shares its download. Closing
 // one viewer cancels only that consumer; the last consumer aborts the network.
 const current=pending;current.readers++;
 return new Promise<Blob>((resolve,reject)=>{
  let finished=false;
  const finish=(callback:()=>void)=>{
   if(finished)return;finished=true;signal?.removeEventListener('abort',abort);current.readers--;
   if(!current.readers&&!current.settled){current.controller.abort();if(downloads.get(id)===current)downloads.delete(id);}
   callback();
  };
  const abort=()=>finish(()=>reject(signal?.reason??new DOMException('请求已取消','AbortError')));
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  void current.promise.then(file=>finish(()=>resolve(file)),error=>finish(()=>reject(error)));
 });
}
export async function syncFiles(state:StudyState,downloadOnly=false){
 const ids=new Set([...state.imports.flatMap(l=>[l.originalFile,l.referenceFile,l.audio?.startsWith('file:')?l.audio.slice(5):undefined]),...(state.importedWords??[]).map(w=>w.originalFile)].filter((id):id is string=>!!id));
 const db=await database;
 for(const id of ids){
  const local=await getFile(id);
  if(local){
   if(downloadOnly||await db.get('fileSync',id))continue;
   const name=state.imports.find(l=>l.originalFile===id)?.originalName??state.imports.find(l=>l.referenceFile===id)?.referenceName??id;
   await fileTransport.uploadFile(id,local,name);
   await db.put('fileSync',true,id);
  }else await getOrFetchFile(id);
 }
}
export async function api<T>(path:string,options:RequestInit={}):Promise<T> {
 const response=await fetch(`/api${path}`,{credentials:'same-origin',mode:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
 const data=await response.json().catch(()=>({error:'连接暂时不可用'}));
 if(response.ok&&path==='/session')fileTransport.rememberSession(data);
 if(!response.ok) throw Object.assign(new Error(data.message ?? data.error ?? '连接暂时不可用'),{status:response.status,data});
 return data as T;
}
