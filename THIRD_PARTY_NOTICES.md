# 第三方致谢与合规说明

本项目是公益求职信息的**聚合与匹配工具**：不在本地建立第三方平台的完整副本，只在运行时按公开接口 / 开源仓库抓取岗位摘要，并为每条岗位保留回源链接、来源署名与抓取时间。

## 岗位数据来源

| 来源 | 用途 | 链接 |
| --- | --- | --- |
| HU-eun/campus-recruitment（2027 届校招岗位库） | 国内校招岗位 | https://github.com/HU-eun/campus-recruitment |
| Greenhouse Boards API | 企业官方职位板 | https://boards-api.greenhouse.io/ |
| Jobicy | 远程职位 API | https://jobicy.com/ |
| RemoteOK | 公开职位 feed | https://remoteok.com/ |
| Himalayas | 公开职位 API | https://himalayas.app/jobs |

各源的启用状态与署名写在 `config/sources.json`，抓取时统一限速、带明确 User-Agent 与超时。

## 合规边界

- 只使用公开、无需密钥、允许程序访问的接口与开源仓库。
- **不抓取 BOSS直聘、智联招聘、前程无忧、国聘等明确禁止未授权程序访问的商业平台。**
- 每条岗位保留 `originUrl` / `sourceName` / `credit` / `publishedAt` / `fetchedAt`，前端可点回原始页面人工核验。
- 校招数据的批次、截止时间与投递方式以企业官网公告为准；本项目只做聚合与匹配，不代投、不保证岗位仍然开放。
- 岗位数据权利归各自原作者所有，本项目不主张对第三方数据的权利。

## 运行时依赖

| 依赖 | 许可 | 说明 |
| --- | --- | --- |
| `pdf-parse@1.1.1` | MIT | **可选**。仅用于 PDF 文本层提取，未安装时回退内置解析器；不联网、不上传简历 |

DOCX 解析使用 Node.js 内置 `zlib` 手写 ZIP 中央目录读取，其余核心代码零第三方依赖。

## 本仓库许可

参赛作品，**未选择开源许可证，保留所有权利**。第三方素材与数据按各自上游条款处理。
