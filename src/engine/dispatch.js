/**
 * 调度器子任务分发与回调处理（从 scheduler.js 提取，通过 prototype 赋值接入）
 * this 指向 Scheduler 实例
 */
const blackboard = require('../blackboard/blackboard');
const CollabLogger = require('../utils/collab-logger');
const { isFatalError, markAgentFatal, isAgentFatal, fatalAgents } = require('../utils/fatal-errors');
const { EVENTS, SUB_STATUS, TASK_TYPES, AGENT_IDS, AGENT_NAMES, genSubTaskId, buildMessage } = require('./events');

// 指数退避（与 scheduler.js 一致）
const BACKOFF_MS = [0, 1000, 3000, 5000, 10000];

module.exports = {
  async _dispatchSubTask(traceId, sub) {
    // 优先使用拆解时主agent指定的模型（preferred_agent）；不在线/熔断/未指定则能力匹配兜底
    let agentNames = [];
    if (sub.preferred_agent && this.profiles.has(sub.preferred_agent) && !isAgentFatal(sub.preferred_agent)) {
      const p = this.profiles.get(sub.preferred_agent);
      if (p.status !== 'offline') agentNames = [sub.preferred_agent]; // busy 也可并发使用
    }
    if (agentNames.length === 0) {
      agentNames = this._matchAgents(sub.type, this.agentsPerTask, traceId);
    }
    if (agentNames.length === 0) {
      // 区分两种"无可用"：有存活模型（等待重试）vs 全部熔断/离线（快速失败，重试必然同样失败白烧 token）
      const online = Array.from(this.profiles.values()).filter(p => p.status !== 'offline');
      const alive = online.filter(p => !isAgentFatal(p.name));
      if (alive.length > 0) {
        // 有在线可用模型但本次未匹配到：暂存等待，通过心跳恢复后重试调度
        console.log(`[Scheduler] 无可用 Agent 匹配，子任务 ${sub.sub_task_id} 等待重试`);
        setTimeout(() => this._dispatchReady(traceId), 3000);
        return;
      }
      // 全部熔断或离线：快速失败，不再等待/重试（重试必然同样 402/鉴权失败，白烧 token）
      const reason = `所有模型均不可用（熔断: ${fatalAgents().join('、')} / 离线），已跳过重试，请检查账户或配置后重试`;
      console.warn(`[Scheduler] ${reason}`);
      CollabLogger.log('sub_fail', {
        trace_id: traceId, sub_task_id: sub.sub_task_id,
        error: reason, fatal: fatalAgents(),
      });
      const subKey = `blackboard:task:${traceId}:sub:${sub.sub_task_id}`;
      blackboard.hset(subKey, 'status', SUB_STATUS.FAILED);
      blackboard.hset(subKey, 'error_msg', reason);
      blackboard.hset(subKey, 'end_time', Date.now());
      this._emitSubUpdate(traceId, sub, SUB_STATUS.FAILED, null);
      this._dispatchReady(traceId); // 触发整体完结判定（该子任务 FAILED -> 顶层失败）
      return;
    }

    const subKey = `blackboard:task:${traceId}:sub:${sub.sub_task_id}`;
    const agentIds = agentNames.map(n => AGENT_IDS[n] || n);
    blackboard.hset(subKey, 'agents', JSON.stringify(agentIds));
    blackboard.hset(subKey, 'agent_id', agentIds[0]);
    blackboard.hset(subKey, 'status', SUB_STATUS.RUNNING);
    blackboard.hset(subKey, 'start_time', Date.now());
    blackboard.hset(subKey, 'retry_count', sub.retry_count || 0);

    // 运行中标记（僵尸检测，方案 §2.3.5）
    blackboard.setex(`blackboard:running:${sub.sub_task_id}`, this.timeoutMs, '1');

    for (const n of agentNames) this._setBusy(n, true);

    // 推送：多个 Agent 已接受任务（RUNNING + agent 名）
    this._emitSubUpdate(traceId, sub, SUB_STATUS.RUNNING, agentNames.join('、'));

    // 组装任务输入
    const mainKey = `blackboard:task:${traceId}:main`;
    const userQuery = blackboard.hget(mainKey, 'user_query') || '';
    const externalTaskId = blackboard.hget(mainKey, 'task_id') || traceId;

    // ===== 模型间通信：把直接依赖（上游子任务）的输出注入上下文 =====
    // 下游模型据此看到上游模型的产出（如「基于已搜集的素材」中的素材），
    // 修复依赖子任务收不到上游输出导致执行偏差的问题。
    let deps = sub.deps;
    if (typeof deps === 'string') {
      try { deps = JSON.parse(deps); } catch (e) { deps = []; }
    }
    if (!Array.isArray(deps)) deps = [];
    const DEP_OUTPUT_MAX = 8000; // 单个上游输出最多注入 8000 字符（防上下文爆炸）
    const upstreamParts = [];
    const upstreamSummary = [];
    for (const depId of deps) {
      const depSub = blackboard.hgetall(`blackboard:task:${traceId}:sub:${depId}`);
      if (!depSub || !depSub.sub_task_id) continue;
      const depOutput = depSub.output || '';
      if (!depOutput) continue; // 上游无输出（理论不会发生：DAG 保证 SUCCESS 才就绪）
      const depAgents = this._agentNamesFromSub(depSub).join('、') || '上游模型';
      const truncated = depOutput.length > DEP_OUTPUT_MAX
        ? depOutput.slice(0, DEP_OUTPUT_MAX) + `\n…（输出过长已截断，共 ${depOutput.length} 字符）`
        : depOutput;
      upstreamParts.push(`【上游子任务 ${depId} 的输出（由 ${depAgents} 完成）】\n${truncated}`);
      upstreamSummary.push({ dep_id: depId, agents: depAgents, chars: depOutput.length, preview: depOutput });
    }
    const upstreamContext = upstreamParts.length > 0
      ? `\n\n=== 上游任务输出（供参考，据此完成本子任务） ===\n${upstreamParts.join('\n\n---\n\n')}`
      : '';

    const subTask = {
      task_id: sub.sub_task_id,
      trace_id: traceId,
      external_task_id: externalTaskId, // 关联外部平台 task_id（流式事件/UI 用）
      type: sub.type || '',
      role: sub.role || 'executor',
      context: `任务ID: ${traceId}\n子任务: ${sub.sub_task_id}\n类型: ${sub.type}\n原始请求: ${userQuery}\n参与模型: ${agentNames.join('、')}${upstreamContext}`,
      instruction: sub.input || '',
      input_files: [],
    };

    // 协作日志：记录下发（模型分配 + 注入的上游模型输出 = 模型间消息传递）
    CollabLogger.logDispatch(traceId, sub, agentNames, upstreamSummary);

    // 超时监控
    const timer = setTimeout(() => {
      this._onTimeout(traceId, sub.sub_task_id);
    }, this.timeoutMs);
    this._timers.set(sub.sub_task_id, timer);

    // 并行执行：多个 Agent 各自执行同一子任务（executor 内部负责流式事件）
    const settled = await Promise.allSettled(agentNames.map(n => this._runExecutor(subTask, n, undefined)));

    // 清理超时定时器
    if (this._timers.has(sub.sub_task_id)) {
      clearTimeout(this._timers.get(sub.sub_task_id));
      this._timers.delete(sub.sub_task_id);
    }

    // 分类各 Agent 结果
    const okResults = [];
    const failResults = [];
    const outputsMap = {};
    settled.forEach((r, idx) => {
      const n = agentNames[idx];
      const agentId = AGENT_IDS[n] || n;
      if (r.status === 'fulfilled' && r.value && r.value.content && !(r.value.status === 'failed' || r.value.error)) {
        okResults.push({ agent: n, content: r.value.content, duration: r.value.duration_ms || 0 });
        outputsMap[agentId] = r.value.content;
        CollabLogger.logAgentResult(traceId, sub.sub_task_id, n, true, r.value.content, r.value.duration_ms || 0);
      } else {
        const err = (r.reason && r.reason.message) || (r.value && r.value.error && r.value.error.message) || 'Agent 执行失败';
        failResults.push({ agent: n, error: err });
        outputsMap[agentId] = { error: err };
        CollabLogger.logAgentResult(traceId, sub.sub_task_id, n, false, err, (r.value && r.value.duration_ms) || 0);
        // 致命错误（402/鉴权/Invalid role 等）：熔断该模型，后续派发自动跳过
        if (isFatalError(err)) markAgentFatal(n);
      }
    });
    blackboard.hset(subKey, 'outputs', JSON.stringify(outputsMap));

    // 推送子任务执行完成（供 orchestrator 写入对话，展示过程中各模型的输出）
    this.eventBus.emit('collab:subtask:done', {
      task_id: externalTaskId,
      trace_id: traceId,
      sub_task_id: sub.sub_task_id,
      type: sub.type || '',
      status: okResults.length > 0 ? SUB_STATUS.SUCCESS : SUB_STATUS.FAILED,
      agents_outputs: okResults.map(r => ({ agent: r.agent, content: r.content })),
      errors: failResults.map(f => ({ agent: f.agent, error: f.error })),
    });

    if (okResults.length === 0) {
      // 全部失败 → 失败事件（走重试/失败判定）
      const errorMsg = failResults.map(f => `${f.agent}: ${f.error}`).join('; ');
      // 模型被其他对话占用（BUSY）：不计入重试次数，像「无空闲 Agent」一样等待重派，
      // 避免 3 次 BUSY 就把子任务判死（多对话并行时另一个对话正在用该模型）
      if (failResults.length > 0 && failResults.every(f => (f.error || '').includes('正被其他对话使用') || (f.error || '').includes('BUSY'))) {
        console.log(`[Scheduler] 子任务 ${sub.sub_task_id} 模型被其他对话占用，3s 后重试调度`);
        blackboard.hset(`blackboard:task:${traceId}:sub:${sub.sub_task_id}`, 'status', SUB_STATUS.PENDING);
        this._emitSubUpdate(traceId, sub, SUB_STATUS.PENDING, null);
        setTimeout(() => this._dispatchReady(traceId), 3000);
        return;
      }
      const failMsg = buildMessage({
        traceId,
        subTaskId: sub.sub_task_id,
        msgType: EVENTS.SUB_TASK_FAIL,
        senderAgent: 'scheduler',
        receiverAgent: 'scheduler',
        output: {},
        errorMsg,
        errorCode: (failResults.length > 0 && failResults.every(f => isFatalError(f.error)))
          ? 'FATAL' // 致命错误（402/鉴权等）：不重试 + 熔断对应模型
          : 'ALL_AGENTS_FAILED',
        timeoutMs: this.timeoutMs,
      });
      this.eventBus.emit(EVENTS.SUB_TASK_FAIL, failMsg);
      return;
    }

    // 综合：REVIEW/SUMMARY 合并多个模型意见；执行类取主结果（第一个成功）
    let combined;
    if (sub.type === TASK_TYPES.REVIEW || sub.type === TASK_TYPES.SUMMARY) {
      combined = okResults.map(r => `**${r.agent}**\n${r.content}`).join('\n\n---\n\n');
    } else {
      combined = okResults[0].content;
    }

    const successMsg = buildMessage({
      traceId,
      subTaskId: sub.sub_task_id,
      msgType: EVENTS.SUB_TASK_SUCCESS,
      senderAgent: 'scheduler',
      receiverAgent: 'scheduler',
      taskDeps: [],
      output: { content: combined },
      costMs: okResults.reduce((s, r) => s + r.duration, 0),
      timeoutMs: this.timeoutMs,
    });
    this.eventBus.emit(EVENTS.SUB_TASK_SUCCESS, successMsg);
  }
,
  async _runExecutor(subTask, agentName, onChunk) {
    if (this.executor && this.executor.run) {
      return this.executor.run(subTask, agentName, onChunk);
    }
    throw new Error('Scheduler executor 未注入');
  }
,
  async _onSubTaskFinish(msg, ok) {
    const { trace_id: traceId, sub_task_id: subId } = msg.msg_meta;
    const subKey = `blackboard:task:${traceId}:sub:${subId}`;
    const sub = blackboard.hgetall(subKey);
    if (!sub || sub.status !== SUB_STATUS.RUNNING) {
      // 已超时/已处理，忽略迟到回调
      return;
    }

    // 清理超时定时器 + 运行中标记
    const timer = this._timers.get(subId);
    if (timer) { clearTimeout(timer); this._timers.delete(subId); }
    blackboard.del(`blackboard:running:${subId}`);

    // 释放该子任务占用的所有 Agent
    this._releaseAgents(sub);

    const agentLabel = this._agentNamesFromSub(sub).join('、');

    if (ok) {
      const output = (msg.task_result && msg.task_result.output) || {};
      blackboard.hset(subKey, 'status', SUB_STATUS.SUCCESS);
      blackboard.hset(subKey, 'output', output.content || '');
      blackboard.hset(subKey, 'end_time', Date.now());
      // 推送：任务完成（前端打对勾）
      this._emitSubUpdate(traceId, sub, SUB_STATUS.SUCCESS, agentLabel);
    } else {
      const retryCount = (sub.retry_count || 0) + 1;
      const maxRetry = sub.max_retry || 3;
      const errorMsg = (msg.task_result && msg.task_result.error_msg) || 'Unknown error';
      const errorCode = (msg.task_result && msg.task_result.error_code) || '';
      // 致命错误（402/鉴权/Invalid role 等）：重试必然同样失败，直接 FAILED，不再烧 token
      if (errorCode === 'FATAL' || isFatalError(errorMsg)) {
        blackboard.hset(subKey, 'status', SUB_STATUS.FAILED);
        blackboard.hset(subKey, 'error_msg', `${errorMsg}（致命错误，已跳过重试）`);
        blackboard.hset(subKey, 'end_time', Date.now());
        CollabLogger.logSubFail(traceId, subId, `${errorMsg} [FATAL no-retry]`);
        this._emitSubUpdate(traceId, sub, SUB_STATUS.FAILED, agentLabel);
        this._dispatchReady(traceId);
        return;
      }
      if (retryCount <= maxRetry) {
        // 触发重试（指数退避）
        blackboard.hset(subKey, 'status', SUB_STATUS.RETRYING);
        blackboard.hset(subKey, 'retry_count', retryCount);
        blackboard.hset(subKey, 'error_msg', errorMsg);
        this._emitSubUpdate(traceId, sub, SUB_STATUS.RETRYING, agentLabel);
        const backoff = BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length - 1)] || 1000;
        CollabLogger.logRetry(traceId, subId, retryCount, maxRetry, backoff, errorMsg);
        const retryMsg = buildMessage({
          traceId, subTaskId: subId,
          msgType: EVENTS.SUB_TASK_RETRY,
          senderAgent: 'scheduler',
          taskInput: { retry_count: retryCount },
          errorMsg, errorCode: (msg.task_result && msg.task_result.error_code) || 'RETRY',
          timeoutMs: this.timeoutMs,
        });
        setTimeout(() => {
          this.eventBus.emit(EVENTS.SUB_TASK_RETRY, retryMsg);
        }, backoff);
        return;
      }
      // 重试耗尽 → FAILED
      blackboard.hset(subKey, 'status', SUB_STATUS.FAILED);
      blackboard.hset(subKey, 'error_msg', errorMsg);
      blackboard.hset(subKey, 'end_time', Date.now());
      CollabLogger.logSubFail(traceId, subId, errorMsg);
      this._emitSubUpdate(traceId, sub, SUB_STATUS.FAILED, agentLabel);
    }

    // 触发依赖就绪重新调度
    this._dispatchReady(traceId);
  }
,
  async _onSubTaskRetry(msg) {
    const traceId = msg.msg_meta.trace_id;
    const subId = msg.msg_meta.sub_task_id;
    const sub = blackboard.hgetall(`blackboard:task:${traceId}:sub:${subId}`);
    if (!sub) return;
    // 重置为 PENDING，重新调度（状态 RETRYING → 重新下发）
    blackboard.hset(`blackboard:task:${traceId}:sub:${subId}`, 'status', SUB_STATUS.PENDING);
    this._emitSubUpdate(traceId, sub, SUB_STATUS.PENDING, null);
    this._dispatchReady(traceId);
  }

  // ===== 超时处理（方案 §5.1.2 僵尸任务）=====
,
};