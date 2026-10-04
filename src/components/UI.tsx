import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { BookOpen, Headphones, NotebookText, PenLine, Languages, ScanLine, X, Leaf, ArrowRight } from 'lucide-react';
import type { Kind } from '../types';
export function KindIcon({kind,size=24}:{kind:Kind;size?:number}){const Icon={vocabulary:NotebookText,reading:BookOpen,listening:Headphones,sentence:ScanLine,writing:PenLine,translation:Languages}[kind];return <Icon size={size} strokeWidth={1.65}/>;}
export function Modal({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}){const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{const el=ref.current;el?.showModal();return()=>el?.close();},[]);return <dialog ref={ref} className={`modal ${wide?'wide':''}`} onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X/></button></header><div className="modal-body">{children}</div></dialog>;}
export function Empty({title,children,action}:{title:string;children:ReactNode;action?:ReactNode}){return <div className="empty"><Leaf size={36} strokeWidth={1.4}/><h2>{title}</h2><p>{children}</p>{action}</div>;}
export function CompanionPrompt({onClick}:{onClick:()=>void}){return <div className="companion-prompt"><div><Leaf size={28}/><span>需要一点帮助？</span></div><button className="button secondary" onClick={onClick}>问问学习搭子<ArrowRight size={18}/></button></div>;}
export function Notice({children,error=false}:{children:ReactNode;error?:boolean}){return <p role={error?'alert':'status'} className={`notice ${error?'error':''}`}>{children}</p>;}
