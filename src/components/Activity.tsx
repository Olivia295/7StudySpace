import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { StudyEvent } from '../types';
import { localDate } from '../lib/study';
import { activityDateLabel, calendarDays, emptyActivity, previousActivity, shiftDay, summarizeActivity } from '../lib/activity';
import './activity.css';

export function ActivityCalendar({ events, onSelect, selectedDate, embedded = false, weeks = 26 }: {
  events: StudyEvent[];
  onSelect?: (date: string) => void;
  selectedDate?: string;
  embedded?: boolean;
  weeks?: number;
}) {
  const today = localDate();
  const [internalDate, setInternalDate] = useState(today);
  const selected = selectedDate ?? internalDate;
  const descriptionId = useId();
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const weekCount = Number.isFinite(weeks) ? Math.max(1, Math.min(52, Math.floor(weeks))) : 26;
  const byDate = useMemo(() => summarizeActivity(events), [events]);
  const days = useMemo(() => calendarDays(byDate, today, weekCount), [byDate, today, weekCount]);
  const activeDays = days.filter(day => day.records > 0).length;
  const selectedActivity = byDate.get(selected) ?? emptyActivity(selected);
  const selectedInRange = days.some(day => day.date === selected && !day.future);
  const weekColumns = Array.from({ length: weekCount }, (_, index) => days.slice(index * 7, index * 7 + 7));

  useEffect(() => {
    const area = scrollRef.current;
    if (!area) return;
    const showLatest = () => { area.scrollLeft = area.scrollWidth; };
    showLatest();
    const observer = new ResizeObserver(showLatest);
    observer.observe(area);
    return () => observer.disconnect();
  }, [today, weekCount]);

  function select(date: string) {
    setInternalDate(date);
    onSelect?.(date);
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const movements: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7, PageUp: -28, PageDown: 28 };
    let next = movements[event.key] === undefined ? null : shiftDay(date, movements[event.key]);
    if (event.key === 'Home') next = days[0].date;
    if (event.key === 'End') next = today;
    if (!next) return;
    event.preventDefault();
    next = next < days[0].date ? days[0].date : next > today ? today : next;
    select(next);
    refs.current.get(next)?.focus();
  }

  return <section className={`activity-calendar${embedded ? ' is-embedded' : ''}`} aria-label="学习打卡日历" style={{ '--activity-weeks': weekCount } as CSSProperties}>
    <div className="activity-section-heading">
      {!embedded && <div><h2>学习足迹</h2><p id={descriptionId}>完成练习，自动留下一个格子。休息的日子也可以留白。</p></div>}
      <span>近 {weekCount} 周 · {activeDays} 天有记录</span>
    </div>
    <div className="activity-calendar-scroll" ref={scrollRef}>
      <div className="activity-calendar-chart" aria-describedby={embedded ? undefined : descriptionId}>
        <div className="activity-calendar-weekdays" aria-hidden="true"><span>一</span><span>三</span><span>五</span><span>日</span></div>
        <div className="activity-calendar-weeks">
          {weekColumns.map((week, weekIndex) => {
            const monthStart = week.find(day => day.date.endsWith('-01'));
            const month = (monthStart ?? week[0]).date.slice(5, 7);
            return <div className="activity-calendar-week" key={week[0].date}>
              <span className="activity-calendar-month" aria-hidden="true">{weekIndex === 0 || monthStart ? `${Number(month)}月` : ''}</span>
              {week.map(day => <button
                key={day.date}
                ref={element => { if (element) refs.current.set(day.date, element); else refs.current.delete(day.date); }}
                type="button"
                className={`activity-cell level-${day.intensity}${day.date === selected ? ' is-selected' : ''}${day.date === today ? ' is-today' : ''}`}
                disabled={day.future}
                tabIndex={day.date === (selectedInRange ? selected : today) ? 0 : -1}
                aria-label={`${activityDateLabel(day.date, true)}，${day.future ? '未来日期' : `${day.records} 条学习记录`}${day.date === today ? '，今天' : ''}`}
                aria-pressed={day.date === selected}
                title={`${activityDateLabel(day.date)} · ${day.records} 条学习记录`}
                onClick={() => select(day.date)}
                onKeyDown={event => navigate(event, day.date)}
              />)}
            </div>;
          })}
        </div>
      </div>
    </div>
    <div className="activity-calendar-footer">
      <p aria-live="polite"><strong>{selected === today ? '今天' : activityDateLabel(selected)}</strong>{selectedActivity.records ? ` · ${selectedActivity.records} 条记录${selectedActivity.wordReviews ? ` · 回忆 ${selectedActivity.uniqueWords} 个单词` : ''}${selectedActivity.questionCount ? ` · 作答 ${selectedActivity.questionCount} 题` : ''}` : ' · 还没有练习记录'}</p>
      <div className="activity-legend" aria-label="格子颜色表示记录数量：0 条、1 至 4 条、5 至 14 条、15 至 29 条、30 条及以上"><span>少</span>{[0, 1, 2, 3, 4].map(level => <i className={`level-${level}`} key={level} aria-hidden="true"/>)}<span>多</span></div>
    </div>
    <p className="activity-calendar-hint">点选日期看当天记录 · 格子深浅表示练习记录数量，包含重复练习</p>
  </section>;
}

function countChange(current: number, previous: number, unit: string) {
  const change = current - previous;
  return change === 0 ? `次数相同` : `${change > 0 ? '多' : '少'} ${Math.abs(change)} ${unit}`;
}

export function DailyProgress({ events, date = localDate(), compact = false }: {
  events: StudyEvent[];
  date?: string;
  compact?: boolean;
}) {
  const today = localDate();
  const byDate = useMemo(() => summarizeActivity(events), [events]);
  const current = date > today ? emptyActivity(date) : byDate.get(date) ?? emptyActivity(date);
  const previous = previousActivity(byDate, date);
  const comparable = current.records > 0 && previous;
  const accuracyChange = current.accuracy !== null && previous?.accuracy !== null && previous?.accuracy !== undefined
    ? Math.round((current.accuracy - previous.accuracy) * 1000) / 10 : null;
  const heading = date === today ? '今天的变化' : `${activityDateLabel(date)} 的练习`;

  return <section className={`daily-progress${compact ? ' is-compact' : ''}`} aria-label={heading}>
    <div className="activity-section-heading">
      <div>{!compact && <h2>{heading}</h2>}<p>{comparable ? `和上个有记录的日子 ${activityDateLabel(previous.date)} 相比` : current.records ? '第一份记录，会成为之后的参照。' : '完成一次练习后，这里就会出现你的变化。'}</p></div>
      {current.records > 0 && <span>{current.records} 条真实记录</span>}
    </div>
    <div className="daily-progress-metrics">
      <div className="daily-progress-metric">
        <span className="daily-progress-label">词汇回忆</span>
        <p><strong>{current.wordReviews}</strong><span>次</span></p>
        <small>{current.uniqueWords} 个不同单词</small>
        {comparable && <span className="daily-progress-change">{countChange(current.wordReviews, previous.wordReviews, '次回忆')}</span>}
      </div>
      <div className="daily-progress-metric">
        <span className="daily-progress-label">客观题作答</span>
        <p><strong>{current.correctCount}<em> / {current.questionCount}</em></strong><span>题答对</span></p>
        <small>{current.accuracy === null ? '还没有客观题记录' : `正确率 ${Math.round(current.accuracy * 100)}%`}{current.repeatedQuizAttempts > 0 ? ` · 含 ${current.repeatedQuizAttempts} 次重做` : ''}</small>
        {comparable && <span className="daily-progress-change">{accuracyChange === null ? `上次作答 ${previous.questionCount} 题` : `${accuracyChange === 0 ? '正确率相同' : `${accuracyChange > 0 ? '+' : '−'}${Math.abs(accuracyChange)} 个百分点`} · ${previous.questionCount} → ${current.questionCount} 题`}</span>}
      </div>
      {!compact && <div className="daily-progress-metric">
        <span className="daily-progress-label">阅读等练习</span>
        <p><strong>{current.lessonAttempts}</strong><span>次</span></p>
        <small>阅读、听力、长难句、写作与翻译</small>
        {comparable && <span className="daily-progress-change">{countChange(current.lessonAttempts, previous.lessonAttempts, '次练习')}</span>}
      </div>}
    </div>
    {current.questionCount > 0 && <p className="daily-progress-footnote">按实际作答统计，包含重做；题目与题量不同，正确率只作观察。词汇自评不计入正确率。</p>}
    {compact && current.lessonAttempts > 0 && current.questionCount === 0 && <p className="daily-progress-footnote">另外留下了 {current.lessonAttempts} 次阅读、听力、长难句、写作或翻译练习。</p>}
  </section>;
}
