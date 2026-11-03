import { expect, test } from 'vitest';
import { ValidationError } from '../tables/validation.ts';
import { deserializeError, PendingWrites, serializeError } from './errors.ts';

// web 上 Worker 回给页面的错：经 postMessage 的结构化克隆之后还原

const across = (error: unknown) => deserializeError(structuredClone(serializeError(error)));

test('ValidationError 过了 Worker 的边界还是 ValidationError，带着表与字段路径；别的错只留消息，不叠上「Error: 」', () => {
  const original = new ValidationError('workout', [{ path: ['note'], message: '太长' }]);
  const restored = across(original);
  expect(restored).toBeInstanceOf(ValidationError);
  expect(restored).toMatchObject({ table: 'workout', issues: [{ path: ['note'], message: '太长' }], message: original.message });
  expect(across(new Error('本机库已关闭'))).toEqual(new Error('本机库已关闭'));
  expect(across('坏了')).toEqual(new Error('坏了'));
});

test('别的错带着 Worker 里的调用栈过去，页面报出时能定位', () => {
  const original = new Error('拉取出错');
  expect(across(original).stack).toBe(original.stack);
});

test('PendingWrites 过了 Worker 的边界还是 PendingWrites，带着上一个人与条数', () => {
  const restored = across(new PendingWrites('alice', 3));
  expect(restored).toBeInstanceOf(PendingWrites);
  expect(restored).toMatchObject({ owner: 'alice', count: 3 });
});
