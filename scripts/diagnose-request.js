#!/usr/bin/env node
/**
 * Agent 异常请求诊断 CLI
 *
 * 用法：
 *   node scripts/diagnose-request.js --task <task_id>          # 诊断整个任务的请求链路
 *   node scripts/diagnose-request.js --request <request_id>    # 诊断单次请求
 *   node scripts/diagnose-request.js --failed [--error-code TIMEOUT] [--agent 克劳德] [--task <task_id>]
 *   node scripts/diagnose-request.js --summary [--error-code TIMEOUT] [--agent 克劳德] [--task <task_id>]
 *
 * 示例：
 *   node scripts/diagnose-request.js --task task_20260829_103155_ad64cf58
 *   node scripts/diagnose-request.js --failed --error-code TIMEOUT
 *   node scripts/diagnose-request.js --summary
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const D = require(path.join(ROOT, 'src', 'utils', 'request-diagnose.js'));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i];
    else if (a === '--request') args.request = argv[++i];
    else if (a === '--failed') args.failed = true;
    else if (a === '--summary') args.summary = true;
    else if (a === '--error-code') args.errorCode = argv[++i];
    else if (a === '--agent') args.agent = argv[++i];
    else if (a === '--count') args.count = Number(argv[++i]) || 100;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let output;

  if (args.request) {
    output = D.diagnoseRequest(args.request);
  } else if (args.summary) {
    output = D.buildDiagnosisSummary({
      count: args.count,
      error_code: args.errorCode,
      agent_name: args.agent,
      task_id: args.task,
    });
  } else if (args.failed) {
    output = D.listFailed({
      count: args.count,
      error_code: args.errorCode,
      agent_name: args.agent,
      task_id: args.task,
    });
  } else if (args.task) {
    output = D.diagnoseTask(args.task);
  } else {
    output = [
      '用法:',
      '  node scripts/diagnose-request.js --task <task_id>',
      '  node scripts/diagnose-request.js --request <request_id>',
      '  node scripts/diagnose-request.js --failed [--error-code CODE] [--agent 名称] [--task <task_id>] [--count N]',
      '  node scripts/diagnose-request.js --summary [--error-code CODE] [--agent 名称] [--task <task_id>] [--count N]',
      '',
      '错误码: TIMEOUT | AUTH_REQUIRED | CLI_ERROR | EXECUTION_ERROR | EMPTY_RESPONSE | FATAL',
    ].join('\n');
  }

  console.log(output);
}

main();
