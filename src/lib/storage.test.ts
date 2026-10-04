import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshState } from './study';

const mocks=vi.hoisted(()=>({
  tables:{state:new Map<string,unknown>(),files:new Map<string,unknown>(),fileSync:new Map<string,unknown>()},
  requestFile:vi.fn(),uploadFile:vi.fn(),rememberSession:vi.fn(),
}));
vi.mock('idb',()=>({openDB:async()=>{
  const table=(name:keyof typeof mocks.tables)=>({
    get:async(key:string)=>mocks.tables[name].get(key),
    put:async(value:unknown,key:string)=>{mocks.tables[name].set(key,value);},
    delete:async(key:string)=>{mocks.tables[name].delete(key);},
  });
  return {
    get:async(name:keyof typeof mocks.tables,key:string)=>table(name).get(key),
    put:async(name:keyof typeof mocks.tables,value:unknown,key:string)=>table(name).put(value,key),
    transaction:()=>({objectStore:table,done:Promise.resolve()}),
  };
}}));
vi.mock('./fileTransport',()=>({fileTransport:{requestFile:mocks.requestFile,uploadFile:mocks.uploadFile,rememberSession:mocks.rememberSession}}));
import { getOrFetchFile, saveFile, syncFiles } from './storage';

function stateWithAttachment(){
 const state=freshState();
 state.imports=[{id:'import-paper',kind:'reading',title:'原卷',subtitle:'',level:'真题',minutes:18,tags:[],body:'',source:{title:'私有资料'},originalFile:'private-id',originalName:'原卷.pdf'}];
 return state;
}
beforeEach(()=>{for(const table of Object.values(mocks.tables))table.clear();vi.clearAllMocks();});

describe('attachment cache synchronization',()=>{
 it('opens cached files without any network or capability lookup',async()=>{
  const file=new Blob(['cached']);await saveFile('private-id',file);
  expect(await getOrFetchFile('private-id')).toBe(file);
  await syncFiles(stateWithAttachment(),true);
  expect(mocks.requestFile).not.toHaveBeenCalled();expect(mocks.uploadFile).not.toHaveBeenCalled();
 });
 it('caches a verified download once, then skips subsequent sync work',async()=>{
  const file=new Blob(['downloaded']);mocks.requestFile.mockResolvedValue(file);
  expect(await getOrFetchFile('private-id')).toBe(file);
  await syncFiles(stateWithAttachment());
  expect(mocks.requestFile).toHaveBeenCalledTimes(1);expect(mocks.uploadFile).not.toHaveBeenCalled();
  expect(mocks.tables.fileSync.get('private-id')).toBe(true);
 });
 it('never caches a rejected download or marks it synchronized',async()=>{
  mocks.requestFile.mockRejectedValueOnce(new Error('资料校验未通过'));
  await expect(getOrFetchFile('private-id')).rejects.toThrow('校验');
  expect(mocks.tables.files.has('private-id')).toBe(false);expect(mocks.tables.fileSync.has('private-id')).toBe(false);
 });
 it('retains unsynced local data after an upload failure and retries later',async()=>{
  const file=new Blob(['private']);await saveFile('private-id',file);
  mocks.uploadFile.mockRejectedValueOnce(new Error('interrupted')).mockResolvedValueOnce(undefined);
  await expect(syncFiles(stateWithAttachment())).rejects.toThrow('interrupted');
  expect(mocks.tables.files.get('private-id')).toBe(file);expect(mocks.tables.fileSync.has('private-id')).toBe(false);
  await syncFiles(stateWithAttachment());
  expect(mocks.uploadFile).toHaveBeenCalledTimes(2);expect(mocks.tables.fileSync.get('private-id')).toBe(true);
 });
});
