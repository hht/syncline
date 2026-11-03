/**
 * 等 work 做完，过了 ms 毫秒还没做完就以 message 失败：去处一直不回话（导出者、广播分片卡住）时照样结束、按退避重排，
 * 不卡到平台的墙钟上限被杀。没做完的 work 不能取消，只是不再等它
 */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
