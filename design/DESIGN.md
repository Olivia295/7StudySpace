# 7StudySpace design contract

User approved warm paper / sage, novice-first mobile and iPad app, no sign-up or placement test. No streaks, ranks, nagging, empty praise. Four surfaces: 今天 / 学习 / 复习 / 记录. Controls and text are native React, not screenshots.

References: `home-concept.png` (1484x1060), `practice-concept.png` (1024x1536). Built-in Image Gen generated both and the separate `public/images/quiet-desk.png`. Brief: quiet editorial Chinese study room, paper #F8F7F3, white #FFF, forest #243D34, sage #6C8573, warm grey #858A81, thin borders, no gradients, single primary framed learning panel and botanical side panel. Image has no added overlay. The production illustration was extracted by Image Gen editing rather than CSS approximation.

Typography: system sans for controls and body; Noto Serif SC / Songti SC / STSong for warm editorial headings, Georgia for words. Root 16px, line-height 1.65; title 38-46px desktop / 28-32px mobile, h2 25-30px. Buttons min44px; visible focus and reduced-motion support. Spacing 8/12/16/24/32/48/64; radius 16-20px. Lucide outline icons stroke1.65. Top nav desktop, thumb-reachable bottom navigation mobile. iPad landscape uses split lesson/article where meaningful.

Home allowed copy: brand 7StudySpace; nav 今天 学习 复习 记录; date computed in Asia/Shanghai; 77，慢慢来，也在向前。; 留一点时间给英语，也留一点空间给自己。; 学习搭子; 今天，学一点什么？; 轻学10分钟 日常40分钟 加练70分钟; 单词与表达 / 从一组实用词汇开始; 听见英语 / 先听懂大意，再慢慢拆解; 读一篇，想一想 / 找到藏在文字里的线索; 开始今天的学习; 可以随时停下，下次接着来。; 给学习留一点呼吸; 不用一次学完。今天的一小步，也值得被记住。; 换个方向，也很好; 按自己的节奏来; 词汇积累 阅读理解 听力练习 写作与翻译.

Intentional responsive differences: shorter mobile greeting wraps naturally; side illustration moves below study action; bottom nav replaces top nav. Live saved state, continuation, and personal name may replace first-use copy. Date is real, never hardcoded. Settings, imports, pairing, notes, backup and AI status extend the same visual system because required workflows need them. No fictional progress counters.

Architecture: React/Vite/TypeScript; small page components, shared types/store/scheduler/import helpers. IndexedDB saves before cloud sync. Private SQLite server with device pairing, revision checks and durable AI jobs. AI uses a narrow local Codex worker only after validation, unavailable state never pretends to be AI. Materials carry provenance. All UI works without AI and can recover after interrupted study.

Final asset treatment correction: the full-height image initially placed leaves behind copy. The final image sits in the lower 66% of the desktop botanical panel, with only a top edge alpha mask to blend its edge. No color overlay remains. Mobile uses a left edge mask on the right-aligned image. Added “和学习搭子聊聊” is a deliberate functional extension so the companion is reachable from the mobile home screen, where the desktop header companion action is hidden.
