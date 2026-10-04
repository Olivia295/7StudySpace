export type Kind = 'vocabulary' | 'reading' | 'listening' | 'sentence' | 'writing' | 'translation';
export type Tab = 'today' | 'library' | 'review' | 'history';
export interface Word { id: string; word: string; phonetic?: string; pos: string; meaning: string; example: string; exampleMeaning?: string; tags: string[]; source: string; sourceUrl?: string; exampleSource?: string; exampleSourceUrl?: string; exampleTranslationSourceUrl?: string; exampleLicense?: string; originalFile?: string; updatedAt?: string }
export interface Question { id: string; prompt: string; options: string[]; answer: number; explanation: string; evidence: string }
export interface Lesson { id: string; kind: Exclude<Kind, 'vocabulary'>; title: string; subtitle: string; level: string; minutes: number; tags: string[]; body: string; translation?: string; audio?: string; questions?: Question[]; analysis?: string[]; sample?: string; source: { title: string; url?: string; license?: string; adapted?: boolean }; originalFile?: string; originalName?: string; referenceFile?: string; referenceName?: string; updatedAt?: string }
export interface Review { due: string; interval: number; lapses: number; successes: number; updatedAt: string }
export interface StudyEvent { id: string; at: string; itemId: string; title: string; kind: Kind; rating?: 'again' | 'hard' | 'good'; correct?: number; total?: number; response?: string; answers?: Record<string, number>; reason?: string }
export interface Progress { draft: string; note: string; answers: Record<string, number>; position: number; completed: boolean; updatedAt: string; fieldUpdatedAt?: Record<string,string>; conflicts?: { field:'draft'|'note'; text:string; at:string }[] }
export interface Session { ids: string[]; index: number; kind: 'vocabulary' | 'lesson'; startedAt: string; updatedAt: string; finished?: boolean }
export interface Settings { name: string; budget: 10 | 40 | 70; companion: string; tone: string; instruction: string; weeklyReview: boolean; focus?: Kind | null; updatedAt: string }
export interface AnalysisReport { id: string; at: string; jobId: string; through: string; text: string; suggestions?: Recommendation[] }
export interface Recommendation { title: string; reason: string; budget?: 10 | 40 | 70; focus?: Kind | null }
export interface PlanChange { id: string; reportId: string; title: string; at: string; before: { budget: 10 | 40 | 70; focus?: Kind | null }; after: { budget: 10 | 40 | 70; focus?: Kind | null }; revertedAt?: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; at: string; jobId?: string; status?: string; review?: boolean; through?: string }
export interface StudyState { version: 1; settings: Settings; events: StudyEvent[]; reviews: Record<string, Review>; progress: Record<string, Progress>; imports: Lesson[]; importedWords?: Word[]; planChanges?: PlanChange[]; session?: Session; reports: AnalysisReport[]; chats?: ChatMessage[] }
export interface AIJob { id: string; kind: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'unavailable'; result?: { text: string; provider?: string } | string | null; error?: { code: string; message: string } | null; createdAt: string; updatedAt: string }
export const kindLabels: Record<Kind, string> = { vocabulary: '词汇积累', reading: '阅读理解', listening: '听力练习', sentence: '长难句', writing: '写作训练', translation: '翻译练习' };
