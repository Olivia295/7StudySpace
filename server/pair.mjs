// Local owner recovery: requires direct filesystem access to the private database.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { openStore, hashToken } from './store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const store=openStore(process.env.STUDY77_DATA_DIR||path.join(root,'data'));
try {
 if(store.getMeta('initialized')!=='1')throw Error('请先完成首次初始化。');
 const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
 const raw=Array.from({length:10},()=>alphabet[randomInt(alphabet.length)]).join('');
 const at=Date.now();store.db.prepare('INSERT INTO pairing (code_hash,expires_at,created_at) VALUES (?,?,?)').run(hashToken(raw),at+600000,at);
 const code=`${raw.slice(0,5)}-${raw.slice(5)}`;
 const outputIndex=process.argv.indexOf('--output');
 if(outputIndex>=0){const output=process.argv[outputIndex+1];if(!output)throw Error('缺少保存位置');writeFileSync(output,code,{mode:0o600,flag:'wx'});console.log('一次性配对码已保存到指定的本机文件，十分钟后失效。');}
 else{console.log('在本机学习室的“设置 → 输入配对码”中使用。十分钟内一次有效，不要公开分享。');console.log(code);}
}catch(error){console.error(error.message);process.exitCode=1;}finally{store.close();}
