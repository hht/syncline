import { notifyAll } from '../common/listeners.ts';

/**
 * 云端发生的、接入方要记日志或指标、要告警的事：Space、Server、广播分片照发生的先后同步交给接入方给的回调（events），
 * SDK 不绑定具体产品（照 PowerSync 服务端与 Zero 把指标交给接入方配的后端）：console.log 成 JSON 进 Workers Logs 或 Logpush，
 * 或写 Analytics Engine 的数据点。回调要快；抛了不影响同步，错误照常报出（isolated）。
 * @see https://developers.cloudflare.com/workers/observability/logs/workers-logs/
 * @see https://developers.cloudflare.com/analytics/analytics-engine/
 */
export type Event =
  /** 一条推来的写执行不了，扣下待修复（该告警：要有人修好后重新提交） */
  | { type: 'write.held'; client: string; id: number; reason: string }
  /** 推来的写前面还缺（序号空洞）：跳过、不推进序号；正常运行不会出现，出现了是缺陷（该告警） */
  | { type: 'write.skipped'; client: string; id: number; lmid: number }
  /** 推来的写改了已删的表或列：这部分丢掉（names），其余照常执行 */
  | { type: 'values.dropped'; client: string; id: number; names: string[] }
  /** 打开时同步的范围变了：进入同步的表与列（设备拉到时重给整张表）、离开同步的不再记 */
  | { type: 'schema.changed'; entered: string[]; left: string[] }
  /** 扣下的写重新提交成功 */
  | { type: 'write.resubmitted'; client: string; id: number }
  /** 推送处理不了（存储出错这类）：出错的那条起不推进序号，以 1011 关推送方的连接，设备退避重发（该告警） */
  | { type: 'push.failed'; reason: string }
  /** 共用空间的设备游标不在当前历史上（历史换掉了），回 reset：设备清空重下 */
  | { type: 'cookie.reset'; version: number }
  /** 拉取给出一块：rows 是改动的行数，chars 是改动的 JSON 字符数，last 是不是末块 */
  | { type: 'chunk.pulled'; space: 'private' | 'shared'; rows: number; chars: number; last: boolean }
  /** 云端关掉一条连接：pullNeeded（没有游标、游标不在当前历史上）、expired（身份到期）等 */
  | { type: 'connection.closed'; code: number; reason: string }
  /** 共用空间有广播分片这一次没通知到：之后按退避重发到送到为止 */
  | { type: 'notice.failed'; shard: string; reason: string }
  /**
   * 后台收拾的一步（index：给已有的表补还缺的索引、删过时的桶规则索引，drop：删过了宽限期的表，truncate：截日志，count：数共用空间每个桶的行数）这次失败：
   * 按退避重排，一直重试到成功
   */
  | { type: 'upkeep.failed'; step: 'index' | 'drop' | 'truncate' | 'count'; reason: string }
  /** 一个导出者这次导出失败：按退避重排，一直重试到成功（该告警：一直失败时，统计一直缺这段时间的改动） */
  | { type: 'export.failed'; name: string; reason: string };

export type Events = (event: Event) => void;

/** 没给回调时什么也不做 */
export const quiet: Events = () => undefined;

/** 接入方的回调单独调用：抛错不影响同步（推送照样确认、导出照样往前走），错误照常报出、不致命。没给的还是 quiet */
export const isolated = (events: Events): Events => (events === quiet ? quiet : (event) => notifyAll([events], event));
