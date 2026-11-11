/* 文本工具：中英双语词表命中、HTML 清洗、稳定 ID。
   被 sources.js（给岗位打标签）与 matcher.js（给简历打标签）共用，
   保证「简历」和「岗位」用同一套词、同一套判断口径。 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(__dirname, "..", "config", "lexicon.json");
export const LEX = JSON.parse(fs.readFileSync(CONFIG, "utf8"));

export function norm(s) {
  return " " + String(s || "").toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim() + " ";
}
/* 有些 feed 把 UTF-8 字节按 latin1 输出，出现 â¢ / Ã© 之类的乱码，做一次安全修复 */
export function fixMojibake(s) {
  const t = String(s || "");
  if (!/[ÃÂ][\u0080-\u00ff\u2018-\u201e]/.test(t)) return t;
  try {
    const fixed = Buffer.from(t, "latin1").toString("utf8");
    return (fixed.match(/\ufffd/g) || []).length ? t : fixed;
  } catch { return t; }
}
export function htmlToText(html) {
  return fixMojibake(String(html || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
function hit(normed, alias) {
  const a = alias.toLowerCase().trim();
  if (!a) return false;
  if (/^[a-z0-9+#.]{1,4}$/.test(a)) {           // 短英文词，用词边界避免 go 命中 google
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?<![a-z0-9+#])" + esc + "(?![a-z0-9+#])", "i").test(normed);
  }
  return normed.includes(a);
}
export function extractSkills(text) {
  const t = norm(text);
  return LEX.skills.filter(g => g.aliases.some(a => hit(t, a))).map(g => g.key);
}
export function detectCategory(text) {
  const t = norm(text);
  let best = null, bestScore = 0;
  for (const c of LEX.categories) {
    let n = 0, first = Infinity;
    for (const a of c.aliases) {
      if (!hit(t, a)) continue;
      n++;
      const idx = t.indexOf(a.trim().toLowerCase());
      if (idx >= 0) first = Math.min(first, idx);
    }
    // 命中数优先；平手时取在文本里更早出现的职类（如「数据分析师 / 算法工程师」应判为数据）
    const score = n * 1000 - first;
    if (n && score > bestScore) { bestScore = score; best = c.key; }
  }
  return best;
}
export function detectDegree(text) {
  const t = norm(text);
  const order = ["博士", "硕士", "本科", "大专"];
  for (const d of order) {
    const g = LEX.degrees.find(x => x.key === d);
    if (g.aliases.some(a => hit(t, a))) return d;
  }
  return null;
}
export function matchAliases(text, list) {
  const t = norm(text);
  return list.filter(a => hit(t, a));
}
export function isNewGrad(text) {
  return matchAliases(text, LEX.newGradTerms).length > 0;
}
export function isSenior(text) {
  return matchAliases(text, LEX.seniorTerms).length > 0;
}
export function detectCities(text) {
  const t = norm(text);
  const out = [];
  for (const [cn, aliases] of Object.entries(LEX.cityAliases)) {
    if (aliases.some(a => hit(t, a))) out.push(cn);
  }
  return out;
}
export function uniq(a) { return [...new Set((a || []).filter(Boolean))]; }
export function hashId(s) { return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16); }
export function truncate(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
export function parseDate(v) {
  if (!v) return null;
  if (typeof v === "number") return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  const d = new Date(String(v).replace(/\//g, "-"));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
