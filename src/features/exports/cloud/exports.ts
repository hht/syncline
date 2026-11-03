import type { Events } from '../../../cloud/events.ts';
import { decodePosition } from '../../../cloud/position.ts';
import type { Space } from '../../../cloud/space.ts';
import { withTimeout } from '../../../cloud/timeout.ts';
import { report } from '../../../common/listeners.ts';
import type { Op } from '../../../common/protocol.ts';

/** 导出一块约多少字符的改动：导出者一次处理一块（如写进 D1），块不大才快 */
const exportChars = 500_000;

/** 写了之后多久导出：攒一阵写一起导，统计几分钟内反映新数据 */
export const defaultExportDelay = 60_000;

/** 导出失败后重排：第 n 次等 min(上限, exportDelay × 2^(n-1))，一直重试到成功（平台对抛错的 alarm 最多重试 6 次） */
export const maxExportDelay = 3_600_000;

/** 一次 alarm 默认最多导这么久，没导完马上再排一次（平台给 alarm 15 分钟墙钟） */
export const defaultExportBudget = 10 * 60_000;

/**
 * 导出（跨 DO 汇总统计等）怎么接着导：导出者是另一个消费者，导到哪（位置）存在去处、与导出的结果写在同一个事务里，
 * Syncline 不替它记。每次先问去处存着的位置，从那里接着读一块，与设备的拉取同一个读取器（全部同步表，
 * 第一次是整份，第一块先清空）；位置不在当前历史上（时间点恢复过、截日志截过了）就从头整份给、第一块先清空，这一块就是 reset：导出者丢掉这个空间导出过的东西、从这块起从头导。
 * 位置就是读取器的位置，对导出者不透明。
 * 写了之后过一阵用 alarm 导（Exports，接到私有空间对象上的后台事），各导出者同时导、一次 alarm 有时间预算，出错按退避一直重试。
 * 不该知道的：块怎么算、导出到哪、alarm 怎么排。
 * @see https://kafka.apache.org/36/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html（Storing Offsets Outside Kafka）
 */

/** 一块：from 是这块从哪接着导的位置（去处存着的），next 是导完它之后的位置，done 是追到了最新一版 */
type ExportChunk = { from: string | undefined; next: string; reset: boolean; patch: Op[]; done: boolean };

/**
 * 从 from（去处存着的位置）接着导的一块。存着的不是位置（不是这里给的：去处的数据坏了、position() 给错了）就报出来，照样从头整份导：
 * 抛错的话这个导出者每次都失败、永远过不去
 */
export function exportChunk(poll: Space['poll'], from: string | undefined, limit = exportChars): ExportChunk {
  if (from !== undefined && !decodePosition(from)) report(new Error(`Syncline：导出的位置认不出，从头整份导：${from.slice(0, 200)}`));
  const { ops, next, done } = poll(from, limit);
  // 去处存着位置（导过了，整份导到一半也是）却从头整份给（以清空开头）：位置不在当前历史上（时间点恢复过、截日志截过了）或认不出，导出过的东西都作废
  return { from, next, reset: from !== undefined && ops[0]?.op === 'clear', patch: ops, done };
}

/**
 * 一个导出者（跨 DO 汇总统计等），是另一个消费者：position 给出去处存着的导到哪（上次 write 一起存下的 next，还没导过是 undefined）；
 * write 收到一块改动（行的当前值，整份的第一块先清空，离开同步的表与列给 drop），要在去处的一个事务里写下改动、存下 next，且只在去处存着的位置还是 from 时写
 * （超时之后还在跑的旧调用、重叠的重试不覆盖新的）；reset 的块（从头整份的第一块）先丢掉这个空间导出过的东西再写。失败就抛错，下次照原样再给
 */
export type Exporter = {
  position(): Promise<string | undefined>;
  write(chunk: { from: string | undefined; next: string; reset: boolean; patch: Op[] }): Promise<void>;
};

/**
 * exports：导出者（名字 → 导出者），写了之后过 exportDelay 毫秒（默认 60 秒）用 alarm 导出；一次 alarm 最多导 exportBudget 毫秒（默认 10 分钟），
 * 导出者到时候还没回话就算这次失败
 */
export type ExportOptions = { exports?: Record<string, Exporter>; exportDelay?: number; exportBudget?: number };

/**
 * 私有空间的对象给导出的：读一块（不报给接入方的事件）、在定时表里登记一件事最迟什么时候做、
 * Syncline 自己的事的名字前缀（与接入方的定时分开）、接入方的事件
 */
type Context = { poll: Space['poll']; by: (name: string, at: number) => void; reserved: string; events: Events };

/** 定时表里的一件事：做一步，没做完返回 true；出错按退避重排 */
type Chore = { run: () => Promise<boolean>; retry: { base: number; max: number }; failed: (error: unknown) => void };

// 导出者到时候还没回话：这次 alarm 照样结束、按退避重排
const timedOut = '导出超时：去处一直没回话';

/** 接到私有空间对象上的导出（由组装根接上）：写了之后每个导出者排一件，alarm 里各自导到追上 */
export class Exports {
  readonly #context: Context;
  readonly #exports: Record<string, Exporter>;
  readonly #delay: number;
  readonly #budget: number;
  readonly #prefix: string;

  constructor(context: Context, { exports = {}, exportDelay = defaultExportDelay, exportBudget = defaultExportBudget }: ExportOptions) {
    this.#context = context;
    this.#exports = exports;
    this.#delay = exportDelay;
    this.#budget = exportBudget;
    this.#prefix = `${context.reserved}export:`;
  }

  /** 写了之后（打开时同步范围变了也算）排导出：每个导出者最迟 exportDelay 之后（攒一阵写一起导）；在退避中的不提前 */
  written() {
    for (const name of Object.keys(this.#exports)) this.#context.by(this.#prefix + name, Date.now() + this.#delay);
  }

  /**
   * 定时表里登记的一件导出，出错报 export.failed、按退避重排，一直重试到成功；不是导出者的是 undefined。
   * started 是这次 alarm 开始的时刻：各导出者同时导，一次 alarm 合起来至多 exportBudget
   */
  chore(key: string, started: number): Chore | undefined {
    const name = key.slice(this.#prefix.length);
    const exporter = key.startsWith(this.#prefix) ? this.#exports[name] : undefined;
    return (
      exporter && {
        run: () => this.#exportTo(exporter, started + this.#budget),
        retry: { base: this.#delay, max: maxExportDelay },
        failed: (error) =>
          this.#context.events({ type: 'export.failed', name, reason: error instanceof Error ? error.message : String(error) }),
      }
    );
  }

  /**
   * 一个导出者导到追上：每块先问去处存着的位置，从那里读一块交给它。追上了返回 false、不再排；到了时间预算返回 true、马上再排；
   * 出错（含导出者到时候还没回话）抛出，报 export.failed、按退避重排
   */
  async #exportTo(exporter: Exporter, deadline: number) {
    for (;;) {
      if (Date.now() >= deadline) return true;
      const chunk = exportChunk(this.#context.poll, await withTimeout(exporter.position(), deadline - Date.now(), timedOut));
      // 没有改动的块（已经追上）也交给导出者：位置要往前走
      await withTimeout(
        exporter.write({ from: chunk.from, next: chunk.next, reset: chunk.reset, patch: chunk.patch }),
        deadline - Date.now(),
        timedOut,
      );
      if (chunk.done) return false;
    }
  }
}
