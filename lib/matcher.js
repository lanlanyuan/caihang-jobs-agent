/* 简历画像解析 + 可解释的岗位匹配
   - 画像：LLM（OpenAI 兼容，可选）优先，本地规则兜底；两者输出到同一结构
   - 匹配：技能 / 职类 / 城市 / 应届友好 / 学历 / 新鲜度 多维打分，每条分数都能给出理由与差距 */
import { extractSkills, detectCategory, detectCities, detectDegree, LEX,
  norm, uniq, truncate, matchAliases } from "./text.js";

const MAJORS = [
  ["计算机", ["计算机", "computer science", "cs ", "software engineering", "软件工程"]],
  ["软件", ["软件工程", "software", "软件"]], ["人工智能", ["人工智能", "artificial intelligence", " ai ", "智能科学"]],
  ["电子信息", ["电子信息", "electronic", "ee ", "微电子", "集成电路"]],
  ["通信", ["通信", "communication engineering", "telecom"]],
  ["电气", ["电气", "electrical", "电力系统", "power system"]],
  ["自动化", ["自动化", "automation", "control engineering", "控制科学"]],
  ["机械", ["机械", "mechanical", "机电", "车辆工程"]],
  ["材料", ["材料", "materials science", "高分子", "冶金"]],
  ["土木", ["土木", "civil engineering", "建筑学", "工程管理", "工程造价"]],
  ["数学", ["数学", "mathematics", "applied math", "统计学", "statistics"]],
  ["物理", ["物理", "physics", "光学"]],
  ["化学化工", ["化学", "chemistry", "化工", "chemical engineering"]],
  ["生物医药", ["生物", "biology", "药学", "pharmacy", "临床", "医学"]],
  ["金融", ["金融", "finance", "financial engineering", "投资学", "经济学", "economics"]],
  ["会计财务", ["会计", "accounting", "财务管理", "审计", "audit"]],
  ["工商管理", ["工商管理", "business administration", "管理学", "management"]],
  ["市场营销", ["市场营销", "marketing", "广告学", "电子商务"]],
  ["人力资源", ["人力资源", "human resource", "劳动经济"]],
  ["法学", ["法学", "law", "法律", "知识产权"]],
  ["中文新闻", ["汉语言", "中文", "新闻", "journalism", "传播学", "communication studies"]],
  ["外语", ["英语", "english", "外语", "日语", "翻译", "translation"]],
  ["设计艺术", ["设计", "design", "动画", "数字媒体", "视觉传达", "美术"]],
  ["教育师范", ["教育", "education", "师范", "心理学", "psychology"]],
  ["物流供应链", ["物流", "logistics", "供应链", "supply chain", "交通运输"]],
  ["能源环境", ["能源", "energy", "环境", "environmental", "核工程", "石油", "地质"]],
  ["农学食品", ["农学", "agriculture", "食品", "food science", "园艺"]]
];
const STOP = new Set(["the", "and", "for", "with", "you", "our", "are", "will", "have", "has", "this", "that", "from", "your", "job", "work", "team", "years", "experience", "公司", "工作", "岗位", "负责", "参与", "以上", "以及", "相关", "能力", "熟练", "掌握", "具备", "我们", "职位", "要求", "描述", "本科", "学历"]);

/* CloudBase 交付：环境变量已获用户明确授权固化为项目内常量（明文进入源码与 ZIP）。
   当前无 .env，LLM key 为空 -> 不启用 LLM，简历画像走本地规则。 */
export const LLM = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "",
  model: "deepseek-chat",
  get configured() { return !!this.apiKey; }
};

/* ---------- 本地画像 ---------- */
function keywordsOf(text) {
  const t = norm(text).toLowerCase();
  const en = (t.match(/[a-z][a-z0-9+#.]{2,}/g) || []).filter(w => !STOP.has(w) && w.length > 2);
  const zh = (t.match(/[\u4e00-\u9fa5]{2,6}/g) || []).filter(w => !STOP.has(w));
  const freq = new Map();
  [...en, ...zh].forEach(w => freq.set(w, (freq.get(w) || 0) + 1));
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
}
export function localParse(text) {
  const t = norm(text);
  // 专业只从「学历/教育」相关行 + 开头基本信息推断，避免把项目描述里的词误认成专业
  const lines = String(text).split(/\n/).map(s => s.trim()).filter(Boolean);
  const edu = lines.filter(l => /学历|专业|教育|毕业|学士|硕士|本科|博士|大专|major|education|degree|学院|大学/i.test(l));
  const majorText = norm((edu.length ? edu.concat(lines.slice(0, 2)) : lines.slice(0, 8)).join(" "));
  const majors = MAJORS.filter(([, als]) => als.some(a => majorText.includes(a.toLowerCase()))).map(x => x[0]);
  const skills = extractSkills(text);
  const roleM = /(?:求职意向|意向岗位|目标岗位|期望职位|应聘岗位)[：:\s]*([^\n。；;]{2,40})/.exec(text);
  const roleText = roleM ? roleM[1] : "";
  // 求职意向里的职类权重更高，但仍保留全文推断结果
  const categories = uniq([detectCategory(roleText), detectCategory(text)]).filter(Boolean).slice(0, 3);
  const exp = /(\d{1,2})\s*年[^。\n]{0,8}(工作|实习|开发|项目)?经验/.exec(text);
  return {
    degree: detectDegree(text), majors, skills,
    cities: detectCities(text), categories,
    expectedRoles: roleText ? [roleText.trim()] : [],
    yearsExp: exp ? Number(exp[1]) : 0,
    isParty: /中共党员|预备党员|学生党员|党员|入党积极分子/.test(text),
    keywords: keywordsOf(text).slice(0, 24),
    highlights: [], crossMajorSuggestions: [],
    summary: truncate(text.replace(/\n/g, " "), 160),
    engine: "本地规则"
  };
}
async function llmParse(text) {
  if (!LLM.configured) throw new Error("未配置 LLM");
  const sys = `你是面向中国应届毕业生的公益求职助手，负责把简历解析成结构化画像。只输出一个 JSON 对象，不要 Markdown 代码块、不要解释。
字段：
{"degree":"大专|本科|硕士|博士|null","majors":["专业中文名"],"skills":["技能中文名，必须使用给定词表中的名称"],"cities":["意向城市中文名"],"categories":["职类，从这些中文名里选：软件研发、算法/AI、数据、产品/项目、设计/创意、市场/运营、销售/客服、财务/金融、硬件/制造、人力/行政、科研/教育、土木/建筑、医药/生物、管培生"],"expectedRoles":["期望岗位"],"yearsExp":0,"isParty":false,"highlights":["简历亮点,最多5条"],"crossMajorSuggestions":["专业受限时可迁移的投递方向,最多4条"],"summary":"一句话求职定位"}
技能词表：${LEX.skills.map(s => s.key).join("、")}。
规则：只输出简历里真实存在的信息，不要推测、不要虚构；无法判断的字段用空数组或 null。`;
  const body = { model: LLM.model, temperature: 0.1, messages: [
    { role: "system", content: sys }, { role: "user", content: String(text).slice(0, 9000) }
  ] };
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 45000);
  let res;
  try {
    res = await fetch(LLM.baseUrl + "/chat/completions", {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + LLM.apiKey },
      body: JSON.stringify(body)
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error("LLM HTTP " + res.status + " " + (await res.text()).slice(0, 160));
  const j = await res.json();
  let c = (j.choices?.[0]?.message?.content || "").replace(/```json|```/gi, "").trim();
  const s = c.indexOf("{"), e = c.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("LLM 未返回 JSON");
  const o = JSON.parse(c.slice(s, e + 1));
  const base = localParse(text);
  return {
    ...base,
    degree: o.degree && o.degree !== "null" ? o.degree : base.degree,
    majors: uniq([...(o.majors || []), ...base.majors]).slice(0, 10),
    skills: uniq([...(o.skills || []), ...base.skills]).slice(0, 24),
    cities: uniq([...(o.cities || []), ...base.cities]).slice(0, 8),
    categories: uniq([...(o.categories || []), ...base.categories]).slice(0, 6),
    expectedRoles: (o.expectedRoles || base.expectedRoles).slice(0, 6),
    yearsExp: Number(o.yearsExp) || base.yearsExp,
    isParty: !!o.isParty || base.isParty,
    highlights: (o.highlights || []).slice(0, 5),
    crossMajorSuggestions: (o.crossMajorSuggestions || []).slice(0, 4),
    summary: o.summary || base.summary,
    engine: "LLM " + LLM.model
  };
}
export async function parseResumeText(text, useLLM = true) {
  if (useLLM && LLM.configured) {
    try { return await llmParse(text); }
    catch (e) { const p = localParse(text); p.engine = `本地规则（LLM 调用失败：${e.message}）`; return p; }
  }
  return localParse(text);
}

/* ---------- 搜索词中英扩展 ---------- */
export function expandQuery(q) {
  const raw = String(q || "").trim().toLowerCase();
  if (!raw) return [];
  const terms = [raw];
  const groups = [...LEX.skills, ...LEX.categories];
  for (const g of groups) {
    if (g.key.toLowerCase().includes(raw) || g.aliases.some(a => a.toLowerCase().includes(raw) && raw.length >= 2)) {
      terms.push(g.key.toLowerCase(), ...g.aliases.map(a => a.toLowerCase().trim()));
    }
  }
  for (const [cn, als] of Object.entries(LEX.cityAliases)) {
    if (cn.includes(raw) || als.some(a => a.includes(raw))) terms.push(cn, ...als);
  }
  // 「ai」「ml」「go」这类 2 字母别名会误命中 email / html / google，扩展词直接丢弃；
  // 用户自己输入的原词（terms[0]）始终保留，长英文别名（algorithm 等）照常召回。
  return uniq(terms.filter(t => t && t.length >= 2))
    .filter((t, i) => i === 0 || !/^[a-z0-9+#.]{1,2}$/.test(t)).slice(0, 40);
}
/* 短英文词按词边界匹配：java 不命中 javascript、ai 不命中 email；中文词走子串匹配 */
function termMatcher(t) {
  const s = String(t).toLowerCase().trim();
  if (/^[a-z0-9+#.]{1,4}$/.test(s)) {
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(?<![a-z0-9+#])" + esc + "(?![a-z0-9+#])", "i");
    return x => re.test(x);
  }
  return x => x.includes(s);
}

/* ---------- 单岗位打分 ---------- */
/* 匹配打分：参考公开简历-岗位匹配项目的「固定权重 + 明确刻度 + 诚实差距 + 分档建议」做法。
   总分仍裁剪到 0–99（与既有 API / 自验保持一致），但额外输出五维明细 breakdown，
   让"分怎么来的"可复现、可核对。规则完全本地确定性执行，不调用任何大模型。 */
const DIM_WEIGHTS = { skill: 40, direction: 28, location: 12, freshGrad: 14, background: 20 };
function scoreTier(score) {
  if (score >= 75) return { label: "强匹配", advice: "优先投递，建议在求职信里点明与岗位最贴合的两三项能力" };
  if (score >= 60) return { label: "良好", advice: "可以投递，在求职信里说明缺口项如何补齐" };
  if (score >= 45) return { label: "一般", advice: "慎重投递，先核对差距项是否致命" };
  return { label: "偏低", advice: "除非有明确战略理由，否则建议优先投更高分的岗位" };
}
export function scoreJob(job, p) {
  let score = 0; const reasons = [], gaps = [], matched = [];
  const dim = { skill: 0, direction: 0, location: 0, freshGrad: 0, background: 0 };
  const hasProfile = !!(p && (p.skills?.length || p.majors?.length || p.cities?.length || p.categories?.length || p.degree));

  if (hasProfile) {
    const ps = new Set(p.skills || []);
    const js = job.skills || [];
    const ov = js.filter(x => ps.has(x));
    if (ov.length) {
      const add = Math.min(40, 12 + ov.length * 8);
      dim.skill = add; score += add; matched.push(...ov);
      reasons.push(`技能命中（+${add}）：${ov.slice(0, 4).join("、")}`);
    }
    const miss = js.filter(x => !ps.has(x)).slice(0, 4);
    if (miss.length) gaps.push(...miss);

    const cats = p.categories || [];
    const catHit = cats.some(c => c === job.category || job.category.includes(c.replace(/\//g, "")) || c.includes(job.category.replace(/\//g, "")));
    if (catHit) { dim.direction += 20; score += 20; reasons.push("职类对口（+20）：" + job.category); }
    else if (job.category !== "其他") { dim.direction += 3; score += 3; }
    if (p.expectedRoles?.length) {
      const t = norm(job.title + " " + job.category);
      if (p.expectedRoles.some(r => r && t.includes(String(r).toLowerCase().slice(0, 4)))) {
        dim.direction += 8; score += 8; reasons.push("符合期望岗位方向（+8）");
      }
    }
    dim.direction = Math.min(28, dim.direction);

    const pc = p.cities || [];
    const jc = job.cities || [];
    const cityHit = pc.find(c => jc.includes(c));
    if (cityHit) { dim.location = 12; score += 12; reasons.push(`意向城市（+12）：${cityHit}`); }
    else if (job.isRemote) { dim.location = 7; score += 7; reasons.push("远程可投（+7），不限工作地"); }
    else if (job.city === "全国" || /全国/.test(job.location)) { dim.location = 8; score += 8; reasons.push("全国可投（+8）"); }

    if (job.type === "campus") { dim.freshGrad = 14; score += 14; reasons.push("国内校招官方入口（+14）：面向应届毕业生"); }
    else if (job.isNewGrad) { dim.freshGrad = 10; score += 10; reasons.push("应届/实习友好（+10）"); }
    if (job.level === "中高级" && (p.yearsExp || 0) < 3) { dim.freshGrad -= 14; score -= 14; reasons.push("疑似中高级职位（−14）：需要较多经验"); }

    if (p.degree && /博士|硕士|本科|大专/.test(job.description || "")) {
      const needed = detectDegree(job.description || "");
      const rank = { "大专": 1, "本科": 2, "硕士": 3, "博士": 4 };
      if (needed && (rank[p.degree] || 0) >= (rank[needed] || 0)) {
        dim.background += 6; score += 6; reasons.push(`学历达标（+6）：要求${needed}`);
      } else if (needed) { dim.background -= 8; score -= 8; reasons.push(`学历可能不达标（−8）：要求${needed}`); }
    }
    if (p.keywords?.length) {
      const jt = norm(`${job.title} ${job.description} ${job.tags.join(" ")}`);
      const hits = p.keywords.filter(k => k.length >= 3 && jt.includes(k)).length;
      if (hits) { const add = Math.min(10, hits * 2); dim.background += add; score += add; reasons.push(`简历关键词命中 ${hits} 个（+${add}）`); }
    }
  } else {
    score = 30;
    reasons.push("未上传简历，按应届友好度与发布时间排序");
  }
  if (job.publishedAt) {
    const days = (Date.now() - new Date(job.publishedAt).getTime()) / 86400000;
    if (days >= 0 && days <= 30) { dim.background += 6; score += 6; reasons.push("近 30 天发布（+6）"); }
    else if (days <= 120) { dim.background += 3; score += 3; reasons.push("近 4 个月发布（+3）"); }
  }
  if (job.salaryText) { dim.background += 2; score += 2; reasons.push("公开薪资区间（+2）"); }
  score = Math.max(0, Math.min(99, Math.round(score)));
  const tier = scoreTier(score);
  const breakdown = Object.entries(DIM_WEIGHTS).map(([key, max]) => ({
    key, max, value: Math.max(0, dim[key]),
    label: { skill: "技能匹配", direction: "方向匹配", location: "地点", freshGrad: "应届友好", background: "背景与时效" }[key]
  }));
  return { score, reasons, gaps: uniq(gaps).slice(0, 4), matched: uniq(matched).slice(0, 8),
    breakdown, tier: tier.label, advice: tier.advice };
}
/* ---------- 筛选 + 排序 ---------- */
export function queryJobs(jobs, opts = {}) {
  const { q, sources, categories, cities, types, onlyNewGrad, onlySalary, onlyChina, sort, profile, limit = 20, offset = 0 } = opts;
  const rawQ = String(q || "").trim().toLowerCase();
  const terms = expandQuery(q);
  const matchers = terms.map(t => ({ primary: t === rawQ, m: termMatcher(t) }));
  const relMap = new Map();
  const has = (v, arr) => !arr || !arr.length || arr.includes(v);
  let list = jobs.filter(j => {
    if (matchers.length) {
      // 分字段加权：标题 > 标签/技能/职类 > 公司 > JD 正文；原词权重高于中英扩展词
      const title = norm(j.title), company = norm(j.company);
      const meta = norm(`${(j.tags || []).join(" ")} ${(j.skills || []).join(" ")} ${j.category} ${j.location}`);
      const rest = norm(j.description);
      let rel = 0, hit = false;
      for (const { primary, m } of matchers) {
        let n = 0;
        if (m(title)) n += 12;
        if (m(meta)) n += 8;
        if (m(company)) n += 6;
        if (m(rest)) n += 2;
        if (n) { hit = true; rel += n * (primary ? 1 : 0.4); }
      }
      if (!hit) return false;
      relMap.set(j.id, Math.round(rel * 10) / 10);
    }
    if (!has(j.sourceId, sources)) return false;
    if (!has(j.category, categories)) return false;
    if (types?.length && !types.includes(j.type)) return false;
    if (cities?.length && !(j.cities || []).some(c => cities.includes(c)) && !j.isRemote) return false;
    if (onlyNewGrad && !(j.isNewGrad || j.type === "campus")) return false;
    if (onlySalary && !j.salaryText) return false;
    if (onlyChina && !(j.isChina || j.type === "campus")) return false;
    return true;
  });
  const ranked = list.map(j => {
    const extra = scoreJob(j, profile);
    return { job: j, extra, score: extra.score, rel: relMap.get(j.id) || 0 };
  });
  const byScore = (a, b) => b.score - a.score || b.rel - a.rel || newest(b.job) - newest(a.job);
  const byRel = (a, b) => b.rel - a.rel || b.score - a.score || newest(b.job) - newest(a.job);
  const byDate = (a, b) => newest(b.job) - newest(a.job);
  const bySalary = (a, b) => (b.job.salaryMax || 0) - (a.job.salaryMax || 0);
  // 有搜索词且未上传简历时按相关度排序；上传简历后仍以匹配分为主，相关度做同分次序
  const cmp = sort === "date" ? byDate : sort === "salary" ? bySalary
    : (rawQ && !profile ? byRel : byScore);
  ranked.sort(cmp);
  const total = ranked.length;
  const items = ranked.slice(offset, offset + limit)
    .map(r => ({ ...r.job, ...r.extra, ...(rawQ ? { relevance: r.rel } : {}) }));
  return { total, items, scoredCount: total };
}
function newest(j) { return j.publishedAt ? new Date(j.publishedAt).getTime() : 0; }
export function summarize(jobs) {
  const by = (fn) => jobs.reduce((m, j) => { const k = fn(j) || "其他"; m[k] = (m[k] || 0) + 1; return m; }, {});
  const cityCount = {};
  jobs.forEach(j => (j.cities || []).forEach(c => { cityCount[c] = (cityCount[c] || 0) + 1; }));
  const byCity = Object.fromEntries(Object.entries(cityCount).sort((a, b) => b[1] - a[1]).slice(0, 40));
  return { total: jobs.length, bySource: by(j => j.sourceName), byCategory: by(j => j.category), byCity,
    byType: by(j => j.type === "campus" ? "国内校招岗位" : "具体岗位"),
    withSalary: jobs.filter(j => j.salaryText).length, newGrad: jobs.filter(j => j.isNewGrad || j.type === "campus").length };
}
