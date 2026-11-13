import { type Poke, pong } from '../../src/protocol/messages.ts';

// Shared across platform tests: queues WebSocket messages and close events received by the client in arrival order.

type Event = { message: Poke } | { pong: true } | { close: number };

/** Accepts the WebSocket and queues subsequent messages and close events; returns a pull function waiting for the next event. */
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
