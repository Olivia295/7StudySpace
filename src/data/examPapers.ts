export type ExamPaper = {
  id: string;
  exam: 'cet6' | 'postgraduate';
  year: number;
  session: string;
  title: string;
  sourceName: string;
  url: string;
  note: string;
  kind: 'past-paper' | 'official-sample';
  sections: string[];
  verifiedAt: string;
};

// These are verified source links, not locally licensed copies or in-app lessons.
// Evidence and inclusion rules: docs/exam-sources.md.
const verifiedAt = '2026-10-04';

function cet(year: number, month: number, set: number, url: string): ExamPaper {
  const setName = ['第一套', '第二套', '第三套'][set - 1];
  return {
    id: `cet6-${year}-${String(month).padStart(2, '0')}-${set}`,
    exam: 'cet6', year, session: `${month}月 · ${setName}`,
    title: `${year}年${month}月六级 · ${setName}`,
    sourceName: '新东方在线', url, kind: 'past-paper', verifiedAt,
    sections: set === 3 ? ['阅读', '翻译', '写作'] : ['听力', '阅读', '翻译', '写作'],
    note: set === 3
      ? '原站提供图版试卷及参考答案；听力请按原站卷次说明选用。'
      : '原站提供图版试卷、参考答案和听力播放器。可先做题，再核对答案。',
  };
}

function postgraduate(year: number, url: string, note: string): ExamPaper {
  return {
    id: `postgraduate-${year}-english-one`,
    exam: 'postgraduate', year, session: '全国统考 · 英语一',
    title: `${year}年考研英语一`, sourceName: '中国教育在线', url,
    kind: 'past-paper', sections: ['完形', '阅读', '新题型', '翻译', '写作'],
    note, verifiedAt,
  };
}

export const examPapers: ExamPaper[] = [
  cet(2025, 6, 1, 'https://cet6.koolearn.com/20250609/901413.html'),
  cet(2025, 6, 2, 'https://cet6.koolearn.com/20250609/901414.html'),
  cet(2025, 6, 3, 'https://cet6.koolearn.com/20250609/901415.html'),
  postgraduate(2025, 'https://kaoyan.eol.cn/shiti/yingyu/202412/t20241226_2648402.shtml', '原站提供试题与参考答案图片，可放大阅读。年份按招生考试年度标记。'),
  cet(2024, 12, 1, 'https://cet6.koolearn.com/20250415/898834.html'),
  cet(2024, 12, 2, 'https://cet6.koolearn.com/20250415/898835.html'),
  cet(2024, 12, 3, 'https://cet6.koolearn.com/20250415/898836.html'),
  cet(2024, 6, 1, 'https://cet6.koolearn.com/20241204/892871.html'),
  cet(2024, 6, 2, 'https://cet6.koolearn.com/20241204/892872.html'),
  cet(2024, 6, 3, 'https://cet6.koolearn.com/20241204/892873.html'),
  postgraduate(2024, 'https://kaoyan.eol.cn/shiti/yingyu/202312/t20231226_2551123.shtml', '掌上考研整理的完整试题及参考答案，以原站图片为准。'),
  cet(2023, 12, 1, 'https://cet6.koolearn.com/20240229/884398.html'),
  cet(2023, 12, 2, 'https://cet6.koolearn.com/20240229/884399.html'),
  cet(2023, 12, 3, 'https://cet6.koolearn.com/20240229/884400.html'),
  postgraduate(2023, 'https://kaoyan.eol.cn/shiti/202304/t20230427_2388496.shtml', '掌上考研整理的试题及答案解析，图版资料在原站查看。'),
  postgraduate(2022, 'https://kaoyan.eol.cn/shiti/yingyu/202203/t20220331_2218121.shtml', '原站提供试题及参考答案图版。先独立作答，再对照解析。'),
  postgraduate(2021, 'https://kaoyan.eol.cn/shiti/yingyu/202012/t20201229_2064036.shtml', '原站转载跨考教育整理的试题与解析；答案为机构参考版本。'),
  postgraduate(2020, 'https://kaoyan.eol.cn/shiti/yingyu/201912/t20191222_1700467.shtml', '原站转载文都教育整理的试题及解析，可在原站逐页阅读。'),
  postgraduate(2019, 'https://kaoyan.eol.cn/shiti/yingyu/201812/t20181224_1638421.shtml', '文都教育整理的试题与详细解析，原站提供可阅读的文字内容。'),
  {
    id: 'cet6-official-sample-2016', exam: 'cet6', year: 2016,
    session: '官方样卷 · 2016修订大纲', title: '六级官方笔试样卷',
    sourceName: '教育部教育考试院',
    url: 'https://cet.neea.edu.cn/res/Home/1704/55b02330ac17274664f06d9d3db8249d.pdf',
    note: '大纲正文第167页起为六级笔试样卷；这是官方样题，不是某年的历年真题。PDF约12 MB。',
    kind: 'official-sample', sections: ['听力', '阅读', '翻译', '写作'], verifiedAt,
  },
];
