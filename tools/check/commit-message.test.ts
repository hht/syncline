import { expect, test } from 'vitest';
import { checkCommitMessage } from './commit-message.ts';

test('合格的提交说明通过', () => {
  expect(
    checkCommitMessage(`新增: 建立门禁脚本

- 禁用词检查

Co-Authored-By: Claude <noreply@anthropic.com>
# git 的提示行不算正文`),
  ).toEqual([]);
});

test('类型、说明、空行不合规被拦下', () => {
  expect(checkCommitMessage('feat: add gates')).toEqual(['首行须为 <类型>: <中文说明>，类型只有 新增 修复 调整 重构 测试 文档 依赖 工具']);
  expect(checkCommitMessage('新增:建立门禁')).toHaveLength(1);
  expect(checkCommitMessage('新增: add gates')).toHaveLength(1);
  expect(checkCommitMessage('新增: 建立门禁\n- 紧跟正文')).toEqual(['首行后须空一行']);
});
