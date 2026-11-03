import { expect, test } from 'vitest';
import { checkCommitMessage } from './commit-message.ts';

test('accepts a well-formed message', () => {
  expect(
    checkCommitMessage(`feat: add gates

- forbidden words

Co-Authored-By: Claude <noreply@anthropic.com>
# git hint lines are not part of the message: 中文`),
  ).toEqual([]);
});

test('rejects a wrong type, missing summary, trailing period, Chinese text and missing blank line', () => {
  expect(checkCommitMessage('新增: 建立门禁')).toEqual([
    'first line must be <type>: <summary>, type is one of feat fix change refactor test docs deps chore',
    'message must be in English',
  ]);
  expect(checkCommitMessage('feature: add gates')).toHaveLength(1);
  expect(checkCommitMessage('feat:add gates')).toHaveLength(1);
  expect(checkCommitMessage('feat(core): add gates')).toHaveLength(1);
  expect(checkCommitMessage('feat!: add gates')).toHaveLength(1);
  expect(checkCommitMessage('feat: add gates.')).toEqual(['summary must not end with a period']);
  expect(checkCommitMessage('feat: add gates\n\n- 禁用词')).toEqual(['message must be in English']);
  expect(checkCommitMessage('feat: add gates\n- body right after')).toEqual(['first line must be followed by a blank line']);
});

test('ignores the diff that `git commit -v` appends below the scissors line', () => {
  expect(
    checkCommitMessage(`fix: keep rows

# ------------------------ >8 ------------------------
# Do not modify or remove the line above.
diff --git a/a.ts b/a.ts
-// 旧
+// 新`),
  ).toEqual([]);
});
