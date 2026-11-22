# 才航 · 真实岗位 + 简历上传匹配助手

面向应届毕业生 / 公益求职场景的本地 Agent 应用。**纯公益、完全免费**。**岗位全部来自公开可核验的真实数据源**，**简历可以上传文件**（PDF / DOCX / TXT 等），自动解析成画像后与岗位做可解释匹配，每条结果都能点回原始职位页核对。

> 这是在原 `公益招聘信息抓取agent.zip` 基础上的重写版。原版仅有 30 条手工维护岗位、RSS/HTML 源均为 disabled 示例，简历只接受粘贴的 JSON 文本，无法上传文件。

## 创作声明

本作品由 **梁湘瑶**（人类作者）与 **阿岩**（WorkBuddy AI 工程助理，AI 辅助）**协同创作**。

> **项目地址（公开仓库）**：https://github.com/lanlanyuan/caihang-jobs-agent
> **公益与隐私声明**：本项目是**个人使用的公益小工具**，纯公益、**完全免费**——不收费、不接受付费内推或导流；**不设账号、不收集个人信息或简历数据**，简历不用于任何商业用途。

| 角色 | 承担的环节 |
| --- | --- |
| 梁湘瑶 | 原始需求、原始项目、「真实岗位数据 + 简历上传匹配」验收标准、产品方向与最终交付审核 |
| 阿岩（AI 辅助） | 原版诊断、数据源实测、v3 架构与代码起草、README 与 25 项端到端自验、交付包校验 |

完整分工、AI 参与边界与引用格式见 [AUTHORS.md](./AUTHORS.md)；第三方来源与许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。提交信息中的 `Co-authored-by` 仅为协作过程留痕。**本项目源代码以 [MIT License](./LICENSE) 开源**；第三方岗位数据不在该许可范围内，按各自上游条款处理（见 THIRD_PARTY_NOTICES.md）。

---

## 1. 快速启动

```bash
# 需要 Node.js >= 18（用到内置 fetch / FormData / Blob，无需任何框架）
cd jobs-agent
npm install          # 可选：仅为了安装 pdf-parse，让中文 PDF 解析更完整；不装也能跑
npm start            # 等价于 node server.js
```

然后打开终端里打印的地址，默认 **http://127.0.0.1:8081**。

- 服务监听 `0.0.0.0`，端口取 `PORT`（默认 9000）；CloudBase 由 bootstrap 注入，本地可用 `PORT=8081 npm start` 指定。
- **部署包内含一份真实岗位快照**（`data/jobs-cache.json`），服务启动即可展示，不依赖联网；运行期每 30 分钟或手动同步会联网刷新内存中的岗位。快照由每日维护任务更新，每条岗位保留 `originUrl` 可回源核验。
- 任一数据源失败都不清空已抓到的结果；也可在页面点「立即同步」手动刷新。快照只作为只读种子数据，服务运行期不写盘，兼容只读文件系统。
- 核心代码零依赖；`npm install` 只装一个可选依赖 `pdf-parse@1.1.1`。未安装时 PDF 走内置文本层提取，DOCX / TXT 完全不受影响。

### 一键自验

```bash
npm run test:e2e     # 服务已启动的前提下运行，25 项检查
```

覆盖：服务状态、5 个数据源、岗位检索与筛选、岗位详情、简历文本解析、岗位匹配、TXT/DOCX/PDF 三种格式上传、静态资源。

---

## 2. 真实岗位数据

### 5 个公开、无需密钥、可人工复核的数据源（均已启用）

| 数据源 | 类型 | 说明 |
| --- | --- | --- |
| [HU-eun/campus-recruitment](https://github.com/HU-eun/campus-recruitment) | 国内 2027 届校招 | 开源社区每日更新的校招岗位库，含公司、岗位、地点、投递链接、截止时间；**仅回链原始公告，侵权即删** |
| [Greenhouse Boards API](https://boards-api.greenhouse.io/) | 企业官方职位板 | 14 家企业自建招聘系统的公开接口，逐条对应官方职位页 |
| [Jobicy](https://jobicy.com/) | 远程职位 API | 含薪资 / 职级 / 发布时间 |
| [RemoteOK](https://remoteok.com/) | 公开职位 feed | 含薪资区间 |
| [Himalayas](https://himalayas.app/jobs) | 公开职位 API | 含薪资 / 职级 / 地区限制 |

> 上表为运行时联网抓取的公开来源，**岗位数据不随部署包分发**。数量随上游变动，以页面实时展示为准。
>
> **校招源说明**：`HU-eun/campus-recruitment`（国内校招）仓库无 LICENSE 授权声明，本站以**公益聚合 + 侵权即删**方式展示：只回链原始公告、不复制数据库、不随包分发数据；如权利方认为不当，请通过 GitHub 地址联系删除。

数据源在 `config/sources.json` 配置，`enabled: false` 即可关闭单个源。抓取时统一限速（默认请求间隔 ≥ 260 ms）、带明确 User-Agent、带超时。

### 每条岗位都带溯源字段

`title`、`company`、`location`、`salaryText`、`deadline`、`category`、`skills`、`description`
以及 **`originUrl`（原始职位/公告链接）**、`sourceName`、`sourceUrl`、`credit`、`publishedAt`、`fetchedAt`。前端每张卡片都显示「来源 · 抓取时间 · 原始链接可核验」。

校招公告常把十几个岗位名挤在同一格，卡片上折叠为「首个岗位 等 N 个方向」，鼠标悬停、职位详情弹窗和 CSV 导出里保留完整原文，不改动真实数据。

### 合规边界

- 只使用公开、无需密钥、允许程序访问的接口与开源仓库；保留回源链接与来源署名。
- **不抓取 BOSS直聘、智联招聘、前程无忧、国聘等明确禁止未授权程序访问的商业平台**。
- 校招数据的批次、截止时间、投递方式请以企业官网公告为准；本项目只做聚合与匹配，不代投、不保证岗位仍然开放。
- 如任何内容涉及侵权，请通过项目 GitHub 地址（https://github.com/lanlanyuan/caihang-jobs-agent）联系作者，我们将第一时间核实并删除相关信息；本链接纯公益、不收费。

---

## 3. 简历上传与解析

**支持格式**：`.pdf` `.docx` `.txt` `.md` `.markdown` `.csv` `.json` `.text`，单文件上限 **12 MB**。也支持直接粘贴简历文本。

- 上传用 `multipart/form-data`。**个人使用 · 不收集简历**：本项目是供个人自助使用的公益小工具，**不设账号、不收集或留存任何个人信息与简历数据**。简历仅在你主动上传后于运行内存中即时解析，完成后立即释放，不落盘、不写日志、不做持久化、不用于其他用途，也不转发给第三方大模型（LLM 未启用）；本地运行时简历不出本机，云端部署时仅在当前实例内存中短暂处理。
- DOCX：内置 ZIP 中央目录 + XML 解析（`word/document.xml` / `footnotes.xml` / `header*.xml`），零依赖。
- PDF：优先 `pdf-parse`（中文支持更好）；未安装时回退内置解析器，可解压 PDF stream、解析 **ToUnicode CMap**，正确处理中文 CID 编码与十六进制字符串，无需任何依赖也能还原中英混排简历。扫描件图片型 PDF 无文本层，会明确提示改用可复制文字的 PDF。
- 产出统一画像：`degree / majors / skills / cities / categories / expectedRoles / yearsExp / isParty / keywords / highlights / crossMajorSuggestions / summary / engine`。
- 解析引擎：**本地中英双语规则**（无需外部服务、不泄露简历）。CloudBase 交付版已把运行参数固化为项目内常量，LLM 未启用；如需接入 LLM，请在其他部署形态下自行改造。

> CloudBase 交付版未启用 LLM，无需任何环境变量配置；本地版如需接入 LLM，请自行改造。

`samples/` 里放了同一份示例简历的 `.txt` / `.docx` / `.pdf`，可直接上传试三种解析路径。

---

## 4. 可解释匹配

`scoreJob()` 对每条岗位逐项打分并给出理由与差距，不搞黑箱：

| 维度 | 分值 | 说明 |
| --- | --- | --- |
| 技能命中 | +12 ~ +40 | 简历技能与岗位技能取交集 |
| 职类对口 | +20 | 简历意向职类 vs 岗位职类 |
| 意向城市 | +12（远程 +7 / 全国 +8） | |
| 应届友好 | 校招 +14 / 应届岗 +10 | |
| 学历达标 | +6 / 不达标 −8 | |
| 简历关键词 | +2 ~ +10 | |
| 期望岗位方向 | +8 | |
| 发布时间 / 公开薪资 | +6 / +3 / +2 | |

总分裁剪到 0–99。同时输出 `reasons`（为什么推荐）、`gaps`（岗位提到但简历没写的技能，提示补充）、`matched`。
带搜索词时按「标题 > 标签/技能 > 公司 > JD 正文」加权算相关度并优先排序；短英文词按词边界匹配，避免 `ai` 命中 `email`、`java` 命中 `javascript`。

---

## 5. HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 岗位数、抓取时间、按源/职类/城市分布、数据源列表、LLM 状态 |
| GET | `/api/health` | 健康检查 |
| GET | `/api/sources` | 数据源原始配置 |
| GET | `/api/jobs?q=&sources=&categories=&cities=&types=&onlyNewGrad=1&onlySalary=1&onlyChina=1&sort=&limit=&offset=` | 检索 + 筛选 + 排序 |
| GET | `/api/job?id=` | 岗位详情（Greenhouse 岗位会按需拉官方完整 JD） |
| POST | `/api/sync` | 强制刷新真实岗位 |
| POST | `/api/parse-resume` | `{ "text": "...", "useLLM": false }` → 画像 |
| POST | `/api/upload-resume` | `multipart/form-data`，字段名 `resume`；返回文件信息 + 画像 + Top12 匹配岗位 |
| POST | `/api/match` | `{ "profile": {...}, "limit": 20, "sort": "score" }` → 匹配结果 |

---

## 6. 目录结构

```
jobs-agent/
├── server.js                 # HTTP 服务、路由、端口顺延、后台同步
├── config/
│   ├── sources.json          # 5 个启用的公开数据源与署名（含 2027 校招专栏）
│   └── lexicon.json          # 中英双语词表（技能/职类/城市/学历/应届词）
├── lib/
│   ├── sources.js            # 各数据源连接器 + 统一岗位结构 + 去重
│   ├── text.js               # 文本归一、乱码修复、词表命中、稳定 ID
│   ├── documents.js          # multipart 解析、PDF/DOCX/TXT 文本提取
│   ├── matcher.js            # 画像解析、可解释打分、检索排序
│   └── store.js              # JSON 读写与缓存
├── public/                   # 前端（原生 HTML/CSS/JS，无构建步骤）
├── scripts/
│   ├── sync.js               # 命令行预抓取
│   └── e2e.js                # 端到端自验
├── samples/                  # 三种格式的示例简历
```

---

## 7. 已知边界

- 岗位数量与有效性取决于上游：商业平台未接入，国内校招（2027 届）以开源社区库为主，其余为公开职位 API；投递前请点原始链接核对。
- 扫描件 PDF（纯图片）没有文本层，无法解析；建议导出为可复制文字的 PDF 或 DOCX。
- 本地规则画像基于词表，能稳定识别学历、技能、城市、职类，但不会生成「亮点 / 可迁移方向」这类主观结论；配置 LLM 后才有。
- 服务监听 `0.0.0.0`，端口取 `PORT`（默认 9000）；简历仅在内存即时解析并释放，不收集、不持久化。
