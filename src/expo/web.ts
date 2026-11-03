import { report } from '../common/listeners.ts';
import { Client } from './client.ts';
import { deserializeError } from './errors.ts';
import { type OpenOptions, type Schema, syncline } from './syncline.ts';
import type { HostMessage, WorkerMessage } from './worker.ts';

export * from './public.ts';

/**
 * web 上怎么打开 Syncline：本机库与同步都在 Syncline 自带的专用 Worker 里（编成 wasm 的 Rust 设备），这里转去调用、收回复与通知。
 * 整个页面一个 Worker：OPFS 上的库同一时刻只许一处打开，先后打开的几个库（换了用户）在同一个 Worker 里按顺序开、关。
 * 每次打开一个编号（instance）：调用带着它，Worker 只接当前开着的那一次的；交回的也带着它，只交给那一次的 Client。
 * 不该知道的：库怎么存、同步怎么进行。
 */

let worker: Worker | undefined;
let nextInstance = 0;
/** 开着的各次打开收 Worker 交回的；关了的不再收 */
const instances = new Map<number, Client>();

/**
 * Worker 坏了（加载失败，如部署后旧页面取不到已删的 Worker 包；消息解析不了）：各次打开在等的调用都以这个错失败、同步状态记成下载出错，
 * 不然读写与 sync() 一直等；丢掉这个 Worker 与开着的各次打开，下次打开时新建
 * @see https://html.spec.whatwg.org/multipage/workers.html#handler-abstractworker-onerror
 */
function broken(error: Error) {
  worker?.terminate();
  worker = undefined;
  for (const client of instances.values()) client.broken(error);
  instances.clear();
}

function post(message: HostMessage) {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url));
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      if ('type' in data) return report(deserializeError(data.error));
      instances.get(data.instance)?.receive(data.received);
    };
    worker.onerror = (event) => broken(new Error(`Syncline 的 Worker 出错：${event.message || '加载失败'}`));
    worker.onmessageerror = () => broken(new Error('Syncline 的 Worker 发来的消息解析不了'));
  }
  worker.postMessage(message);
}

/** 打开（没有就建）一个本机库并开始同步私有空间 */
export function openSyncline<S extends Schema>(options: OpenOptions<S>) {
  const { name, token } = options;
  const instance = nextInstance++;
  const client = new Client((call) => post({ instance, call }), options);
  instances.set(instance, client);
  const main = client.open({ name });
  /** 关库：之后不再收这一次打开的 */
  const close = () => client.close({ type: 'close', name, remove: false }, () => instances.delete(instance));
  /** 删库：等关完，再以另一次打开的名义让 Worker 只删文件（这一次打开关了之后不再收回复） */
  const remove = async () => {
    await close();
    const removal = nextInstance++;
    const remover = new Client((call) => post({ instance: removal, call }), options);
    instances.set(removal, remover);
    await remover.call<void>({ type: 'close', name, remove: true }).finally(() => instances.delete(removal));
  };
  return syncline(name, client.local, main, { shared: client.share, close, delete: remove }, token);
}
