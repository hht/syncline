// Syncline 核心的上限各是多少、为什么：两端共用的，与定下一次请求、一个空间的工作量上界的；只一处用到的调节写在用它的地方，功能的上限留在功能里（核心不提它们）

/**
 * Durable Object 的 SQL 存储上限：Syncline 存进去的值（一行、一个参数、提交记录的一项）都从它推，各处另留余地。
 * 设备与云端共用：设备上的写要在上传前就照它拒，免得上传后被云端扣下
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/（Maximum string, BLOB or table row size）
 */

/** 单个字符串、BLOB 或一行最多多少字节 */
export const valueBytes = 2_000_000;

/** 按字符数（UTF-16 码元）切的值一份至多多少个：UTF-8 一个码元至多 3 字节，3 倍之后还留四分之一的余地 */
export const valueChars = valueBytes / 4;

/**
 * 同步表一行的主键编成 JSON 至多多少字节（UTF-8）：分块拉取接着拉的位置带着它，共用空间放进拉取的网址（Cloudflare 的网址至多 16 KB，
 * 非 ASCII 的字节转义后是 3 倍）；照常见的主键上限（Firestore 的文档 ID 1500 字节、DynamoDB 的排序键 1024 字节）再收紧，UUID 这类主键远在其内。
 * 本机写时就拒，云端照样查
 * @see https://developers.cloudflare.com/workers/platform/limits/（URL size）
 * @see https://firebase.google.com/docs/firestore/quotas（Constraints on document IDs）
 * @see https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html（Sort key length）
 */
export const keyBytes = 512;

/**
 * 共用空间一台设备的订阅（桶的规范写法排好的 JSON 数组）至多多少字节（UTF-8）：设备每次拉取把落地时的订阅原样带回（编成 base64，约 4/3 倍），
 * 与接着拉的位置一起放进网址（Cloudflare 的网址至多 16 KB）。照 PowerSync 一条连接至多 1000 个桶的用意给订阅封顶（不设上限时一块要在很多桶之间归并），
 * 按字节而不按个数：一条规则一个参数、参数是 UUID 时约 170 个桶，是五位数的整数时约 550 个。超了入口拒绝（接入方要换一种分桶）
 * @see https://developers.cloudflare.com/workers/platform/limits/（URL size）
 * @see https://github.com/powersync-ja/powersync-service/blob/12fa59d700ded33dc33770855bde90ffb60ebc8f/packages/service-core/src/util/config/defaults.ts#L4
 */
export const subscriptionBytes = 8192;

/**
 * 一次写至多改多少行，连带删的也算（设备推来的、服务端的、本机写都是）：一条删除只有一个主键，连带删能放大成任意多行，
 * 云端一次写在一个事务里做完、提交记录要列出改到的每一行，内存与 CPU 都随它涨。一次写 19 万短行在 Cloudflare 上用 4.7–7.6 秒 CPU，
 * 取约一半，留足 30 秒 CPU 与内存的余地。超了云端扣下这条写、服务端的写抛错，本机写时就整条回滚
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see probes/cloudflare/push-size.ts（重测这个上限的探针）
 */
export const writeRows = 100_000;

/**
 * 共用空间一次服务端写至多改多少行（连带删的也算）：每行还要维护它在的桶（分桶的索引、各桶的行数），比私有空间贵得多，writeRows 挡不住超时。
 * 一张表一条按列分桶的规则、一次写 2 万行在 Cloudflare 上用的 CPU（同样的写两次差一倍）：各进一个新桶 3.0–6.6 秒，
 * 各从一个桶挪到另一个桶 13.4–26.3 秒（最慢约 1.3 毫秒一行），都进同一个桶 2.7–5.0 秒。按最慢的挪桶取约 30 秒 CPU 的一半；规则多了每行要维护的索引跟着多，余量更小。超了与 writeRows 一样处理
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see probes/cloudflare/shared-write.ts（重测这个上限的探针）
 */
export const sharedWriteRows = 10_000;

/**
 * 一次写改到的行的主键编成 JSON 共至多多少字节（UTF-8），连带删的也算：云端一次写要把改到的每一行的主键留在内存里、拼进提交记录，
 * 主键接近 keyBytes 时 writeRows 行的主键就有约 50 MB。私有空间占的内存约是这些主键的三倍，取 16 MB（约 45 MB），留在 DO 内存（128 MB）的一半之内；
 * UUID 这类短主键 writeRows 行先到。共用空间另把每一行改前在的桶留到写完（一个桶至多 256 字节，常见的一两个约 50 字节，
 * 至多 sharedWriteRows 行，约多一两 MB）。超了与 writeRows 一样处理
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/（Memory per isolate）
 */
export const writeKeyBytes = 16_000_000;

/**
 * 一次写的改动编成 JSON 至多多少字节（UTF-8），本机写时就照它拒：推送时一条写要一条 WebSocket 消息装得下（DO 收一条至多 32 MiB），
 * 云端还要在一次调用的 CPU 上限（默认 30 秒）里解析、执行完：一条 8 MiB 的写要 4.7–7.6 秒 CPU，16 MiB 要 17–20 秒、离上限太近（正式的空间另有校验、事件与额度，每行的 CPU 只会更多），20 MiB 以上超出上限
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 * @see probes/cloudflare/push-size.ts
 */
export const writeBytes = 8 * 2 ** 20;

/**
 * 云端收一条推送至多多少字节（UTF-8），超了不解析就拒收：设备推的一批是至多一条 writeBytes 的写，加上前面约 1.2 万字节的改动与至多 1000 条写的客户端编号、序号
 * （各约 100 字节），留 1 MiB 的余地。不先查的话有缺陷或改过的客户端推来 20 MiB 以上的，解析就超出 DO 的 CPU 上限、对象被重置，它每次重连再推一次
 * @see probes/cloudflare/push-size.ts（一条写 8 MiB 用 4.7–7.6 秒 CPU，20 MiB 以上超时）
 */
export const pushBytes = writeBytes + 2 ** 20;

/**
 * 私有空间的 HTTP 拉取，正文至多多少字节（UTF-8），超了不读完、回 413：正文里大的只有列出的客户端与它们最早的待上传序号，
 * 两项各作一个 SQL 参数查、各至多 valueBytes（超了拉取本来就失败），其余几项共约 0.1 MB，取 4 倍留余地。
 * 不先查的话有缺陷或改过的客户端发来上百 MB 的正文，读进来就超出 DO 的内存
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/（Memory per isolate）
 */
export const pullBytes = 4 * valueBytes;

/**
 * 私有空间一次拉取（一块、连上时的补齐）至多读库里多少行，跳过的提交与项也算：DO 的行读按行计费、每行都花 CPU，
 * 一次请求的读量要有上界，不随空间的行数与历史涨。读到了就停、给出接着读的位置，0 行也前进。扫描每行读两遍（量字节、取值），
 * 一块至多给 1 万行：改动约 100 字符以上的行先到一块的字符上限（chunkLimit，约 100 万字符一块，在 Cloudflare 上用 40–50 毫秒 CPU），
 * 块数与只按字符切时一样；这一条挡住更短的行与跳过的项很多的情形。行读的总数不随块的大小变，只是每块一个来回
 */
export const readRows = 20_000;

/**
 * 云端的提交记录（日志）按字节封顶：至少这么多字节，空间的数据（库文件减日志）多了按它的 1/4；超了由后台任务截掉最早的，截到上限的 3/4，
 * 每步至多删 truncateRows 版（DELETE 每行计 1 行写）、主键共 truncateBytes 字节（一版的主键可以接近 1 MB，只按版数限一步能删 10 GB）。
 * 最新一版永不删。日志与时间点恢复无关（恢复时日志也一起回去）
 * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
 */
export const commitFloor = 64 * 2 ** 20;

export const truncateRows = 10_000;

export const truncateBytes = 64 * 2 ** 20;

/**
 * 云端一次从库里读进内存的正文约多少字节（拉取、拼通知、算校验和都分批读）：一批至少一份，
 * 一行、一次提交的主键都可以接近单个值的上限，一次读进来的约这么多加一份，远小于 DO 的内存（128 MB）
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/（Memory per isolate）
 */
export const readBytes = 1_000_000;

/** 云端每次从库里至多取多少行或多少次提交（另按 readBytes 封顶）：读够一块的预算就停，多取的下一块再取 */
export const batchRows = 100;
