import { Reject } from '../common/storage.ts';
import { VersionMismatch } from '../common/version.ts';
import { type Incompatibility, SchemaMismatch } from '../tables/declaration.ts';
import { type Issue, ValidationError } from '../tables/validation.ts';
import type { SyncStatus } from './status.ts';

/**
 * 错误怎么跨过 Worker 与页面之间的边界、从 Rust 的核心交回 JS：postMessage 的结构化克隆只留标准错误的名字与消息（调用栈各浏览器不一），
 * 接入方要用 instanceof 分辨的 ValidationError（连同表与字段路径）、AccountMismatch、PendingWrites、VersionMismatch、SchemaMismatch、Reject
 * 带过去、在页面里还原，与手机上一样；别的错只留消息。Rust 核心交来的错是同一个样子。
 * 同步状态里的错（downloadError、uploadError）也是这个样子（deserializeStatus 还原）。只在设备一侧有的两种（AccountMismatch、PendingWrites）在这里定义。
 * 不该知道的：错从哪来、页面拿它做什么。
 * @see https://html.spec.whatwg.org/multipage/structured-data.html#serializable-objects
 */

/**
 * 云端说的空间与这个库第一次同步时记下的不同：这个设备上换了账号，库里的却还是上一个人的（如 web 上另一个标签页换了登录，token 已是别人的）。
 * 同步停下、不推（不把上一个人的写推进别人的空间）；App 据此按当前账号重新打开（换 owner），或让用户重新登录
 */
export class AccountMismatch extends Error {
  readonly stored: string;
  readonly cloud: string;

  constructor(stored: string, cloud: string) {
    super(`账号不一致：本机库是 ${stored} 的，云端是 ${cloud} 的；同步已停下，按当前账号重新打开`);
    this.name = 'AccountMismatch';
    this.stored = stored;
    this.cloud = cloud;
  }
}

/**
 * 换了人打开，上一个人还有没上传的写：不清、不打开，免得丢掉它们（换人时清掉上一个人的数据，没上传的写就再也传不上去了）。
 * App 让用户切回 owner 登录、同步完再换人，或明确丢弃（打开时给 discardPending）
 */
export class PendingWrites extends Error {
  /** 上一个人 */
  readonly owner: string;
  /** 没上传的写有几条 */
  readonly count: number;

  constructor(owner: string, count: number) {
    super(`上一个登录的人（${owner}）还有 ${count} 条写没上传`);
    this.name = 'PendingWrites';
    this.owner = owner;
    this.count = count;
  }
}

export type SerializedError = {
  message: string;
  stack?: string;
  validation?: { table: string; issues: Issue[] };
  account?: { stored: string; cloud: string };
  pending?: { owner: string; count: number };
  version?: number;
  schema?: Incompatibility;
  reject?: Record<string, never>;
};

export function serializeError(error: unknown): SerializedError {
  if (error instanceof ValidationError) return { message: error.message, validation: { table: error.table, issues: error.issues } };
  if (error instanceof AccountMismatch) return { message: error.message, account: { stored: error.stored, cloud: error.cloud } };
  if (error instanceof PendingWrites) return { message: error.message, pending: { owner: error.owner, count: error.count } };
  if (error instanceof VersionMismatch) return { message: error.message, version: error.cloud };
  if (error instanceof SchemaMismatch) return { message: error.message, schema: { kind: error.kind, names: error.names } };
  if (error instanceof Reject) return { message: error.message, reject: {} };
  if (!(error instanceof Error)) return { message: String(error) };
  return error.stack === undefined ? { message: error.message } : { message: error.message, stack: error.stack };
}

/** 还原成页面里的错；带着 Worker 里的调用栈，报出时能定位到出错的地方 */
export function deserializeError(serialized: SerializedError) {
  const error = restored(serialized);
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  return error;
}

function restored({ message, validation, account, pending, version, schema, reject }: SerializedError): Error {
  if (validation) return new ValidationError(validation.table, validation.issues);
  if (account) return new AccountMismatch(account.stored, account.cloud);
  if (pending) return new PendingWrites(pending.owner, pending.count);
  if (version !== undefined) return new VersionMismatch(version);
  if (schema) return new SchemaMismatch(schema);
  if (reject) return new Reject(message);
  return new Error(message);
}

/** 同步状态跨过边界：里面的两个错是 SerializedError */
export type SerializedStatus = Omit<SyncStatus, 'downloadError' | 'uploadError'> & {
  downloadError: SerializedError | undefined;
  uploadError: SerializedError | undefined;
};

export const deserializeStatus = ({ downloadError, uploadError, ...status }: SerializedStatus): SyncStatus => ({
  ...status,
  downloadError: downloadError && deserializeError(downloadError),
  uploadError: uploadError && deserializeError(uploadError),
});
