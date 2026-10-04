import { mkdir, copyFile, readdir, writeFile, access } from 'node:fs/promises';
const target=new URL('../public/ocr/',import.meta.url);await mkdir(target,{recursive:true});
await copyFile(new URL('../node_modules/tesseract.js/dist/worker.min.js',import.meta.url),new URL('worker.min.js',target));
await copyFile(new URL('../node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt',import.meta.url),new URL('worker.LICENSE.txt',target));
const core=new URL('../node_modules/tesseract.js-core/',import.meta.url);
for(const file of await readdir(core)){if(file.includes('-lstm.')&&/\.(wasm|js)$/.test(file))await copyFile(new URL(file,core),new URL(file,target));}
await copyFile(new URL('LICENSE',core),new URL('core.LICENSE',target));
for(const language of ['eng','chi_sim']){
 const file=new URL(`${language}.traineddata.gz`,target);
 try{await access(file);continue;}catch{}
 const source=`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${language}/4.0.0_best_int/${language}.traineddata.gz`;
 const response=await fetch(source);if(!response.ok)throw Error(`Language download failed: ${response.status}`);
 await writeFile(file,new Uint8Array(await response.arrayBuffer()));
}
await writeFile(new URL('SOURCES.txt',target),'Tesseract.js worker and Tesseract.js-core: Apache-2.0. Language data: tesseract.js-data 4.0.0_best_int (eng, chi_sim), Apache-2.0; https://github.com/naptha/tessdata . Bundled locally so OCR does not depend on a third-party CDN at learning time.\n');
console.log('Local English / Simplified Chinese OCR assets are ready.');
