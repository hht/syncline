// The native module of Expo tests: the core thread is the test's, delivering messages to the listener the JS side registers.

type Message = { handle: number; data: string };

/** Builds the native module from the test's core calls; deliver passes messages to the JS side as the core thread does. */
export function fakeNative(core: {
  start(name: string): unknown;
  send(handle: number, call: string): void;
  remove?(name: string): Promise<void>;
}) {
  let listener: (message: Message) => void = () => undefined;
  const module = {
    ...core,
    addListener: (_: string, added: typeof listener) => {
      listener = added;
      return { remove: () => undefined };
    },
  };
  return { module, deliver: (message: Message) => listener(message) };
}
