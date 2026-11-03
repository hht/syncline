import type { Progress } from '../common/protocol.ts';

/**
 * 一个空间的同步状态长什么样：核心报来、页面订阅。变了就换一个新对象。
 * 不该知道的：状态怎么算出来。
 * @see https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/db/crud/SyncStatus.ts
 */

/** 同步状态，变了就换一个新对象 */
export type SyncStatus = {
  /** 连着云端、已补齐：之后的改动实时到 */
  connected: boolean;
  /** start 了还没连上（含取 token、HTTP 拉取、退避等待）；要更新 App 而停下的不算 */
  connecting: boolean;
  /** 正在 HTTP 拉取 */
  downloading: boolean;
  /** HTTP 拉取的进度，拉到第二块起才有（一块拉完的没有）；不在拉取时没有 */
  downloadProgress: Progress | undefined;
  /** 待上传的写有几条 */
  pending: number;
  /** 同步过：本机有游标（重启后也在，被重置后没有） */
  hasSynced: boolean;
  /** 取 token、拉取、连接出的错；拉取收下一块、或追平之后清掉 */
  downloadError: Error | undefined;
  /** 云端处理推送出的错；之后有写被云端确认时清掉 */
  uploadError: Error | undefined;
  /** 云端的同步协议比这个 App 新（protocolVersion），或 App 用到了云端已删的表或列：同步已停下，要更新 App */
  updateNeeded: boolean;
};

/** 没在连着时这几项都是假（没有） */
export const offline = { connected: false, connecting: false, downloading: false, downloadProgress: undefined };
