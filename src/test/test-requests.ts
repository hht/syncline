import type { Trace } from './test-sockets.ts';
import { type Message, pullMessage } from './test-trace.ts';

// 确定性模拟里的 HTTP 拉取（Network 的一半）：请求排着，云端什么时候算好应答、应答什么时候到设备、哪个请求失败，都由调用方的随机数挑。
// 云端怎么算应答（替身 Worker 认版本、身份与表结构，再交给对象）由 Network 给

/** 改坏了的正文：不是 JSON */
export const garbled = 'garbled{';

/** 一个 HTTP 拉取请求 */
export type Pull = {
  device: number;
  token: string;
  url: string;
  /** 私有空间 POST 的正文；共用空间 GET 没有 */
  body: string | undefined;
  schema: string | undefined;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  /** 轨迹核对：模型里这个请求（或它的应答）已经丢了，之后算应答、送到都不再记 */
  gone?: true;
  /** 云端算好了的应答，还在路上（之后才到设备）；message 是它在模型里是哪条消息（回错的没有） */
  answer?: { status: number; body: string | null; message: Message | undefined };
};

/** 云端算一个请求的应答 */
export type Answer = (request: Pick<Pull, 'token' | 'url' | 'body' | 'schema'>) => { status: number; body: string | null };

export class Requests {
  #requests: Pull[] = [];
  readonly #pick: <T>(items: T[]) => T | undefined;
  readonly #answer: Answer;
  readonly #trace: () => Trace | undefined;

  constructor(pick: <T>(items: T[]) => T | undefined, answer: Answer, trace: () => Trace | undefined) {
    this.#pick = pick;
    this.#answer = answer;
    this.#trace = trace;
  }

  /** Connection 的替身 fetch：某台设备的一个 HTTP 拉取 */
  fetch(
    device: number,
    url: string,
    { headers, body, signal }: { headers: { Authorization: string; 'Syncline-Schema'?: string }; body?: string; signal?: AbortSignal },
  ) {
    return new Promise<Response>((resolve, reject) => {
      // 同一台设备之前的请求还在路上：那次连接已经作废，它的结果不再理会
      for (const other of this.#requests) if (other.device === device) this.#dropped(other);
      this.#trace()?.('PullReq', device);
      const request: Pull = {
        device,
        token: headers.Authorization.replace(/^Bearer /, ''),
        url,
        body,
        schema: headers['Syncline-Schema'],
        resolve,
        reject,
      };
      this.#requests.push(request);
      // 中止（超时、停了）：照 fetch，请求作废、以 AbortError 失败
      signal?.addEventListener('abort', () => {
        if (!this.#requests.includes(request)) return;
        this.#requests = this.#requests.filter((other) => other !== request);
        this.#dropped(request);
        reject(new DOMException('请求中止了', 'AbortError'));
      });
    });
  }

  /** 有还没算应答的请求、有在路上的应答 */
  unanswered() {
    return this.#requests.some(({ answer }) => !answer);
  }

  answered() {
    return this.#requests.some(({ answer }) => answer);
  }

  /** 云端（替身 Worker 与对象）算好一个请求的应答：之后才到设备（arrive），期间云端照常变，到的是算的那一刻的 */
  respond() {
    const request = this.#pick(this.#requests.filter(({ answer }) => !answer));
    if (!request) return;
    const answer = this.#answer(request);
    const message = pullMessage(answer.status, answer.body ?? '');
    // 算出了拉取的结果是处理拉取；回错（版本、身份、表结构对不上，对象出错）在模型里是丢掉了请求
    if (message && !request.gone) this.#trace()?.('HandlePull', request.device, { message });
    else this.#dropped(request);
    request.answer = { ...answer, message };
  }

  /** 一个算好了的应答到了设备 */
  arrive() {
    const request = this.#pick(this.#requests.filter(({ answer }) => answer));
    if (!request?.answer) return;
    this.#requests = this.#requests.filter((other) => other !== request);
    const { status, body, message } = request.answer;
    // 改坏了的：设备解析不了、不收，模型里是丢了这条。都记成一定要做：算出它时记了处理拉取，它就在模型的网络里，收下、当作用不上或丢掉总做得了；
    // 可做可不做的话，不做的那一支里这次拉取一直在路上，要把之后可选的动作全部试完才排除
    if (message && !request.gone) this.#trace()?.(body === garbled ? 'Drop' : 'Recv', request.device, { message });
    request.resolve(new Response(body, { status }));
  }

  /** 在路上的成功应答：可以被改坏（garble） */
  responses() {
    return this.#requests.filter(({ answer }) => answer?.status === 200);
  }

  /** 把一个在路上的应答改坏 */
  garble(request: Pull) {
    request.answer = { ...(request.answer as NonNullable<Pull['answer']>), body: garbled };
  }

  /** 随便一个请求失败 */
  failOne() {
    this.#fail(this.#pick(this.#requests));
  }

  /** 这台设备的请求都失败（进程没了） */
  failAll(device: number) {
    for (const request of this.#requests.filter((request) => request.device === device)) this.#fail(request);
  }

  /**
   * 一个请求不会再有人收了（请求失败、连接作废）：模型里丢了它，或它算好的应答，一定要丢（同 arrive：记了发起或处理拉取，它就在模型的网络里）；
   * 回错的在模型里已经丢了
   */
  #dropped(request: Pull) {
    if (request.gone) return;
    request.gone = true;
    if (request.answer && !request.answer.message) return;
    this.#trace()?.('Drop', request.device, { message: request.answer?.message ?? { t: 'pullreq' } });
  }

  #fail(request: Pull | undefined) {
    if (!request) return;
    this.#requests = this.#requests.filter((other) => other !== request);
    this.#dropped(request);
    request.reject(new TypeError('fetch failed'));
  }
}
