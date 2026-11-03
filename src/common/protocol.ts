/**
 * 设备与空间之间的消息：推送、拉取与通知。
 * 不该知道的：消息怎么传（WebSocket、HTTP）、接入方的表。
 * @see https://doc.replicache.dev/reference/server-push
 * @see https://doc.replicache.dev/reference/server-pull
 */

/** 设备的状态等于云端在 version 那一版时的状态；nonce 是那一版提交的随机数，时间点恢复、清空重建后用它认出走岔的游标。第 0 版（空库）的 nonce 在建空间时随机定一次 */
export type Cookie = { version: number; nonce: number };

/** 两个游标是不是同一版（版本与随机数都相同）；都没有也算相同 */
export const sameCookie = (a: Cookie | null, b: Cookie | null) => a?.version === b?.version && a?.nonce === b?.nonce;

/** 共用空间的一版与它是空间的哪一代（代是建空间时定的随机数，清空重建后不同；没记下代的本机数据是 undefined） */
export type Point = { cookie: Cookie; incarnation: number | undefined };

/** a 比 b 新（model/Shared.tla 的 Newer）：b 没有、不是同一代（代是随机数，只比相等、分不出先后），或同一代里版本更大 */
export const newer = (a: Point, b: Point | undefined) => !b || a.incarnation !== b.incarnation || a.cookie.version > b.cookie.version;

/**
 * 一次本机写：id 在每个 client 内从 1 递增；changes 是它改到的行，每行一次、不分先后。
 * first：推送时标在这个客户端本机最早的待上传上（模型 PushMsg 的 first）：比云端处理到的大时云端跳号，没标的照常当空洞跳过
 */
export type Mutation = { client: string; id: number; changes: Change[]; first?: true };

/** 列的值：SQLite 的整数、小数、文本与 NULL（同步表不存 BLOB） */
export type Value = number | string | null;

/**
 * 本机写改到的一行，行与主键都是 SQL 列名到值：put 是插入的整行（主键已在时改成这些值），
 * patch 是主键加改了的列（行已不在时什么也不做），del 是主键
 * @see https://docs.powersync.com/client-sdks/writing-data
 */
export type Change =
  | { op: 'put'; table: string; row: Record<string, Value> }
  | { op: 'patch'; table: string; row: Record<string, Value> }
  | { op: 'del'; table: string; key: Record<string, Value> };

/**
 * 云端行的改动。行与主键都是 SQL 列名到 SQLite 值；put 另带主键（本机还没有的表的行也按主键存）。
 * clear 只出现在整份下发的开头；drop 是这张表（给了 columns 是这些列，给了 range 是主键在这一段里的行）设备上一个不留，之后的改动照常叠上：
 * 离开了同步，或扫描先清（按范围重下的一段给 range）
 * @see https://docs.powersync.com/architecture/powersync-protocol
 */
export type Op =
  | { op: 'put'; table: string; key: Record<string, unknown>; row: Record<string, unknown> }
  | { op: 'del'; table: string; key: Record<string, unknown> }
  | { op: 'drop'; table: string; columns?: string[] }
  | { op: 'drop'; table: string; range: KeyRange }
  | { op: 'clear' };

/** 主键的一段：key 是主键的列（按比较的先后），在 after 之后（没有是从头）、不超过 until（没有是到尾）的，按行值比 */
export type KeyRange = { key: string[]; after?: Record<string, Value>; until?: Record<string, Value> };

/**
 * 通知与拉取的末块：设备游标等于 base 时才能接上；lmids 是各客户端处理到第几条：通知给 base 之后有提交的客户端，末块给请求列出的客户端。
 * 拉取分了块的，末块带这次请求的 cursor（上一块的 next），设备暂存的最后一块的 next 等于它才接得上。
 * 共用空间的末块另带 seen（见 Chunk）、next 与 landed：末块可能是缓存里的过时的副本，设备发现它比暂存的块早时，当作中间块从 next 接着拉；
 * landed 是这一块按的订阅（编过的，设备不解读），落地时存下、之后每次拉取原样带回
 */
export type Poke = {
  base: Cookie | null;
  cursor?: string;
  cookie: Cookie;
  lmids: Record<string, number>;
  patch: Op[];
  seen?: number;
  next?: string;
  landed?: string;
  /** base 之后云端扣下的写（执行不了，序号照样推进，原样存着待修复）：设备据此告诉用户哪条没存上 */
  held?: { client: string; id: number; reason: string }[];
  /** 私有空间的拉取要了校验和（PullRequest 的 checksum）时，末块带 cookie 那一版的数据里一段的校验和（云端当场算） */
  checksum?: Checksum;
} & Advice &
  Origin;

/** 校验和的一段里一张表的一部分：主键在这一段里的行 */
export type ChecksumPart = { table: string } & KeyRange;

/**
 * 按范围重下的一张表（拉取请求的 ranges，校验和对不上的那一段的一部分）：主键在 after 之后、不超过 until 的行，都没给是整张表；
 * 云端按自己的主键的列比，不用设备说先后
 */
export type PullRange = Omit<ChecksumPart, 'key'>;

/**
 * 校验和的一段：按整份扫描的先后连着的几部分、这几部分的行的哈希之和、有几行（设备对的途中库变了按它减半）、下一段从哪起（设备原样带回；
 * 没有是这一段读到了最后）。最后一段另带全部同步表（tables）：设备把这些表以外、本机还存着的行也算进这一段（云端没有它们，和是 0），残留的行也对得出来
 */
export type Checksum = { parts: ChecksumPart[]; sum: number; rows: number; next?: string; tables?: string[] };

/**
 * 消息另带它来自哪：私有空间的补齐、提示与拉取结果带 space（入口验过的身份）。设备第一次同步时记下，之后对不上就是这个设备上
 * 换了账号（如 web 上另一个标签页换了登录，token 已是别人的）：不收、不推，停下报 AccountMismatch。
 * 共用空间的拉取结果、通知与提示带 sub（这条消息按的订阅的指纹，入口按令牌算出订阅）：与本机落地时的不同，设备就去拉（云端从落地的订阅重起计划）；
 * 另带 incarnation（空间的这一代，第 0 版的随机数，清空重建后不同；分片还什么都没记时发的不带）：版本号换一代从头记、不能拿新旧比，设备据此认出换了代
 */
export type Origin = { space?: string; sub?: string; incarnation?: number };

/**
 * WebSocket 上的消息另带的、云端给设备的建议：spread 是断了之后重连在 0 到多少毫秒之间随机等
 * （广播分片按这片连着的设备数给：部署断开全部连接时，一片的设备不挤在 1 秒内一齐重连）；expiresIn 是这条连接的身份还有多久到期（毫秒，
 * 补齐里给，用相对时间不受设备时钟影响）：设备在到期前自己换新 token 重连，不攒到下一次通知时被一起关掉、一起重连
 * @see https://github.com/rocicorp/mono/blob/main/packages/zero-protocol/src/error.ts（minBackoffMs、maxBackoffMs）
 */
export type Advice = { spread?: number; expiresIn?: number };

/** 身份到 expiresAt（毫秒）还有多久；没有到期的时刻（测试里）不给 */
export const expiresIn = (expiresAt: number): Advice => (Number.isFinite(expiresAt) ? { expiresIn: expiresAt - Date.now() } : {});

/**
 * 拉取的一块，后面还有：设备先暂存，带着 next 拉下一块，末块到了与暂存的各块在一个本机事务里一起生效。
 * cursor 是这次请求带的（第一块没有）；cursor 与 next 对设备不透明，只原样带回。progress 是这次拉取到这块为止的进度（共用空间的增量块没有）。
 * 共用空间的块另带 seen：算这一块时云端的最新一版（块经缓存发出，可能是过时的副本）
 */
export type Chunk = { base: Cookie | null; cursor?: string; next: string; patch: Op[]; progress?: Progress; seen?: number } & Origin;

/**
 * 拉取的进度：downloaded 是已下的量，total 是开始时估的总共的量，只用来算比例。
 * 私有空间按字节估，共用空间按行（扫过的行 ÷ 看得见的行）。拉取中途又有提交时会超出，超出时总共跟着已下的涨，所以是估计
 * @see https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/db/crud/SyncProgress.ts
 */
export type Progress = { downloaded: number; total: number };

/** 共用空间的分片推给设备的提示：空间到了哪一版 */
export type Hint = { hint: Cookie } & Advice & Origin;

/** 共用空间拉取时游标不在云端当前的历史上（历史换掉了）：设备清空同步表，从头整份拉；私有空间不回它（整份重拉、待上传留着） */
export type Reset = { base: Cookie | null; reset: true } & Origin;

/**
 * 云端关掉连接、要设备先走 HTTP 拉取再连的关闭码（WebSocket 留给应用自定义的 4000–4999）：没有游标、私有空间的游标不在当前的历史上
 * （拉取会整份重拉）时用；补齐、通知太大不关连接，发提示。
 * 其他关闭（部署、断网）一律按退避重连
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2
 */
export const pullNeeded = 4000;

/** 云端处理推送出错（存储出错这类，不推进出错的那条）时关连接的关闭码（WebSocket 的 Internal Error）：设备退避后重连、重发 */
export const pushFailed = 1011;

/**
 * 云端认不出推上去的这批（解析不了、超出一次推送的上限、认不出哪条写是哪个客户端的第几条）时关连接的关闭码（WebSocket 的 Invalid frame payload data）：
 * 是设备的缺陷，原样重推只会再被拒，设备不再推、报出来（不当作 1011 那样的暂时出错）。认得出身份、只是改动认不出的写云端扣下，不关连接
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-7.4.1
 */
export const invalidPush = 1007;

/**
 * 推得太多（超过接入方设的写入额度 Quota，或当天的写入上限）时关连接的关闭码（WebSocket 的 Try Again Later）：这批没执行，设备照常按退避重连、重推
 * @see https://www.iana.org/assignments/websocket/websocket.xhtml#close-code-number
 */
export const overQuota = 1013;

/** HTTP 拉取的一块约多大（改动的 JSON 字符数）：攒到它就停（边缘自动压缩），DO 与设备一次只拿一块在内存里 */
export const chunkLimit = 1_000_000;

/**
 * 网最慢按每秒多少字节算（上下行一样）：GPRS 一个时隙、离基站远时用的 CS-1 编码，不含 RLC/MAC 开销 8.0 kbit/s（常见的 class 10 上行只有一两个时隙）。
 * WebSocket 上的消息大小与心跳的期限都按它定；TCP、TLS 的开销与握手由下面的余量吸收
 * @see https://en.wikipedia.org/wiki/General_Packet_Radio_Service#Coding_schemes_and_speeds
 */
export const slowestRate = 1_000;

/**
 * WebSocket 上一条消息至多多少字节（UTF-8）：补齐与通知超过它就只发提示，设备连着走 HTTP 拉（HTTP 按多久没收到数据计时，慢网也拉得完）；
 * 推送一批的改动封顶在它的一半。心跳按「整条消息到达」计时：最慢的网上一条约 24 秒传完，在 receiveTimeout
 * （30 秒，从建连接起、含握手）与 ping 之后等回音的时间之内
 */
export const socketLimit = 24_000;

/** 身份过期、云端关掉连接的关闭码；设备照常按退避重连，重连时取新 token */
export const expired = 4001;

/**
 * 设备怎么带 token：WebSocket 放在子协议里，和协议名一起发 [subprotocol, bearer + token]，云端回 subprotocol
 * （浏览器的 WebSocket 设不了请求头，放 URL 会进访问日志）；HTTP 拉取放 Authorization: Bearer <token>。
 * JWT 只含 base64url 字符与点，都是子协议名允许的字符
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-4.1
 * @see https://github.com/rocicorp/mono/blob/main/packages/zero-client/src/client/zero.ts（createSocket 的 Sec-WebSocket-Protocol）
 */
export const subprotocol = 'syncline';
export const bearer = 'bearer.';

/** 心跳：设备空闲时发 ping，云端回 pong（Durable Object 的自动回复，不唤醒对象） */
export const ping = 'ping';
export const pong = 'pong';

/**
 * 一次推送至多几条写：设备按它分批，云端照它拒收别的。不设上限时一条消息塞成千上万条写就能把空间的 CPU 用完；
 * 客户端数不另限：每个客户端处理到第几条一批只按主键查一次，至多与条数一样多
 */
export const pushMutations = 1000;

export const formatCookie = ({ version, nonce }: Cookie) => `${version}.${nonce}`;
