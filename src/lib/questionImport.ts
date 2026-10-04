import type { Question } from '../types';

export interface ParsedQuestionText {
  body:string;
  questions:Question[];
  warnings:string[];
}

interface AnswerKey { answers:Map<string,number>; conflicts:Set<string>; start:number }
const answerHeading=/^[ \t]*(?:参考答案|答案(?:汇总|与解析)?|Answer[ \t]*Key|Answers?)[ \t]*[:：]?[ \t]*(.*)$/gim;
const numberedAnswer=/(\d{1,3})[ \t]*[.．、)）:：][ \t]*([A-D])(?=\s|$|[,，;；])/gi;
const questionStart=/^[ \t]*(\d{1,3})[.．、)）][ \t]*/gm;
const choiceLine=/^[ \t]*(?:\(([A-D])\)|\[([A-D])\]|([A-D])[.．、)）:：]|([A-D])[ \t]+)[ \t]*(.*)$/gm;
const localAnswer=/^[ \t]*(?:参考答案|答案|Answer)[ \t]*[:：][ \t]*([A-D])(?=\s|$|[.。])/gim;
const explanationHeading=/^[ \t]*(?:解析|Explanation)[ \t]*[:：][ \t]*/im;

// Only consume a key beneath an explicit answer heading. Numbered text elsewhere
// must never be interpreted as an answer key merely because it contains A-D.
function readAnswerKey(text:string):AnswerKey|undefined {
  for(const heading of text.matchAll(answerHeading)) {
    const following=text.slice(heading.index+heading[0].length);
    const lines=[heading[1],...following.split('\n')];
    const answers=new Map<string,number>(),conflicts=new Set<string>();
    for(const line of lines) {
      if(!line.trim())continue;
      const matches=[...line.matchAll(numberedAnswer)];
      const remainder=line.replace(numberedAnswer,'').replace(/[\s,，;；]/g,'');
      if(!matches.length||remainder)break;
      for(const match of matches) {
        const number=String(Number(match[1])),answer=match[2].toUpperCase().charCodeAt(0)-65;
        if(answers.has(number)&&answers.get(number)!==answer)conflicts.add(number);
        answers.set(number,answer);
      }
    }
    if(answers.size)return {answers,conflicts,start:heading.index};
  }
  return undefined;
}

/** Extract explicitly answered multiple-choice questions without showing their
 * answer-bearing source text as the reading passage. The caller retains `text`
 * so the learner can review anything that was not converted. */
export function parseQuestionText(text:string):ParsedQuestionText {
  const normalized=text.replace(/\r\n?/g,'\n');
  const answerKey=readAnswerKey(normalized);
  const exerciseText=answerKey?normalized.slice(0,answerKey.start):normalized;
  const starts=[...exerciseText.matchAll(questionStart)];
  const questions:Question[]=[];
  const warnings:string[]=[];
  let firstQuestionAt:number|undefined;
  let skipped=0;

  for(let index=0;index<starts.length;index++) {
    const start=starts[index],number=String(Number(start[1]));
    const block=exerciseText.slice(start.index+start[0].length,starts[index+1]?.index??exerciseText.length);
    const choices=[...block.matchAll(choiceLine)];
    if(!choices.length)continue;
    firstQuestionAt??=start.index;
    const letters=choices.map(match=>match[1]??match[2]??match[3]??match[4]);
    const prompt=block.slice(0,choices[0].index).trim();
    if(choices.length!==4||letters.join('')!=='ABCD'||!prompt){skipped++;continue;}

    const inlineAnswers=[...block.matchAll(localAnswer)].map(match=>match[1].toUpperCase().charCodeAt(0)-65);
    const uniqueAnswers=new Set(inlineAnswers);
    const keyedAnswer=answerKey?.answers.get(number);
    if(keyedAnswer!==undefined)uniqueAnswers.add(keyedAnswer);
    if(uniqueAnswers.size!==1||answerKey?.conflicts.has(number)){skipped++;continue;}
    const answer=[...uniqueAnswers][0];
    const explanationMarker=block.match(explanationHeading);
    const localMarker=[...block.matchAll(localAnswer)][0];
    const metadataStart=Math.min(localMarker?.index??block.length,explanationMarker?.index??block.length);
    const options=choices.map((choice,i)=>{
      // Start after the option marker but retain wrapped option lines from PDFs.
      const optionStart=choice.index+choice[0].length-choice[5].length;
      const optionEnd=Math.min(choices[i+1]?.index??block.length,metadataStart);
      return block.slice(optionStart,optionEnd).trim();
    });
    if(options.some(option=>!option)){skipped++;continue;}
    let explanation=explanationMarker?block.slice(explanationMarker.index!+explanationMarker[0].length).trim():'';
    // A local answer printed after the explanation is metadata as well.
    const trailingAnswer=explanation.search(localAnswer);
    if(trailingAnswer>=0)explanation=explanation.slice(0,trailingAnswer).trim();
    questions.push({
      id:`import-question-${number}-${index+1}`,
      prompt,options,answer,
      explanation:explanation||'导入资料所附答案，请对照原材料核实。',
      evidence:'',
    });
  }

  if(skipped)warnings.push(`有 ${skipped} 道题缺少完整选项或明确一致的答案，未转为交互题目。请返回上一步核对原始文字。`);
  if(!questions.length)return {body:text.trim(),questions,warnings};
  warnings.push('正文已与题目、答案分开。完整原始文字仍可返回上一步查看。');
  return {
    body:exerciseText.slice(0,firstQuestionAt??0).trim()||'请阅读题干后作答。',
    questions,warnings,
  };
}
