#!/usr/bin/env python3
"""Build 7StudySpace's attributed, simplified-Chinese vocabulary pack.

Requires Python 3.10+, wordfreq==3.1.1, opencc-python-reimplemented==0.1.7.
Example (use a disposable virtual environment for these build-only tools):
  pip install wordfreq==3.1.1 opencc-python-reimplemented==0.1.7
  python scripts/build-vocabulary.py --download

The two Kaikki downloads are dated 2026-10-01 Chinese Wiktionary snapshots.
They are cached outside the repository; hashes prevent silently importing a
different, unreviewed snapshot. Pass --cache-dir to use an existing cache.
No scraped exam answers, audio or externally quoted dictionary definitions are
bundled. Attributed Tatoeba pairs and original teaching examples are held in
the adjacent reviewable JSON files. Missing examples remain empty strings.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from hashlib import sha256
from importlib.metadata import distribution, version
import json
from pathlib import Path
import re
import sys
import tarfile
import tempfile
from urllib.parse import quote
from urllib.request import Request, urlopen

try:
    from opencc import OpenCC
    from wordfreq import zipf_frequency
except ImportError:
    sys.exit("Install build-only dependencies: wordfreq==3.1.1 opencc-python-reimplemented==0.1.7")

ROOT = Path(__file__).resolve().parents[1]
CC_BY_SA = "https://creativecommons.org/licenses/by-sa/4.0/"
SOURCES = [
    {
        "filename": "7studyspace-wiktionary-en-traditional.jsonl",
        "url": "https://kaikki.org/zhwiktionary/%E8%8B%B1%E8%AA%9E/kaikki.org-dictionary-%E8%8B%B1%E8%AA%9E.jsonl",
        "sha256": "ce3b2e10f7fe73d9d85b63dbf06cc04d1e66c6089d1e702366a51e951432cd7e",
    },
    {
        "filename": "7studyspace-wiktionary-en-simplified.jsonl",
        "url": "https://kaikki.org/zhwiktionary/%E8%8B%B1%E8%AF%AD/kaikki.org-dictionary-%E8%8B%B1%E8%AF%AD.jsonl",
        "sha256": "e3ecda3d47230967ef65a7efcc2c1b1523590aa86265c37432664b5e18ad22f4",
    },
]
WORDNET = {
    "filename": "7studyspace-wordnet-3.1.tar.gz",
    "url": "https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz",
    "sha256": "3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a",
}
POS = {"noun": "n.", "verb": "v.", "adj": "adj.", "adv": "adv.", "prep": "prep."}
EXCLUDED_TAGS = {
    "form-of", "alt-of", "obsolete", "archaic", "vulgar", "offensive",
    "slur", "rare", "dated", "dialectal", "slang", "nonstandard", "misspelling",
}
EXCLUDED_LABELS = re.compile(r"古语|古旧|方言|俚语|粗俗|贬义|讽刺|罕见|过时|苏格兰|非标准|不常用")
REFERENCE_ONLY = re.compile(
    r"过去[时式]|过去分词|现在分词|第三人称|的.{0,3}复数|不规则复数|变体|拼写|异体|"
    r"缩写|缩略|替代形式|参见|同上|^见[ :：]|^(同|等同于)[ A-Za-z]|[{}]|\[\[|"
    r"Template:|首字母|小写形|大写形|比较级|最高级"
)
# These were rejected during editorial spot checks: either a misleading rare
# sense was the only usable Chinese gloss, or the headword is inappropriate
# for the first general/academic study pack. This is not a universal word ban.
EXCLUDED_WORDS = set("""
been bein boner ass arse bitch cock cunt dick fuck fucking shit bullshit piss
porno porn gangbang blowjob motherfucker bastard slut whore damn bloody
gonna wanna gotta kinda sorta yup nope yeah yep tho nah dunno ain't
singing sender moves returns hung wont fir didnt doesnt wasnt dont
lol lmao omg btw aka info app apps blog blogger blogs tweet tweets meme
nigger niggers nigga faggot fag dyke douche dickhead fucker dildo gangbang
hentai incest pedophile brothel threesome lewd porno topless sexy kinky kink
you what could would should her his ought gonna wanna
labrador caesar ply lab theretofore thither hither whither goddamned commie tit
""".split())

# Hand-authored teaching entries repair missing/incomplete common senses in
# the source snapshot. Definitions and contextual examples are original, not
# extracted from another dictionary. They are also released under CC BY-SA 4.0.
# Format: word | POS | Chinese meaning | original example | Chinese translation.
ORIGINAL_ROWS = """
approach|n.; v.|方法，途径；接近；着手处理|We need a different approach to this problem.|我们需要用一种不同的方法来处理这个问题。
environment|n.|环境；周围的条件或状况|A quiet environment helps her focus on the article.|安静的环境有助于她专注于这篇文章。
analyze|v.|分析；细察各部分及其关系|The researchers analyze the results before making a claim.|研究人员在提出论断之前分析结果。
evidence|n.|证据；支持某种判断的事实或信息|There is little evidence that the two events are related.|几乎没有证据表明这两件事有关联。
evaluate|v.|评价；评估价值、效果或质量|We should evaluate the plan after trying it for a week.|我们应该试行一周后再评估这项计划。
adequate|adj.|足够的；能满足需要的|Students need adequate time to check their answers.|学生需要足够的时间检查答案。
sustainable|adj.|可持续的；能长期维持的|The city is investing in sustainable transport.|这座城市正在投资可持续交通。
acquire|v.|获得；逐渐学会或掌握|Children acquire new words through meaningful conversations.|孩子们通过有意义的对话学会新词。
assumption|n.|未经证实的假定；作为推理起点的设想|The argument rests on an assumption that may be wrong.|这个论证建立在一个可能错误的假定上。
interpret|v.|解释；理解含义；口译|Readers may interpret the same sentence in different ways.|读者可能会以不同方式理解同一句话。
relevant|adj.|与当前问题有关的；切题的|Underline the information that is relevant to the question.|在与问题有关的信息下画线。
revise|v.|修改；修订；复习|She decided to revise the final paragraph of her essay.|她决定修改作文的最后一段。
summarize|v.|概括；总结要点|Try to summarize the author's view in one sentence.|试着用一句话概括作者的观点。
resource|n.|可供利用的资源、材料或能力|The library provides free resources for language learners.|图书馆为语言学习者提供免费资源。
retain|v.|保留；保持；记住|Regular practice can help us retain what we have learned.|有规律的练习可以帮助我们记住所学内容。
strategy|n.|为实现目标制定的策略或行动安排|Her new strategy is to read the questions before listening.|她的新策略是在听录音之前先读题。
method|n.|方法；按一定步骤做事的方式|This method is useful when a sentence contains several clauses.|当一个句子包含多个从句时，这种方法很有用。
assess|v.|评估；判断性质、质量或程度|The survey helps us assess the needs of local residents.|这项调查帮助我们评估当地居民的需求。
factor|n.|因素；影响结果的条件|Cost is only one factor in the decision.|费用只是作出这项决定的因素之一。
outcome|n.|结果；某项行动或过程造成的后果|The outcome depends on how well the team works together.|结果取决于团队合作的情况。
implement|v.|实施；执行计划或决定|The school will implement the new policy next term.|学校将在下学期实施这项新政策。
indicate|v.|表明；显示；指示|The figures indicate a gradual increase in demand.|这些数字表明需求在逐渐增加。
establish|v.|建立；确立；查明或证实|The study aims to establish a link between sleep and memory.|这项研究旨在证实睡眠与记忆之间的联系。
contribute|v.|作出贡献；促成；捐助|Public libraries contribute to the life of a community.|公共图书馆为社区生活作出贡献。
consistent|adj.|前后一致的；持续稳定的|Her conclusion is consistent with the evidence in the report.|她的结论与报告中的证据一致。
perspective|n.|观察问题的角度；观点；透视法|The article examines the issue from a historical perspective.|这篇文章从历史角度审视这个问题。
derive|v.|得到；源自；推导出|Many English words derive from Latin.|许多英语单词源自拉丁语。
distinguish|v.|区分；辨别；使具有特色|It is important to distinguish facts from opinions.|区分事实与观点很重要。
conclude|v.|得出结论；结束|We cannot conclude that the policy caused the change.|我们不能断定这项政策导致了变化。
efficient|adj.|效率高的；能以较少时间或资源完成工作的|A shorter route makes the delivery service more efficient.|更短的路线提高了配送服务的效率。
significant|adj.|显著的；重要的；有意义的|The discovery had a significant influence on later research.|这项发现对后来的研究产生了重要影响。
accurate|adj.|准确的；符合事实或标准的|An accurate summary preserves the main idea of the text.|准确的摘要会保留文章的中心思想。
demonstrate|v.|证明；展示；示范|The experiment will demonstrate how heat affects the material.|这个实验将展示热如何影响这种材料。
maintain|v.|维持；保养；坚持声称|It takes regular effort to maintain a public garden.|维护公共花园需要经常投入精力。
priority|n.|优先事项；优先权|Improving access to clean water is a major priority.|改善清洁用水条件是一项主要的优先任务。
decline|n.; v.|下降，减少；衰退；婉言拒绝|The number of visitors began to decline after September.|九月之后，游客人数开始下降。
involve|v.|涉及；包含；使参与|The project will involve students from several departments.|这个项目将让来自多个院系的学生参与。
emerge|v.|出现；显露；逐渐形成|A clear pattern began to emerge from the data.|数据中开始显现出一个清晰的规律。
consume|v.|消耗；吃或喝；占用|Older buildings often consume more energy in winter.|较老的建筑在冬天往往消耗更多能源。
expand|v.|扩大；扩展；膨胀|The university plans to expand its online courses.|这所大学计划扩大在线课程的规模。
benefit|n.; v.|益处；好处；使受益，得益于|The new park will benefit everyone in the neighborhood.|新公园将使附近的每个人受益。
context|n.|上下文；事情发生的背景|You can often guess a word's meaning from its context.|你常常可以根据上下文猜出一个词的意思。
contrast|n.; v.|对比；差异；比较以显示不同之处|The second paragraph provides a contrast to the first.|第二段与第一段形成对比。
process|n.; v.|过程；流程；加工或处理|Learning to write clearly is a gradual process.|学会清晰地写作是一个渐进的过程。
available|adj.|可获得的；可使用的；有空的|The recording is available even when the device is offline.|即使设备离线，这段录音也可以使用。
adapt|v.|适应；调整；改编|The plan can adapt to changes in her daily routine.|这项计划可以适应她日常安排的变化。
resolve|v.; n.|解决；下决心；决心|The team met to resolve the remaining disagreements.|团队开会解决剩下的分歧。
fundamental|adj.|根本的；基础的|Trust is a fundamental part of a strong relationship.|信任是稳固关系的基本组成部分。
restrict|v.|限制；约束|Limited funding may restrict the size of the project.|有限的资金可能会限制项目的规模。
alternative|n.; adj.|可供选择的方案；替代的|Cycling is a practical alternative to driving for short trips.|短途出行时，骑车是一种可行的驾车替代方式。
emphasis|n.|强调；重点|The course places emphasis on understanding rather than speed.|这门课程把重点放在理解上，而不是速度上。
potential|adj.; n.|潜在的，可能的；潜力|The report discusses the potential effects of the proposal.|这份报告讨论了该提议可能产生的影响。
reliable|adj.|可靠的；可信赖的|Check whether the information comes from a reliable source.|检查信息是否来自可靠的来源。
objective|n.; adj.|目标；客观的|The main objective is to make the service easier to use.|主要目标是让这项服务更容易使用。
sequence|n.|顺序；一连串相关事物|Put the events in the correct sequence.|把这些事件按正确顺序排列。
encounter|v.; n.|遇到；遭遇；相遇|Readers often encounter unfamiliar ideas in academic texts.|读者在学术文章中经常会遇到陌生的观点。
considerable|adj.|相当多的；相当大的|The team spent considerable time checking the results.|团队花了相当多的时间核查结果。
ensure|v.|确保；保证某事发生|Clear instructions help ensure that the task is understood.|清晰的说明有助于确保大家理解任务。
despite|prep.|尽管；虽然有|Despite the delay, the project was completed on time.|尽管出现了延误，项目仍按时完成。
whereas|conj.|然而；而；用于对比两种情况|The first study used interviews, whereas the second used surveys.|第一项研究采用访谈，而第二项采用问卷调查。
tendency|n.|倾向；趋势|There is a tendency to remember the beginning of a story best.|人们往往最容易记住故事的开头。
regulation|n.|规则；规章；管理或调节|The new regulation requires clearer labels on food packages.|新规定要求食品包装上的标签更加清晰。
memory|n.|记忆；记忆力；计算机内存|The smell brought back a memory of her first day at school.|这股气味唤起了她第一天上学的回忆。
investment|n.|投资；投入的金钱、时间或精力|The project needs investment in both equipment and training.|这个项目需要在设备和培训两方面投入资源。
compare|v.|比较；对比；把……比作|Compare the two explanations and decide which is clearer.|比较这两种解释，判断哪一种更清楚。
dependent|adj.|依赖的；取决于……的|The success of the plan is dependent on public support.|这项计划的成功取决于公众的支持。
sufficient|adj.|足够的；充足的|The passage gives sufficient information to answer the question.|文章提供了足够的信息来回答这个问题。
always|adv.|总是；一直；在任何时候|A longer answer is not always a better answer.|更长的答案并不总是更好的答案。
campaign|n.; v.|有组织的活动；运动；发起或参加活动|The campaign encourages people to use less plastic.|这项活动鼓励人们减少塑料的使用。
slip|v.; n.|滑倒；滑动；悄悄移动；小差错；纸条|She wrote the address on a small slip of paper.|她把地址写在一张小纸条上。
grid|n.|网格；格栅；输电网|The city is improving its electricity grid.|这座城市正在改进电网。
ultraviolet|adj.; n.|紫外线的；紫外线|The coating protects the material from ultraviolet light.|这层涂层保护材料免受紫外线影响。
landscape|n.|风景；地貌；某领域的整体状况|Digital tools are changing the landscape of education.|数字工具正在改变教育的整体状况。
twin|n.; adj.|双胞胎之一；成双的；孪生的|The twin sisters chose different subjects at university.|这对双胞胎姐妹在大学选择了不同的专业。
cookie|n.|小甜饼；曲奇；网站保存的少量浏览数据|The website uses a cookie to remember your language choice.|这个网站使用浏览数据记录你的语言选择。
dividend|n.|股息；红利；被除数|The company announced a higher dividend for its shareholders.|公司宣布向股东发放更高的股息。
staple|n.; adj.|订书钉；主要食物或产品；主要的|Rice is a staple food in many parts of the world.|稻米是世界许多地区的主要食物。
subconscious|adj.; n.|潜意识的；下意识的；潜意识|Past experiences can have a subconscious influence on our choices.|过去的经历可能会在潜意识中影响我们的选择。
web|n.|网；蜘蛛网；相互连接的体系；万维网|The article describes a complex web of social relationships.|这篇文章描述了一张复杂的社会关系网。
well|adv.; adj.; n.|好地；充分地；健康的；井|The report explains the problem well, but offers no solution.|报告很好地解释了问题，却没有提出解决办法。
snag|n.; v.|意外的障碍或小问题；挂住，钩破|The project hit a snag when the materials arrived late.|材料迟到使项目遇到了一个意外问题。
upheaval|n.|剧变；动荡；使秩序遭到打乱的变化|The invention brought a period of economic upheaval.|这项发明带来了一段经济剧变时期。
hunch|n.; v.|直觉；预感；弓起背部或耸起肩膀|She had a hunch that the missing page was in her notebook.|她直觉认为丢失的那页纸在笔记本里。
adventure|n.|冒险；不寻常而令人兴奋的经历|Their first journey abroad became an unforgettable adventure.|他们第一次出国旅行成了一次难忘的冒险经历。
default|n.; v.|默认状态；未履行义务，违约；不履行债务等义务|The application saves new notes to this folder by default.|这个应用默认把新笔记保存在这个文件夹中。
""".strip()

PRIORITY = """
approach evidence analyze relevant context retain perspective assumption
interpret consistent evaluate distinguish strategy revise sustainable
contribute acquire significant accurate outcome efficient demonstrate
academic research analysis concept principle theory hypothesis insight
objective argument conclusion claim indicate imply infer justify assess
fundamental essential appropriate adequate considerable relatively
nevertheless moreover therefore despite whereas consequently however
alternative potential available resource factor impact influence
environment economy society culture community technology education
benefit challenge opportunity priority capacity responsibility
maintain establish implement adapt resolve restrict expand decline
emerge encounter consume ensure sequence method process structure
function feature tendency trend consequence cause effect proportion
distribution demand supply income investment employment occupation
innovation competition cooperation regulation policy institution
individual collective diverse diversity equality access opportunity
psychology behavior attitude motivation attention memory perception
recognize identify investigate explore examine observe compare
contrast illustrate clarify define emphasize summarize transform
predict propose reject accept reveal reflect respond respond
reliable valid precise complex comprehensive specific general
abstract concrete temporary permanent flexible stable gradual
efficient effective independent dependent sufficient insufficient
advantage disadvantage limitation requirement achievement progress
participate involve include exclude expand reduce promote prevent
preserve protect conserve recover restore replace adjust allocate
generate obtain retain sustain survive support encourage stimulate
""".split()


def download(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    request = Request(url, headers={"User-Agent": "7StudySpace-vocabulary-builder/1.0 (educational content preparation)"})
    temporary = target.with_suffix(target.suffix + ".download")
    with urlopen(request, timeout=120) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    temporary.replace(target)


def original_entries() -> dict[str, dict]:
    result = {}
    for line in ORIGINAL_ROWS.splitlines():
        word, pos, meaning, example, translation = line.split("|")
        assert word not in result, word
        result[word] = {"word": word, "pos": pos, "meaning": meaning, "example": example, "exampleMeaning": translation}
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="download missing source files to the cache")
    parser.add_argument("--cache-dir", type=Path, default=Path(tempfile.gettempdir()))
    parser.add_argument("--count", type=int, default=3200)
    args = parser.parse_args()
    if version("wordfreq") != "3.1.1" or version("opencc-python-reimplemented") != "0.1.7":
        sys.exit("Use the pinned build dependency versions documented in this script.")
    if not 3000 <= args.count <= 5000:
        sys.exit("This study pack is designed for 3000–5000 unique headwords.")

    converter = OpenCC("t2s")
    candidates = defaultdict(list)
    phonetics = {}
    stats = Counter()
    wn_path = args.cache_dir / WORDNET["filename"]
    if not wn_path.exists() and args.download:
        download(WORDNET["url"], wn_path)
    if not wn_path.exists() or sha256(wn_path.read_bytes()).hexdigest() != WORDNET["sha256"]:
        sys.exit("Missing or changed WordNet snapshot. Use --download with a clean cache, or review the source hash.")
    lexical_counts = Counter()
    lexical_pos = defaultdict(set)
    with tarfile.open(wn_path, "r:gz") as archive:
        # Read only these known members; never extract untrusted archive paths.
        for line in archive.extractfile("dict/index.sense"):
            key, _offset, _number, count = line.decode("utf-8").split()
            word, sense = key.split("%")
            lexical_counts[word] += int(count)
            lexical_pos[word].add({"1": "noun", "2": "verb", "3": "adj", "4": "adv", "5": "adj"}[sense[0]])
        header = archive.extractfile("dict/data.noun").read().decode("utf-8").splitlines()[:29]
        wordnet_license = "\n".join(re.sub(r"^\s*\d+\s?", "", line).rstrip() for line in header)
    for source in SOURCES:
        path = args.cache_dir / source["filename"]
        if not path.exists() and args.download:
            download(source["url"], path)
        if not path.exists():
            sys.exit(f"Missing {path}. Use --download or supply a populated --cache-dir.")
        digest = sha256(path.read_bytes()).hexdigest()
        if digest != source["sha256"]:
            sys.exit(f"Source snapshot changed: {path.name}. Review the new release before updating its pinned hash.")
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                entry = json.loads(line)
                stats["sourceRecords"] += 1
                word = entry.get("word", "")
                if entry.get("lang_code") != "en" or not re.fullmatch(r"[a-z]{3,20}", word):
                    continue
                for sound in entry.get("sounds", []):
                    if sound.get("ipa") and word not in phonetics:
                        phonetics[word] = sound["ipa"]
                pos = entry.get("pos")
                if pos not in POS or word in EXCLUDED_WORDS or pos not in lexical_pos[word] or lexical_counts[word] == 0:
                    stats["lexicalGateRecordsSkipped"] += 1
                    continue
                entry_tags = set(entry.get("tags", []))
                entry_labels = converter.convert(" ".join(entry.get("raw_tags", [])))
                categories = " ".join(c.get("name", "") if isinstance(c, dict) else c for c in entry.get("categories", []))
                if "非詞元" in categories or "非词元" in categories:
                    stats["nonLemmaRecordsSkipped"] += 1
                    continue
                for sense in entry.get("senses", []):
                    tags = entry_tags | set(sense.get("tags", []))
                    labels = entry_labels + " " + converter.convert(" ".join(sense.get("raw_tags", [])))
                    if tags & EXCLUDED_TAGS or sense.get("form_of") or sense.get("alt_of") or EXCLUDED_LABELS.search(labels):
                        stats["restrictedOrReferenceSensesSkipped"] += 1
                        continue
                    for gloss in sense.get("glosses", [])[:1]:
                        gloss = re.sub(r"\s+", " ", converter.convert(gloss)).strip()
                        if not re.search(r"[\u4e00-\u9fff]", gloss) or len(gloss) > 100 or REFERENCE_ONLY.search(gloss) or EXCLUDED_LABELS.search(gloss):
                            stats["unusableGlossesSkipped"] += 1
                            continue
                        # Strip an English paraphrase surrounding a Chinese gloss.
                        match = re.fullmatch(r"[A-Za-z ,'-]+[（(]([\u4e00-\u9fff；，、。]+)[）)]", gloss)
                        if match:
                            gloss = match.group(1)
                        candidates[word].append({"pos": pos, "gloss": gloss, "specialized": bool(sense.get("topics"))})

    originals = original_entries()
    priority = {word: i for i, word in enumerate(dict.fromkeys(PRIORITY + list(originals)))}
    words = set(candidates) | set(originals)
    # Frequency is a general-language selection signal, not an exam syllabus
    # mapping or a claim about an individual learner's knowledge.
    ranked = sorted(words, key=lambda word: (0, priority[word]) if word in priority else (1, -zipf_frequency(word, "en"), word))
    selected = ranked[:args.count]
    if len(selected) < args.count:
        sys.exit(f"Only {len(selected)} suitable words; refusing to pad the pack.")

    additions_path = ROOT / "scripts/build-vocabulary.examples.json"
    additions = json.loads(additions_path.read_text(encoding="utf-8")) if additions_path.exists() else []
    corrections = json.loads((ROOT / "scripts/build-vocabulary.corrections.json").read_text(encoding="utf-8"))
    tatoeba_snapshot = json.loads((ROOT / "scripts/build-vocabulary.tatoeba.json").read_text(encoding="utf-8"))
    contextual_examples = {row["word"]: row for row in additions}
    corrected_definitions = {row["word"]: row["correction"] for row in corrections + additions if row.get("correction")}
    sentence_pairs = {row["word"]: row for row in tatoeba_snapshot["sentences"]}
    assert len(contextual_examples) == len(additions), "Duplicate original example headwords"
    assert len(sentence_pairs) == len(tatoeba_snapshot["sentences"]), "Duplicate Tatoeba headwords"

    records = []
    for word in selected:
        if word in originals:
            record = dict(originals[word])
            record["source"] = "7StudySpace 原创教学释义与例句 · CC BY-SA 4.0"
            record["exampleSource"] = "7StudySpace 原创例句"
            if word in phonetics:
                record["source"] += "；音标：中文维基词典"
        else:
            by_pos = defaultdict(list)
            senses = sorted(candidates[word], key=lambda item: item["specialized"])
            for sense in senses:
                if sense["gloss"] not in by_pos[sense["pos"]] and len(by_pos[sense["pos"]]) < 2:
                    by_pos[sense["pos"]].append(sense["gloss"])
            groups = list(by_pos.items())[:3]
            record = {
                "word": word,
                "pos": "; ".join(POS[pos] for pos, _ in groups),
                "meaning": "；".join(f"{POS[pos]} {'；'.join(glosses)}" for pos, glosses in groups),
                "example": "",
                "source": "中文维基词典贡献者 / Kaikki · CC BY-SA 4.0",
            }
        record["id"] = "word-" + word
        record["sourceUrl"] = "https://zh.wiktionary.org/wiki/" + quote(word)
        record["tags"] = ["精选词汇", "学术与阅读" if word in priority else "通用基础"]
        if word in phonetics:
            record["phonetic"] = phonetics[word]
        if word in corrected_definitions:
            record.update(corrected_definitions[word])
            record["source"] = "7StudySpace 原创教学释义修订 · CC BY-SA 4.0"
            if word in phonetics:
                record["source"] += "；音标：中文维基词典"
            record["definitionSource"] = "7StudySpace 原创教学修订"
        if word in contextual_examples:
            original_example = contextual_examples[word]
            record.update({key: original_example[key] for key in ("example", "exampleMeaning")})
            record["exampleSource"] = "7StudySpace 原创例句与译句 · CC BY-SA 4.0"
            record["exampleLicense"] = "CC BY-SA 4.0"
            record["exampleLicenseUrl"] = CC_BY_SA
        elif not record["example"] and word in sentence_pairs:
            pair = sentence_pairs[word]
            record.update({key: pair[key] for key in ("example", "exampleMeaning")})
            record["exampleSource"] = f'Tatoeba · 英文：{pair["englishAuthor"]}（#{pair["englishId"]}，{pair["license"]}）；中文：{pair["chineseAuthor"]}（#{pair["chineseId"]}，{pair["translationLicense"]}）'
            record["exampleSourceUrl"] = f'https://tatoeba.org/en/sentences/show/{pair["englishId"]}'
            record["exampleTranslationSourceUrl"] = f'https://tatoeba.org/en/sentences/show/{pair["chineseId"]}'
            record["exampleLicense"] = pair["license"]
            record["exampleLicenseUrl"] = "https://creativecommons.org/licenses/by/2.0/fr/" if pair["license"] == "CC BY 2.0 FR" else "https://creativecommons.org/publicdomain/zero/1.0/"
            record["exampleTranslationLicense"] = pair["translationLicense"]
            record["exampleTranslationLicenseUrl"] = "https://creativecommons.org/licenses/by/2.0/fr/" if pair["translationLicense"] == "CC BY 2.0 FR" else "https://creativecommons.org/publicdomain/zero/1.0/"
            record["exampleModification"] = "中文繁体字转为简体；英文未改写。"
        elif record["example"]:
            record["exampleLicense"] = "CC BY-SA 4.0"
            record["exampleLicenseUrl"] = CC_BY_SA
        # Remove extraction scaffolding and normalize invisible formatting.
        record["meaning"] = re.sub(r"\s*(?:\*|；)?\s*(?:\[?(?:正体|简体)\]?[:：]).*$", "", record["meaning"])
        record["meaning"] = re.sub(r"[\ufe00-\ufe0f\u200b-\u200f\u202a-\u202e]", "", record["meaning"]).strip()
        records.append(record)

    assert len(records) == args.count
    assert len({r["id"] for r in records}) == len(records)
    assert len({r["word"] for r in records}) == len(records)
    assert all(r["pos"] and re.search(r"[\u4e00-\u9fff]", r["meaning"]) for r in records)
    assert all(not r["example"] or r.get("exampleMeaning") for r in records)
    assert all(not re.search(r"来源\s*[:：]|Source\s*:|OALD|\{\{|\}\}", r["meaning"], re.I) for r in records), "External quotation or template remains"
    stats.update({
        "eligibleUniqueHeadwords": len(words),
        "selectedUniqueHeadwords": len(records),
        "withChineseMeaning": len(records),
        "withPhonetic": sum(bool(r.get("phonetic")) for r in records),
        "withExample": sum(bool(r["example"]) for r in records),
        "exampleCoveragePercent": round(100 * sum(bool(r["example"]) for r in records) / len(records), 2),
        "originalTeachingEntries": len(originals),
        "originalDefinitionCorrections": sum(r["word"] in corrected_definitions for r in records),
        "withOriginalExample": sum(bool(r["example"]) and r.get("exampleSource", "").startswith("7StudySpace") for r in records),
        "withTatoebaExample": sum(bool(r["example"]) and r.get("exampleSource", "").startswith("Tatoeba") for r in records),
        "withoutExample": sum(not r["example"] for r in records),
        "externalDictionaryQuotesIncluded": 0,
        "audioFilesIncluded": 0,
    })

    # Preserve the installed distribution's source-specific attribution and
    # citations rather than confusing its Apache code license with data rights.
    metadata_text = distribution("wordfreq").read_text("METADATA")
    attribution_start = metadata_text.index("## License\n")
    wordfreq_attribution = metadata_text[attribution_start:]
    metadata = {
        "title": "7StudySpace 精选英语词汇",
        "version": "2026-10-04.2",
        "license": "CC BY-SA 4.0",
        "licenseUrl": CC_BY_SA,
        "description": "适合通用英语与学术阅读的词汇基础；未声称覆盖六级或考研英语一完整大纲。",
        "scope": "按开放词频和学习用途筛选的独立词头，合并词性与部分常用义；并非完整词典。",
        "quality": f"全库完成唯一性、中文非空、模板与外部引文痕迹筛查，并抽样复核语义；修订 {stats['originalDefinitionCorrections']} 个错义、词性或过窄常用义。{stats['withOriginalExample']} 组原创英中例句经过逐条撰写检查；Tatoeba 例句按词形与中文语义线索筛选并抽样复核。开放社区资料仍可能有译文或义项差异，尚未完成全部词义与例句逐条专业审校。",
        "sources": [
            {
                "id": "zh-wiktionary-kaikki",
                "name": "中文维基词典贡献者，经 Kaikki / Wiktextract 提取",
                "url": "https://kaikki.org/zhwiktionary/index.html",
                "upstreamUrl": "https://zh.wiktionary.org/",
                "attribution": "中文维基词典贡献者（作者名单见每个 sourceUrl 页面的历史记录）；提取工具与数据整理：Tatu Ylonen / Kaikki / Wiktextract。",
                "license": "CC BY-SA 4.0（选择此许可使用文本，不依赖软件代码许可）",
                "licenseUrl": CC_BY_SA,
                "licenseEvidence": "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content",
                "dumpDate": "2026-10-01",
                "extractionDate": "2026-10-02",
                "retrievedDate": "2026-10-04",
                "downloads": SOURCES,
                "modifications": "只保留英语、小写单词、部分词性和含中文释义的非纯词形条目；去重、转简体、去除特殊用法并合并部分释义。未复制例句、引文、图片或音频。",
            },
            {
                "id": "wordfreq",
                "name": "Robyn Speer — wordfreq 3.1.1",
                "url": "https://github.com/rspeer/wordfreq",
                "license": "数据：CC BY-SA 4.0；代码：Apache-2.0",
                "licenseUrl": CC_BY_SA,
                "use": "仅用于筛选及排列一般英语词头，未提供考试大纲标签；频率是截至约 2021 年的历史语料快照。",
                "attributionAndSourceCitations": wordfreq_attribution,
            },
            {
                "id": "wordnet",
                "name": "Princeton University — WordNet 3.1",
                "url": "https://wordnet.princeton.edu/",
                "license": "WordNet 3.1 许可（允许使用、修改与分发，须保留完整声明）",
                "licenseEvidence": "https://wordnet.princeton.edu/license-and-commercial-use",
                "download": WORDNET,
                "use": "第二层词元与词性校验：词典候选须出现在 WordNet 相应词性中，并在其标注语料中有至少一次使用记录。未复制 WordNet 释义。",
                "fullLicense": wordnet_license,
            },
            {
                "id": "tatoeba",
                "name": "Tatoeba 句子贡献者，经 ManyThings / Charles Kelly 整理及 Tatoeba 官方 API 补充",
                "url": "https://tatoeba.org/",
                "exportUrl": "https://www.manythings.org/anki/",
                "license": "每条例句与译句各按所附许可使用：CC BY 2.0 France 或 CC0 1.0",
                "licenseUrl": "https://creativecommons.org/licenses/by/2.0/fr/",
                "licenseEvidence": "https://tatoeba.org/en/terms_of_use",
                "exportLicenseEvidence": "https://www.manythings.org/anki/",
                "attribution": "每词 exampleSource 保存英文与中文贡献者及句号；exampleSourceUrl、exampleTranslationSourceUrl 分别链接原句。保留作者署名与许可链接；该来源不包括音频授权。",
                "snapshot": {key: value for key, value in tatoeba_snapshot.items() if key != "sentences"},
                "modifications": "匹配完整词头或明确屈折词形，筛选适度长度与一般语境，排除人名、粗俗内容、个人识别信息；中文转简体，英文未改写。例句原许可保持不变。",
                "includedPairs": stats["withTatoebaExample"],
            },
            {
                "id": "7studyspace-original",
                "name": "7StudySpace 原创教学内容",
                "license": "CC BY-SA 4.0",
                "licenseUrl": CC_BY_SA,
                "use": f"{len(originals)} 个原创教学词条，另有 {stats['originalDefinitionCorrections']} 个原创释义修订；合计 {stats['withOriginalExample']} 组原创英文例句及中文译句。音标存在时仍署名中文维基词典。",
                "words": list(originals),
                "additionalExampleWords": [r["word"] for r in records if r["word"] in contextual_examples],
                "correctedDefinitionWords": [r["word"] for r in records if r["word"] in corrected_definitions],
            },
        ],
        "build": {
            "script": "scripts/build-vocabulary.py",
            "reviewableInputs": ["scripts/build-vocabulary.tatoeba.json", "scripts/build-vocabulary.examples.json", "scripts/build-vocabulary.corrections.json"],
            "dependencies": {"wordfreq": "3.1.1", "opencc-python-reimplemented": "0.1.7"},
            "filters": [
                "只接受 3–20 个小写英文字母组成的词头，排除专名和大部分缩略语",
                "词典条目限定名词、动词、形容词、副词、介词；原创教学条目另含 whereas 连词",
                "排除无中文释义、纯词形和替代拼写条目以及带古语、方言、粗俗等标签的义项",
                "以 Princeton WordNet 词性与标注语料记录作第二层筛选，减少表面词频中的人名、缩写、罕见义和孤立词形",
                "保留真实不同词头；相同词头按词性与释义合并，不使用词形变换增加数量",
                "优先原创学术与阅读词，其他按 wordfreq 英语词频从高到低选择",
                "保留最多三个词性、每词性最多两个不同释义；没有例句的条目不生成模板句",
                "Tatoeba 输入快照保留逐句作者、原句编号、英中许可及筛选说明；原创补充与释义修订单独保存，便于复核",
            ],
            "statistics": dict(stats),
        },
        "distributionNotice": "词典释义、原创教学内容及本词库编排以 CC BY-SA 4.0 分享；Tatoeba 例句与译句各保留其标明的原许可（CC BY 2.0 France 或 CC0）。分发时保留本来源清单、逐条作者、原句和许可链接与修改说明。内容许可不自动改变独立应用程序代码的许可。",
    }
    output = ROOT / "public" / "content"
    output.mkdir(parents=True, exist_ok=True)
    (output / "vocabulary.json").write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "vocabulary-sources.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(dict(stats), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
