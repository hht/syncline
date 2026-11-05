import type { Watch } from './test-sockets.ts';
import { type Message, pullMessage } from './test-trace.ts';

// Deterministic simulation HTTP pull pipeline (complement of Network): queued requests,
// computing responses, in-flight delivery, and faults scheduled by pseudo-random picker.

/** Corrupted payload marker: invalid JSON. */
export const garbled = 'garbled{';

/** HTTP pull request descriptor. */
export type Pull = {
  device: number;
  token: string;
  url: string;
  /** POST body for private space; undefined for shared space GET. */
  body: string | undefined;
  schema: string | undefined;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  /** Trace validation: marked gone if dropped in model so subsequent computation is untracked. */
  gone?: true;
  /** Computed response in transit; message holds model representation (undefined for error responses). */
  answer?: { status: number; body: string | null; message: Message | undefined };
};

/** Cloud response generator for a request. */
export type Answer = (request: Pick<Pull, 'token' | 'url' | 'body' | 'schema'>) => { status: number; body: string | null };

export class Requests {
  #requests: Pull[] = [];
  readonly #pick: <T>(items: T[]) => T | undefined;
  readonly #answer: Answer;
  readonly #watch: Watch;

  constructor(pick: <T>(items: T[]) => T | undefined, answer: Answer, watch: Watch) {
    this.#pick = pick;
    this.#answer = answer;
    this.#watch = watch;
  }

  /** Connection mock fetch: executes HTTP pull for device index. */
  fetch(
    device: number,
    url: string,
    { headers, body, signal }: { headers: { Authorization: string; 'Syncline-Schema'?: string }; body?: string; signal?: AbortSignal },
  ) {
    return new Promise<Response>((resolve, reject) => {
      // Supersedes in-flight request for same device on invalidated connection.
      for (const other of this.#requests) if (other.device === device) this.#dropped(other);
      this.#watch.trace?.('PullReq', device);
      this.#watch.seams?.request(device, url, body);
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
      // Abort handling (timeout, stop): cancels request with AbortError.
      signal?.addEventListener('abort', () => {
        if (!this.#requests.includes(request)) return;
        this.#requests = this.#requests.filter((other) => other !== request);
        this.#dropped(request);
        reject(new DOMException('request aborted', 'AbortError'));
      });
    });
  }

  /** Whether uncomputed or in-flight responses exist. */
  unanswered() {
    return this.#requests.some(({ answer }) => !answer);
  }

  answered() {
    return this.#requests.some(({ answer }) => answer);
  }

  /** Computes response for pending request; response enters transit (arrive) reflecting state at compute time. */
  respond() {
    const request = this.#pick(this.#requests.filter(({ answer }) => !answer));
    if (!request) return;
    const answer = this.#answer(request);
    this.#watch.seams?.response(request, answer);
    const message = pullMessage(answer.status, answer.body ?? '');
    // Successful pulls map to HandlePull in model; error responses (version, auth, schema) map to Drop.
    if (message && !request.gone) this.#watch.trace?.('HandlePull', request.device, { message });
    else this.#dropped(request);
    request.answer = { ...answer, message };
  }

  /** Delivers in-flight response to device. */
  arrive() {
    const request = this.#pick(this.#requests.filter(({ answer }) => answer));
    if (!request?.answer) return;
    this.#requests = this.#requests.filter((other) => other !== request);
    const { status, body, message } = request.answer;
    // Corrupted responses cannot be parsed by device; mapped as Drop in model.
    if (message && !request.gone) this.#watch.trace?.(body === garbled ? 'Drop' : 'Recv', request.device, { message });
    request.resolve(new Response(body, { status }));
  }

  /** In-flight 200 OK responses eligible for corruption. */
  responses() {
    return this.#requests.filter(({ answer }) => answer?.status === 200);
  }

  /** Corrupts an in-flight response body. */
  garble(request: Pull) {
    request.answer = { ...(request.answer as NonNullable<Pull['answer']>), body: garbled };
  }

  /** Fails random pending request. */
  failOne() {
    this.#fail(this.#pick(this.#requests));
  }

  /** Fails all pending requests for given device (process exit). */
  failAll(device: number) {
    for (const request of this.#requests.filter((request) => request.device === device)) this.#fail(request);
  }

  /**
   * Drops request from active processing (failure, connection superseded);
   * recorded as Drop in model trace.
   */
  #dropped(request: Pull) {
    if (request.gone) return;
    request.gone = true;
    if (request.answer && !request.answer.message) return;
    this.#watch.trace?.('Drop', request.device, { message: request.answer?.message ?? { t: 'pullreq' } });
  }

  #fail(request: Pull | undefined) {
    if (!request) return;
    this.#requests = this.#requests.filter((other) => other !== request);
    this.#dropped(request);
    request.reject(new TypeError('fetch failed'));
  }
}
