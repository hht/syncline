-------------------------------- MODULE Private --------------------------------
(***************************************************************************)
(* Syncline 私有空间的同步协议模型。                                         *)
(*                                                                         *)
(* 骨架是 Replicache 的推送 / 拉取 / 通知与「每空间一个版本号」，云端是一个    *)
(* DO：每处理一条写记一行提交记录（版本、随机数、改到的键）。设备保存同步表、  *)
(* 待上传（每条带撤回信息）和游标；收到云端改动时先撤回全部待上传回到游标那  *)
(* 一版，应用改动，丢掉已确认的，再重放剩下的。                              *)
(*                                                                         *)
(* 业务有两个 mutator：inc(k) 把 k 加 1，超过 MaxVal 就拒收；del(k) 删掉这一行； *)
(* 行已不在时都什么也不做。结果依赖当前值，所以设备预测和云端结果可以不同，     *)
(* 能覆盖重放、拒收与删除。                                                  *)
(*                                                                         *)
(* 表：NT 张，每张 NR 行；键 1..NT*NR 按（表，主键）排序，T(k) 是键所在的表。  *)
(* 网络：收到即消费；丢失与重复投递各有次数上限，次序任意。连接上的消息丢了   *)
(* 就是连接断了（WebSocket 走 TCP，不会只丢一条）。                          *)
(* 传输：WebSocket 连上时 URL 带游标，云端校验后从游标起读一份（与拉取同一个  *)
(* 读取器）：读得完就在这条连接上先发补齐通知，读不完发提示；HTTP 拉取：没连  *)
(* 上时（新装、被重置后），或连着时收到提示（补齐或通知太大，改走 HTTP、连接  *)
(* 不断）；拉取在路上时连上的接不上的通知丢掉、不断开。                       *)
(* 拉取的读取器：位置在一轮里先扫描、后追尾巴。扫描集 S(f, h) 是这一轮的起点 f *)
(* 之后、水位 h 及之前进入同步的表（整份时 f 为空，取 h 时在同步的全部表），  *)
(* 按键升序扫，每个键给当前值或「不在」（先清后扫）；尾巴从追到的一版追到最新， *)
(* 跳过 S 中表 t 版本不晚于 since(t) 的项（含其间的删掉）；追到最新时 (h, 最新] *)
(* 里又有表进入，就开下一轮。可以先给几块（设备暂存、游标不动），再带 cursor  *)
(* （位置与算这一块时的最新一版 seen）接着拉，末块到了一起落地；位置不在当前  *)
(* 历史上就从头整份重拉。                                                    *)
(* 写的身份：（客户端，序号）一经生成永不改变。客户端表记每个客户端处理到第几  *)
(* 条（lmid），永不删；推送带每个客户端最早的待上传序号，比 lmid + 1 大时云端 *)
(* 把 lmid 跳到它之前（只往上跳），与这一条写同一个事务。                     *)
(* 日志：后台任务截掉下限之前的提交，下限记那一版的随机数；游标低于下限整份。 *)
(* 故障：消息丢失、重复、乱序；设备崩溃重启（换新客户端编号）；部署断开全部     *)
(* 连接；时间点恢复（整库回到过去、对象重启，不封口：游标不在恢复后的历史上的  *)
(* 设备整份重拉、待上传留着）；设备从备份恢复，也可以恢复到另一台设备上（克隆）；*)
(* 云端处理推送时存储出错；本机一行被改坏（校验和发现后按主键范围重下）；     *)
(* 用户要整份重下（resync：断开、从头整份拉，待上传留着，拉到最新才再连）。   *)
(* 后台写（导入等服务端写）：云端自己执行一次写，像设备的写一样记提交、发通知。 *)
(* 同步范围：范围表记每张表在不在同步与最近一次进入的版本 since。进入同步（只  *)
(* 在云端的表、或离开过的表回来）只写 since、记一版不带键的提交，行由拉取的扫描 *)
(* 给；离开同步记一版「删掉」，设备收到后这张表一行不留；离开期间云端可以直接  *)
(* 改这些行（不记提交）。                                                    *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Devices,       \* 设备集合
    NT,            \* 表的张数
    NR,            \* 每张表的行数
    MaxVal,        \* inc 超过它就拒收
    MaxMuts,       \* 全部设备一共最多产生几条写
    MaxDeletes,    \* 其中（连同后台写）最多几条是 del
    MaxCrashes,    \* 设备崩溃重启次数上限
    MaxDeploys,    \* 部署次数上限
    MaxRestores,   \* 时间点恢复次数上限
    MaxBackups,    \* 设备备份次数上限（每次覆盖唯一的备份槽）
    MaxDrops,      \* 网络丢消息次数上限（无限丢就谈不上收敛）
    MaxDups,       \* 网络重复投递次数上限
    MaxBackendWrites, \* 后台写（导入等服务端写）次数上限
    MaxChunks,     \* 拉取分块（设备暂存，再带 cursor 接着拉）的块数上限
    MaxStorageErrors, \* 云端处理推送时存储出错的次数上限
    Later,         \* 只在云端的表：部署后进入同步
    Retiring,      \* 同步表：部署后离开同步
    MaxReturns,    \* 离开同步的表最多回来几次（0 就是删掉、不再回来）
    MaxHints,      \* 提示（补齐、通知太大）的次数上限：连上时补齐读不完，或连着时改走 HTTP 拉取
    MaxTruncs,     \* 后台任务截日志的次数上限
    MaxCorrupts,   \* 本机一行被改坏的次数上限
    MaxRefetches   \* 用户要整份重下的次数上限

ASSUME MaxRestores \in {0, 1, 2}
ASSUME Later \cup Retiring \subseteq 1..NT /\ Later \cap Retiring = {}
\* 坏行与备份不同时查（备份回滚坏行没有建模）
ASSUME MaxCorrupts = 0 \/ MaxBackups = 0

Tables == 1..NT
Keys == 1..(NT * NR)
T(k) == ((k - 1) \div NR) + 1
KeysOf(ts) == {k \in Keys : T(k) \in ts}

CNil == [nil |-> TRUE]     \* 被重置后还没拉过的游标
NoConn == 0               \* 没连上（连接编号从 1 开始）
Backend == 0              \* 后台写与范围变化的提交（设备的客户端编号从 1 开始）
NoSnap == [none |-> TRUE]  \* 备份槽为空
NoStage == [none |-> TRUE] \* 没有暂存的块
Absent == -1              \* 行不在
Init0 == [k \in Keys |-> 0]                                     \* 云端开始时的表（只在云端的表也有这些行）
In0 == [t \in Tables |-> t \notin Later]                         \* 开始时在同步的表
Since0 == [t \in Tables |-> 0]                                   \* 开始时的 since
DevInit == [k \in Keys |-> IF T(k) \in Later THEN Absent ELSE 0]  \* 新装的设备：没有只在云端的表
Head0 == [v |-> 0, n |-> 0]          \* 空库的游标：版本 0、随机数 0
NoKey == 1                          \* 范围变化的提交不是一条写，不看 key、op
NoUid == 0                          \* 不是设备的写的提交没有写的编号（设备的写从 1 起编）
Merge(a, b) == [k \in DOMAIN a \cup DOMAIN b |-> IF k \in DOMAIN b THEN b[k] ELSE a[k]]
SetMax(S) == CHOOSE x \in S : \A y \in S : y <= x
SetMin(S) == CHOOSE x \in S : \A y \in S : x <= y
SyncedOf(in) == KeysOf({t \in Tables : in[t]})

\* 业务：inc(k)、del(k)；行已不在时什么也不做（rows.ts 的 patch、del）。w：真改了这一行（实现里 RETURNING 有行才记进提交）
Run(t, k, op) ==
    IF t[k] = Absent THEN [ok |-> TRUE, w |-> FALSE, t |-> t]
    ELSE IF op = "del" THEN [ok |-> TRUE, w |-> TRUE, t |-> [t EXCEPT ![k] = Absent]]
    ELSE IF t[k] + 1 > MaxVal THEN [ok |-> FALSE, w |-> FALSE, t |-> t]
    ELSE [ok |-> TRUE, w |-> TRUE, t |-> [t EXCEPT ![k] = @ + 1]]

\* 云端执行设备的一条写：改的不是同步表就拒收（实现里是每次执行都会出的错，扣下）
Exec(t, syn, k, op) == IF k \in syn THEN Run(t, k, op) ELSE [ok |-> FALSE, w |-> FALSE, t |-> t]

VARIABLES
    sData,        \* 云端的表
    sCommits,     \* 提交记录，第 i 条就是版本 i（截掉的也留着，是幽灵：读只读得到日志下限之后的）
    sHist,        \* 幽灵：sHist[i] = 版本 i 之后的云端表（恢复时用）
    sLow,         \* 日志下限：这一版及之前的提交已截掉，记下它的版本与随机数
    sLowHist,     \* 幽灵：sLowHist[i] = 记下版本 i 时（那段时间开始时）的日志下限（恢复时用）
    sIn, sSince,  \* 范围表：每张表在不在同步、最近一次进入的版本
    sConns,       \* 云端认为还连着的连接编号
    nonceOf,      \* 幽灵：随机数 -> 那一版的云端表与设备该有的行（跨时间线保留，用来写不变量）
    nextNonce,    \* 模型化「随机数各不相同」
    gapSeen,      \* 幽灵：推送里出现过序号空洞（P3）
    dTables,      \* 设备的表
    dCookie,      \* 设备游标，CNil 表示被重置后还没拉过
    dPending,     \* 设备待上传：<<[client, mid, key, op, undo, uid]>>；uid 是幽灵：写下时取的全局编号 nextUid（P8k、P8r、P11 用）
    dClient,      \* 设备当前会话的客户端编号
    dNextMid,     \* 当前会话下一条写的序号
    dConn,        \* 设备当前连接编号，NoConn 表示没连
    dWant,        \* 设备记着要追到的版本（实现的 wanted）：丢掉的接不上的通知、云端的提示说的；比游标新就连着拉，开新连接、进程重启时作废（0）
    dStaged,      \* 设备分块拉取暂存的：接着拉的位置（pos）、算这一块时的最新一版（seen）与叠起来的值（rows）；NoStage 表示没有
    dBad,         \* 幽灵：本机被改坏、还没重下的键
    dRefetch,     \* 设备记着要整份重拉（用户要的整份重下；实现里记在库里的游标那一行）：拉取带上它、云端从头整份给；游标换了（落地）就不再要，
                  \* 进程重启还在。升级本机表、撤回失败时实现也记它（撤回失败时不断开），模型里没有这两条
    net,          \* 在途消息：可丢、可重复投递、可乱序
    nextClient, nextConn,
    muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
    bSnap,        \* 唯一的设备备份槽
    nextUid,      \* 幽灵：下一条设备的写的编号（只给检查用：每条写一个）
    rolled,       \* 幽灵：时间点恢复回滚掉的写（提交记录里被截掉的 uid）；只有它们可以丢（P8k）
    forbidden,    \* 幽灵：回滚掉、且恢复那一刻没有任何设备（或备份）还留在待上传里的写：不许再出现在提交记录里（P8r）
    lostByBackup  \* 幽灵：设备从备份恢复时丢掉的待上传（备份之后写下的）

\* 云端存的（推送、后台写、范围变化、恢复、截日志改的那些）
logVars == <<sData, sCommits, sHist, sLow, sLowHist, sIn, sSince, nonceOf, nextNonce, gapSeen>>
devVars == <<dTables, dCookie, dPending, dClient, dNextMid, nextClient, dWant, dStaged, dBad, dRefetch>>
counters == <<muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts,
             refetches>>
\* 收下消息的动作里不变的次数（重复投递在 Take 里）
fixed == <<muts, dels, crashes, deploys, restores, backups, drops, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches>>
ghostVars == <<nextUid, rolled, forbidden, lostByBackup>>
vars == <<logVars, sConns, devVars, dConn, net, nextConn, counters, bSnap, ghostVars>>

\* 同步表的行
sSynced == SyncedOf(sIn)

\* ---------------------------------------------------------------- 云端工具
\* 还能写的 mutator：del 有次数上限
Ops == IF dels < MaxDeletes THEN {"inc", "del"} ELSE {"inc"}

HeadOf(cs) == IF cs = <<>> THEN Head0 ELSE [v |-> Len(cs), n |-> cs[Len(cs)].nonce]
HistAt(h, i) == IF i = 0 THEN Init0 ELSE h[i]

\* 客户端表：这个客户端处理到第几条，永不删。跳号与这个客户端的下一条写同一个事务、跳到它之前，
\* 所以 lmid 总是它最后一条提交的序号（截掉的提交也算：客户端表不随日志截断）
Lmid(cs, c) == SetMax({0} \cup {cs[i].mid : i \in {i \in 1..Len(cs) : cs[i].client = c}})
\* 拉取的末块给各客户端处理到的（实现里只给请求列出的、设备待上传的那几个客户端，结果相同）
AllLmids(cs) == [c \in {cs[i].client : i \in 1..Len(cs)} |-> Lmid(cs, c)]
\* 通知给版本 from 之后有提交的客户端
LmidsSince(cs, from) == [c \in {cs[i].client : i \in (from + 1)..Len(cs)} |-> Lmid(cs, c)]

\* 游标在不在当前历史上：不低于日志下限（等于下限时比下限记的随机数），不晚于最新，那一版的随机数对得上（commits.ts 的 onHistory）
OnHist(c) == /\ c # CNil
             /\ c.v >= sLow.v /\ c.v <= Len(sCommits)
             /\ IF c.v = sLow.v THEN c.n = sLow.n ELSE sCommits[c.v].nonce = c.n
\* 当前历史上的一版的游标
At(v) == IF v = sLow.v THEN sLow ELSE [v |-> v, n |-> sCommits[v].nonce]
\* 当前历史上的全部游标（与 OnHist 无关的独立写法，供性质 P8a 对照）
HistCookies == {sLow} \cup {[v |-> i, n |-> sCommits[i].nonce] : i \in (sLow.v + 1)..Len(sCommits)}

\* 一行提交记录：改到的键 keys、删掉（离开同步）的表 drop。syn、in、since、key、op、uid 是幽灵：
\* 记下时的同步表（设备到这一版该有的行）与范围表（恢复时用），设备的写本身（P2、P8k、P8r、P11）
Entry(nonce, client, mid, key, op, keys, uid) ==
    [nonce |-> nonce, client |-> client, mid |-> mid, key |-> key, op |-> op, keys |-> keys, drop |-> {},
     uid |-> uid, syn |-> sSynced, in |-> sIn, since |-> sSince]
\* 同步范围变化的一次提交（客户端是 Backend，不带键）：删掉的表 drop、之后的范围表
Rescoped(cs, drop, in, since) ==
    [Entry(nextNonce, Backend, Lmid(cs, Backend) + 1, NoKey, "none", {}, NoUid)
        EXCEPT !.drop = drop, !.syn = SyncedOf(in), !.in = in, !.since = since]

\* 通知；onHist 是幽灵，供 P8a 检查增量只发给游标在当前历史上的设备
Poke(d, conn, base, cookie, lm, patch) ==
    [type |-> "poke", to |-> d, conn |-> conn, base |-> base, cookie |-> cookie, lmids |-> lm,
     patch |-> patch, onHist |-> base \in HistCookies]

\* 一批写按顺序逐条处理（照 Replicache）：重复跳过；序号正好接在 lmid 后面的照常处理；
\* 比那大、又是这个客户端最早的待上传（first）的跳号后处理（时间点恢复回滚掉了它前面已确认的几条）；
\* 其余来自未来的（前面还缺）跳过（gap 记下出现过）。拒收也推进序号
RECURSIVE Process(_, _, _, _, _, _, _)
Process(data, cs, hist, nonce, gap, ms, first) ==
    IF ms = <<>> THEN [data |-> data, cs |-> cs, hist |-> hist, nonce |-> nonce, gap |-> gap]
    ELSE LET m == Head(ms)
             l == Lmid(cs, m.client)
         IN IF m.mid <= l THEN Process(data, cs, hist, nonce, gap, Tail(ms), first)
            ELSE IF m.mid > l + 1 /\ m.mid # first[m.client] THEN Process(data, cs, hist, nonce, TRUE, Tail(ms), first)
            ELSE LET r == Exec(data, sSynced, m.key, m.op)
                     e == Entry(nonce, m.client, m.mid, m.key, m.op, IF r.w THEN {m.key} ELSE {}, m.uid)
                 IN Process(r.t, Append(cs, e), Append(hist, r.t), nonce + 1, gap, Tail(ms), first)

\* ---------------------------------------------------------------- 读取器
\* 位置：full（以整份开头）、f（这一轮的起点，整份第一轮是 CNil）、h（这一轮的水位）、at（扫到的键）、
\* p（尾巴追到的一版）、rng（设备要求重下的键）、heal（幽灵：落地后恢复的坏行）
From(pos) == IF pos.f = CNil THEN -1 ELSE pos.f.v
\* 扫描集：f 之后、h 及之前进入同步、现在仍在同步的表
S(f, h) == {t \in Tables : sIn[t] /\ f < sSince[t] /\ sSince[t] <= h}
\* 这一轮还没扫的键：扫描集里的表的键，加上设备要求重下的
Rem(pos) == {k \in KeysOf(S(From(pos), pos.h.v)) \cup pos.rng : k > pos.at}
\* 扫描给的：每个键的当前值，不在同步里的给「不在」
ScanRows(K) == [k \in K |-> IF k \in sSynced THEN sData[k] ELSE Absent]
\* 读提交只能读到日志下限之后的（之前的已截掉）
Readable(from, upTo) == {i \in (from + 1)..upTo : i > sLow.v}
\* 尾巴里跳过的项：扫描集里的表 t 在 since(t) 及之前的（扫描已给了现在的值）
Skip(i, t, pos) == t \in S(From(pos), pos.h.v) /\ i <= sSince[t]
\* 尾巴 (from, upTo] 里的改动：改到的同步表的行给当前值，删掉的表的行给「不在」，都除去跳过的项
TailRows(from, upTo, pos) ==
    LET is == Readable(from, upTo)
        changed == UNION {{k \in sCommits[i].keys : ~Skip(i, T(k), pos)} : i \in is} \cap sSynced
        dropped == KeysOf(UNION {{t \in sCommits[i].drop : ~Skip(i, t, pos)} : i \in is})
    IN [k \in changed \cup dropped |-> IF k \in changed THEN sData[k] ELSE Absent]
\* 追到最新时 (h, 最新] 里又有表进入：开下一轮
More(pos) == S(pos.h.v, Len(sCommits)) # {}
NextRound(pos) == [pos EXCEPT !.f = pos.h, !.h = HeadOf(sCommits), !.at = 0, !.p = HeadOf(sCommits), !.rng = {}]
\* 读完剩下的：本轮剩下的扫描、尾巴追到最新；追到时要开下一轮就把下一轮也扫完（尾巴已在最新）
FinalRows(pos) ==
    LET r1 == Merge(ScanRows(Rem(pos)), TailRows(pos.p.v, Len(sCommits), pos))
    IN IF More(pos) THEN Merge(r1, ScanRows(Rem(NextRound(pos)))) ELSE r1
\* 新的位置：整份从最新一版扫全部同步表；增量从游标起，扫描集加上设备要求重下的键
StartPos(cookie, rng, full) ==
    [full |-> full, f |-> IF full THEN CNil ELSE cookie, h |-> HeadOf(sCommits), at |-> 0,
     p |-> IF full THEN HeadOf(sCommits) ELSE cookie, rng |-> IF full THEN {} ELSE rng,
     heal |-> IF full THEN Keys ELSE rng]
\* 设备带回的 cursor 接不接着用：算块时的最新一版、位置里的各版、增量的游标都要在当前历史上
Valid(m) ==
    LET pos == m.cursor.pos
    IN /\ OnHist(m.cursor.seen) /\ OnHist(pos.h) /\ OnHist(pos.p)
       /\ (pos.f # CNil => OnHist(pos.f))
       /\ (~pos.full => OnHist(m.cookie))

\* ---------------------------------------------------------------- 设备工具
\* 撤回一条待上传
Undo(t, p) == IF p.undo = <<>> THEN t ELSE [t EXCEPT ![p.undo[1]] = p.undo[2]]
RECURSIVE Rewind(_, _)
Rewind(t, ps) == IF ps = <<>> THEN t ELSE Rewind(Undo(t, ps[Len(ps)]), SubSeq(ps, 1, Len(ps) - 1))

\* 重放：重新执行并重新记撤回信息；本机预测失败就记空，照样上传
RECURSIVE Replay(_, _)
Replay(t, ps) ==
    IF ps = <<>> THEN [t |-> t, ps |-> <<>>]
    ELSE LET p == Head(ps)
             r == Run(t, p.key, p.op)
             p2 == [p EXCEPT !.undo = IF r.ok THEN <<p.key, t[p.key]>> ELSE <<>>]
             rest == Replay(r.t, Tail(ps))
         IN [t |-> rest.t, ps |-> <<p2>> \o rest.ps]

LmidIn(lm, c) == IF c \in DOMAIN lm THEN lm[c] ELSE 0

\* 应用一份云端改动（通知或拉取结果都走这里）；设备上是一个本机事务：撤回、叠上 rows（整份时没给的键都「不在」）、
\* 丢掉已确认的、重放剩下的（序号不改）
ApplyPatch(d, cookie, lm, rows, full) ==
    LET t1 == Rewind(dTables[d], dPending[d])
        t2 == [k \in Keys |-> IF k \in DOMAIN rows THEN rows[k] ELSE IF full THEN Absent ELSE t1[k]]
        r == Replay(t2, SelectSeq(dPending[d], LAMBDA p : p.mid > LmidIn(lm, p.client)))
    IN /\ dTables' = [dTables EXCEPT ![d] = r.t]
       /\ dPending' = [dPending EXCEPT ![d] = r.ps]
       /\ dCookie' = [dCookie EXCEPT ![d] = cookie]

NewSession(d) ==
    /\ dClient' = [dClient EXCEPT ![d] = nextClient]
    /\ dNextMid' = [dNextMid EXCEPT ![d] = 1]
    /\ nextClient' = nextClient + 1

\* 消费一条消息并放进新消息；也可能是重复投递：原消息还留在网络里
Take(m, new) ==
    \/ /\ net' = (net \ {m}) \cup new
       /\ UNCHANGED dups
    \/ /\ dups < MaxDups
       /\ dups' = dups + 1
       /\ net' = net \cup new

\* 云端关掉这些连接时发给设备的关闭：排在这条连接上已发出的消息后面，设备收到它才知道断了（之前发出的通知照样收得到）
Closing(conns) == {[type |-> "close", to |-> d, conn |-> dConn[d]] : d \in {e \in Devices : dConn[e] \in conns}}

\* 断开全部连接（部署、对象重启）：云端不再记着它们，设备各收到一个关闭
DropAll ==
    /\ sConns' = {}
    /\ net' = net \cup Closing(sConns)

\* ---------------------------------------------------------------- 初始
Init ==
    /\ sData = Init0 /\ sCommits = <<>> /\ sHist = <<>> /\ sLow = Head0 /\ sLowHist = <<>>
    /\ sIn = In0 /\ sSince = Since0
    /\ sConns = {}
    /\ nonceOf = [n \in {0} |-> [t |-> Init0, vis |-> SyncedOf(In0)]] /\ nextNonce = 1
    /\ gapSeen = FALSE
    /\ dTables = [d \in Devices |-> DevInit]
    /\ dCookie = [d \in Devices |-> CNil]     \* 新装：先整份拉取
    /\ dPending = [d \in Devices |-> <<>>]
    /\ \E f \in [Devices -> 1..Cardinality(Devices)] :
          /\ \A a, b \in Devices : a # b => f[a] # f[b]
          /\ dClient = f
    /\ dNextMid = [d \in Devices |-> 1]
    /\ dConn = [d \in Devices |-> NoConn]
    /\ dWant = [d \in Devices |-> 0]
    /\ dStaged = [d \in Devices |-> NoStage]
    /\ dBad = [d \in Devices |-> {}]
    /\ dRefetch = [d \in Devices |-> FALSE]
    /\ net = {}
    /\ nextClient = Cardinality(Devices) + 1 /\ nextConn = 1
    /\ muts = 0 /\ dels = 0 /\ crashes = 0 /\ deploys = 0 /\ restores = 0 /\ backups = 0
    /\ drops = 0 /\ dups = 0 /\ bwrites = 0 /\ errs = 0 /\ returns = 0 /\ hints = 0
    /\ chunks = 0 /\ truncs = 0 /\ corrupts = 0 /\ refetches = 0
    /\ bSnap = NoSnap
    /\ nextUid = 1 /\ rolled = {} /\ forbidden = {} /\ lostByBackup = {}

\* ---------------------------------------------------------------- 设备动作
\* 本机写：不等网络。本机预测失败（会超过 MaxVal）就不产生写。设备的代码与云端的一样，只写同步表
Mutate(d, k, op) ==
    /\ muts < MaxMuts /\ k \in sSynced
    /\ LET r == Run(dTables[d], k, op) IN
       /\ r.ok
       /\ dTables' = [dTables EXCEPT ![d] = r.t]
       /\ dPending' = [dPending EXCEPT ![d] = Append(@,
              [client |-> dClient[d], mid |-> dNextMid[d], key |-> k, op |-> op, undo |-> <<k, dTables[d][k]>>,
               uid |-> nextUid])]
    /\ dNextMid' = [dNextMid EXCEPT ![d] = @ + 1]
    /\ nextUid' = nextUid + 1
    /\ muts' = muts + 1
    /\ dels' = IF op = "del" THEN dels + 1 ELSE dels
    /\ UNCHANGED <<logVars, sConns, dCookie, dClient, nextClient, dWant, dStaged, dBad, dRefetch, dConn, net, nextConn,
                   crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, rolled, forbidden, lostByBackup>>

\* 拉取带的 cursor：位置与算这一块时的最新一版
CursorOf(s) == IF s = NoStage THEN NoStage ELSE [pos |-> s.pos, seen |-> s.seen]

\* 拉取在路上（请求或结果）：这时不连 WebSocket、不再发拉取
PullInFlight(d) ==
    \E m \in net : \/ m.type = "pullreq" /\ m.from = d
                   \/ m.type \in {"pullresp", "chunk"} /\ m.to = d

\* 建 WebSocket，URL 带游标：游标要在当前历史上（不在的云端以 4000 关掉，设备先整份拉取再连，模型里就是连不上、只能拉）。
\* 连上时从游标起读一份：读得完就在这条连接上先发补齐通知（已是最新也发一条空的；有表进入时含扫描），
\* 读不完（超了一次请求的预算）发提示，设备连着走 HTTP 拉；之后的通知都排在它后面
Connect(d) ==
    /\ dConn[d] = NoConn /\ OnHist(dCookie[d]) /\ dStaged[d] = NoStage /\ ~PullInFlight(d) /\ ~dRefetch[d]
    /\ dWant' = [dWant EXCEPT ![d] = 0]
    /\ dConn' = [dConn EXCEPT ![d] = nextConn]
    /\ sConns' = sConns \cup {nextConn}
    /\ nextConn' = nextConn + 1
    /\ \/ /\ net' = net \cup {Poke(d, nextConn, dCookie[d], HeadOf(sCommits), LmidsSince(sCommits, dCookie[d].v),
                                   FinalRows(StartPos(dCookie[d], {}, FALSE)))}
          /\ UNCHANGED hints
       \/ /\ hints < MaxHints /\ hints' = hints + 1
          /\ net' = net \cup {[type |-> "hint", to |-> d, conn |-> nextConn, cookie |-> HeadOf(sCommits)]}
    /\ UNCHANGED <<logVars, dTables, dCookie, dPending, dClient, dNextMid, nextClient, dStaged, dBad, dRefetch,
                   muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* 推送全部待上传，带每个客户端最早的待上传序号（first）
PushMsg(d) ==
    LET ps == dPending[d]
    IN [type |-> "push", from |-> d, conn |-> dConn[d],
        muts |-> [i \in 1..Len(ps) |-> [client |-> ps[i].client, mid |-> ps[i].mid, key |-> ps[i].key, op |-> ps[i].op, uid |-> ps[i].uid]],
        first |-> [c \in {ps[i].client : i \in 1..Len(ps)} |-> SetMin({ps[i].mid : i \in {j \in 1..Len(ps) : ps[j].client = c}})]]

\* 推送（只能走已连上的连接；同样的推送已在路上就不重复发）
Push(d) ==
    /\ dConn[d] # NoConn /\ dPending[d] # <<>>
    /\ PushMsg(d) \notin net
    /\ net' = net \cup {PushMsg(d)}
    /\ UNCHANGED <<logVars, sConns, devVars, dConn, nextConn, counters, bSnap, ghostVars>>

\* 设备可以要求重下的键（校验和对不上之后）：对不上的一段，按（表，主键）连续，可以跨几张表（前一张表的尾段、中间的整张表、后一张表的
\* 头段；起止不全的退成整张表，也在其中）；最后一段另带云端不同步的表整张（设备上残留的对得出来），合起来含至少一个坏行，并成一次
\* 拉取；没有暂存时（有暂存的拉取接着拉，不带范围）。
\* 不要求没有待上传：重下给最新一版的值，落地照常撤回、重放（「没有待上传」是校验和比对的前提，比对在模型外）
Ranges(d) ==
    IF dStaged[d] = NoStage /\ dBad[d] # {}
    THEN {r \in {seg \cup rest : seg \in {{k \in Keys : a <= k /\ k <= b} : a, b \in Keys},
                                rest \in {{}, KeysOf({t \in Tables : ~sIn[t]})}} : r \cap dBad[d] # {}}
    ELSE {}

\* HTTP 拉取：没连上时（新装、被重置后），或连着时落后于记着要追到的版本（Wanting），或连着时收到补齐、通知太大的提示
\* （改走 HTTP、连接不断；这种提示随时可能来，不另建提示消息，次数有上限），或要求重下一段；同一时刻只有一个在路上。
\* 暂存了块时带上 cursor，接着拉
Wanting(d) == dCookie[d] # CNil /\ dWant[d] > dCookie[d].v
PullMsg(d, rng) == [type |-> "pullreq", from |-> d, cookie |-> dCookie[d], cursor |-> CursorOf(dStaged[d]), rng |-> rng, full |-> dRefetch[d]]
PullReq(d) ==
    /\ ~PullInFlight(d)
    /\ \/ (dConn[d] = NoConn \/ Wanting(d)) /\ net' = net \cup {PullMsg(d, {})} /\ UNCHANGED hints
       \/ dConn[d] # NoConn /\ hints < MaxHints /\ hints' = hints + 1 /\ net' = net \cup {PullMsg(d, {})}
       \/ \E rng \in Ranges(d) : net' = net \cup {PullMsg(d, rng)} /\ UNCHANGED hints
    /\ UNCHANGED <<logVars, sConns, devVars, dConn, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* 收到通知：只认当前连接上、base 等于本机游标、没有暂存的块的（分块拉取到一半时游标不动，通知接在游标上也不应用）
RecvPokeOf(d, m) ==
    /\ m.type = "poke" /\ m.to = d /\ m.conn = dConn[d] /\ m.base = dCookie[d] /\ dStaged[d] = NoStage
    /\ ApplyPatch(d, m.cookie, m.lmids, m.patch, FALSE)
    /\ dRefetch' = [dRefetch EXCEPT ![d] = FALSE]
    /\ Take(m, {})
    /\ UNCHANGED <<logVars, sConns, dClient, dNextMid, nextClient, dWant, dStaged, dBad, dConn, nextConn, fixed, bSnap, ghostVars>>
RecvPoke(d) == \E m \in net : RecvPokeOf(d, m)

\* 落地或暂存的值：从头重拉的（reset）或没有暂存时就是这一块的，否则叠在暂存上
Landed(d, m) == IF m.reset \/ dStaged[d] = NoStage THEN m.rows ELSE Merge(dStaged[d].rows, m.rows)

\* 收到拉取结果：base 必须仍是本机游标，cursor 必须是本机暂存到的地方；末块与暂存一起落地，暂存清掉，重下的坏行恢复
RecvPullOf(d, m) ==
    /\ m.type = "pullresp" /\ m.to = d /\ m.base = dCookie[d] /\ m.cursor = CursorOf(dStaged[d])
    /\ ApplyPatch(d, m.cookie, m.lmids, Landed(d, m), m.full)
    /\ dStaged' = [dStaged EXCEPT ![d] = NoStage]
    /\ dBad' = [dBad EXCEPT ![d] = @ \ m.heal]
    /\ dRefetch' = [dRefetch EXCEPT ![d] = FALSE]
    /\ Take(m, {})
    /\ UNCHANGED <<logVars, sConns, dClient, dNextMid, nextClient, dWant, dConn, nextConn, fixed, bSnap, ghostVars>>
RecvPull(d) == \E m \in net : RecvPullOf(d, m)

\* 收到一块：暂存、不生效（游标不动），记下接着拉的位置；cursor 必须是本机暂存到的地方
RecvChunkOf(d, m) ==
    /\ m.type = "chunk" /\ m.to = d /\ m.base = dCookie[d] /\ m.cursor = CursorOf(dStaged[d])
    /\ dStaged' = [dStaged EXCEPT ![d] = [pos |-> m.pos, seen |-> m.seen, rows |-> Landed(d, m)]]
    /\ Take(m, {})
    /\ UNCHANGED <<logVars, sConns, dTables, dCookie, dPending, dClient, dNextMid, nextClient, dWant, dBad, dRefetch, dConn, nextConn,
                   fixed, bSnap, ghostVars>>
RecvChunk(d) == \E m \in net : RecvChunkOf(d, m)

\* 发给本设备、但已经用不上的消息（旧连接上的通知、提示与关闭，base 或 cursor 对不上的结果）：丢掉。
\* 当前连接上的通知接不上本机游标或有暂存的块：拉取在路上或拉到一半（连着时改走了 HTTP）、记着要追的版本还没追到，丢掉、
\* 记下要追到它（拉取回来后游标还早于它就接着拉）；拉取已把设备带过了这一版，丢掉；否则是这条连接上的消息乱了，断开重连，连上时补齐
Passed(d, m) == dCookie[d] # CNil /\ m.cookie.v <= dCookie[d].v
Covered(d, m) == PullInFlight(d) \/ dStaged[d] # NoStage \/ Wanting(d) \/ Passed(d, m)
StaleOf(d, m) ==
    /\ \/ m.type = "poke" /\ m.to = d /\ (m.conn # dConn[d] \/ m.base # dCookie[d] \/ dStaged[d] # NoStage)
       \/ m.type \in {"close", "hint"} /\ m.to = d /\ m.conn # dConn[d]
       \/ m.type \in {"pullresp", "chunk"} /\ m.to = d /\ m.base # dCookie[d]
       \/ m.type \in {"pullresp", "chunk"} /\ m.to = d /\ m.cursor # CursorOf(dStaged[d])
    /\ net' = net \ {m}
    /\ LET current == m.type = "poke" /\ m.conn = dConn[d]
       IN /\ dConn' = IF current /\ ~Covered(d, m) THEN [dConn EXCEPT ![d] = NoConn] ELSE dConn
          /\ dWant' = IF current /\ Covered(d, m) /\ ~Passed(d, m) /\ m.cookie.v > dWant[d]
                      THEN [dWant EXCEPT ![d] = m.cookie.v] ELSE dWant
    /\ UNCHANGED <<logVars, sConns, dTables, dCookie, dPending, dClient, dNextMid, nextClient, dStaged, dBad, dRefetch, nextConn,
                   counters, bSnap, ghostVars>>
Stale(d) == \E m \in net : StaleOf(d, m)

\* 设备收到当前连接上的提示（连上时补齐读不完；云端处理推送时存储出错、别的设备的写已提交却没发通知）：
\* 记下要追到它，连着走 HTTP 拉
RecvHintOf(d, m) ==
    /\ m.type = "hint" /\ m.to = d /\ m.conn = dConn[d]
    /\ dWant' = [dWant EXCEPT ![d] = IF m.cookie.v > @ THEN m.cookie.v ELSE @]
    /\ net' = net \ {m}
    /\ UNCHANGED <<logVars, sConns, dTables, dCookie, dPending, dClient, dNextMid, nextClient, dStaged, dBad, dRefetch, dConn, nextConn,
                   counters, bSnap, ghostVars>>
RecvHint(d) == \E m \in net : RecvHintOf(d, m)

\* 设备收到当前连接上的关闭（云端关掉了这条连接）：之前发出的消息都已收到，设备不再连着
RecvClose(d) ==
    \E m \in net :
       /\ m.type = "close" /\ m.to = d /\ m.conn = dConn[d]
       /\ dConn' = [dConn EXCEPT ![d] = NoConn]
       /\ net' = net \ {m}
       /\ UNCHANGED <<logVars, sConns, devVars, nextConn, counters, bSnap, ghostVars>>

\* 设备崩溃重启：内存丢失、断线、换新客户端编号；库里的东西都在
Crash(d) ==
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ dConn' = [dConn EXCEPT ![d] = NoConn]
    /\ dWant' = [dWant EXCEPT ![d] = 0]
    /\ NewSession(d)
    /\ UNCHANGED <<logVars, sConns, dTables, dCookie, dPending, dStaged, dBad, dRefetch, net, nextConn,
                   muts, dels, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* 系统备份（只备份库里的持久内容）
Backup(d) ==
    /\ backups < MaxBackups
    /\ backups' = backups + 1
    /\ bSnap' = [t |-> dTables[d], c |-> dCookie[d], p |-> dPending[d], s |-> dStaged[d], f |-> dRefetch[d]]
    /\ UNCHANGED <<logVars, sConns, devVars, dConn, net, nextConn,
                   muts, dels, crashes, deploys, restores, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   ghostVars>>

\* 从备份恢复（可以恢复到另一台设备上，即克隆）；恢复后就是一次重启
RestoreBackup(d) ==
    /\ bSnap # NoSnap
    /\ dTables' = [dTables EXCEPT ![d] = bSnap.t]
    /\ dCookie' = [dCookie EXCEPT ![d] = bSnap.c]
    /\ dPending' = [dPending EXCEPT ![d] = bSnap.p]
    /\ dStaged' = [dStaged EXCEPT ![d] = bSnap.s]
    /\ dRefetch' = [dRefetch EXCEPT ![d] = bSnap.f]
    /\ dConn' = [dConn EXCEPT ![d] = NoConn]
    /\ dWant' = [dWant EXCEPT ![d] = 0]
    /\ NewSession(d)
    /\ bSnap' = NoSnap
    \* 备份之后写下、还没上传的写跟着库一起回到过去
    /\ lostByBackup' = lostByBackup \cup ({dPending[d][i].uid : i \in 1..Len(dPending[d])} \ {bSnap.p[i].uid : i \in 1..Len(bSnap.p)})
    /\ UNCHANGED <<logVars, sConns, dBad, net, nextConn, counters, nextUid, rolled, forbidden>>

\* 本机一行被改坏（模型外：磁盘、绕过 Syncline 的写）；校验和会发现，之后按范围重下
Corrupt(d, k) ==
    /\ corrupts < MaxCorrupts /\ k \in sSynced
    /\ corrupts' = corrupts + 1
    /\ \E v \in ({Absent} \cup 0..MaxVal) \ {dTables[d][k]} : dTables' = [dTables EXCEPT ![d][k] = v]
    /\ dBad' = [dBad EXCEPT ![d] = @ \cup {k}]
    /\ UNCHANGED <<logVars, sConns, dCookie, dPending, dClient, dNextMid, nextClient, dWant, dStaged, dRefetch, dConn, net, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, refetches,
                   bSnap, ghostVars>>

\* 用户要整份重下（resync，待上传留着）：断开这次连接、丢掉暂存的块与要追的版本，记下要整份重拉（库里记着，重启也在）；
\* 拉到最新（落地，游标换了）之前不再连，落地时照常重放待上传、推上去
Refetch(d) ==
    /\ refetches < MaxRefetches
    /\ refetches' = refetches + 1
    /\ dRefetch' = [dRefetch EXCEPT ![d] = TRUE]
    /\ dConn' = [dConn EXCEPT ![d] = NoConn]
    /\ dWant' = [dWant EXCEPT ![d] = 0]
    /\ dStaged' = [dStaged EXCEPT ![d] = NoStage]
    /\ UNCHANGED <<logVars, sConns, dTables, dCookie, dPending, dClient, dNextMid, nextClient, dBad, net, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts,
                   bSnap, ghostVars>>

\* ---------------------------------------------------------------- 云端动作
\* 落下 Process 的结果（提交与幽灵）
Record(r) ==
    /\ sData' = r.data /\ sCommits' = r.cs /\ sHist' = r.hist /\ nextNonce' = r.nonce
    /\ sLowHist' = sLowHist \o [i \in 1..(Len(r.cs) - Len(sCommits)) |-> sLow]
    /\ nonceOf' = nonceOf @@ [n \in {r.cs[i].nonce : i \in (Len(sCommits) + 1)..Len(r.cs)} |->
                     LET i == CHOOSE i \in (Len(sCommits) + 1)..Len(r.cs) : r.cs[i].nonce = n
                     IN [t |-> r.hist[i], vis |-> r.cs[i].syn]]
    /\ gapSeen' = (gapSeen \/ r.gap)

\* 处理一批推送 m 里的 ms（全部或前缀）、提交、通知在线设备；partial 时至少执行了一条（不然这一批推不动）
Handled(m, ms, partial) ==
    LET r == Process(sData, sCommits, sHist, nextNonce, FALSE, ms, m.first)
        base == HeadOf(sCommits)
        patch == [k \in UNION {r.cs[i].keys : i \in (Len(sCommits) + 1)..Len(r.cs)} |-> r.data[k]]
    IN /\ partial => Len(r.cs) > Len(sCommits)
       /\ Record(r)
       \* 输出门：提交落盘后才发通知，所以通知与提交在同一步出现
       /\ Take(m, IF Len(r.cs) = Len(sCommits) THEN {}
                  ELSE {Poke(d, dConn[d], base, HeadOf(r.cs), LmidsSince(r.cs, Len(sCommits)), patch)
                        : d \in {e \in Devices : dConn[e] \in sConns}})
       /\ UNCHANGED <<sConns, errs>>

\* 处理一批推送；旧连接上的推送直接丢（时间点恢复之前发出的也是）；都是重复、没产生新提交就不发通知（按来源设备分开，公平性逐设备给）。
\* 存储出错（磁盘满、IO 出错这类，不是这条写本身的问题）：已提交的前 n 条留着，出错那条起不处理、不推进序号，
\* n 是全部时出错的是拼通知。关掉推送方的连接（重连补齐、重推）；已有写提交的话别的在线设备也没收到通知，给它们发提示、连着拉
HandlePushOf(src, m) ==
    /\ m.type = "push" /\ m.from = src
    /\ IF m.conn \notin sConns
       THEN /\ net' = net \ {m}
            /\ UNCHANGED <<sData, sCommits, sHist, sLowHist, nonceOf, nextNonce, gapSeen, sConns, dups, errs>>
       ELSE \/ Handled(m, m.muts, FALSE)
            \* 一批的工作量到了上限（limits.ts 的 writeRows，按写的行累计）：只处理前缀，停在执行了的一条之后，照常通知、不断开；
            \* 设备收到确认后接着推剩下的（模型里 Push 随时可以再推）
            \/ \E n \in 1..(Len(m.muts) - 1) : Handled(m, SubSeq(m.muts, 1, n), TRUE)
            \/ /\ errs < MaxStorageErrors
               /\ errs' = errs + 1
               /\ \E n \in 0..Len(m.muts) :
                     LET r == Process(sData, sCommits, sHist, nextNonce, FALSE, SubSeq(m.muts, 1, n), m.first)
                         others == {e \in Devices : dConn[e] \in sConns \ {m.conn}}
                         hinted == IF Len(r.cs) = Len(sCommits) THEN {}
                                   ELSE {[type |-> "hint", to |-> e, conn |-> dConn[e], cookie |-> HeadOf(r.cs)] : e \in others}
                     IN /\ Record(r)
                        /\ sConns' = sConns \ {m.conn}
                        /\ Take(m, Closing({m.conn}) \cup hinted)
    /\ UNCHANGED <<sLow, sIn, sSince, devVars, dConn, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, bwrites, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>
HandlePush(src) == \E m \in net : HandlePushOf(src, m)

\* 处理拉取：没有 cursor 时开新的位置（游标不在当前历史上就整份）；有就核对 cursor（Valid），对不上从头整份。
\* 给末块（剩下的读完，cursor 原样带回，设备核对接不接得上暂存），或先给一块（次数有上限，按预算切在任何地方）：
\* 扫描段里扫到某个键为止；或扫完本轮剩下的、尾巴再追到某一版为止（可以一版也没追：实现里块切在一次提交中间），
\* 追到最新又要开下一轮就带着下一轮的位置。
\* reset：从头重拉，设备换掉暂存；幽灵 onHist 供 P8a 检查：尾巴的起点、增量的游标都在当前历史上
HandlePullOf(src, m) ==
    /\ m.type = "pullreq" /\ m.from = src
    /\ LET fresh == m.cursor = NoStage \/ ~Valid(m)
           \* cursor 认不出，或没有 cursor 而游标不在当前历史上、设备要整份重拉：整份
           pos == IF ~fresh THEN m.cursor.pos ELSE StartPos(m.cookie, m.rng, m.cursor # NoStage \/ ~OnHist(m.cookie) \/ m.full)
           Chunk(np, rows) == [type |-> "chunk", to |-> m.from, base |-> m.cookie, cursor |-> m.cursor, pos |-> np,
                               seen |-> HeadOf(sCommits), rows |-> rows, reset |-> fresh]
       IN \/ /\ Take(m, {[type |-> "pullresp", to |-> m.from, base |-> m.cookie, cursor |-> m.cursor,
                          cookie |-> HeadOf(sCommits), lmids |-> AllLmids(sCommits), full |-> pos.full,
                          reset |-> fresh, heal |-> pos.heal, rows |-> FinalRows(pos),
                          onHist |-> pos.p \in HistCookies /\ (pos.full \/ m.cookie \in HistCookies)]})
             /\ UNCHANGED chunks
          \/ /\ chunks < MaxChunks
             /\ chunks' = chunks + 1
             /\ \/ \E b \in Rem(pos) :
                      Take(m, {Chunk([pos EXCEPT !.at = b], ScanRows({k \in Rem(pos) : k <= b}))})
                \/ \E upTo \in pos.p.v..Len(sCommits) :
                      LET np == IF upTo = Len(sCommits) /\ More(pos) THEN NextRound(pos)
                                ELSE [pos EXCEPT !.at = IF Rem(pos) = {} THEN @ ELSE NT * NR, !.p = At(upTo)]
                      IN Take(m, {Chunk(np, Merge(ScanRows(Rem(pos)), TailRows(pos.p.v, upTo, pos)))})
    /\ UNCHANGED <<logVars, sConns, devVars, dConn, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, bwrites, errs, returns, hints, truncs, corrupts, refetches,
                   bSnap, ghostVars>>
HandlePull(src) == \E m \in net : HandlePullOf(src, m)

\* 部署：断开全部连接
Deploy ==
    /\ deploys < MaxDeploys
    /\ deploys' = deploys + 1
    /\ DropAll
    /\ UNCHANGED <<logVars, devVars, dConn, nextConn,
                   muts, dels, crashes, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* 记一次提交 e，之后的云端表是 data：提交、幽灵历史与随机数
RecordEntry(e, data) ==
    /\ sCommits' = Append(sCommits, e) /\ sHist' = Append(sHist, data)
    /\ sLowHist' = Append(sLowHist, sLow)
    /\ nonceOf' = nonceOf @@ [n \in {e.nonce} |-> [t |-> data, vis |-> e.syn]]
    /\ nextNonce' = nextNonce + 1

\* 部署了把一张表交给同步的代码（只在云端的表进入同步，或离开过的表回来）：写 since（下一版）、记一版不带键的提交；
\* 对象重启（连接全断）。模型检查只让 Later、Retiring 进入
Enter(t) ==
    /\ ~sIn[t]
    /\ t \in Retiring => returns < MaxReturns
    /\ returns' = IF t \in Retiring THEN returns + 1 ELSE returns
    /\ sIn' = [sIn EXCEPT ![t] = TRUE]
    /\ sSince' = [sSince EXCEPT ![t] = Len(sCommits) + 1]
    /\ RecordEntry(Rescoped(sCommits, {}, sIn', sSince'), sData)
    /\ DropAll
    /\ UNCHANGED <<sData, sLow, gapSeen, devVars, dConn, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* 部署了不再同步一张表的代码（删掉，或代码回滚）：记一版「删掉」这张表的提交；对象重启（连接全断）。
\* 之后云端不再记、不再发这张表，推来的写改它就拒收。模型检查只让 Retiring 离开；轨迹核对（TracePrivate.tla）里进入过同步的 Later 也可以离开
Leave(t) ==
    /\ sIn[t]
    /\ sIn' = [sIn EXCEPT ![t] = FALSE]
    /\ RecordEntry(Rescoped(sCommits, {t}, sIn', sSince), sData)
    /\ DropAll
    /\ UNCHANGED <<sData, sLow, sSince, gapSeen, devVars, dConn, nextConn, counters, bSnap, ghostVars>>

\* 哪些写还留在某台设备（或备份槽）的待上传里：时间点恢复回滚掉的写里，只有这些还会由设备重放、再推上来
PendingAnywhere ==
    UNION {{dPending[d][i].uid : i \in 1..Len(dPending[d])} : d \in Devices}
    \cup (IF bSnap = NoSnap THEN {} ELSE {bSnap.p[i].uid : i \in 1..Len(bSnap.p)})

\* 恢复到版本 k 那段时间里的某一刻时的日志下限：那段时间里可能截过几次日志，取开始时与结束时（下一段开始时）的下限之间任一版
LowsIn(k) ==
    LET from == IF k = 0 THEN 0 ELSE sLowHist[k].v
    IN {IF v = 0 THEN Head0 ELSE [v |-> v, n |-> sCommits[v].nonce] : v \in from..sLowHist[k + 1].v}

\* 时间点恢复到版本 k 那段时间里的某一刻：表、提交、范围表、日志下限（LowsIn）、客户端表一起回去，对象重启、连接全断；不封口。
\* 重启时按现在的代码比范围：那时不在、现在在的写 since（下一版），那时在、现在不在的记删掉，一次提交。
\* 幽灵：回滚掉的写记进 rolled；其中恢复这一刻没有任何设备还留在待上传里的记进 forbidden（不许复活）
Restore(k) ==
    /\ restores < MaxRestores
    /\ k \in 0..(Len(sCommits) - 1)
    /\ restores' = restores + 1
    /\ \E lowAt \in LowsIn(k) :
       LET data == HistAt(sHist, k)
           cs == SubSeq(sCommits, 1, k)
           inAt == IF k = 0 THEN In0 ELSE sCommits[k].in
           sinceAt == IF k = 0 THEN Since0 ELSE sCommits[k].since
           entered == {t \in Tables : sIn[t] /\ ~inAt[t]}
           gone == {t \in Tables : ~sIn[t] /\ inAt[t]}
           since2 == [t \in Tables |-> IF t \in entered THEN k + 1 ELSE sinceAt[t]]
           cut == {sCommits[i].uid : i \in (k + 1)..Len(sCommits)} \ {NoUid}
       IN /\ sData' = data /\ sLow' = lowAt
          /\ IF entered \cup gone = {}
             THEN /\ sCommits' = cs /\ sHist' = SubSeq(sHist, 1, k) /\ sLowHist' = SubSeq(sLowHist, 1, k)
                  /\ sSince' = sinceAt
                  /\ UNCHANGED <<nonceOf, nextNonce>>
             ELSE LET e == Rescoped(cs, gone, sIn, since2)
                  IN /\ sCommits' = Append(cs, e) /\ sHist' = Append(SubSeq(sHist, 1, k), data)
                     /\ sLowHist' = Append(SubSeq(sLowHist, 1, k), lowAt)
                     /\ sSince' = since2
                     /\ nonceOf' = nonceOf @@ [n \in {e.nonce} |-> [t |-> data, vis |-> e.syn]]
                     /\ nextNonce' = nextNonce + 1
          /\ rolled' = rolled \cup cut
          /\ forbidden' = forbidden \cup (cut \ PendingAnywhere)
    /\ DropAll
    /\ UNCHANGED <<sIn, gapSeen, devVars, dConn, nextConn, nextUid, lostByBackup, bSnap,
                   muts, dels, crashes, deploys, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches>>

\* 后台任务截日志：下限推到 v（最新一版不删），记下 v 的随机数
Truncate ==
    /\ truncs < MaxTruncs
    /\ truncs' = truncs + 1
    /\ \E v \in (sLow.v + 1)..(Len(sCommits) - 1) : sLow' = At(v)
    /\ UNCHANGED <<sData, sCommits, sHist, sLowHist, sIn, sSince, nonceOf, nextNonce, gapSeen, sConns, devVars, dConn, net, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, corrupts, refetches,
                   bSnap, ghostVars>>

\* 后台写（导入等服务端写）：在云端执行一次 inc(k) 或 del(k)，像设备的写一样记一次提交（客户端是 Backend），
\* 通知发给全部在线设备。值到了上限就不改，模型里照样记一次提交；实现里没改到同步的行就不记、不发通知（space.ts 的 #commit），
\* 设备看到的数据一样，只是少一版。
\* 不记提交、直接改云端表的话，游标已是最新的设备收不到这次改动
BackendWrite(k, op) ==
    /\ bwrites < MaxBackendWrites /\ k \in sSynced
    /\ bwrites' = bwrites + 1
    /\ dels' = IF op = "del" THEN dels + 1 ELSE dels
    /\ sData' = Run(sData, k, op).t
    /\ RecordEntry(Entry(nextNonce, Backend, Lmid(sCommits, Backend) + 1, k, op, {k}, NoUid), sData')
    \* 输出门：提交落盘后才发通知
    /\ net' = net \cup {Poke(d, dConn[d], HeadOf(sCommits), HeadOf(sCommits'),
                             LmidsSince(sCommits', Len(sCommits)), [j \in {k} |-> sData'[j]])
                        : d \in {e \in Devices : dConn[e] \in sConns}}
    /\ UNCHANGED <<sLow, sIn, sSince, gapSeen, sConns, devVars, dConn, nextConn,
                   muts, crashes, deploys, restores, backups, drops, dups, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* 云端直接改不在同步范围里的行（只在云端用的表、离开了同步的表）：不记提交、不发通知
DirectWrite(k, op) ==
    /\ bwrites < MaxBackendWrites /\ k \notin sSynced
    /\ bwrites' = bwrites + 1
    /\ dels' = IF op = "del" THEN dels + 1 ELSE dels
    /\ sData' = Run(sData, k, op).t
    /\ UNCHANGED <<sCommits, sHist, sLow, sLowHist, sIn, sSince, nonceOf, nextNonce, gapSeen, sConns,
                   devVars, dConn, net, nextConn,
                   muts, crashes, deploys, restores, backups, drops, dups, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* 网络丢消息；丢的是连接上的消息（推送、通知）就是这条连接断了，设备断线
DropOf(m) ==
    /\ drops < MaxDrops
    /\ net' = net \ {m}
    /\ dConn' = [d \in Devices |-> IF "conn" \in DOMAIN m /\ dConn[d] = m.conn THEN NoConn ELSE dConn[d]]
    /\ drops' = drops + 1
    /\ UNCHANGED <<logVars, sConns, devVars, nextConn,
                   muts, dels, crashes, deploys, restores, backups, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>
Drop == \E m \in net : DropOf(m)

\* 设备那一头的连接断了、路上没有这条连接的消息（退到后台、心跳发现悄悄断了、云端单独关了这条连接）：设备不再连着；
\* 云端那一头照旧记着这条连接，之前在它上面推来、还在路上的推送照样处理（与实现里先到的帧先处理一样）。与丢消息共用次数上限
Disconnect(d) ==
    /\ dConn[d] # NoConn /\ drops < MaxDrops
    /\ drops' = drops + 1
    /\ dConn' = [dConn EXCEPT ![d] = NoConn]
    /\ UNCHANGED <<logVars, sConns, devVars, net, nextConn,
                   muts, dels, crashes, deploys, restores, backups, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* 协议本身的动作（活性检查要求它们最终会发生）
Protocol ==
    \/ \E d \in Devices : Connect(d) \/ Push(d) \/ PullReq(d) \/ RecvPoke(d) \/ RecvPull(d)
                         \/ RecvChunk(d) \/ RecvHint(d) \/ RecvClose(d) \/ Stale(d)
    \/ \E d \in Devices : HandlePush(d) \/ HandlePull(d)

\* 用户操作、部署与故障（不要求发生，次数有上限）
Faults ==
    \/ \E d \in Devices, k \in Keys, op \in Ops : Mutate(d, k, op)
    \/ \E k \in Keys, op \in Ops : BackendWrite(k, op) \/ DirectWrite(k, op)
    \/ \E d \in Devices : Crash(d) \/ Backup(d) \/ RestoreBackup(d) \/ Disconnect(d) \/ Refetch(d)
    \/ \E d \in Devices, k \in Keys : Corrupt(d, k)
    \/ Deploy \/ Drop \/ Truncate
    \/ \E t \in Later \cup Retiring : Enter(t)
    \/ \E t \in Retiring : Leave(t)
    \/ \E k \in 0..Len(sCommits) : Restore(k)

Next == Protocol \/ Faults

Spec == Init /\ [][Next]_vars

\* 活性检查用：协议动作只要一直可做就最终会做（弱公平）。
\* 连接用强公平：拉取在路上时连不了，拉完就连，不会一直只拉不连
Fair ==
    /\ \A d \in Devices : /\ SF_vars(Connect(d)) /\ WF_vars(Push(d)) /\ WF_vars(PullReq(d))
                         /\ WF_vars(RecvPoke(d)) /\ WF_vars(RecvPull(d)) /\ WF_vars(RecvChunk(d))
                         /\ WF_vars(RecvHint(d)) /\ WF_vars(RecvClose(d)) /\ WF_vars(Stale(d))
                         /\ WF_vars(HandlePush(d)) /\ WF_vars(HandlePull(d))
LiveSpec == Spec /\ Fair

\* 设备彼此对称（初始时客户端编号的各种分法都有，动作与性质都不偏向哪一台）：只差设备名字对调的状态算同一个。
\* 只给安全性的配置用：活性检查加了对称会漏报
\* @see https://learntla.com/topics/optimization.html
Symmetry == Permutations(Devices)

\* ---------------------------------------------------------------- 性质
BaseOf(c) == IF c = CNil THEN DevInit ELSE nonceOf[c.n].t
\* 设备到游标那一版该有的行：那一版的同步表里、现在仍同步着的（还没同步过的设备是全部行，都按新装算）
VisOf(c) == (IF c = CNil THEN Keys ELSE nonceOf[c.n].vis) \cap sSynced

\* P1：同一客户端在提交记录里序号严格连续，没有重复
P1_AtMostOnceInOrder ==
    \A i, j \in 1..Len(sCommits) :
        (i < j /\ sCommits[i].client = sCommits[j].client) => sCommits[j].mid > sCommits[i].mid

\* P2（修改不丢）：推进了序号的每条设备的写，都在前一版的云端表上执行了：改了行的记下改到的键，
\*     不改表的只能是被业务拒收、行已不在或改的不是同步表（存储出错不能推进序号）。
\*     只比同步表的行：不在同步范围里的行云端可以直接改、不记提交
P2_NoLostWrite ==
    \A i \in 1..Len(sCommits) : sCommits[i].client # Backend =>
        LET r == Exec(HistAt(sHist, i - 1), sCommits[i].syn, sCommits[i].key, sCommits[i].op)
        IN /\ \A x \in sCommits[i].syn : sHist[i][x] = r.t[x]
           /\ sCommits[i].keys = IF r.w THEN {sCommits[i].key} ELSE {}

\* P3：推送里不会出现序号空洞（来自未来、又不是这个客户端最早的待上传）：空洞只会来自实现的缺陷，云端只跳过、报出来
P3_NoGap == ~gapSeen

\* 提交记录与云端表一致：最后一版的表就是当前表（同步表的行；不在同步范围里的可以直接改）；每一版都登记在幽灵映射里
HistConsistent ==
    /\ \A x \in sSynced : sData[x] = HistAt(sHist, Len(sCommits))[x]
    /\ \A i \in 1..Len(sCommits) : nonceOf[sCommits[i].nonce] = [t |-> sHist[i], vis |-> sCommits[i].syn]

\* P5（核心不变量）：设备表 = 游标那一版的云端表 + 按顺序重放全部待上传；
\*     每条待上传的撤回信息正好撤回它自己（逐条撤回能回到游标那一版）。
\*     那一版之后才进入同步的行，撤回之后要么还没有，要么是那一版的值（整份拉取先给了）。被改坏、还没重下的行不比
P5_ClientView ==
    \A d \in Devices :
        LET c == dCookie[d]
            replayed == Replay(BaseOf(c), dPending[d]).t
            rewound == Rewind(dTables[d], dPending[d])
        IN /\ \A k \in VisOf(c) \ dBad[d] : dTables[d][k] = replayed[k] /\ rewound[k] = BaseOf(c)[k]
           /\ \A k \in (sSynced \ VisOf(c)) \ dBad[d] : rewound[k] \in {Absent, BaseOf(c)[k]}

\* P6：没有待上传、游标在当前历史的最新一版时，设备与云端完全一致（被改坏、还没重下的行除外）
P6_Converged ==
    \A d \in Devices :
        (dPending[d] = <<>> /\ dCookie[d] # CNil /\ dCookie[d] = HeadOf(sCommits)) =>
            \A k \in VisOf(dCookie[d]) \ dBad[d] : dTables[d][k] = sData[k]

\* P7：设备到了云端最新一版时，已被确认的待上传都已删掉
P7_AckedDropped ==
    \A d \in Devices :
        dCookie[d] = HeadOf(sCommits) =>
            \A i \in 1..Len(dPending[d]) : dPending[d][i].mid > Lmid(sCommits, dPending[d][i].client)

\* 已提交的写（当前历史上的，含截掉的）；设备发起过的全部写
CommittedUids == {sCommits[i].uid : i \in 1..Len(sCommits)} \ {NoUid}
EverWritten == 1..(nextUid - 1)

\* P8k（恢复不丢本机写）：设备发起的每条写，要么还在某台设备（或备份）的待上传里，要么在当前历史上提交了；
\*      丢掉的只能是时间点恢复回滚掉的（含恢复生效前已确认、设备据此删掉了的），或设备从备份恢复丢掉的。
P8k_PendingKept == \A u \in EverWritten : u \in PendingAnywhere \cup CommittedUids \cup rolled \cup lostByBackup

\* P8r（回滚掉的不复活）：恢复回滚掉的写再次出现在提交记录里，只能是因为恢复那一刻某台设备（或备份）还把它留在待上传里、之后重放推上来的
P8r_NoRevival == \A i \in 1..Len(sCommits) : sCommits[i].uid \notin forbidden

\* P8a：增量下发（通知、增量的末块）只发给游标在云端当前历史上的设备（服务器恢复后不会悄悄分叉）
P8a_IncrementalOnHistory ==
    \A m \in net : m.type \in {"poke", "pullresp"} => m.onHist

\* P10：设备到了云端最新一版、没有待上传时，同步范围外的行一个不留（离开了同步的表收到「删掉」，只在云端的表从没下发）
P10_ScopeOnly ==
    \A d \in Devices :
        (dPending[d] = <<>> /\ dCookie[d] = HeadOf(sCommits)) => \A k \in (Keys \ sSynced) \ dBad[d] : dTables[d][k] = Absent

\* P11：同一条设备的写在提交记录（含截掉的）里至多一次（时间点恢复、从备份恢复与克隆之后也是）
P11_ExecutedOnce ==
    \A i, j \in 1..Len(sCommits) : (i < j /\ sCommits[i].uid # NoUid) => sCommits[i].uid # sCommits[j].uid

\* P9：故障停止后，所有设备最终没有待上传、与云端的同步表一致
P9_Converges == <>[](\A d \in Devices : dPending[d] = <<>> /\ \A k \in sSynced : dTables[d][k] = sData[k])
=============================================================================
