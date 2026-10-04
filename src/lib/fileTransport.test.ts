import { describe, expect, it, vi } from 'vitest';
import { createFileTransport, fileContentHash, MAX_FILE_BYTES } from './fileTransport';

const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const makeFetch=()=>vi.fn<typeof fetch>();
const blob=new Blob(['abcdefg'],{type:'application/pdf'});

describe('private attachment transport',()=>{
  it('keeps raw local-server uploads and downloads without another session read',async()=>{
    const fetcher=makeFetch().mockResolvedValueOnce(new Response(null,{status:201})).mockResolvedValueOnce(new Response(blob));
    const client=createFileTransport(fetcher);client.rememberSession({authenticated:true});
    await client.uploadFile('private-id',blob,'原卷.pdf');
    expect(fetcher.mock.calls[0][0]).toBe('/api/files/private-id');
    expect(fetcher.mock.calls[0][1]?.headers).toEqual({'Content-Type':'application/pdf','X-Filename':encodeURIComponent('原卷.pdf')});
    expect(await (await client.requestFile('private-id')).text()).toBe('abcdefg');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uploads bounded chunks and publishes metadata only after every chunk succeeds',async()=>{
    const fetcher=makeFetch().mockImplementation(async()=>json({ok:true}));
    const client=createFileTransport(fetcher);client.rememberSession({fileTransport:'chunks',maxChunkBytes:3});
    await client.uploadFile('private-id',blob,'原卷.pdf');
    expect(fetcher.mock.calls.map(call=>call[0])).toEqual(['/api/files/private-id/chunks/0','/api/files/private-id/chunks/1','/api/files/private-id/chunks/2','/api/files/private-id/complete']);
    expect(fetcher.mock.calls.slice(0,3).map(call=>(call[1]?.body as Blob).size)).toEqual([3,3,1]);
    expect(JSON.parse(fetcher.mock.calls[3][1]?.body as string)).toEqual({mimeType:'application/pdf',name:'原卷.pdf',size:7,totalChunks:3,contentHash:await fileContentHash(blob)});
  });

  it('does not complete an interrupted upload and can retry the same file ID',async()=>{
    const fetcher=makeFetch().mockResolvedValueOnce(json({ok:true})).mockResolvedValueOnce(new Response(null,{status:503}));
    const client=createFileTransport(fetcher);client.rememberSession({fileTransport:'chunks',maxChunkBytes:3});
    await expect(client.uploadFile('private-id',blob,'paper')).rejects.toThrow('完整同步');
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async()=>json({ok:true}));
    await client.uploadFile('private-id',blob,'paper');
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/files/private-id/complete');
  });

  it('reassembles binary chunks and verifies hash and MIME before exposing a file',async()=>{
    const fetcher=makeFetch().mockResolvedValueOnce(json({id:'private-id',mimeType:'application/pdf',name:'原卷.pdf',size:7,totalChunks:3,contentHash:await fileContentHash(blob)}));
    for(const part of ['abc','def','g'])fetcher.mockResolvedValueOnce(new Response(part));
    const client=createFileTransport(fetcher);client.rememberSession({fileTransport:'chunks',maxChunkBytes:3});
    const result=await client.requestFile('private-id');
    expect(result.type).toBe('application/pdf');expect(await result.text()).toBe('abcdefg');
  });

  it('rejects altered or truncated data instead of returning it to the cache',async()=>{
    for(const [last,message] of [['X','校验'],['','不完整']]) {
      const fetcher=makeFetch().mockResolvedValueOnce(json({id:'private-id',mimeType:'application/pdf',name:'p',size:7,totalChunks:3,contentHash:await fileContentHash(blob)}));
      for(const part of ['abc','def',last])fetcher.mockResolvedValueOnce(new Response(part));
      const client=createFileTransport(fetcher);client.rememberSession({fileTransport:'chunks',maxChunkBytes:3});
      await expect(client.requestFile('private-id')).rejects.toThrow(message);
    }
  });

  it('rejects oversized files and inconsistent metadata without requesting chunks',async()=>{
    const fetcher=makeFetch();const client=createFileTransport(fetcher);
    await expect(client.uploadFile('private-id',new Blob([new Uint8Array(MAX_FILE_BYTES+1)]),'large')).rejects.toThrow('30 MB');
    expect(fetcher).not.toHaveBeenCalled();
    client.rememberSession({fileTransport:'chunks',maxChunkBytes:3});
    fetcher.mockResolvedValueOnce(json({id:'other-id',mimeType:'application/pdf',name:'p',size:7,totalChunks:100000,contentHash:'0'.repeat(64)}));
    await expect(client.requestFile('private-id')).rejects.toThrow('不完整');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors cancellation between chunks and never completes an aborted upload',async()=>{
    const controller=new AbortController();
    const fetcher=makeFetch().mockImplementation(async()=>{controller.abort();return json({ok:true});});
    const client=createFileTransport(fetcher);client.rememberSession({fileTransport:'chunks',maxChunkBytes:3});
    await expect(client.uploadFile('private-id',blob,'paper',controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares capability discovery and retries it after a temporary failure',async()=>{
    const fetcher=makeFetch().mockResolvedValueOnce(new Response(null,{status:503}));
    const client=createFileTransport(fetcher);
    await expect(client.requestFile('first')).rejects.toThrow();
    fetcher.mockImplementation(async path=>String(path)==='/api/session'?json({authenticated:true}):new Response(blob));
    await Promise.all([client.requestFile('first'),client.requestFile('second')]);
    expect(fetcher.mock.calls.filter(call=>call[0]==='/api/session')).toHaveLength(2);
  });
});
