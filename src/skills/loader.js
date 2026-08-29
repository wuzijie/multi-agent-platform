/**
 * Skill 定义加载器
 *
 * Skill 以 .md 文件形式提供（skills/ 目录），格式：
 * - YAML frontmatter：id / name / description / params / tool / execution
 * - 正文：人类可读的技能定义 / 执行指令（prompt 型 skill 直接返回给模型）
 * - 提示词模板：正文中的 ```prompt <name> 代码块，{{变量}} 占位
 * - 内联脚本：正文中的 ```skill-execute 代码块
 *
 * 引擎（如 ToolRegistry）启动时加载解析。修改技能无需改代码。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

/**
 * 解析单个 Skill md 文件
 * @returns {{file, meta, body, prompts, script}} meta=frontmatter, prompts={name:模板},
 *   script=内联执行脚本（```skill-execute 代码块内容）或 null
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
  // 内联执行脚本：```skill-execute ... ```（可选，供 ToolRegistry 通用执行）
  let script = null;
  const sm = body.match(/```skill-execute[^\n]*\r?\n([\s\S]*?)```/);
  if (sm) script = sm[1].trim();
  return { file: filePath, meta, body, prompts, script };
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

module.exports = { parseSkillMd, loadAllSkills, loadSkill };
