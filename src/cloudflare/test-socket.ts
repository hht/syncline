import { type Poke, pong } from '../common/protocol.ts';

// 平台测试共用：设备那一头的 WebSocket 收到的消息与关闭，按到达顺序一条条取

type Event = { message: Poke } | { pong: true } | { close: number };

/** 接受这条 WebSocket，之后的消息与关闭按到达顺序排队；next 取下一件，还没到就等 */
export function inbox(socket: WebSocket) {
  const events: Event[] = [];
  const waiting: ((event: Event) => void)[] = [];
  const arrive = (event: Event) => {
    const resolve = waiting.shift();
    if (resolve) resolve(event);
    else events.push(event);
  };
  socket.addEventListener('message', ({ data }) => arrive(data === pong ? { pong: true } : { message: JSON.parse(String(data)) }));
  socket.addEventListener('close', ({ code }) => arrive({ close: code }));
  socket.accept();
  return () => new Promise<Event>((resolve) => (events.length > 0 ? resolve(events.shift() as Event) : waiting.push(resolve)));
}
