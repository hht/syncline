import { requireNativeModule } from 'expo';
import { Client, type Received } from './client.ts';
import { OpenDatabases } from './open-databases.ts';
import { type OpenOptions, type Schema, type Syncline, syncline } from './syncline.ts';

export * from './public.ts';

/**
 * iOS、Android 上怎么打开 Syncline：本机库与同步都在原生模块里（Rust 的核心线程与网络线程，`rust/native`），JS 线程只发调用、收回复与通知。
 * 每个库一个句柄：调用经 send 交下去（JSON），交回的经 message 事件按句柄分给它的 Client。库文件在 App 的数据目录里（「名字.db」）。
 * 不该知道的：表里的业务，同步怎么进行。
 * @see https://docs.expo.dev/modules/module-api/
 */

type SynclineModule = {
  /** 起一个库的核心线程，回句柄（库在收到 open 调用时才打开） */
  start(name: string): number;
  send(handle: number, call: string): void;
  /** 删掉库文件（库要先关掉） */
  remove(name: string): Promise<void>;
  addListener(event: 'message', listener: (event: { handle: number; data: string }) => void): { remove(): void };
};

/** 开着的库，按句柄 */
const clients = new Map<number, Client>();

/** 第一次开库时才取原生模块：只 import 不开库的地方（如测试里加载 App 的代码）没有它也不出错 */
let loaded: SynclineModule | undefined;
function native() {
  if (!loaded) {
    loaded = requireNativeModule<SynclineModule>('Syncline');
    loaded.addListener('message', ({ handle, data }) => clients.get(handle)?.receive(JSON.parse(data) as Received[]));
  }
  return loaded;
}

/** 这个进程里开着的库 */
const opened = new OpenDatabases<Syncline>();

/**
 * 打开（没有就建）一个本机库并开始同步私有空间。后台任务的 syncOnce 正开着同一个人的库时接管那一份，开着别人的就先关掉它；前台已经开着同名库就抛错
 */
export function openSyncline<S extends Schema>(options: OpenOptions<S>) {
  return opened.open(options.name, options.owner, () => open(options));
}

function open<S extends Schema>(options: OpenOptions<S>) {
  const { name, token } = options;
  const module = native();
  // 第一次发调用（open）时才起句柄：建 Client、编表的声明会抛错（声明不合法），抛在起句柄之前，不留下一个排着号却永远不开不关的句柄、挡住后面同名的
  let handle: number | undefined;
  const client: Client = new Client((call) => {
    if (handle === undefined) {
      handle = module.start(name);
      clients.set(handle, client);
    }
    module.send(handle, JSON.stringify(call));
  }, options);
  const main = client.open();
  /**
   * 关库：等核心线程关掉库文件（之后才能删），之后不再收它交回的。一调用就不再算开着：马上再开同名库（卸载后再挂载、热更新）另起一个句柄，
   * 它的核心线程等这个关完才开库文件（原生一侧按文件排）
   */
  const close = () => {
    opened.closed(name, instance);
    return client.close({ type: 'close' }, () => handle !== undefined && clients.delete(handle));
  };
  const instance = syncline(
    name,
    client.local,
    main,
    {
      shared: client.share,
      close,
      delete: async () => {
        await close();
        await module.remove(name);
      },
    },
    token,
  );
  return instance;
}

/**
 * 同步一次（App 不在前台、被系统的后台任务叫醒的那几十秒）：连上，推完待上传、拉到最新。这个进程里已经开着这个库（App 还在后台活着）就用它的 sync、
 * 不关；没开就打开，同步完关掉，不留连接与重连；同步期间用户点开了 App、前台接管了它就不关。signal 中止（如超时）、出错就失败，打开的库照样关掉；
 * iOS 收回后台时间时 App 随即被挂起，不保证执行到关库。只同步私有空间。不管给没给 discardPending 都不丢没上传的写：换了人、上一个人还有待上传就以
 * PendingWrites 失败，等 App 在前台定
 */
export function syncOnce<S extends Schema>({ discardPending: _, ...options }: OpenOptions<S>, settings: { signal?: AbortSignal } = {}) {
  return opened.syncOnce(options.name, options.owner, () => open(options), settings);
}
