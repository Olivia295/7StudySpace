import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileText, LoaderCircle } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { getOrFetchFile } from '../lib/storage';
import './original-document.css';

interface OriginalDocumentProps {
  fileId:string;
  filename?:string;
  label?:string;
  initialPage?:number;
  onPageChange?:(page:number)=>void;
}

/** A private attachment reader: it only uses the local attachment store and our
 * own file endpoint. PDF actions and links are never executed by this canvas. */
export default function OriginalDocument({fileId,filename,label='原卷',initialPage=1,onPageChange}:OriginalDocumentProps) {
  const [document,setDocument]=useState<PDFDocumentProxy|null>(null);
  const [kind,setKind]=useState<'loading'|'pdf'|'image'|'other'>('loading');
  const [source,setSource]=useState(''),[error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const [page,setPage]=useState(Math.max(1,Math.floor(initialPage)||1));
  const [zoom,setZoom]=useState(1),[width,setWidth]=useState(0);
  const [rendering,setRendering]=useState(false),[pageError,setPageError]=useState(''),[pageText,setPageText]=useState('');
  const container=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);

  useEffect(()=>{
    const controller=new AbortController();
    let cancelled=false,objectUrl='',task:PDFDocumentLoadingTask|undefined;
    setDocument(null);setSource('');setKind('loading');setError('');
    async function open() {
      try {
        const blob=await getOrFetchFile(fileId,controller.signal);
        if(cancelled)return;
        objectUrl=URL.createObjectURL(blob);setSource(objectUrl);
        const isPDF=blob.type==='application/pdf'||(await blob.slice(0,5).text())==='%PDF-';
        if(cancelled)return;
        if(isPDF) {
          const pdf=await import('pdfjs-dist');
          if(cancelled)return;
          pdf.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).href;
          const data=new Uint8Array(await blob.arrayBuffer());
          if(cancelled)return;
          task=pdf.getDocument({
            data,
            isEvalSupported:false,
            useSystemFonts:true,
            cMapUrl:'/pdfjs/cmaps/',
            cMapPacked:true,
            standardFontDataUrl:'/pdfjs/standard_fonts/',
          });
          const loaded=await task.promise;
          if(cancelled)return;
          setDocument(loaded);setPage(current=>Math.min(loaded.numPages,Math.max(1,current)));setKind('pdf');
        } else if(/^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(blob.type))setKind('image');
        else setKind('other');
      }catch {
        if(!cancelled){setError(objectUrl?'原卷暂时没能展开，可以下载原件查看。':'原卷暂时没能打开，请联网后点击“重新打开原件”。');setKind('other');}
      }
    }
    void open();
    return()=>{cancelled=true;controller.abort();if(task)void task.destroy().catch(()=>{});if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[fileId,retry]);

  useEffect(()=>{
    const element=container.current;
    if(!element)return;
    const observer=new ResizeObserver(entries=>{
      const next=Math.floor(entries[0]?.contentRect.width??0);
      // A mobile tab can hide this pane temporarily. Keep the previous rendered
      // page while hidden, instead of creating a zero-width PDF canvas.
      if(next>0)setWidth(current=>Math.abs(current-next)>1?next:current);
    });
    observer.observe(element);
    return()=>observer.disconnect();
  },[]);

  useEffect(()=>{
    if(!document||!width||!canvas.current)return;
    let cancelled=false,pdfPage:PDFPageProxy|undefined,renderTask:RenderTask|undefined;
    setRendering(true);setPageError('');setPageText('');
    async function renderPage() {
      try {
        pdfPage=await document!.getPage(page);
        if(cancelled){pdfPage.cleanup();return;}
        const natural=pdfPage.getViewport({scale:1});
        const viewport=pdfPage.getViewport({scale:width/natural.width*zoom});
        // Bound backing-store memory on iPads and scanned papers. One page is
        // rendered at a time, with no background rendering of the whole paper.
        const ratio=Math.min(window.devicePixelRatio||1,2,4096/viewport.width,4096/viewport.height,Math.sqrt(6_000_000/(viewport.width*viewport.height)));
        const element=canvas.current;
        if(!element)return;
        const context=element.getContext('2d');
        if(!context)throw Error('canvas-unavailable');
        element.width=Math.max(1,Math.floor(viewport.width*ratio));
        element.height=Math.max(1,Math.floor(viewport.height*ratio));
        element.style.width=`${viewport.width}px`;element.style.height=`${viewport.height}px`;
        renderTask=pdfPage.render({canvasContext:context,viewport,transform:[ratio,0,0,ratio,0,0]});
        await renderTask.promise;
        if(cancelled)return;
        setRendering(false);
        const text=await pdfPage.getTextContent();
        if(!cancelled)setPageText(text.items.map(item=>'str' in item?`${item.str}${item.hasEOL?'\n':' '}`:'').join('').trim());
      }catch {
        if(!cancelled){setPageError('这一页暂时没有显示出来，可以切换一页再回来，或下载原件查看。');setRendering(false);}
      }
    }
    void renderPage();
    return()=>{
      cancelled=true;
      if(renderTask){renderTask.cancel();void renderTask.promise.then(()=>pdfPage?.cleanup(),()=>pdfPage?.cleanup());}
      else pdfPage?.cleanup();
    };
  },[document,page,width,zoom]);

  function moveTo(next:number) {
    if(!document)return;
    const target=Math.min(document.numPages,Math.max(1,next));
    if(target===page)return;
    setPage(target);onPageChange?.(target);
    container.current?.scrollTo({top:0,left:0});
  }

  return <div className="original-document" aria-label={`${label}阅读器`}>
    <div className="original-document-heading"><span><FileText size={16}/>{label}阅读</span><span>{source?<a href={source} download={filename||'学习资料'}><Download size={15}/>下载原件</a>:<button className="text-button" disabled={kind==='loading'} onClick={()=>setRetry(value=>value+1)}>{kind==='loading'?'正在准备原件':'重新打开原件'}</button>}</span></div>
    {kind==='pdf'&&document&&<div className="original-document-controls">
      <button className="document-page-button" aria-label={`${label}上一页`} disabled={page<=1} onClick={()=>moveTo(page-1)}><ChevronLeft size={19}/></button>
      <label className="document-page-select">第 <select aria-label={`${label}页码`} value={page} onChange={event=>moveTo(Number(event.target.value))}>{Array.from({length:document.numPages},(_,index)=><option key={index+1} value={index+1}>{index+1}</option>)}</select><span>/ {document.numPages} 页</span></label>
      <button className="document-page-button" aria-label={`${label}下一页`} disabled={page>=document.numPages} onClick={()=>moveTo(page+1)}><ChevronRight size={19}/></button>
      <label className="document-zoom-label"><select aria-label={`${label}缩放`} value={zoom} onChange={event=>setZoom(Number(event.target.value))}><option value={1}>适应宽度</option><option value={1.25}>放大 125%</option><option value={1.5}>放大 150%</option><option value={2}>放大 200%</option></select></label>
    </div>}
    <div className={`original-document-viewport ${kind==='pdf'?'is-pdf':''}`} ref={container} aria-busy={kind==='loading'||rendering}>
      {kind==='loading'&&<div className="document-placeholder" role="status"><LoaderCircle className="spin" size={23}/><p>正在打开{label}…</p></div>}
      {kind==='pdf'&&<><canvas ref={canvas} role="img" aria-label={`${label}第 ${page} 页${filename?`：${filename}`:''}`} />{rendering&&<div className="document-rendering" role="status"><LoaderCircle className="spin" size={16}/>正在展开第 {page} 页</div>}</>}
      {kind==='image'&&<img className="document-image" src={source} alt={filename?`${label}：${filename}`:'学习资料原图'} onError={()=>setError('这张原图暂时没有显示出来，可以下载原件查看。')}/>}
      {kind==='other'&&!error&&<div className="document-placeholder"><FileText size={25}/><p>这份原件暂不支持页内预览。</p><a href={source} download={filename||'学习资料'}>下载后查看</a></div>}
    </div>
    {(error||pageError)&&<p className="document-error" role="status">{error||pageError}</p>}
    {kind==='pdf'&&!rendering&&!pageError&&<details className="document-page-text"><summary>查看本页文字</summary>{pageText?<p>{pageText}</p>:<p>这一页没有可提取的文字，请对照上方原卷图片阅读。</p>}</details>}
    <p className="document-reading-note">翻页只保存阅读位置。自己的答案和笔记可以写在作答区。</p>
  </div>;
}
