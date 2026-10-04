import { z } from 'zod';
import type { Lesson, StudyState, Word } from '../types';
import { freshState, now } from './study';
import { stateSchema, lessonSchema, wordSchema } from './schema';
const str=z.string().max(250000); const timestamp=z.string().datetime();
import { allFiles, restoreFileBatch, syncFiles, readSaved } from './storage';
export function parseBackup(text:string):{state:StudyState;files:{id:string;type:string;data:string}[]} {
 const data=JSON.parse(text);if(data.format!=='7StudySpace')throw Error('这不是学习室备份。请用“添加资料”导入学习内容。');
 const state=stateSchema.parse(data.state) as StudyState;
 state.chats=z.array(z.object({id:z.string(),role:z.enum(['user','assistant']),text:str,at:timestamp,jobId:z.string().optional(),status:z.string().optional(),review:z.boolean().optional(),through:timestamp.optional()})).max(10000).parse(data.state.chats??[]);
 const files=z.array(z.object({id:z.string(),type:z.string(),data:z.string().max(70000000)})).max(1000).parse(data.files??[]);
 return {state,files};
}
export function blobToData(blob:Blob):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(blob);});}
export async function exportBackup(state:StudyState){
 await syncFiles(state, true); const files=await allFiles();const serialized=await Promise.all(files.map(async f=>({id:f.id,type:f.blob.type,data:await blobToData(f.blob)})));
 download(JSON.stringify({format:'7StudySpace',version:1,exportedAt:now(),state,files:serialized},null,2),`学习室备份-${new Date().toISOString().slice(0,10)}.json`);
}
export function download(text:string,name:string){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{a.remove();URL.revokeObjectURL(url);},10000);}
export async function restoreFiles(files:{id:string;data:string}[]){
 const decoded=files.map(file=>{if(!/^[\w-]{8,100}$/.test(file.id))throw Error('附件编号不正确');const match=file.data.match(/^data:(image\/(?:png|jpeg|webp)|application\/(?:pdf|json)|text\/(?:plain|csv|markdown)|audio\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/);if(!match)throw Error('备份含不支持的附件格式');const raw=atob(match[2]);if(raw.length>30*1024*1024)throw Error('附件过大');return{id:file.id,blob:new Blob([Uint8Array.from(raw,c=>c.charCodeAt(0))],{type:match[1]})};});
 await restoreFileBatch(decoded);
}
export function parseCSV(text:string):string[][] {
 const rows:string[][]=[];let row:string[]=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';}else field+=c;}
 if(quoted)throw Error('表格有一个未闭合的引号，请检查后重试');row.push(field);if(row.some(x=>x.trim()))rows.push(row);return rows;
}
export function csvWords(text:string):Word[]{
 const rows=parseCSV(text.replace(/^\uFEFF/,''));if(!rows.length)throw Error('表格是空的');if(rows.length>10001)throw Error('每次最多添加10000个词条');
 const header=rows[0].map(x=>x.trim().toLowerCase());const wi=header.findIndex(x=>['word','单词','英文'].includes(x));const mi=header.findIndex(x=>['meaning','释义','中文'].includes(x));const ei=header.findIndex(x=>['example','例句'].includes(x));const ti=header.findIndex(x=>['translation','例句翻译'].includes(x));const hasHeader=wi>=0&&mi>=0;
 return rows.slice(hasHeader?1:0).map((row,i)=>{const word=row[hasHeader?wi:0]?.trim(),meaning=row[hasHeader?mi:1]?.trim();if(!word||!meaning)throw Error(`第${i+1+(hasHeader?1:0)}行缺少单词或释义`);return wordSchema.parse({id:`import-word-${crypto.randomUUID()}`,word,meaning,example:hasHeader&&ei>=0?row[ei]??'':'',exampleMeaning:hasHeader&&ti>=0?row[ti]??'':'',pos:'',tags:['我的词表'],source:'个人导入词表',updatedAt:now()});});
}
export function makeLesson(patch:Partial<Lesson>):Lesson {return {...{id:`import-${crypto.randomUUID()}`,kind:'reading' as const,title:'我的学习资料',subtitle:'自己添加的资料',level:'自选',minutes:10,tags:['我的资料'],body:'',source:{title:'个人导入资料'},updatedAt:now()},...patch};}
export function parseLessonJSON(text:string):Lesson[]{const data=JSON.parse(text);const entries=Array.isArray(data)?data:[data];return entries.map(x=>lessonSchema.parse(makeLesson({...x,id:`import-${crypto.randomUUID()}`,updatedAt:now()})) as Lesson);}
export async function extractFile(file:File,onProgress:(text:string)=>void):Promise<string>{
 if(file.size>30*1024*1024)throw Error('这份文件超过30MB，请分成几份添加。');
 if(file.type==='application/pdf'||file.name.toLowerCase().endsWith('.pdf')){
   onProgress('正在读取 PDF 文字');const pdf=await import('pdfjs-dist');pdf.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).href;
   const doc=await pdf.getDocument({data:new Uint8Array(await file.arrayBuffer()),isEvalSupported:false,useSystemFonts:true}).promise;
   if(doc.numPages>60){await doc.destroy();throw Error('请先选取60页以内的内容，再添加到学习室。');}
   const pages:string[]=[];let worker:Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>|undefined;
   try{for(let i=1;i<=doc.numPages;i++){onProgress(`正在读取第 ${i} / ${doc.numPages} 页`);const page=await doc.getPage(i);const text=await page.getTextContent();let body=text.items.map(x=>'str'in x?x.str+('hasEOL'in x&&x.hasEOL?'\n':' '):'').join('');
     if(body.trim().length<20){if(!worker)worker=await createOCR(onProgress);const viewport=page.getViewport({scale:1.4});const canvas=document.createElement('canvas');canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d')!,viewport}).promise;body=(await worker.recognize(canvas)).data.text;}
     pages.push(body);page.cleanup();}return pages.join('\n\n');}finally{await worker?.terminate();await doc.destroy();}
 }
 if(file.type.startsWith('image/')){const worker=await createOCR(onProgress);try{return(await worker.recognize(file)).data.text;}finally{await worker.terminate();}}
 if(file.type.startsWith('audio/'))return '';
 return file.text();
}
async function createOCR(onProgress:(text:string)=>void){onProgress('正在准备文字识别，首次使用可能稍久');const {createWorker}=await import('tesseract.js');return createWorker(['eng','chi_sim'],1,{langPath:'/ocr',workerPath:'/ocr/worker.min.js',corePath:'/ocr',logger:m=>{if(m.status==='recognizing text')onProgress(`正在识别文字 ${Math.round(m.progress*100)}%`);}});}
export const emptyBackup=freshState;

export async function exportRawBackup(){const state=await readSaved();const files=await allFiles();download(JSON.stringify({format:'7StudySpace',version:1,exportedAt:now(),state,files:await Promise.all(files.map(async f=>({id:f.id,type:f.blob.type,data:await blobToData(f.blob)})))}),'学习室原始记录备份.json');}
export function normalizedFile(file:File):File {const ext=file.name.split('.').at(-1)?.toLowerCase();const known:Record<string,string>={pdf:'application/pdf',json:'application/json',csv:'text/csv',md:'text/markdown',txt:'text/plain',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',ogg:'audio/ogg',webm:'audio/webm'};const type=known[ext??'']??file.type;if(!/^(image\/(png|jpeg|webp)|application\/(pdf|json)|text\/(plain|csv|markdown)|audio\/(mpeg|mp4|wav|ogg|webm|x-m4a|x-wav))$/.test(type))throw Error('暂时不支持这种文件。可以换成图片、PDF、文字或常见音频。');return new File([file],file.name,{type,lastModified:file.lastModified});}
