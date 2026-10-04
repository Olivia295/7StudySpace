import {describe,it,expect,vi} from 'vitest';
vi.mock('./storage',()=>({allFiles:vi.fn(),restoreFileBatch:vi.fn(),syncFiles:vi.fn()}));
import {csvWords,parseCSV,parseBackup,parseLessonJSON,restoreFiles} from './imports';
import {restoreFileBatch} from './storage';
import {freshState} from './study';
describe('imports and recovery',()=>{
 it('handles commas, quoted newlines, BOM and escaped quotes in vocabulary',()=>{const result=csvWords('\uFEFFword,meaning,example\r\napproach,"方法, 途径","Try a ""new"" approach.\nIt helps."');expect(result[0].meaning).toBe('方法, 途径');expect(result[0].example).toContain('"new"');expect(result[0].id).toMatch(/^import-word-/);});
 it('rejects broken CSV instead of silently changing the source',()=>expect(()=>parseCSV('"broken,word')).toThrow());
 it('rejects a backup with invalid timestamps without creating records',()=>{const state=freshState();state.settings.updatedAt='oops';expect(()=>parseBackup(JSON.stringify({format:'7StudySpace',state}))).toThrow();});
 it('preserves custom words, tutor replies and plans through backups',()=>{const state=freshState();state.importedWords=csvWords('evidence,证据');state.chats=[{id:'c',role:'assistant',text:'实际建议',at:'2026-10-04T00:00:00.000Z'}];expect(parseBackup(JSON.stringify({format:'7StudySpace',state})).state).toEqual(state);});
 it('assigns fresh ids to imported lessons so they cannot shadow the built-in library',()=>{const [lesson]=parseLessonJSON('{"id":"reading-001","title":"Imported","body":"Read me"}');expect(lesson.id).toMatch(/^import-/);expect(lesson.id).not.toBe('reading-001');});
 it('rejects remote audio links in imported material',()=>expect(()=>parseLessonJSON('{"title":"Imported","audio":"https://example.org/tracker.mp3"}')).toThrow());
 it('validates every attachment before any restore write',async()=>{await expect(restoreFiles([{id:'abcdefgh',data:'data:text/plain;base64,aGk='},{id:'bad-file',data:'data:text/html;base64,aGk='}])).rejects.toThrow();expect(restoreFileBatch).not.toHaveBeenCalled();});
});

it('normalizes empty browser MIME types before backup',async()=>{const {normalizedFile}=await import('./imports');const file=normalizedFile(new File(['word,meaning\nevidence,证据'],'words.csv'));expect(file.type).toBe('text/csv');});
