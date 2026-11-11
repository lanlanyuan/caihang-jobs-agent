/* 抓取结果落盘：断网 / 未开启实时同步时，仍使用上次成功抓取的真实数据 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..");
export const CACHE_FILE = path.join(ROOT, "data", "jobs-cache.json");
export const SOURCES_FILE = path.join(ROOT, "config", "sources.json");

export function loadJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
export function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, file);
}
export function loadCache() {
  const c = loadJson(CACHE_FILE, null);
  if (!c || !Array.isArray(c.jobs) || !c.jobs.length) return null;
  return c;
}
