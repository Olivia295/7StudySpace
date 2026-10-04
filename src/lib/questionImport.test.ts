import {describe,it,expect} from 'vitest';
import {parseQuestionText} from './questionImport';

const question=(number:string,answer='答案：B')=>`${number} Why did the team change its plan?\nA. To work longer.\nB. To reduce waste.\nC. To gain attention.\nD. To travel abroad.\n${answer}\n解析：The passage says the new plan reduces waste.`;

describe('question text import',()=>{
  it('keeps the passage separate from the prompt, choices and answer',()=>{
    const result=parseQuestionText(`A team tested a new plan.\nIt reduced waste.\n\n${question('1.')}`);
    expect(result.body).toBe('A team tested a new plan.\nIt reduced waste.');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].prompt).toBe('Why did the team change its plan?');
    expect(result.questions[0].options).toEqual(['To work longer.','To reduce waste.','To gain attention.','To travel abroad.']);
    expect(result.questions[0].answer).toBe(1);
    expect(result.questions[0].explanation).toBe('The passage says the new plan reduces waste.');
    expect(result.body).not.toMatch(/答案|解析|waste\.$[\s\S]*Why/);
  });

  it.each(['1.','1、','1)','1）'])('recognizes question numbering %s',number=>{
    expect(parseQuestionText(question(number)).questions).toHaveLength(1);
  });

  it('uses neutral material text when the import starts with a question',()=>{
    expect(parseQuestionText(question('1.')).body).toBe('请阅读题干后作答。');
  });

  it('recognizes English local answer labels without guessing an answer',()=>{
    const result=parseQuestionText(question('1.','Answer: C'));
    expect(result.questions[0].answer).toBe(2);
    expect(result.questions[0].options[3]).toBe('To travel abroad.');
  });

  it('keeps the entire original text when no explicit answer is available',()=>{
    const original=`An article.\n\n${question('1.','')}`;
    const result=parseQuestionText(original);
    expect(result.questions).toEqual([]);
    expect(result.body).toBe(original);
    expect(result.warnings[0]).toContain('缺少');
  });

  it('supports an explicit consolidated inline answer key',()=>{
    const one=question('1.','').split('\n解析：')[0],two=question('2、','').split('\n解析：')[0];
    const result=parseQuestionText(`The original passage.\n\n${one}\n${two}\n答案：1.A 2.B`);
    expect(result.body).toBe('The original passage.');
    expect(result.questions.map(q=>q.answer)).toEqual([0,1]);
    expect(result.questions.map(q=>q.options[3])).toEqual(['To travel abroad.','To travel abroad.']);
    expect(result.body).not.toContain('答案');
  });

  it('supports consolidated answer keys on separate lines',()=>{
    const one=question('51)','').split('\n解析：')[0],two=question('52.','').split('\n解析：')[0];
    const result=parseQuestionText(`${one}\n${two}\nAnswer Key:\n51. A\n52. D`);
    expect(result.questions.map(q=>q.answer)).toEqual([0,3]);
    expect(result.questions[0].id).toContain('51');
  });

  it('does not treat a numbered passage paragraph as a question',()=>{
    const result=parseQuestionText(`1. An article with numbered paragraphs.\n2. The second paragraph offers context.\n\n${question('3.')}`);
    expect(result.body).toBe('1. An article with numbered paragraphs.\n2. The second paragraph offers context.');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].prompt).not.toContain('paragraph');
  });

  it('does not silently choose when local and consolidated answers conflict',()=>{
    const original=`${question('1.')}\n答案：1.C`;
    const result=parseQuestionText(original);
    expect(result.questions).toEqual([]);
    expect(result.body).toBe(original);
    expect(result.warnings[0]).toContain('一致');
  });

  it('does not discard unrecognized questions without a warning',()=>{
    const result=parseQuestionText(`Passage.\n${question('1.','')}\n${question('2.')}`);
    expect(result.questions).toHaveLength(1);
    expect(result.body).toBe('Passage.');
    expect(result.warnings[0]).toContain('1 道题');
    expect(result.warnings.join('')).toContain('上一步');
  });

  it('preserves wrapped options but excludes metadata from the last option',()=>{
    const result=parseQuestionText(`Passage.\n1. Choose a reason.\nA. The first\nwrapped option.\nB. The second option.\nC. The third option.\nD. The fourth\nwrapped option.\n答案：D\n解析：An explanation\nwith another line.`);
    expect(result.questions[0].options[0]).toBe('The first\nwrapped option.');
    expect(result.questions[0].options[3]).toBe('The fourth\nwrapped option.');
    expect(result.questions[0].explanation).toBe('An explanation\nwith another line.');
  });

  it('retains a blank line in the passage and normalizes CRLF safely',()=>{
    const result=parseQuestionText(`A first paragraph.\r\n\r\nA second paragraph.\r\n${question('1.').replaceAll('\n','\r\n')}`);
    expect(result.body).toBe('A first paragraph.\n\nA second paragraph.');
    expect(result.questions).toHaveLength(1);
  });
});
