import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root='dist';
async function list(folder){const entries=await fs.readdir(path.join(root,folder),{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?list(`${folder}/${e.name}`):`${folder}/${e.name}`))).flat();}
const core=['/','/favicon.svg','/manifest.webmanifest',...await list('assets'),...await list('content'),...await list('images'),...await list('audio').catch(()=>[])].map(p=>p.startsWith('/')?p:`/${p}`);
const hash=createHash('sha256');for(const file of core)hash.update(await fs.readFile(path.join(root,file==='/'?'index.html':file)));const version=hash.digest('hex').slice(0,14);
const source=await fs.readFile('public/sw.js','utf8');await fs.writeFile(path.join(root,'sw.js'),source.replace("'study77-development'",JSON.stringify(`study77-${version}`)).replace('/* PRECACHE */ []',JSON.stringify(core)));
console.log(`离线包：${core.length} 个本机资源，版本 ${version}`);
