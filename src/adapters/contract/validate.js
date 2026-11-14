/**
 * UnifiedInput 统一校验
 *
 * 注意：context 允许为空字符串。
 * resume（delta）模式下游标之后没有需要重复注入的历史时，context 就是空串——
 * 历史已经在同一 CLI 会话里，不能再要求调用方伪造一个占位上下文。
 */

const { ROLE } = require('./enums');

const REQUIRED = ['task_id', 'role', 'instruction'];

function validateUnifiedInput(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('UnifiedInput 不能为空');
  }
  for (const field of REQUIRED) {
    if (input[field] === undefined || input[field] === null || input[field] === '') {
      throw new Error(`Missing required field in UnifiedInput: ${field}`);
    }
  }
  if (typeof input.context !== 'string') {
    throw new Error('UnifiedInput.context must be a string（delta 模式允许为空串）');
  }
  if (!Object.values(ROLE).includes(input.role)) {
    throw new Error(`Invalid role: ${input.role}`);
  }
  return input;
}

module.exports = { validateUnifiedInput, REQUIRED };
