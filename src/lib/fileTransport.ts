/** Authenticated attachments have the same IDs locally and in the cloud. */
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 3_000_000;
type FileTransport = { mode:'raw' } | { mode:'chunks'; chunkBytes:number };
interface RemoteFileMeta { id:string; mimeType:string; name:string; size:number; totalChunks:number; contentHash:string }

function checkAbort(signal?:AbortSignal) {
  if(signal?.aborted)throw signal.reason ?? new DOMException('请求已取消','AbortError');
}
function checkFileSize(size:number) {
  if(!Number.isSafeInteger(size)||size<=0||size>MAX_FILE_BYTES)throw Error('资料不能为空，也不能超过 30 MB');
}
export async function fileContentHash(blob:Blob) {
  const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}

export function createFileTransport(fetcher:typeof fetch=(...args)=>fetch(...args)) {
  let mode:FileTransport|undefined;
  let sessionRequest:Promise<FileTransport>|undefined;
  function rememberSession(session:unknown) {
    if(!session||typeof session!=='object')throw Error('暂时无法确认资料连接方式');
    const data=session as Record<string,unknown>;
    if(data.fileTransport==='chunks') {
      const bytes=data.maxChunkBytes??MAX_CHUNK_BYTES;
      if(typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<=0||bytes>MAX_CHUNK_BYTES)throw Error('资料连接设置暂时不可用');
      mode={mode:'chunks',chunkBytes:bytes};
    } else if(data.fileTransport===undefined||data.fileTransport==='raw')mode={mode:'raw'};
    else throw Error('资料连接方式暂不支持');
    return mode;
  }
  async function response(path:string,options:RequestInit={},message='资料暂时无法传输') {
    const result=await fetcher(path,{credentials:'same-origin',mode:'same-origin',redirect:'error',...options});
    if(!result.ok)throw Object.assign(new Error(message),{status:result.status});
    return result;
  }
  async function transport() {
    if(mode)return mode;
    // Session reads from the main state connection are reused; simultaneous file
    // opens also share one capability request. A failed request remains retryable.
    if(!sessionRequest)sessionRequest=response('/api/session').then(result=>result.json()).then(rememberSession).finally(()=>{sessionRequest=undefined;});
    return sessionRequest;
  }
  async function boundedBlob(result:Response,limit:number,signal?:AbortSignal) {
    const declared=result.headers.get('content-length');
    if(declared!==null&&Number(declared)>limit)throw Error('资料大小超过传输限制');
    if(!result.body) {
      const blob=await result.blob();
      if(blob.size>limit)throw Error('资料大小超过传输限制');
      return blob;
    }
    const reader=result.body.getReader(),parts:ArrayBuffer[]=[];
    let size=0;
    try {
      while(true) {
        checkAbort(signal);
        const {done,value}=await reader.read();
        if(done)break;
        size+=value.byteLength;
        if(size>limit)throw Error('资料大小超过传输限制');
        parts.push(value.slice().buffer as ArrayBuffer);
      }
    }catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally{reader.releaseLock();}
    return new Blob(parts,{type:result.headers.get('content-type')?.split(';')[0]??''});
  }
  function metadata(value:unknown,id:string,chunkBytes:number):RemoteFileMeta {
    if(!value||typeof value!=='object')throw Error('资料信息不完整，请稍后重新打开');
    const data=value as Partial<RemoteFileMeta>;
    checkFileSize(data.size as number);
    if(data.id!==id||typeof data.mimeType!=='string'||!data.mimeType||typeof data.name!=='string'||
      !Number.isInteger(data.totalChunks)||data.totalChunks!==Math.ceil(data.size!/chunkBytes)||
      typeof data.contentHash!=='string'||! /^[a-f0-9]{64}$/i.test(data.contentHash))throw Error('资料信息不完整，请稍后重新打开');
    return data as RemoteFileMeta;
  }
  async function requestFile(id:string,signal?:AbortSignal) {
    checkAbort(signal);
    const config=await transport();checkAbort(signal);
    const path=`/api/files/${encodeURIComponent(id)}`;
    if(config.mode==='raw') {
      const result=await response(path,{signal},'资料尚未下载，请联网后重新打开');
      const blob=await boundedBlob(result,MAX_FILE_BYTES,signal);checkFileSize(blob.size);checkAbort(signal);
      return blob;
    }
    const result=await response(`${path}/meta`,{signal},'资料尚未下载，请联网后重新打开');
    const meta=metadata(await result.json(),id,config.chunkBytes),parts:Blob[]=[];
    let size=0;
    for(let index=0;index<meta.totalChunks;index++) {
      checkAbort(signal);
      const chunk=await response(`${path}/chunks/${index}`,{signal},'资料还没有完整下载，请重新打开');
      const blob=await boundedBlob(chunk,Math.min(config.chunkBytes,meta.size-size),signal);
      const expected=Math.min(config.chunkBytes,meta.size-size);
      if(blob.size!==expected)throw Error('资料下载不完整，请重新打开');
      size+=blob.size;parts.push(blob);
    }
    const file=new Blob(parts,{type:meta.mimeType});
    if(size!==meta.size||(await fileContentHash(file))!==meta.contentHash.toLowerCase())throw Error('资料校验未通过，请重新打开');
    checkAbort(signal);
    return file;
  }
  async function uploadFile(id:string,file:Blob,name:string,signal?:AbortSignal) {
    checkFileSize(file.size);checkAbort(signal);
    const config=await transport();checkAbort(signal);
    const path=`/api/files/${encodeURIComponent(id)}`,mimeType=file.type||'text/plain';
    if(config.mode==='raw') {
      await response(path,{method:'POST',signal,headers:{'Content-Type':mimeType,'X-Filename':encodeURIComponent(name)},body:file},'原始资料尚未同步');
      return;
    }
    const totalChunks=Math.ceil(file.size/config.chunkBytes),contentHash=await fileContentHash(file);
    for(let index=0;index<totalChunks;index++) {
      checkAbort(signal);
      await response(`${path}/chunks/${index}`,{method:'POST',signal,headers:{'Content-Type':mimeType},body:file.slice(index*config.chunkBytes,(index+1)*config.chunkBytes)},'原始资料尚未完整同步');
    }
    checkAbort(signal);
    await response(`${path}/complete`,{method:'POST',signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({mimeType,name,size:file.size,totalChunks,contentHash})},'原始资料尚未完成同步');
  }
  return {rememberSession,requestFile,uploadFile};
}

export const fileTransport=createFileTransport();
