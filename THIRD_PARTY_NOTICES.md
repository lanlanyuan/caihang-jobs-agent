# 第三方致谢与合规说明

本项目是公益求职信息的**聚合与匹配工具**：不在本地建立第三方平台的完整副本，只在运行时按公开接口 / 开源仓库抓取岗位摘要，并为每条岗位保留回源链接、来源署名与抓取时间。

> **项目地址**：https://github.com/lanlanyuan/caihang-jobs-agent
> **公益与隐私声明**：本项目是**个人使用的公益小工具**，纯公益、**完全免费**，不收费、不接受付费内推或导流；**不设账号、不收集个人信息或简历数据**。

## 岗位数据来源

| 来源 | 用途 | 链接 |
| --- | --- | --- |
| HU-eun/campus-recruitment（2027 届校招岗位库） | 国内校招岗位（**公益聚合 + 侵权即删**，仅回链原始公告） | https://github.com/HU-eun/campus-recruitment |
| Greenhouse Boards API | 企业官方职位板 | https://boards-api.greenhouse.io/ |
| Jobicy | 远程职位 API | https://jobicy.com/ |
| RemoteOK | 公开职位 feed | https://remoteok.com/ |
| Himalayas | 公开职位 API | https://himalayas.app/jobs |

HU-eun 校招源已启用并在前端开设「2027 校招专栏」。该库无 LICENSE 授权声明，本站以公益聚合方式展示：每条岗位只保留标题/公司/地点/原始链接等摘要字段并回链原始公告，快照仅用于冷启动回退、可一键删除；**如权利方认为不当，请通过项目 GitHub 地址联系，我们将第一时间删除相关信息**。各源启用状态与署名写在 `config/sources.json`，抓取时统一限速、带明确 User-Agent 与超时。

## 合规边界

- 只使用公开、无需密钥、允许程序访问的接口与开源仓库。
- **不抓取 BOSS直聘、智联招聘、前程无忧、国聘等明确禁止未授权程序访问的商业平台。**
- 每条岗位保留 `originUrl` / `sourceName` / `credit` / `publishedAt` / `fetchedAt`，前端可点回原始页面人工核验。
- 校招数据的批次、截止时间与投递方式以企业官网公告为准；本项目只做聚合与匹配，不代投、不保证岗位仍然开放。
- 岗位数据权利归各自原作者所有，本项目不主张对第三方数据的权利。
> **侵权与联系方式**：如任何内容涉及侵权，请通过项目 GitHub 地址（https://github.com/lanlanyuan/caihang-jobs-agent）联系作者，我们将第一时间核实并删除相关信息。**本链接纯公益、不收费**。

## 开源致谢

本项目的实现站在以下公开项目与社区的肩膀上，谨此致谢：

| 项目 / 社区 | 致谢内容 | 链接 |
| --- | --- | --- |
| Greenhouse Boards API | 企业官方职位板公开接口 | https://boards-api.greenhouse.io/ |
| Jobicy | 远程职位公开 API（按其要求署名并回链原帖） | https://jobicy.com/ |
| RemoteOK | 公开职位 feed | https://remoteok.com/ |
| Himalayas | 公开职位 API | https://himalayas.app/jobs |
| pdf-parse | MIT 许可，可选 PDF 文本提取依赖 | https://www.npmjs.com/package/pdf-parse |
| Node.js 社区 | 内置 `fetch` / `zlib` / `FormData`，使核心代码零第三方依赖 | https://nodejs.org/ |
| HU-eun/campus-recruitment | 感谢其公开整理的 2027 届校招岗位库（本站公益聚合展示，侵权即删） | https://github.com/HU-eun/campus-recruitment |

上述来源与依赖的权利归各自作者所有；本项目仅在公益范围内使用，并保留回源链接与署名。

## 运行时依赖

| 依赖 | 许可 | 说明 |
| --- | --- | --- |
| `pdf-parse@1.1.1` | MIT | **可选**。仅用于 PDF 文本层提取；未安装时回退项目内置的 ToUnicode CMap 解析器（可处理中文 CID 编码），不联网、不上传简历 |

DOCX 解析使用 Node.js 内置 `zlib` 手写 ZIP 中央目录读取，其余核心代码零第三方依赖。

## 本仓库许可

**本仓库源代码以 [MIT License](./LICENSE) 开源**（版权归人类作者梁湘瑶）。该许可**仅覆盖本项目自有源代码与文档**，不覆盖任何第三方岗位数据、示例素材或依赖库——它们分别按其上游条款处理。

项目免费供公益求职使用，不收取任何费用；源代码按 MIT 开源，第三方素材与数据按各自上游条款处理。
