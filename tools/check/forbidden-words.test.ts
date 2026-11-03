import { expect, test } from 'vitest';
import { checkForbiddenWords } from './forbidden-words.ts';

const rules = (path: string, text: string) => checkForbiddenWords([{ path, text }]).map((p) => `${p.line} ${p.message}`);

test('本仓声明的名字含禁用词被拦下', () => {
  expect(
    rules(
      'a.ts',
      `class WorkoutManager {}
const userData = 1;
function handleTap() {}
export const doSave = () => {};`,
    ),
  ).toEqual([
    '1 WorkoutManager 含禁用词 Manager，改用说得出做什么的词',
    '2 userData 含禁用词 Data，改用说得出做什么的词',
    '3 handleTap 含禁用词 handle，改用说得出做什么的词',
    '4 doSave 含禁用词 do，改用说得出做什么的词',
  ]);
});

test('框架写法、第三方引用、形近词放行', () => {
  expect(
    rules(
      'a.tsx',
      `import { processColor } from 'react-native';
function useWorkout() { return processColor('red'); }
const AuthProvider = () => null;
const doneAt = 1;
const data = 2;`,
    ),
  ).toEqual([]);
});

test('外部规定的名字（第三方的全局对象）放行，本仓自己起的同类名字照拦', () => {
  expect(rules('a.ts', `const handler = ErrorUtils.reportError;\nconst paymentInfo = 1;`)).toEqual([
    '2 paymentInfo 含禁用词 Info，改用说得出做什么的词',
  ]);
});

test('小写开头的禁用词也被拦下', () => {
  expect(rules('a.ts', 'const utils = {};')).toEqual(['1 utils 含禁用词 Utils，改用说得出做什么的词']);
});

test('文件名含禁用词被拦下', () => {
  expect(rules('src/date-utils.ts', '')).toEqual(['1 date-utils.ts 含禁用词 Utils，改用说得出做什么的词']);
  expect(rules('src/workout-helper.web.ts', '')).toEqual(['1 workout-helper.web.ts 含禁用词 Helper，改用说得出做什么的词']);
});

test('产品代码的名字、注释与字符串里不提接入方的项目；按整词找，oneof 这类形近词放行；tools/ 不查', () => {
  const text = `// 照 neo 的写法\nconst NeoSet = fc.oneof(a, b);\nconst label = 'Boostcamp';`;
  const message = '不提接入方的项目：Syncline 独立于接入方，写通用的规则与例子';
  expect(rules('src/a.ts', text)).toEqual([`1 ${message}`, `2 ${message}`, `3 ${message}`]);
  expect(rules('tools/check/a.ts', text)).toEqual([]);
});

test('写来历或含糊动作的词被拦下（旧、临时、迁移、apply、split）；同步（sync）照常用；hold、template 这类形近词放行', () => {
  const text = `const oldConfig = 1;
const tempDir = 2;
function migrateUser() {}
function applyPatch() {}
const splitUser = 3;
const syncState = 4;
const legacyItems = 5;
const holdTime = 6;
const template = 7;`;
  expect(rules('a.ts', text)).toEqual([
    '1 oldConfig 含禁用词 Old，改用说得出做什么的词',
    '2 tempDir 含禁用词 Temp，改用说得出做什么的词',
    '3 migrateUser 含禁用词 Migrate，改用说得出做什么的词',
    '4 applyPatch 含禁用词 Apply，改用说得出做什么的词',
    '5 splitUser 含禁用词 Split，改用说得出做什么的词',
    '7 legacyItems 含禁用词 Legacy，改用说得出做什么的词',
  ]);
});

test('page 说不清是界面还是数据的一段，被拦下（界面叫 screen、同步的一段叫 chunk、分批叫 batch）；pageant 这类形近词放行', () => {
  const text = `const lastPage = 1;
function readPages() {}
const pagedItems = 2;
const paging = 3;
const pageant = 4;`;
  expect(rules('a.ts', text)).toEqual([
    '1 lastPage 含禁用词 Page，改用说得出做什么的词',
    '2 readPages 含禁用词 Pages，改用说得出做什么的词',
    '3 pagedItems 含禁用词 Paged，改用说得出做什么的词',
    '4 paging 含禁用词 Paging，改用说得出做什么的词',
  ]);
});

test('log 说不清记的是什么，被拦下；catalog、login 是别的词', () => {
  const text = `const log = 1;
const changeLogs = 2;
const logger = 3;
const catalog = 4;
const login = 5;`;
  expect(rules('a.ts', text)).toEqual([
    '1 log 含禁用词 Log，改用说得出做什么的词',
    '2 changeLogs 含禁用词 Logs，改用说得出做什么的词',
    '3 logger 含禁用词 Logger，改用说得出做什么的词',
  ]);
});

test('名字里不带版本号；p95 这类不是版本号', () => {
  expect(rules('a.ts', 'const finishedV2At = 1;\nconst coach_v2 = 2;\nconst p95 = 3;')).toEqual([
    '1 finishedV2At 含版本号 V2，按意义起名',
    '2 coach_v2 含版本号 v2，按意义起名',
  ]);
});

test('目录名按标识符查', () => {
  expect(rules('src/features/legacy/index.ts', '')).toEqual(['1 目录 src/features/legacy 含禁用词 Legacy，改用说得出做什么的词']);
});

test('配置文件里同样不提接入方的项目；不按标识符查', () => {
  const message = '不提接入方的项目：Syncline 独立于接入方，写通用的规则与例子';
  expect(rules('src/cloudflare/wrangler.jsonc', '{\n  "name": "neo-sync",\n  "legacy": true\n}')).toEqual([`2 ${message}`]);
});

test('Rust 的名字转成驼峰再查，报出时照写原名；enum 变体、字段、参数也查', () => {
  expect(
    rules(
      'rust/core/src/upload_helper.rs',
      `const SHRINK_PAGES: u32 = 1;
struct ColumnInfo { row_data: u8 }
enum Message { TempHeld }
fn handle_poke(user_data: u8) { let do_it = 1; }`,
    ),
  ).toEqual([
    '1 upload_helper.rs 含禁用词 Helper，改用说得出做什么的词',
    '1 SHRINK_PAGES 含禁用词 Pages，改用说得出做什么的词',
    '2 ColumnInfo 含禁用词 Info，改用说得出做什么的词',
    '2 row_data 含禁用词 Data，改用说得出做什么的词',
    '3 TempHeld 含禁用词 Temp，改用说得出做什么的词',
    '4 handle_poke 含禁用词 handle，改用说得出做什么的词',
    '4 user_data 含禁用词 Data，改用说得出做什么的词',
    '4 do_it 含禁用词 do，改用说得出做什么的词',
  ]);
});
