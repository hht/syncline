const subject = /^(新增|修复|调整|重构|测试|文档|依赖|工具): .*\p{Script=Han}/u;

/** 返回不合规的原因；git 的 # 提示行不属于提交说明 */
export function checkCommitMessage(message: string): string[] {
  const [first = '', second] = message.split('\n').filter((line) => !line.startsWith('#'));
  return [
    ...(subject.test(first) ? [] : ['首行须为 <类型>: <中文说明>，类型只有 新增 修复 调整 重构 测试 文档 依赖 工具']),
    ...(second ? ['首行后须空一行'] : []),
  ];
}
