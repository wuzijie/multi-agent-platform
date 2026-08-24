const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const orchestrator = require('../orchestrator/orchestrator');
const agentRuntime = require('../agent/runtime');
const eventBus = require('../eventbus/bus');
const worktreeManager = require('../worktree/manager');
const featureManager = require('../features/manager');
const config = require('../utils/config');
const scheduler = require('../engine/scheduler');
const { AGENT_NAMES } = require('../engine/events');
const blackboard = require('../blackboard/blackboard');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * API Server
 *
 * 提供 REST API + WebSocket 两种通信方式
 * REST API: 任务 CRUD、Agent 状态查询、文件导出
 * WebSocket: 实时推送任务状态变更、Agent 状态变更
 */
class ApiServer {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.port = process.env.PORT || 3000;
  }

  async start() {
    this._setupMiddleware();
    this._setupRestApi();
    this._setupWebSocket();
    this._setupStaticFiles();

    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`[ApiServer] Server running at http://localhost:${this.port}`);
        console.log(`[ApiServer] WebSocket available at ws://localhost:${this.port}/ws`);
        resolve();
      });
    });
  }

  _setupMiddleware() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use((req, res, next) => {
      // CORS for local development
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type, user_id');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });
  }

  _setupRestApi() {
    const api = express.Router();

    // ===== 健康检查 =====
    api.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // ===== 前端埋点日志 =====
    api.post('/analytics/log', (req, res) => {
      try {
        const { type, ...data } = req.body;
        const analyticsDir = path.join(ROOT, 'logs', 'analytics');
        if (!fs.existsSync(analyticsDir)) fs.mkdirSync(analyticsDir, { recursive: true });

        const filename = type ? `${type}.jsonl` : 'general.jsonl';
        const filePath = path.join(analyticsDir, filename);
        const entry = JSON.stringify({ ...data, type, server_time: new Date().toISOString() }) + '\n';
        fs.appendFileSync(filePath, entry);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== 任务相关 =====

    // 创建新任务
    api.post('/tasks', async (req, res) => {
      try {
        const task = await orchestrator.createTask({
          name: req.body.name,
          description: req.body.description,
          instruction: req.body.instruction,
          priority: req.body.priority,
          task_type: req.body.task_type,
          created_by: req.headers['user_id'] || 'user_default',
          input_files: req.body.input_files,
          executor_agent: req.body.executor_agent,
        });
        res.status(201).json(task);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 获取任务列表（支持筛选和排序）
    api.get('/tasks', (req, res) => {
      try {
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.difficulty) filter.difficulty = req.query.difficulty;
        if (req.query.created_by) filter.created_by = req.query.created_by;
        if (req.query.sort_by) filter.sort_by = req.query.sort_by;
        if (req.query.sort_order) filter.sort_order = req.query.sort_order;

        const tasks = orchestrator.getTasks(filter);
        res.json(tasks);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 获取单个任务详情
    api.get('/tasks/:taskId', (req, res) => {
      try {
        const task = orchestrator.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        res.json(task);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 获取事件驱动协作的任务列表（黑板子任务状态，供右侧面板展示）
    api.get('/tasks/:taskId/collab/state', (req, res) => {
      try {
        const task = orchestrator.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        // 始终扫描黑板取该 task_id 下 create_time 最新的 trace：
        // task.collab_trace_id 只在回合结束后才更新，执行中的新回合仍指向上一回合，
        // 若优先用它，右侧面板会被旧回合的任务列表覆盖（表现为新任务逐个出现）
        let best = null;
        for (const k of blackboard.keys('blackboard:task:')) {
          if (!k.endsWith(':main')) continue;
          const main = blackboard.hgetall(k);
          if (main && main.task_id === req.params.taskId) {
            if (!best || (main.create_time || 0) > (best.create_time || 0)) best = main;
          }
        }
        const traceId = (best && best.trace_id) || task.collab_trace_id || null;
        if (!traceId) return res.json({ trace_id: null, sub_tasks: [] });
        const state = scheduler.getTaskState(traceId);
        if (!state) return res.json({ trace_id: traceId, sub_tasks: [] });
        // 扁平化为前端易用结构（agent_id → 中文名，支持多 Agent 分配）
        const sub_tasks = (state.sub_tasks || []).map(s => {
          let agentLabel = '';
          const ids = Array.isArray(s.agents) && s.agents.length ? s.agents : (s.agent_id ? [s.agent_id] : []);
          if (ids.length) agentLabel = ids.map(id => AGENT_NAMES[id] || id).join('、');
          return {
            sub_task_id: s.sub_task_id,
            type: s.type || '',
            status: s.status || 'PENDING',
            agent: agentLabel,
            input: s.input || '',
            output: s.output || '',
            error_msg: s.error_msg || '',
          };
        });
        res.json({ trace_id: traceId, overall_status: state.overall_status || '', sub_tasks });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 获取任务对话记录
    api.get('/tasks/:taskId/conversation', (req, res) => {
      try {
        const task = orchestrator.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        const conversation = orchestrator.getConversation(req.params.taskId);
        res.json({ task_id: req.params.taskId, conversation, task });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 获取任务输出文件列表
    api.get('/tasks/:taskId/outputs', (req, res) => {
      try {
        const outputs = orchestrator.getOutputFiles(req.params.taskId);
        res.json(outputs);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 下载单个输出文件
    api.get('/tasks/:taskId/outputs/:filename', (req, res) => {
      try {
        const filePath = path.join(ROOT, 'tasks', req.params.taskId, 'outputs', req.params.filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        res.sendFile(filePath);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 执行任务（用户发送消息）
    api.post('/tasks/:taskId/execute', async (req, res) => {
      try {
        const task = orchestrator.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        // 对话开始时不再评估复杂度，直接执行（@mention 路由 / 多Agent讨论 / 事件驱动协作）
        let result;
        result = await orchestrator.executeSimpleTask(req.params.taskId, req.body.message, {
          mentioned_agent: req.body.mentioned_agent,
          discussion_agents: req.body.discussion_agents,
          collab_mode: req.body.collab_mode,
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 继续已有任务的对话
    api.post('/tasks/:taskId/chat', async (req, res) => {
      try {
        const task = orchestrator.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        if (task.status === 'completed' || task.status === 'failed') {
          return res.status(400).json({ error: `Cannot continue task with status: ${task.status}. 请新建对话。` });
        }

        // 继续对话：默认由任务当前绑定的 Agent 回复，除非用户 @了其他 Agent（或 @多个进入讨论 / 事件驱动协作）
        let result;
        result = await orchestrator.executeSimpleTask(req.params.taskId, req.body.message, {
          mentioned_agent: req.body.mentioned_agent,
          discussion_agents: req.body.discussion_agents,
          collab_mode: req.body.collab_mode,
        });
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 结束当前对话（将任务标记为 completed）
    api.post('/tasks/:taskId/complete', async (req, res) => {
      try {
        const task = orchestrator.getTask(req.params.taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        const result = await orchestrator.terminateTask(req.params.taskId);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 终止任务
    api.post('/tasks/:taskId/terminate', async (req, res) => {
      try {
        const task = await orchestrator.terminateTask(req.params.taskId);
        res.json(task);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 批量导出任务
    api.post('/tasks/batch/export', (req, res) => {
      try {
        const { task_ids } = req.body;
        if (!task_ids || !Array.isArray(task_ids) || task_ids.length === 0) {
          return res.status(400).json({ error: 'task_ids is required' });
        }

        const exportData = orchestrator.exportTasks(task_ids);

        // 创建 zip 文件
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=tasks_export_${Date.now()}.zip`);

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const item of exportData) {
          const prefix = `task_${item.task.task_id}/`;

          // 添加 task.json
          archive.append(JSON.stringify(item.task, null, 2), { name: `${prefix}task.json` });

          // 添加对话记录
          archive.append(item.conversation, { name: `${prefix}conversation.md` });

          // 添加输出文件
          for (const output of item.outputs) {
            const outputPath = path.join(ROOT, output.path);
            if (fs.existsSync(outputPath)) {
              archive.file(outputPath, { name: `${prefix}outputs/${output.name}` });
            }
          }
        }

        archive.finalize();
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 批量删除任务
    api.post('/tasks/batch/delete', async (req, res) => {
      try {
        const { task_ids } = req.body;
        if (!task_ids || !Array.isArray(task_ids) || task_ids.length === 0) {
          return res.status(400).json({ error: 'task_ids is required' });
        }

        const userId = req.headers['user_id'] || 'user_default';
        const result = await orchestrator.deleteTasks(task_ids, userId);

        // 同时清理对应的 worktree
        for (const item of result.deleted) {
          await worktreeManager.cleanupWorktree(item.task_id);
        }

        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== Agent 状态相关 =====

    // 获取所有 Agent 状态
    api.get('/agents', (req, res) => {
      try {
        const states = agentRuntime.getAgentStates();
        res.json(states);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 获取单个 Agent 状态
    api.get('/agents/:name', (req, res) => {
      try {
        const state = agentRuntime.getAgentState(req.params.name);
        if (!state) return res.status(404).json({ error: 'Agent not found' });
        res.json(state);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== 特性清单相关 =====

    // 获取所有特性
    api.get('/features', (req, res) => {
      try {
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        const features = featureManager.listFeatures(filter);
        res.json(features);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 获取特性统计
    api.get('/features/stats', (req, res) => {
      try {
        const stats = featureManager.getStats();
        res.json(stats);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 创建特性
    api.post('/features', (req, res) => {
      try {
        const feature = featureManager.createFeature(
          req.body.name,
          req.body.description,
          req.body.associated_task
        );
        res.status(201).json(feature);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 更新特性
    api.put('/features/:featureId', (req, res) => {
      try {
        const feature = featureManager.updateFeature(req.params.featureId, req.body);
        res.json(feature);
      } catch (e) {
        res.status(e.message.includes('not found') ? 404 : 500).json({ error: e.message });
      }
    });

    // ===== Worktree 相关 =====

    // 获取 worktree 列表
    api.get('/worktrees', (req, res) => {
      try {
        const worktrees = worktreeManager.listWorktrees();
        res.json(worktrees);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== 事件查询 =====

    // 获取最近的事件
    api.get('/events', (req, res) => {
      try {
        const type = req.query.type;
        const count = parseInt(req.query.count) || 50;
        const events = type
          ? eventBus.getEventsByType(type, count)
          : eventBus.getRecentEvents(count);
        res.json(events);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // ===== 配置查询 =====

    // 获取用户列表
    api.get('/config/users', (req, res) => {
      res.json(config.users);
    });

    this.app.use('/api', api);
  }

  _setupWebSocket() {
    this.wss.on('connection', (ws) => {
      console.log('[WebSocket] Client connected');

      // 订阅事件推送
      const onEvent = (event) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(event));
        }
      };

      // FileEventBus.emit 对每个事件都会触发通配符 '*'
      // （且已逐个命名订阅过一遍，会导致 task:* 事件重复推送、前端重复刷新），
      // 因此这里只订阅 '*' 即可覆盖全部事件
      eventBus.on('*', onEvent);

      ws.on('close', () => {
        eventBus.off('*', onEvent);
        console.log('[WebSocket] Client disconnected');
      });

      // 接收前端消息
      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          console.log('[WebSocket] Received:', data);
        } catch (e) {
          // 忽略非 JSON 消息
        }
      });
    });

    // 定时推送 Agent 状态
    setInterval(() => {
      const states = agentRuntime.getAgentStates();
      this.wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify({
            timestamp: new Date().toISOString(),
            event_type: 'agent:heartbeat',
            data: states,
          }));
        }
      });
    }, 5000);
  }

  _setupStaticFiles() {
    // 提供前端静态文件
    const frontendDir = path.join(ROOT, 'frontend');
    if (fs.existsSync(frontendDir)) {
      this.app.use(express.static(frontendDir));
      // SPA 路由支持
      this.app.get('*', (req, res, next) => {
        // 不以 /api/ 开头的请求返回 index.html
        if (!req.path.startsWith('/api/') && !req.path.startsWith('/ws')) {
          const indexPath = path.join(frontendDir, 'index.html');
          if (fs.existsSync(indexPath)) {
            return res.sendFile(indexPath);
          }
        }
        next();
      });
    }
  }

  stop() {
    this.wss.close();
    this.server.close();
  }
}

module.exports = new ApiServer();
