/**
 * Skill 定义加载器
 *
 * Skill 以 .md 文件形式提供（skills/ 目录），格式：
 * - YAML frontmatter：id / name / description / triggers（触发关键词）/ params（执行参数）
 * - 正文：人类可读的技能标准化定义
 * - 提示词模板：正文中的 ```prompt <name> 代码块，{{变量}} 占位
 *
 * 引擎（如 src/skills/deep-research.js）启动时加载解析：触发词、参数、提示词
 * 全部来自 md，修改技能无需改代码；md 缺失/解析失败时引擎使用内置兜底。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

/**
 * 解析单个 Skill md 文件
 * @returns {{file, meta, body, prompts}} meta 为 frontmatter 对象，prompts 为 {name: 模板字符串}
 */
function parseSkillMd(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // frontmatter
  let meta = {};
  let body = raw;
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    meta = yaml.load(fm[1]) || {};
    body = raw.slice(fm[0].length);
  }
  // 提示词模板：```prompt <name> ... ```
  const prompts = {};
  const re = /```prompt\s+([A-Za-z0-9_]+)[^\n]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(body))) {
    prompts[m[1]] = m[2].trim();
  }
  return { file: filePath, meta, body, prompts };
}

/**
 * 加载 skills/ 目录下全部 .md Skill 定义
 * @returns {Map<string, object>} 以 meta.id 为 key
 */
function loadAllSkills(dir = SKILLS_DIR) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    try {
      const def = parseSkillMd(path.join(dir, f));
      if (def.meta && def.meta.id && def.meta.enabled !== false) {
        out.set(def.meta.id, def);
      }
    } catch (e) {
      console.error(`[SkillLoader] 解析失败 ${f}:`, e.message);
    }
  }
  return out;
}

/**
 * 加载单个 Skill 定义（按 id 匹配 frontmatter.id）
 * @returns {object|null}
 */
function loadSkill(id, dir = SKILLS_DIR) {
  const all = loadAllSkills(dir);
  return all.get(id) || null;
}

/**
 * 渲染提示词模板（{{var}} 占位替换）
 */
function renderTemplate(tpl, vars = {}) {
  if (!tpl) return '';
  return tpl.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key) => (
    key in vars ? String(vars[key]) : whole
  ));
}

module.exports = { parseSkillMd, loadAllSkills, loadSkill, renderTemplate, SKILLS_DIR };
