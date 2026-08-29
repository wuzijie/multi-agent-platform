/**
 * 通用工具注册表（Tool Registry）-- skill 即 md 文件，工具定义与执行方式全部来自 md
 *
 * 每个 skill md（skills/*.md）：
 * - frontmatter.tool：name / description / parameters（暴露给大模型的工具定义）
 * - frontmatter.execution：执行方式
 *     type: module           -> require 一个 JS 模块（模块导出 handler(args, ctx)）
 *        module: <相对项目根的路径>（默认 src/skills/<id>.js）
 *     type: inline           -> 用正文里的 ```skill-execute 代码块作为执行脚本
 *        （代码块内 module.exports = async function(args, ctx){...}）
 * - 无 tool 段的 skill 不暴露为工具（纯文档/提示词型）
 *
 * 新增 skill = 新增一个 md 文件，无需改任何 JS。执行模块懒加载（避免加载期循环依赖）。
 *
 * 调用机制（伪 FC，CLI 通用）：
 * - getToolPrompt() 生成工具说明注入 prompt，模型输出 [TOOL_CALL]{json}[/TOOL_CALL]
 * - agentRuntime 解析标记后调 execute()，结果回灌模型继续生成
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { loadAllSkills } = require('../skills/loader');

const ROOT = path.resolve(__dirname, '..', '..');
// 供内联脚本 require 项目模块（相对项目根解析）
const rootRequire = createRequire(path.join(ROOT, 'package.json'));

class ToolRegistry {
  constructor() {
    this._tools = new Map(); // name -> { name, description, parameters, execution, skill_id, file }
    this._ready = false;
  }

  /** 扫描 skills/*.md 加载工具定义（元数据；执行模块在 execute 时懒加载） */
  init() {
    if (this._ready) return this;
    this._tools.clear();
    try {
      const skills = loadAllSkills();
      for (const [id, def] of skills) {
        const meta = def.meta || {};
        const t = meta.tool;
        if (!t || !t.name) continue;            // 无 tool 段的 skill 不暴露为工具
        if (t.enabled === false || meta.enabled === false) continue;
        this._tools.set(t.name, {
          name: t.name,
          description: t.description || '',
          parameters: t.parameters || { type: 'object', properties: {} },
          execution: meta.execution || { type: 'prompt' }, // prompt | module | inline
          script: def.script || null,           // 内联脚本（```skill-execute）
          body: def.body || '',                 // md 正文（prompt 型执行时返回给模型）
          skill_id: id,
          file: def.file,
          _handler: null,                        // 懒加载缓存
        });
      }
      console.log(`[ToolRegistry] 已从 skills/*.md 加载 ${this._tools.size} 个工具: ${Array.from(this._tools.keys()).join(', ')}`);
    } catch (e) {
      console.error('[ToolRegistry] 加载失败:', e.message);
    }
    this._ready = true;
    return this;
  }

  /** 热加载（修改 skills/*.md 后调用） */
  reload() {
    this._ready = false;
    this.init();
  }

  /** 手动注册 JS 工具（无 md 定义时的兜底入口） */
  register(tool) {
    this.init();
    if (!tool || !tool.name) throw new Error('工具缺少 name');
    this._tools.set(tool.name, Object.assign({ execution: { type: 'module' }, script: null, skill_id: null, file: null, _handler: null }, tool));
  }

  /** 工具列表（含 schema，来自 md） */
  list() {
    this.init();
    return Array.from(this._tools.values());
  }
  getToolSchemas() {
    return this.list().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      },
    }));
  }

  /** 注入模型 prompt 的工具说明（伪 FC 用） */
  getToolPrompt() {
    const tools = this.list();
    if (tools.length === 0) return '';
    const lines = ['你可以调用以下工具完成任务：'];
    for (const t of tools) {
      const props = (t.parameters && t.parameters.properties) || {};
      const pstr = Object.keys(props)
        .map((k) => `${k}(${props[k].type || 'any'}): ${props[k].description || ''}`)
        .join(', ');
      const req = ((t.parameters && t.parameters.required) || []).join(',');
      lines.push(`- ${t.name}：${t.description || ''}`);
      lines.push(`    参数：${pstr || '无'}（必填：${req || '无'}）`);
    }
    lines.push('');
    lines.push('当需要调用工具时，在回复中输出如下标记（仅一处），然后停止：');
    lines.push('[TOOL_CALL]{"name":"工具名","arguments":{参数对象}}[/TOOL_CALL]');
    lines.push('调用工具后会收到工具结果，据此继续完成最终回复。');
    return lines.join('\n');
  }

  /** 执行工具（懒加载执行模块） */
  async execute(name, args, ctx = {}) {
    this.init();
    const tool = this._tools.get(name);
    if (!tool) return `错误：未知工具「${name}」`;
    let parsedArgs = args;
    if (typeof args === 'string') {
      try { parsedArgs = JSON.parse(args); } catch (e) { parsedArgs = { _raw: args }; }
    }
    try {
      const handler = this._loadHandler(tool);
      const result = await handler(parsedArgs || {}, ctx);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e) {
      return `工具「${name}」执行失败：${e.message}`;
    }
  }

  /** 按 md 声明的 execution 加载执行 handler（懒加载 + 缓存） */
  _loadHandler(tool) {
    if (tool._handler) return tool._handler;
    const exec = tool.execution || {};
    let handler = null;
    if (exec.type === 'prompt') {
      // prompt 型：模型调用时，把 skill 的 md 正文（执行指令）作为工具结果返回，
      // 由模型按指令自行完成。结果里附加用户传入的参数，供模型对齐。
      const body = tool.body || '(该 skill 无指令正文)';
      handler = (args) => `【${tool.name} 技能指令】\n\n${body}\n\n【本次调用参数】\n${JSON.stringify(args, null, 2)}\n\n请严格按上述指令执行，并把完整结果作为最终回复输出。`;
    } else if (exec.type === 'inline') {
      if (!tool.script) throw new Error('execution.type=inline 但 md 无 ```skill-execute 代码块');
      handler = this._compileInline(tool.script, tool.file);
    } else {
      // module：require 相对项目根的 JS 模块，取导出 handler
      const rel = exec.module || `src/skills/${tool.skill_id}.js`;
      const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
      const mod = require(abs);
      if (typeof mod === 'function') handler = mod;                                  // 直接导出函数
      else if (mod.handler) handler = mod.handler.bind(mod);                         // 导出 { handler }（绑定 this=模块）
      else if (mod.default && mod.default.handler) handler = mod.default.handler.bind(mod.default); // ESM 风格
      else throw new Error(`skill ${tool.name}（${abs}）未导出 handler(args, ctx)`);
    }
    tool._handler = handler;
    return handler;
  }

  /** 编译内联执行脚本（md 的 ```skill-execute 块）为 handler 函数 */
  _compileInline(code, file) {
    // eslint-disable-next-line no-new-func
    const factory = new Function('module', 'exports', 'require', 'args', 'ctx', '__dirname', '__filename',
      `${code}\n;return module.exports;`);
    const mod = { exports: {} };
    factory(mod, mod.exports, rootRequire, null, null, path.dirname(path.join(ROOT, file)), path.join(ROOT, file));
    const fn = mod.exports;
    if (typeof fn !== 'function' && fn && typeof fn.handler === 'function') return fn.handler;
    if (typeof fn !== 'function') throw new Error(`内联脚本 ${file} 需 module.exports = async function(args, ctx){...}`);
    return fn;
  }
}

const instance = new ToolRegistry();

// ===== 从文本解析工具调用块（CLI 伪 FC）=====
const TOOL_CALL_RE = /\[TOOL_CALL\]\s*([\s\S]*?)\s*\[\/TOOL_CALL\]/;
function parseToolCallsFromText(text) {
  if (!text) return null;
  const m = text.match(TOOL_CALL_RE);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1].trim());
    if (!obj || !obj.name) return null;
    return {
      tool_calls: [{ id: `call_${Date.now()}`, name: obj.name, arguments: obj.arguments || obj.args || {} }],
      remaining: text.replace(TOOL_CALL_RE, '').trim(),
    };
  } catch (e) {
    return null;
  }
}

instance.ToolRegistry = ToolRegistry;
instance.parseToolCallsFromText = parseToolCallsFromText;
module.exports = instance;
