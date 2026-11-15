# 竞品与专利开放检索

日期：2026-11-15。这是 `docs/plan-film-2026-11.zh-CN.md` 第十二节第 5 步承诺补做的检索：此前的市场调研只读了各家官网，没做开放搜索。

## 范围与局限

- 五路检索（中国平台、中国制作方与初创、海外产品、专利、论文与开源），每路做了一次核查。
- 共用的搜索额度在核查阶段用尽，核查多数只能直读一手页面，没能再做独立搜索。
- **专利没有查全**：Google Patents 多次返回 503，Espacenet、Patentscope、USPTO 返回 403，CNIPA 没有直接查询；2025 年 5 月以后提交的申请大多还未公开。所以本文**不能支持任何“没有相关专利”的说法**，只是一份交给律师的线索清单，不是自由实施意见。
- 没搜到的方向：科大讯飞、百度、商汤、小米；广州、深圳的制作方；清华、北航、港中文；小程序和听电影类应用；微信文章；知网。

## 结论

**1. 原计划那句“未见公开产品把这些做在一起”，作为几项的组合仍然成立，但其中几项单独看并不新。**

| 我们原先当作特色的 | 已经有人做了 |
| --- | --- |
| 人脸按影片分组 + 人工标名字 | AI-Media 的 LEXI AD（商用、云端）：从上传的视频自动把人脸分组，客户在生成稿子之前给每组标名字；默认还从名牌、画面文字、对白取名 |
| 不靠演员表、从对白取名的角色库 | 牛津 StreamCast（2026-10-27，有代码但没有许可证）；更早的 MM-Narrator（2023）已是“名字第一次在对白里被叫到之前，人物保持匿名” |
| 模型只写人物编号、事后映射成名字 | MICap（CVPR 2024）、BAC（2026-10）。占位符本身是已有技术 |
| 角色库 + “名字只在连续台词的第一句前说一次” | 腾讯的在审专利申请 CN119316627A（人脸库、人脸到角色名的对照表，名字从百科按片名取） |
| 给志愿者的制作工具（空隙、字数建议、改稿、配音、混音） | 浙大 EagleMovie / EasyAD（按中国盲文图书馆和上海光影之声的要求做，Word / SRT / ASS 导入导出）；腾讯的流程（志愿者写、视障测评员审、图书馆专家定稿）；优酷的内部系统；YouDescribeX / ADx3、DescribePro、Sema |
| 对读屏友好的中文口述稿工具 | ScriptGrid / ScriptCue（视障开发者，MIT，无 AI） |
| “名字来自片中字幕，生成前把人物表念给视障操作者听” | GitHub 上的“听见 · AI 口述影像”演示（2026-09，人物数据是预设的，云端语音，无许可证） |

**2. 检索日仍未找到的：**

- 用**代码**强制执行的点名规则（揭示时机、把握级别、剧透锁）。别人把规则写在提示词里，或让另一个模型判断。
- 按场景记忆着装（有一篇论文明确把人物外观排除在重复度评分之外，其余都没有）。
- 视障者只靠听来确认名字。
- 人确认的角色库、全程本机、宽松许可、面向用户自己的影片文件、中文读屏——这几样合在一个可安装的开放工具里。
- 专门研究“AI 口述里怎么点名”的视障用户研究。

**3. 差异化应该这样说**（已改进计划第三节和第十一节）：

> 截至 2026-11-15，开放检索找到了不靠演员表的角色库（StreamCast）、带人工标名的人脸分组（LEXI AD）和志愿者编辑器（EagleMovie、YouDescribeX），但没有找到一个系统同时具备：人确认的角色库、由代码强制的点名闸门、着装记忆、中文读屏支持，以及在用户自己的影片文件上全程本机、许可宽松地运行。

**4. 不比速度。** 优酷称两小时影片的识别与提炼从 3 天缩到 2 小时（另一来源说解说版从一个月缩到三四天），腾讯称 30 天缩到 10 天。我们比的是名字不出错、用户自己的文件、开放。

**5. 平台不公开它们怎么给人物点名，这是“没披露”，不是“做不到”。** 平台手里有演员表和人物识别技术（腾讯 2019 年就写过用人脸识别区分剧中人物）。

## 最接近的几家

| 名称 | 是什么 | 和我们的差别 |
| --- | --- | --- |
| AI-Media LEXI AD | 商用云服务；可选的人脸自动分组 + 客户标名；稿件编辑器；交付口述音轨、混音视频、稿子 | 云端；名字何时说、着装、跨集保持均无文档；合成语音；中文输出未确认 |
| 腾讯 CN119316627A（在审） | 人脸库 + 角色名对照表 + “连续台词只在第一句前说名字” | 名字来自百科而不是影片本身；没有人确认；没有着装逻辑 |
| StreamCast（牛津） | 由人脸轨迹、说话人和对白名字流式建角色库，未命名的先留着，事后回填 | 全自动、无人确认；不生成口述；自测点名准确率 72.8%（这正是需要人确认的理由）；代码无许可证，只能引用 |
| EagleMovie / EasyAD（浙大） | 桌面制作工具：字幕 OCR 找空隙、估算字数、大模型起草、改稿、合成、混音 | 人物完全不管；起草用云端大模型；未见公开发行 |
| 腾讯视频、优酷的无障碍剧场 | 内部流水线，人工审核；只做平台片库 | 封闭，不能用于用户自己的文件，不导出稿子或口述包 |
| 听见 · AI 口述影像（演示） | 概念最接近：名字来自字幕，人物页先念给视障操作者 | 人物和场景数据是为一段 3 分钟片子预设的 |
| ScriptGrid（MIT） | ASS / SRT / SUP 与 XLSX 口述稿互转、空隙时间轴模板 | 无 AI、无人物；值得互通 |
| YouDescribeX / ADx3、DescribePro、Sema | 志愿者编辑器：对白时间轴、自动压缩到空隙、录音 | 面向网络视频、云端模型、英文；无角色库 |

## 专利线索（交给律师）

| 专利 | 权利人与状态 | 大致覆盖 | 碰到我们哪一块 |
| --- | --- | --- | --- |
| CN119316627A | 腾讯，2023-07 申请，在审（实质审查中） | 分段描述、识别目标对象、拼成口述稿；说明书含人脸库、角色名对照、名字只说一次 | 角色库、点名（接近） |
| CN116109967B | 浙江大学，2025-08 授权，有效 | 字幕 OCR → 字幕之间的间隔作为旁白区间 → 按前一条字幕语速推荐字数 | 空隙与字数上限（接近；我们用字幕文件而非 OCR、用固定语速表） |
| US12142047B1、US12675998B2、WO2025250925A1 | 3Play Media，美国两件已授权，PCT 已公开 | 逐帧图像描述 → 大模型摘要 → 放入时间段；说明书含静音间隔、估算时长、缩短或加速 | 把口述贴进空隙（接近） |
| US10580457B2、US11238899B1 | 3Play Media，有效 | 带视频和文稿的编辑器，选点、输入描述、合成并保存 | 稿件编辑器（接近） |
| US9191639B2 及同族 | Adobe，有效，预计 2031 年到期 | 按时间码找对白间隔，把描述段对齐到间隔；编辑时更新时长显示是否放得下（只见摘要） | 贴合表（接近） |
| WO2026026819A1、CN121442141A | 北京字跳，在审 | 很宽：视频属性数据 → 描述文本 → 带该音频的新视频 | 整体流程（相邻） |
| CN120512585A | 武汉大学，在审 | 情节要素记忆 + 大模型；字数由音频间隔长度定 | 生成（相邻） |
| CN115695902B | 百视通，2024-09 授权，有效 | 外部口述音轨与影片声音混音，按语音活动调音量 | 压低原声（相邻） |
| CN110519636B | 腾讯，有效（只见摘要） | 图像识别 → 描述文本 → 语音，面向视障观众 | 整体流程（相邻） |
| US11430485B2 | Netflix，有效 | 找无对白段、压低音量、插入合成语音 | 播放（相邻） |
| US10999566B1 | Amazon，有效（只见摘要） | 神经网络把动作和声音变成文字描述 | 生成（相邻） |
| US9596386B2 | Oladas，2017 授权，状态未显示 | 手机上用声学指纹把第二条音频对到影院影片 | 口述包对时（接近） |
| US11295084B2 | IBM，显示“失效”（原因未知） | 为每个角色建带识别特征的模型，识别角色名，输出给视障观众的描述稿 | 角色库（相邻） |
| US11190855B2 | Arris，2026-01 因未缴费失效 | 场景、对白间隔、描述视觉元素、合成 | 无 |

已有的公开文献（可作为现有技术引用）：Everingham 等 2006（从字幕与剧本给电视人物命名，并用衣着匹配）、AutoAD II（2023）、AutoAD-Zero（2024，在人脸上画彩色圈）、Set-of-Mark（2023，给画面编号）、MM-Narrator（2023）、Rescribe（2020，自动把描述贴进间隔）、Netflix 口述风格指南 v2.5（点名规则的出处）。

**建议**：上线前委托一次专业的 CNIPA / incoPat 检索；把上表连同本计划第 5.2–5.5 节交给律师。

## 可以复用或应当引用的

- **评测**：StreamCast 的 MCN 数据集及其指标（Apache-2.0）；Movie101 / Movie101v2（人民大学，CC-BY-4.0）——203 部华语片的口述文本和角色名标注，是现成的华语点名测试参照（不含影片本身）。
- **代码**：AutoAD-Zero、Shot-by-Shot（Apache-2.0）可参考。StreamCast、YouDescribeX 的代码没有许可证，BAC 是非商业许可：只引用，不复制。
- **互通**：导入导出按中国盲文图书馆的稿件样式（时间码、每分钟 240–260 字的语速、【】里的语气提示——样式出自二手描述，待核实）和 ScriptGrid 的 XLSX。
- **做法**：光明影院的“贯穿式描述”——首次出场时讲一个让人记得住、后面剧情用得上的特征。确认角色时允许人指定一个衣着之外的持久特征用于介绍。

## 要问你的一件事

GitHub 上的“听见 · AI 口述影像”（账号 dada-maker-0528，2026-09-21 创建）是不是你自己早先做的演示？如果是，它就不算竞品；如果不是，它是概念上离我们最近的一个。

---

以下是五路检索的原始报告和核查（英文，未改动），供查证来源。

## Appendix A — China: video platforms

### Verdict
Nothing found breaks the claimed difference, but two parts of the sentence are weaker than stated. No Chinese platform publicly says how its accessible-film pipeline identifies or names characters: no mention of face recognition, cast lists, name confirmation or outfit-aware introduction in any source opened. That is absence of disclosure, not proof of absence, since platforms hold cast metadata and person-recognition technology. The "volunteer studio with blind reviewer" already exists as a process at Tencent Video with 中国盲文图书馆, and as an internal workflow tool at Youku (Echovision). A Chinese desktop authoring tool (EasyAD) is in use at 中国盲文图书馆. All are closed, catalogue-only and not installable; none works on a user's own files or exports scripts or packages.

### What exists
- **优酷无障碍剧场 + "Echovision"**: the name is confirmed, but only by one press report (华夏时报, 2026-10-30); no official technical document was found [unverified beyond press].
  - Role: in-house workflow system that takes the film script and algorithm output, then supports editing, dubbing, review, compositing and delivery.
  - Outputs: 解说版, and 字幕助听版 with speaking-character labels for deaf viewers (method undisclosed).
  - Review: "相关算法结果均需经过人工审核和修订".
  - Time: a 2-hour film went from at least 3 days to about 2 hours for "画面内容识别、人物对话提炼和字幕放大"; this is not clearly the full narrated version.
  - Scale and status: 9,600+ titles, free, internal.
  - Source: https://cj.sina.com.cn/articles/view/1838672663/6d97eb1702001rb2o
- **Youku voices**: 胡歌 AI voice pack (2024-05-19, "自研的音色训练大模型", first 10+ films), 易小星 AI version and an official version, with audio-track switching. https://cn.chinadaily.com.cn/a/202405/19/WS6649f6f8a3109f7860dde69b.html
- **Youku access**: 中国残联 identity verification for blind users since 2022-12-03 and deaf users since 2025-03. https://www.bjnews.com.cn/detail/1670036236169790.html
- **腾讯视频无障碍剧场 × 中国盲文图书馆** (launched May 2024):
  - AI: "AI素材生产系统" on a "自研多模态长视频理解大模型"; drafts description for dialogue gaps over 5 seconds with a suggested character count, then AI voice and automatic mixing after human edits. https://lmtw.com/mzw/content/detail/id/234360 (2024-06-05) [secondary]
  - Time: viewings fell from 13–15 to 5; production from about 30 days to about 10. Tencent's own page confirms first drafts "based on plot and dialogue intervals" and a 100-volunteer programme for 150 titles. https://www.tencent.com/en-us/articles/2202031.html (2025-02-10)
  - Cinema-release workflow: volunteers write, 视障测评员 review, library experts finalise, 至爱影院 records human narration. https://paper.people.com.cn/rmrbwap/html/2024-08/09/nw.D110000renmrb_20240809_6-14.htm
  - Access: disability identity verification in the app. http://www.news.cn/politics/20240520/8971cd6b694e485c8b4820d82a502d23/c.html (2024-05-20)
  - Characters: nothing disclosed.
- **EasyAD** (浙江大学 + 中国盲文图书馆, W4A 2024; PDF read directly):
  - PyQt5 desktop tool: subtitle OCR finds speech gaps, Video-Chat plus ChatGPT drafts, the author edits per gap, PaddleSpeech voices, FFmpeg mixes.
  - Its "character recognition" means OCR of subtitles, not people.
  - Operational at the library for three months; studied with 6 authors, no blind viewers; about 50% time saved.
  - Uses ChatGPT, so not on-device; no code release found.
  - Source: https://zhoushengisnoob.github.io/papers/W4A.pdf
- **Same group, research only**:
  - MMAD (LREC-COLING 2024, "actor-tracking-aware story linking"). https://daria8976.github.io/mmad-page
  - FocusedAD (arXiv, 2025-04-16): character perception module with an automatically built character query bank, no human confirmation, code "will be released". https://arxiv.org/abs/2504.12157
- **爱奇艺**: "光明影院" playlist of 13 human-made "无障碍解说版" films (updated 2025-11-25); no AI pipeline found. https://www.iqiyi.com/playlist7442996088736502.html
- **西瓜视频/抖音/今日头条 无障碍影院** (2021-06): employee volunteers write and voice; 80 films by end of 2021. https://bytedance.com/zh/corporate [search snippet only, page not opened]
- **Person-recognition patents not tied to audio description**: Tencent CN117523625A 视频人物识别 [secondary, 金融界 2024-02-07]; CN109034040B 基于演员表的人物识别 (applicant not verified, page returned 503).

### Searched and found nothing
- 哔哩哔哩 blind-viewer description zone ("B站 无障碍电影 视障 专区 口述影像"): only a 2021 sign-language and captioned esports room.
- 芒果TV ("芒果TV 无障碍专区 视障 AI 口述"), 咪咕 ("咪咕视频 无障碍 视障 解说"), 央视频 ("央视频 无障碍 视障 电影 解说 总台"): nothing.
- Any platform statement of face recognition, cast-list matching or human name confirmation in audio description ("优酷 无障碍剧场 AI 口述 角色识别", "腾讯视频 无障碍剧场 AI 口述影像 人物识别", "AI 无障碍电影 人脸识别 角色名"): nothing.
- Patents by 优酷, 阿里, 腾讯, 爱奇艺 or 字节 on 无障碍旁白 or 口述影像 generation with face clustering or character names: nothing. This was general web search only; CNIPA and Google Patents were not queried directly.
- Blind-user complaints about AI narration misnaming characters; Echovision official documentation; the name of Tencent's volunteer tool; Tencent 2026 updates; script or package export from any platform: nothing.

### What the plan should change or say differently
- Scope the sentence to "no public, installable product for a user's own film files", and say platform pipelines exist but are closed with character handling undisclosed.
- Do not imply platforms cannot name characters; they own cast metadata.
- Drop any novelty claim for the volunteer plus blind-reviewer workflow as such. Cite the Tencent and 中国盲文图书馆 practice as precedent; the difference is an open tool that packages it.
- Name EasyAD as the nearest Chinese precedent, and differentiate on people identification, on-device processing, open licence and blind review.
- Use the platform figures as benchmarks and avoid speed claims: Youku 3 days to 2 hours, Tencent 30 to 10 days.
- Note that platforms gate access by 残联 verification for copyright reasons, so shareable packages must carry description only, never film content.
- Mark the patent absence as provisional until a CNIPA search is done.

### Fact-check

- **1. Youku "Echovision": one press source; character method undisclosed; 3 days→2 h** → confirmed, incomplete → 华夏时报 re-read: no character method. A second source (《中国残疾人》杂志 via Sohu, 2026-11-13; no "Echovision") says the narration generator is fed "剧情推进、人物关系等上下文信息" plus human scripts as style reference; the narrated version went from one month to 3–4 days, so use that benchmark. https://www.sohu.com/a/1101292337_121106822 [secondary]
- **2. "No platform mentions face recognition"; Tencent characters undisclosed** → wrong as worded; confirmed for the 2024 pipeline → Tencent's 2019 Red Dot entry for a blind-user Tencent Video app states "facial recognition to identify different characters in TV shows" (voice differentiation, not narration). https://www.red-dot.org/project/tencent-video-41208. The lmtw and tencent.com pages contain no 人物/角色/人脸.
- **3. EasyAD: "character recognition" = subtitle OCR; 6 authors; no code** → confirmed [secondary review; PDF text not extractable here] → PaddleOCR; 32 h→16.3 h overall, but authoring only 20→15 h; GitHub search: 0 repos; ChatGPT use not re-verified. https://a11y-paradise.onrender.com/reviews/69b0287cc08ef8452bdf9324
- **4. FocusedAD: automatic query bank; code "will be released"** → outdated → the bank comes from IMDb top 5–8 cast names and portraits (needs a cast list; English films), with no human check. https://arxiv.org/html/2504.12157v3. The announced repo github.com/Thorin215/FocusedAD returns 404; an unlicensed copy with code and query bank exists: https://github.com/whuhxb/FocusedAD
- **5. No platform patents on AD with character naming; CN117523625A; CN109034040B** → unverifiable → Google Patents returned 503 for both records on repeated tries; two keyword web searches found no Chinese hit; patent databases were not queried (search budget ran out after seven searches). Still provisional.

**Missed:** (found through direct fetches, since no further searches were possible)
- Movie101/Movie101v2 (人民大学, ACL 2023/2025): 203 films from 西瓜视频无障碍影院; cast lists from Xigua metadata, manually corrected; narrations aligned to cast names; portraits as model input. https://arxiv.org/html/2404.13370v2
- StoryTeller (ByteDance Seed, SJTU, PKU): names speakers from a cast list of photos and names; Apache-2.0 code, weights "coming soon". https://github.com/hyc2026/StoryTeller

**Net effect:** The "closed, catalogue-only, not installable" finding stands. But "nobody mentions face recognition or cast lists" is too strong: Tencent (2019), ByteDance research and Xigua-derived datasets all use cast-list naming, so the plan's difference should rest on human name confirmation, own-file use and openness, not on character identification itself.

## Appendix B — China: producers, research groups and open source

### Verdict
The sentence survives only as a five-way conjunction; three of its parts are individually weakened and it should be narrowed. (a) AI-draft + human-edit + script-export + blind-tester workflows already run in China (浙大 EagleMovie at 中国盲文图书馆, Tencent, Youku), though none is public, open or on-device. (b) MIT-licensed, screen-reader-friendly Chinese AD tools exist (ScriptGrid/ScriptCue, by a blind developer), without AI or characters. (c) A Sept-2026 contest demo, 听见·AI口述影像, already shows "names from the film's own subtitles + a character page the blind operator hears before generation", but on preset data with cloud TTS. Nothing found has a computed, human-confirmed per-film character bank, an outfit-aware name gate, or on-device processing; no platform says publicly how it names characters. Caveat: the shared web-search budget ran out after 25 queries, so part of the brief is unsearched (listed below).

### What exists
- **EagleMovie 无障碍电影制作工具 V2.0 / EasyAD (浙江大学 卜佳俊/王炜组)** — authoring tool: OCR/ASR gap detection, estimated narration length, multimodal-LLM draft (VideoChat + ChatGPT, cloud), TTS, mixing; narration import/export in Word/SRT/ASS. Built to requirements of 中国盲文图书馆 and 上海光影之声; "currently operational at the China Braille Library"; 6 AD authors, time 32h→16.3h. Characters: none in the tool. Distribution and licence [unverified]. Slides 2024-05-29: https://w3.org/2024/01/webevolve-series-events/media/slides/wang-wei.pdf
- **MMAD (COLING 2024) / FocusedAD (arXiv 2025-04), same ZJU group** — research: 角色识别模块 feeding "活跃角色信息"; FocusedAD has an "automated pipeline for building character query banks". No human confirmation, no introduction/outfit rule found. https://aclanthology.org/2024.lrec-main.998 · https://arxiv.org/abs/2504.12157
- **Movie101 / v2 (人民大学, ACL 2023/2025)** — 101 films from 西瓜视频 barrier-free channel; requires role names in narration, from supplied role metadata. Dataset, CC-BY-4.0, no tool. https://github.com/yuezih/Movie101
- **腾讯视频 无障碍剧场 (2024-05-16)** — in-house long-video model drafts text for dialogue gaps over 5 s with a suggested character count; staff/volunteers polish; AI voice and mix; 30→10 days; 100 volunteers for 150 titles; 视障测评员 and 盲文图书馆 experts review; recording by 上海 至爱影院. Character naming: not described. Internal. https://lmtw.com/mzw/content/detail/id/234360 (2024-06-05) · https://paper.people.com.cn/rmrb/html/2024-08/09/nw.D110000renmrb_20240809_6-14.htm · https://www.tencent.com/zh-cn/articles/2202031.html (2025-02-10)
- **优酷 无障碍剧场 / "Echovision"** — AI draft from video + subtitles + plot and 人物关系 context; staff review, listen, edit, confirm; cloned 胡歌 voice; 2-hour film in ~2 h vs 3 days; 9,600+ titles. Staff say AI output is flat "客观描述" needing human rewriting. Character naming method not described; system name from one press piece [unverified]. Internal. https://cj.sina.com.cn/articles/view/1838672663/6d97eb1702001rb2o (2026-10-30) · https://www.sohu.com/a/1101292337_121106822 (2026-11-13)
- **听见 · AI 口述影像 (GitHub dada-maker-0528, contest demo, 2026-09-23)** — closest in concept: "人物称呼来自片中字幕或稳定外貌描述"; a 人物页 reads each character aloud before generation; keyboard and 读屏优先 modes for blind operators; scene-by-scene confirm. But character and scene data are preset for one 3-minute clip, TTS is cloud 豆包, no licence file. https://github.com/dada-maker-0528/tingjian-audio-description
- **阿宾 (blind creator, 昆明)** — built a workflow in Tencent's WorkBuddy agent that analyses a film and drafts narration; "大概12部". Names, licence, distribution not stated [secondary: 新京报 commentary]. https://finance.sina.com.cn/tech/roll/2026-10-23/doc-iniweuqq8203367.shtml
- **ScriptGrid / ScriptCue (yunshenwuji, blind developer; MIT; pushed 2026-11)** — ScriptGrid: ASS/SRT/SUP↔XLSX script conversion and gap-timeline templates from dialogue subtitles, screen-reader friendly. ScriptCue: synchronised start for several live describers. No AI, no characters. https://github.com/yunshenwuji/ScriptGrid
- **audio-description-workstation; audio-description-writer (GitHub, 2026-10/11)** — script writing/review tools, the second for blind writers by listening and speaking; both self-described as unverified archives, no licence.
- **Audio-Description-Film-Agent (WuliSren, MIT, 2026-08)** — real-time prototype (gap timing → VLM → TTS; 千问/Anthropic/offline heuristic). README has no character handling. https://github.com/WuliSren/Audio-Description-Film-Agent
- **光明影院 (中传)** — volunteers; no AI tool found. 付海钲 (2023): "和大厂合作研究如何更简便地做口述影像"; teaches describing a memorable trait at first appearance, including traits the plot needs later ("贯穿式描述"). https://news.qq.com/rain/a/20230717A0824N00

### Searched and found nothing
- 光明影院 AI tooling (2 queries, one extended): nothing beyond the 2023 remark.
- 心目影院/红丹丹 + AI: nothing. 至爱影院 own AI: nothing (human recording only).
- 华为视频; 西瓜/抖音 (2021 human-made channel only); 爱奇艺/咪咕/芒果: nothing on AI description.
- 香港盲人輔導會 + AI 口述影像: nothing. 台灣口述影像發展協會 and 香港口述影像協會 home pages (fetched): no AI or software.
- Chinese patents on character-named 口述影像 (3 queries, one extended): none surfaced; no patent database was queried.
- Blind users on Zhihu/Bilibili about AI-made films and character names (1 query): nothing.
- Gitee (1 query): only general 影视解说 tools (NarratoAI forks).
- **Not searched (budget exhausted):** 科大讯飞, 百度, 商汤, 小米; 广州/深圳 producers; 清华/北航/港中文; mini-programs and listening apps; WeChat articles; further GitHub queries (API rate-limited after 9).

### What the plan should change or say differently
1. Replace the sentence with: "Among the systems found (list them), none computes a per-film character bank that a person confirms, none gates name versus outfit, and none runs fully on the user's machine under a permissive licence." Drop "volunteer studio", "blind review", "fit meter" and "Chinese screen-reader support" as differentiators; all exist separately.
2. Name 听见 as nearest concept and EagleMovie as nearest workflow, and say what SceneVoice adds to each. Confirm 听见 is not the planner's own earlier demo.
3. State the search limits: patents and the unsearched vendors remain open.
4. Interoperate: import/export SRT/ASS/Word/XLSX in 盲文图书馆 script form (EagleMovie's sample has time codes, a 240–260 字/分钟 pace, 【】 delivery cues) and ScriptGrid's XLSX.
5. That sample opens with 故事梗概 and 主要演职人员 ("冷锋由吴京饰演"); decide whether a human-entered opening cast block is allowed alongside "names only from the film".
6. Let the confirmer mark a persistent trait other than outfit for the introduction (付海钲's guidance).
7. Do not compete on speed (Youku claims 2 hours per film); compete on name correctness, local files and openness.

### Fact-check

**Search status:** WebSearch was refused on first call (shared 200-search budget used up). Zero open searches ran; everything below is direct fetches of primary pages. The two "own searches" and any patent query could not be run.

1. **听见 demo** (names from subtitles + 人物页; preset data; cloud 豆包 TTS; no licence) → **confirmed**. README: "画面分析、角色信息…为预设流程". API: created 2026-09-21, pushed 2026-09-23, licence null, 0 stars. https://github.com/dada-maker-0528/tingjian-audio-description
2. **EagleMovie "currently operational at 中国盲文图书馆; 6 AD authors; 32h→16.3h"** → **unverifiable from the cited source**. Slide text says only: built to 盲文图书馆/光影之声 requirements, "6位志愿者", "耗时减少了50%". No deployment sentence, hour figures, 240–260 字/分钟 or "冷锋由吴京饰演" in the extractable text (could be in images); the W3C report has none. Probably from the Web4All 2024 paper, not located. Word/SRT/ASS and no character feature: confirmed. https://www.w3.org/2024/01/webevolve-series-events/media/en.report.html
3. **MMAD / FocusedAD character modules, no human confirmation** → **confirmed, with corrections**. Neither computes names from the film: MMAD takes "an actor identity matching table" (photo + role name); FocusedAD seeds its bank from IMDb top 5–8 cast portraits, evaluated on English sets only. Its code URL github.com/Thorin215/FocusedAD returns 404. https://arxiv.org/html/2504.12157v3 · https://aclanthology.org/2024.lrec-main.998.pdf
4. **Youku "2-hour film in ~2 h vs 3 days", "Echovision"** → **single-source and contradicted**. 华夏时报 says both; the 中国残疾人杂志社 piece says "一个月…缩短到三四天" and never names Echovision. 9,600+ titles and no naming method: confirmed. Tencent details confirmed across its three sources; none describes naming. https://www.sohu.com/a/1101292337_121106822
5. **ScriptGrid / ScriptCue: MIT, no AI, no characters** → **confirmed, nuance**. Bio says "视障者" (not 盲人); ScriptGrid runs local OCR (EasyOCR + ONNX), so "no generative AI". https://github.com/yunshenwuji

**Patents "none surfaced"** → **unverifiable**; no patent database queried in either round.

**Missed:**
- StoryTeller (ByteDance Seed): global audio-visual character identification on 187 Movie101 films; cast list with photos and names is an input; unlisted characters get a descriptive label; Apache-2.0 code, weights "Coming soon". https://github.com/hyc2026/StoryTeller · https://arxiv.org/abs/2411.07076
- Uni-AD (ant-research repo, CVPR'25): character-refinement module fed by AutoAD character predictions; LLaMA licence. https://github.com/ant-research/UniAD
- Movie101 site: metadata for 203 films includes "character names, and actor portraits", a ready naming test set. https://movie101-dataset.github.io

**Net effect:** The core verdict holds and tightens: every character-aware system checked takes a supplied cast list, and none confirms names with a person. Mark EagleMovie's deployment and hour figures and Youku's "2 hours" as unverified or single-source; patents and all open-search gaps remain untested.

## Appendix C — Products outside China

### Verdict
The five-way combination was still not found in any one product, but the plan's sentence is too strong and one pillar is weakened. AI-Media's LEXI AD (commercial, cloud) ships an optional face-recognition step that auto-groups faces from the uploaded video and lets the customer label names before the script is generated. By default it also takes names from name tags, on-screen text and dialogue. So "faces clustered per film + names confirmed by a person" and "names from dialogue or text" are not unique. Research has used per-film character banks since 2023. Nothing found documents a name-reveal gate, outfit memory, a blind-reviewer role, per-cue volunteer recording, Chinese screen-reader support, or fully on-device permissive processing.

### What exists
- **AI-Media LEXI AD** — "AI-Powered Face Recognition: option to auto-group faces from your video file, allowing you to quickly label names" (one-pager, July 2026: https://landing.ai-media.tv/hubfs/LEXI%20AD_One%20Pager_EN_2026JULY_DIGITAL.pdf).
  - The help-centre article (created 2026-05-01, updated 2026-07-08) confirms the default name sources and that labelling happens before script generation and lengthens turnaround: https://customersupport.ai-media.tv/hc/en-us/articles/48812758603924-Does-LEXI-AD-offer-facial-recognition (read via the help-centre API; the page itself returns 403).
  - The product page lists a script editor, Basic / Customer-Assisted / Professional-Assisted workflows, and delivery of AD track, mixed video and scripts via API/S3/FTP: https://www.ai-media.tv/our-products/lexi-ai-powered-captioning-tool-kit/lexi-ad/
  - Voices are synthetic; price is on request. Languages are "40+" (one-pager) or "over 90" (help centre); Chinese AD output is not confirmed.
  - Not documented: whether labels persist across episodes, name timing, outfit handling. Launched at IBC, 2025-09-13: https://www.ibc.org/artificial-intelligence/news/ai-media-debuts-lexi-voice-and-lexi-ad/22385
- **VIDIO** — names are typed in manually and the descriptions rewritten with them; no face recognition. Line editor; exports MP4, MP3, WebVTT, TXT; 0.11 credits per second. https://www.vidio.ai/tools/ai-audio-description (© 2026)
- **ViddyScribe** — no naming feature; editor with custom pronunciation; exports VTT/SRT/JSON/EDL, WAV, MP4; API. https://www.viddyscribe.com/ (© 2026)
- **Visonic AI** — "analyses the full title to follow characters, locations, plot" (model only); optional human review; script files; from $1/min; 17 languages, no Chinese. https://visonicai.com/products/audio-description/
- **Verbit AI Audio Description** (released 2026-01-15) — no character feature; optional expert review; English. https://verbit.ai/ai-audio-description/
- **3Play Media** — AI AD with a self-edit editor (https://3playmedia.com/services/features/audio-description-editor). Patent US12142047B1 covers automated plus hybrid human AD; no character recognition in the excerpts seen (https://patents.google.com/patent/US12142047). Kaltura's EAD editor reportedly resells 3Play [unverified].
- **Audible Sight, Binclusive Content Studio (May 2026), Accedo AD Generator ($29/month), Neodata (IBC 2026)** — model-only description; no naming features documented. https://www.audiblesight.ai/ · https://studio.binclusive.io/ · https://ad.compose.accedo.tv/ · https://neodatagroup.ai/
- **microsoft/ai-audio-descriptions** — MIT; editable WebVTT draft, local review Studio, rendered MP4; needs Azure; no character handling. https://github.com/microsoft/ai-audio-descriptions
- **YouDescribe / ADx3** (GenAD, RefineAD, AdaptAD; 2026-02) and **DescribePro** (fork and version descriptions; 2025-08) — research volunteer workflows with human editing; no character bank. https://arxiv.org/abs/2602.02684 · https://arxiv.org/abs/2508.01092
- **Research character banks**
  - AutoAD II: cast-list names plus face features (ICCV 2023): https://openaccess.thecvf.com/content/ICCV2023/html/Han_AutoAD_II_The_Sequel_-_Who_When_and_What_in_ICCV_2023_paper.html
  - LLM-AD (Microsoft): IMDb cast plus tracklet face recognition: https://arxiv.org/abs/2405.00983
  - FocusedAD: automated character query bank (2025): https://arxiv.org/abs/2504.12157
  - EARS4SEE (CVIU, May 2026): https://www.sciencedirect.com/science/article/pii/S1077314226001396
  - None has a human confirmation step.
- **Amazon patent US 10,999,566** (granted 2021-05-04) — replaces pronouns with character names via a knowledge graph of voices and faces [search snippet only; page 403]. https://patents.justia.com/patent/10999566
- **Prime Video** — AI finds dialogue gaps for human script teams: https://www.aboutamazon.com/news/entertainment/artificial-intelligence-prime-video-streaming. Netflix "Dynamic Audio Description" test [unverified; ezud.com only].
- **Google Guided Vision** (2026-10-01) — live camera description in Gemini Live, not film AD. https://support.google.com/accessibility/android/answer/18365638
- **PiccyBot, FYEO, an AppleVis developer tool (2026-10-16)** — on-demand, model-only; a user asks for by-name character recognition. https://applevis.com/comment/218630
- **RNIB / Surrey / BBC study** (2025-09-01) — "Misidentified characters … were common"; recommends hybrid workflows. https://www.rnib.org.uk/professionals/research-and-data/reports-and-insight/exploring-ai-generated-audio-description-can-emerging-technologies-help-expand-access-to-broadcast-media/

### Searched and found nothing
- "YouTube automatic audio description Gemini 2026" and "auto-generated audio description" YouTube: no YouTube feature.
- "Prime Video AI-assisted audio description 2026 characters": no 2026 announcement.
- Apple AI audio description 2026: only generated subtitles.
- Disney, Deluxe, Pixelogic, Descriptive Video Works, Dicapta, Earcatch, Spectrum Access, Be My Eyes, Envision, Seeing AI with AI AD or character identification: nothing.
- ElevenLabs, WellSaid, Descript audio-description products: none (Descript has only a feature request).
- "name reveal" / "until named" / outfit consistency in AI AD tools: nothing.
- Patents combining audio description, cast and face recognition with human confirmation: nothing beyond the Amazon and 3Play ones.
- Chinese queries (口述影像 AI 人脸识别 角色名 演员表; 开源 角色库 人脸聚类 人工确认 本地运行): nothing matching.

### What the plan should change or say differently
- Replace the sentence with: "As of 2026-11-15, open search found no product combining all of: on-device permissive processing, a human-confirmed per-film character bank, a name gate with outfit-aware introduction, a volunteer and blind-review studio, and Chinese screen-reader support. Nearest: AI-Media LEXI AD (cloud; auto-grouped faces labelled by the customer before generation)."
- Stop presenting face clustering plus human naming, or names from dialogue and text, as novel. Cite LEXI AD and AutoAD II / LLM-AD as prior art.
- Move the claimed difference to the name gate, outfit memory, blind reviewer, per-cue human recording, shareable packages, and local/open processing.
- State the limits: LEXI AD's labelling interface was not inspected (documents only), and its cross-episode persistence, name timing and Chinese output are unknown.
- Add a comparison against LEXI AD's default naming, and note the RNIB finding as motivation for confirmation.

### Fact-check

**Claims**

1. LEXI AD ships optional face auto-grouping with customer name-labelling before script generation → **confirmed**. One-pager read directly (PDF dated 2026-07-01), wording as quoted: https://landing.ai-media.tv/hubfs/LEXI%20AD_One%20Pager_EN_2026JULY_DIGITAL.pdf. Product page adds "Smart Face Detection – Automatically identify and label faces". Help-centre wording seen only in the search index (page 403). Announced 2025-09-09, not 09-13: https://www.advanced-television.com/2025/09/09/ai-media-extends-lexi-suite-with-lexi-voice-lexi-direct-api-lexi-ad/
2. Amazon US 10,999,566 (pronouns → character names, knowledge graph, granted 2021-05-04) → **unverifiable**. Google Patents 503 (six tries), Justia 403, USPTO 403. Search index confirms only title ("Automated generation and presentation of textual descriptions of video content") and assignee Amazon Technologies. Keep [unverified]: https://patents.google.com/patent/US10999566
3. 3Play US12142047B1, no character recognition → **confirmed, incomplete**. Filed 2024-05-31, granted 2024-11-12, active; claims cover per-frame image-to-text plus summary placement, no character terms. The description does handle names: metadata with "names of entities depicted in the source media"; summaries use "names of characters rather than names of actors". No face recognition. https://patents.google.com/patent/US12142047B1/en
4. Research character banks have no human confirmation step → **not refuted**. Also true of AutoAD-Zero, NarrAD and MovieTeller as far as read; the dedicated counter-example search was not run (see limit).
5. VIDIO (names typed in, no face recognition), Verbit and Visonic (no naming feature, no Chinese) → **confirmed**. Verbit's blog is dated 2026-01-14, not 01-15. https://www.vidio.ai/tools/ai-audio-description · https://verbit.ai/ai-audio-description/ · https://visonicai.com/products/audio-description/

**Missed:**
- 3Play continuation US 12,675,998 B2 (application 18/942,978, filed 2024-11-11) and WO2025250925A1; grant date not read (same URL as claim 3).
- Tencent Video 无障碍剧场 (launched May 2024 with China Braille Library, 600+ titles planned): volunteers write scripts, visually impaired testers suggest revisions — https://cn.chinadaily.com.cn/a/202407/29/WS66a762f1a3107cd55d26d172.html. AI first draft, volunteer revision, AI voicing, 30 → 10 days [unverified; secondary]: https://daoinsights.com/news/how-can-blind-people-watch-a-movie-tencent-thinks-out-a-way. No character recognition mentioned.
- YouDescribe "Prompted" (AI draft, volunteer edits) and "Freestyle" interfaces live for all volunteers 2026-05-21: https://www.ski.org/?p=17016
- MovieTeller (2026-02), face-recognition identity grounding: https://arxiv.org/abs/2602.23228

**Limit:** the shared web-search budget ran out after 11 searches; three planned searches (human-in-the-loop character labelling, Tencent technical detail, cast-list upload products) did not run.

**Net effect:** The verdict stands — LEXI AD is the nearest prior art and nothing found has the full combination. Fix the 3Play entry, keep Amazon unverified, and soften "nothing found" for Chinese services and blind-reviewer roles, since Tencent's service documents visually impaired testers.

## Appendix D — Patents

### Verdict
Nothing found breaks the claimed combination, but the search was only partly completed and several components are individually patented or pending. The closest record is Tencent's pending CN119316627A: a face library, a face-to-character-name table and a rule that the name is spoken only before the first of consecutive lines. It differs from the plan in taking names from an online encyclopedia, with no human confirmation and no outfit logic. No record was found for a name gate, clothing-state tracking, human-confirmed cast, or numbered boxes for a vision-language model. Gap detection, duration fitting, the editing interface and fingerprint sync all have live patents. This is a landscape for a lawyer, not a freedom-to-operate opinion. Claims were paraphrased from Google Patents or PatSnap pages, several from abstracts only; legal status is as those pages show. All sources accessed 2026-11-15.

### What exists
**China / PCT**
- **CN119316627A**, Tencent, 一种视频处理方法及相关装置. Filed 2023-07-12, published 2025-01-14, pending. Claim 1: segment the video, describe each segment, recognise a target object, attach its speech, splice into an AD script. Description: face library, names fetched from 百科 by title, name-once rule. **Close** on themes 1–2. https://patents.google.com/patent/CN119316627A/zh
- **CN120512585A**, Wuhan University, 故事情节驱动的口述影像生成方法. Filed 2025-04-29, published 2025-08-19, pending. Plot-element memory plus LLM; word count set by audio-gap length; character identification by unspecified "existing" techniques. **Adjacent.** https://patents.google.com/patent/CN120512585A/zh
- **WO2026026819A1**, 北京字跳 (ByteDance). Priority 2024-07-30, published 2026-02-05, pending. Claim 1 is very broad: video attribute data → descriptive text → new video with that audio. Description covers silent sub-segments and splitting over-long audio. **Adjacent.** https://patents.google.com/patent/WO2026026819A1/zh
- **WO2024146338A1**, 字跳. Priority 2023-01-06, published 2024-07-11. Per-clip commentary speech for "barrier-free video". **Adjacent** (abstract only). https://eureka.patsnap.com/patent-WO2024146338A1
- **CN116109967B**, Zhejiang University, 电影旁白区间检测. Filed 2022-12-21, granted 2025-08-22, active. OCR of burned-in subtitles; gaps between subtitles become narration intervals; recommended character count from the preceding subtitle's speaking rate. **Close** on theme 3. https://patents.google.com/patent/CN116109967A/zh
- **CN115695902B**, BesTV. Filed 2022-11-07, granted 2024-09-10, active. Mixes an external AD track with film audio, adjusting volume by voice-activity detection. **Adjacent** (playback). https://patents.google.com/patent/CN115695902A/zh
- **CN108882033A**, 上海影谱, published 2018-11-23, status not shown. Face-recognition candidates filtered by names recognised from the video's speech; not AD. **Adjacent** to names from dialogue (abstract only). https://eureka.patsnap.com/patent-CN108882033A
- CN119723551A (Zhejiang University, subtitle extraction for accessible film, published 2025-03-28): listed, not opened.

**US / EP**
- **US11295084B2**, IBM. Filed 2019-09-16, granted 2022-04-05; PatSnap shows "Inactive", no reason given. Builds a role model with identifying features per role, identifies the role name, outputs a description script for visually disabled viewers. **Adjacent** (abstract only). https://eureka.patsnap.com/patent-US11295084B2
- **US12142047B1** (filed 2024-05-31, granted 2024-11-12, active) and **US12675998B2** (filed 2024-11-11, published 2026-07-07), 3Play Media. Frame captions → LLM summary → placement period. Description: silence gaps, estimated spoken duration, shorten or speed up. No faces. **Close** on theme 3. https://patents.google.com/patent/US12142047B1/en
- **US10580457B2 / US11238899B1**, 3Play, active. Editor showing video with transcript; user picks a point, types description, system synthesises and stores it. **Close** to the script editor. https://ipiq.io/patents/1106382
- **US9191639B2**, Adobe (family US8447604, US8825488, US8825489, US9066049). Priority 2010-04-12, active, estimated expiry 2031-10-25. Dialogue gaps from timecodes; description segments aligned to gaps. A search snippet says duration updates while editing to show fit; claims not read. **Close** to the fit meter. https://eureka.patsnap.com/patent-US9191639B2
- **US11190855B2**, Arris. Granted 2021-11-30; Google Patents shows lapsed for unpaid fees 2026-01-05. Scenes, dialogue gaps, describe a visual element, TTS. **Adjacent.** https://patents.google.com/patent/US11190855B2/en
- **US10999566B1**, Amazon. Filed 2019-09-06, active. Neural nets turn action plus sound into a text description. **Adjacent** (abstract only). https://eureka.patsnap.com/patent-US10999566B1
- **US11430485B2**, Netflix. Priority 2019-11-19, active. Finds no-dialogue sections, lowers volume, inserts synthetic voice. **Adjacent.** https://eureka.patsnap.com/patent-US11430485B2
- **US9596386B2**, Oladas. Priority 2012-07-24, granted 2017-03-14, status not shown. Acoustic-fingerprint sync of a second audio file on a phone to a cinema film. **Close** on theme 4 (abstract only). https://eureka.patsnap.com/patent-US9596386B2
- **Unrelated:** US12530401B2 / EP4742059A2 (Sony Interactive, scene and action captions); US12548589B1 (CNTXT, AD in a cloned voice, granted 2026-02-10); US9774911B1 (Adeia, rating AD tracks); US20230269442 (AD quality indicator).
- Seen as search hits only, not opened: US9596502, US9516373, US9578072 / WO2013103584A1, US7907211, US8817183 (second-screen fingerprint sync).

### Searched and found nothing
- Google Patents full-text queries that ran: "无障碍电影" (11 hits), "口述影像" (9), "无障碍视频"+解说 (3) — relevant ones are listed above. "audio description"+"character bank": 0. "旁白"+"角色库"+视障: 0. "无障碍"+"旁白"+"视障"+对白+间隙: 0. 视障+解说+人脸聚类+角色名: 3, none relevant.
- Web searches in Chinese and English found no patent on: when a name may be spoken with outfit tracking; Set-of-Mark or numbered boxes (only the 2023 Microsoft paper, arXiv 2310.11441); fingerprint sync specifically for AD; anything held by Greta & Starks, MovieReading, Earcatch, Actiview or myLINGO by name.
- No AD-with-characters filing surfaced for 优酷/阿里, 华为, 讯飞, 中国传媒大学, Google, Apple, Microsoft, AI-Media or Descript; Baidu's only hit (CN119854569A) is general commentary video.
- **Not completed:** Google Patents returned HTTP 503 after about a dozen requests, so the English full-text queries for themes 1, 2, 4 and 5 never ran there. Espacenet, Patentscope, Justia, FreePatentsOnline and USPTO PDFs returned 403. The shared web-search quota ran out. CNIPA was not queried directly. Applications filed after about May 2025 are mostly unpublished.

### What the plan should change or say differently
- Replace the sentence with: "A partial patent and product search found no single record combining these features; the individual components have prior patents and papers."
- Stop implying the character bank or "name once, then sparingly" is new. Tencent's application and the AutoAD papers cover them. The defensible difference is: per-film clustering with no external cast database, names only from the film's own dialogue or text, human confirmation, and the outfit-aware gate.
- Send a lawyer this review list before building: CN116109967B (if gaps come from subtitle OCR with a recommended length), the 3Play and Adobe families (editor, fit meter, LLM gap fitting), CN119316627A, the 字跳 filings, CN115695902B (ducking), US9596386 (sync).
- Record AutoAD II (2023), AutoAD-Zero (2024, coloured circles on faces) and Set-of-Mark (2023) as published prior art for themes 1 and 5.
- Commission a professional CNIPA/incoPat search; this round cannot support any "no patent exists" statement.

### Fact-check

**Method:** the WebSearch quota was already exhausted, so no open search ran (searched: nothing). Evidence is from direct fetches only; Google Patents returned 503 after six pages.

1. CN119316627A: Tencent, pending; face library, 百科 names, name-once rule; no human confirmation or outfits → **confirmed**. Substantive examination in force 2026-02-17; no B publication. https://patents.google.com/patent/CN119316627A/zh
2. CN116109967B: Zhejiang University, granted 2025-08-22, active → **confirmed**; subtitle OCR, gap intervals and recommended character count are all in claim 1. https://patents.google.com/patent/CN116109967A/zh
3. 3Play US12675998B2 "published 2026-07-07", "no faces" → **wrong status**: B2 is a grant, and PatSnap shows Active. "No faces" holds, but ¶0209 edits summaries to use character names instead of actor names. https://eureka.patsnap.com/patent-US12675998B2
4. WO2026026819A1: 字跳, pending, broad claim 1 → **confirmed but incomplete**: its Chinese member CN121442141A (published 2026-01-30, pending) was not listed. https://eureka.patsnap.com/patent-CN121442141A
5. US11295084B2: IBM, "Inactive" → **unverifiable**: Google Patents 503 four times, Justia and uspto.report 403. PatSnap shows "Inactive" without a reason and no claims, so whether its role features include clothing is unread. https://eureka.patsnap.com/patent-US11295084B2

Also confirmed: Arris US11190855B2 lapsed (fee event 2026-01-05, effective 2025-11-30); AutoAD-Zero draws coloured circles on faces, with names from an external cast list (https://arxiv.org/html/2407.15850v2).

**Missed:**
- WO2025250925A1, 3Play PCT, published 2025-12-04; national-phase entries, including China, not yet visible. https://eureka.patsnap.com/patent-WO2025250925A1
- CN110519636B, Tencent, 语音信息播放方法 (B published 2021-12-21, Active per PatSnap): image recognition → descriptive text → speech for visually impaired viewers. Abstract only. https://eureka.patsnap.com/patent-CN110519636B
- Everingham et al., BMVC 2006: names TV characters from subtitles aligned with transcripts, using clothing matching alongside faces. https://www.robots.ox.ac.uk/~vgg/publications/2006/Everingham06a/
- StoryTeller (2024) matches character names to dialogue lines; not AD-specific. https://arxiv.org/abs/2411.07076

**Net effect:** The verdict survives, but exposure is larger than stated: 3Play holds two granted US patents plus a PCT, and 字跳 and Tencent have further Chinese records. Clothing cues and names from a programme's own text have 2006 academic prior art, so the novelty narrows to human confirmation and the outfit-aware name gate.

## Appendix E — Research and open source

### Verdict
The full combination was not found anywhere, but three of its parts are no longer open territory and the sentence must be narrowed. (1) A cast-free character bank built from the film itself, with names taken only from dialogue, was published with code on 2026-10-27 (Oxford VGG, StreamCast). (2) Having the model write a character identifier that is mapped to a name afterwards is established prior art (LSMDC fill-in-the-blank, MICap, BAC). (3) Volunteer editing studios with gap-fit timelines and recording exist (YouDescribeX/ADx3, DescribePro, Sema). Still not found: a deterministic output-side gate for name reveal, human confirmation of the bank, per-scene outfit memory, or a blind-participant study on naming in AI audio description.

### What exists
- **StreamCast, "As the Story Unfolds"** (Gui, Xie, Han, Xie, Zisserman; arXiv 2610.37579, 2026-10-27; repo description says NeurIPS 2026). Streaming bank from face tracks, voice diarisation and dialogue names. Unnamed identities are kept until named, with retrospective naming. Fully automatic: no human confirmation, no AD generation, no outfit. Naming accuracy 72.8% (Gemini 82.5%); principal-character recall@5 is 63. Code github.com/zhrgui/StreamCast has no licence, so cite only; the MCN dataset is Apache-2.0. https://arxiv.org/abs/2610.37579
- **StoryTeller** (Hahm, Dinh, Jin; ECCV 2026; arXiv 2607.11798, 2026-07-13). Long-form AD without a character bank. Face tracklets start anonymous; a name (optionally from IMDb metadata) is accepted only after a local Qwen3-VL ACCEPT/REJECT. That gate is a model, not a rule; no reveal-timing logic, no outfit. Only benchmark code is released, licence unspecified. https://arxiv.org/abs/2607.11798
- **BAC, "Beyond Anonymous Captions"** (Moments Lab; arXiv 2610.10163, 2026-10-07). Captioner refers to people as P_i; identifiers are mapped to names afterwards (described for QA); confidence threshold 0.30, else UNIDENTIFIED. Names from an IMDb face gallery. CC BY-NC-SA, cite only. Older versions of the idea: M-VAD Names (2019), MICap (CVPR 2024, https://arxiv.org/abs/2405.11483).
- **Name-reveal rule as professional norm.** Netflix AD Style Guide v2.5 (changelog 2023-04-27): characters stay unnamed "until introduced through dialogue or plot-point", descriptor before name, never name concealed characters. ViDscribe (CHI EA '26, arXiv 2603.14662, Gemini 3 Pro) and "What, When, and How" (arXiv 2609.30121, 2026-09-24; its solver handles timing only) put this in the prompt; neither enforces it in code.
- **Outfit.** CoherentAD (arXiv 2510.25440) explicitly exempts people's appearance from its repetition scoring. AutoAD-Zero and Shot-by-Shot (both Apache-2.0), HierAD (no licence), FocusedAD and EARS4SEE all use cast-list or portrait banks and have no outfit memory.
- **YouDescribeX / ADx3** (SFSU, Smith-Kettlewell; arXiv 2602.02684, 2026-02-02; novice-describer study arXiv 2605.05348). AI draft, then a volunteer editor with colour-coded dialogue timeline, auto-condense to fit the gap, AI or own-voice recording. Web, YouTube videos, cloud models, model-only naming; blind consultants advised but there is no blind-review stage. Code github.com/youdescribe-sfsu/YouDescribeX-app, no licence.
- **DescribePro** (ASSETS 2025, arXiv 2508.01092): describer-AI editor with forkable versions; 18 describers. **ADCanvas** (CHI '26, arXiv 2602.07266): blind creators author AD conversationally, including renaming "a man" across a script.
- **Sema** (github.com/Jeremiah-Sakuda/sema, Apache-2.0, 2026-09): fit measured from synthesised audio, per-line human approval, exports narration stem, timed script, WebVTT. Gemini cloud, English, films up to 20 minutes, no character handling.
- **Chinese open source.** ScriptGrid (MIT, github.com/yunshenwuji/ScriptGrid): gap-timeline templates from subtitles, screen-reader friendly. audio-description-workstation and audio-description-writer (2026-10/11, no licence, self-described as unverified or incomplete). 听见 demo (2026-09, preset character info, Doubao TTS). NarratoAI (MIT, film commentary; lead-character face matching is an unticked to-do). None has a character bank.
- **Shenzhen AI drafting with volunteer review** (sznews.com, 2026-10-19) [unverified: page returned HTTP 514; known only from a search summary].
- **Blind-viewer evidence.** RNIB / University of Surrey (2025-09-01): misidentified characters were common; participants agreed "human review remains essential". ViDscribe: "Include character names" was a recurring custom instruction (n=5). Chmiel & Mazur 2021 (50 participants): naming preferences differ by onset of blindness [direction unverified].

### Searched and found nothing
- "audio description name reveal", spoiler, "only after introduced", rule-based post-processing: no deterministic gate, no patent (two patent searches, English and Chinese).
- "audio description" with costume, outfit, clothing change, appearance memory (two searches).
- GitHub code search: "audio description" with name_gate, "name reveal", "character token" placeholder, outfit "first appearance", 口述影像 角色 占位符: zero hits.
- Human-in-the-loop cast confirmation for describers: only dataset-annotation tools (M-VAD Names, MovieGraphs).
- CHI/ASSETS 2025–2026 studies specifically on character naming in AI AD.
- 口述影像 自动生成 人物 命名; 无障碍电影 人脸聚类 角色库; 电影解说 角色一致性: no Chinese paper or repo with a character bank. CNKI and WeChat were not searchable.
- Hugging Face models and spaces for "audio description": only image-to-speech demos.

### What the plan should change or say differently
- Stop presenting dialogue-mined, cast-free banks as new. Cite StreamCast and StoryTeller; the difference is human confirmation. StreamCast's 73% naming accuracy is the argument for it.
- Reword open territory (a): the token is prior art (cite MICap, BAC). The claim is a deterministic gate that enforces the Netflix-style rule in code; cite Netflix v2.5 as the rule's source.
- Keep (b) but phrase it as "searched 2026-11-15, none found".
- Stop listing "volunteer studio" as a difference by itself. Cite YouDescribeX/ADx3, DescribePro, ADCanvas and Sema; the difference is local film files, on-device processing, Chinese, and a required blind-review stage.
- Suggested sentence: "As of 2026-11-15 we found cast-free character banks (StreamCast), verified naming (StoryTeller) and volunteer editors (YouDescribeX), but no system that combines a human-confirmed bank, a rule-enforced name gate, outfit memory, Chinese screen-reader support, and permissively licensed on-device processing."
- Reuse: MCN dataset and its metrics for evaluation; AutoAD-Zero and Shot-by-Shot code (Apache-2.0). StreamCast and YouDescribeX code are unlicensed, BAC is non-commercial: cite, do not copy.

### Fact-check

**Limit:** the shared WebSearch budget was already exhausted (five queries, English and Chinese, all refused), so no open search ran. Everything below comes from direct fetches of primary pages. Patent, product and Chinese-news searches were not run.

1. StreamCast facts (2026-10-27, 72.8% vs Gemini 82.5%, recall@5 63, unlicensed repo, MCN Apache-2.0) → confirmed. Its novelty is overstated; see Missed. https://arxiv.org/abs/2610.37579 , https://huggingface.co/datasets/g2zr004/MovieCharacterNaming
2. BAC "names from an IMDb face gallery" → partly wrong. IMDb supplies cast names only; reference faces are DuckDuckGo images. The P_i-to-name mapping is "for evaluation and qualitative presentation". Threshold 0.30, UNIDENTIFIED and CC BY-NC-SA are confirmed. https://arxiv.org/html/2610.10163
3. Netflix v2.5 rule, enforced only by prompt elsewhere → confirmed, with two corrections. The guide permits naming at first appearance for pop-culture figures, timing or clarity, and large groups. ViDscribe's prompt has only descriptor-before-name, not "only after introduced". https://partnerhelp.netflixstudios.com/hc/en-us/articles/215510667-Audio-Description-Style-Guide-v2-5 , https://arxiv.org/html/2603.14662
4. ADx3 "no blind-review stage" → overstated. Editing is designed for "both BLV users and sighted volunteers", and viewers can rate and comment. There is still no required blind sign-off and no BLV evaluation. https://arxiv.org/html/2602.02684
5. "No Chinese paper or repo with a character bank" → wrong. Movie101 (ACL 2023) and Movie101v2 provide Chinese narration for visually impaired viewers, with character names and actor portraits; the repo is CC-BY-4.0. https://movie101-dataset.github.io/ , https://github.com/yuezih/Movie101

"No patent, no deterministic gate, no outfit memory" → unverifiable this round. StoryTeller and "What, When, and How" details are confirmed.

Missed:
- MM-Narrator (CVPR 2024): AD generation without a cast list, names only from dialogue; identities "remain mystery until their names are being first-time called in dialogues" (read via arXiv's ar5iv mirror). https://arxiv.org/abs/2311.17435
- Haurilet et al., WACV 2016: character naming from subtitles only. https://doi.org/10.1109/WACV.2016.7477560
- Rescribe (2020): automatic fitting of descriptions to gaps. https://arxiv.org/abs/2010.03667
- Frazier: commercial AD editor with speech preview, gap recognition and centralised review; no character features on its homepage. https://www.videotovoice.com/en/

Net effect: the verdict's shape survives, but the plan should date cast-free dialogue naming in AD to MM-Narrator (2023), cite Movie101 as the Chinese baseline, and soften the ADx3 blind-review contrast. The no-patent and no-outfit claims remain unchecked until searches can run.
