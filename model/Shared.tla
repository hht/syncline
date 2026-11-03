-------------------------------- MODULE Shared --------------------------------
(***************************************************************************)
(* Syncline 共用空间的同步协议模型。                                         *)
(*                                                                         *)
(* 共用空间只由后台写，设备只读，拉取的响应经缓存发出（照 ElectricSQL 的     *)
(* Shape HTTP 协议）。DO 不留历史版本，响应里的行读的都是算这一块时的当前值，  *)
(* 所以缓存里的旧副本与现算的新副本内容可以不同。                             *)
(*                                                                         *)
(* 可见范围是桶：一行属于哪些桶，由它自己的分桶列按它所在的表的规则算出（一张 *)
(* 表的几条规则合在一起，一行可属多个桶）；订阅是云端按令牌算出的一组桶，可以 *)
(* 变（令牌换了）。设备上是订阅看得见的行，一条全局游标。                    *)
(*                                                                         *)
(* 云端：后台写改一行（改值、改分桶列即在桶之间移动、删掉），记一版、只记键；  *)
(* 一行改前与改后在哪些桶由那一版的值与规则算出。部署改了一张表的规则：这张表 *)
(* 的 since 设为下一版、记一版不带键的提交，之后按新规则算。清空重建（换代）：*)
(* 新一代从第 0 版记起，旧一代的游标都认不出。截日志：删掉一代里最早的提交，  *)
(* 游标与接着拉的位置早于下限的整份（实现里回 reset）。代是建空间时定的随机数，设备与  *)
(* 云端都只比相等、不比先后；模型里的位置（代, 版本）按真实的先后编号，只用来  *)
(* 表达「请求发出之前算不出它的响应」。                                      *)
(*                                                                         *)
(* 读取器（照私有空间的线性三段）：一个计划在一轮里先扫描、后追尾巴。扫描集  *)
(* S(f, h) 是这一轮的起点 f 之后、水位 h 及之前 since 前进了的表（整份时取 h  *)
(* 时的全部表），这些表先清空、再给订阅看得见的行；增量的第一轮另扫订阅里新加 *)
(* 的桶（落地的订阅 o 之外的），给桶里现在的行。尾巴从追到的一版追到最新，给  *)
(* 改前或改后在订阅 N 里的行（跳过扫描集里表 t 在 since(t) 及之前的项），值按 *)
(* 「现在的桶 ∩ N」，交集为空就是「不在」；追到最新时 (h, 最新] 里又有表的     *)
(* since 前进，就开下一轮。设备没有游标、游标不在这一代、订阅去掉了桶（o 不是 *)
(* N 的子集）就整份：先清空全部表，第一轮扫全部表。水位 h 可以是起点到算的那  *)
(* 一版之间任一版（实现里对齐到块边界，让同一时刻起拉的设备共用缓存）。        *)
(* 一块可以切在扫描的任一项之后，或扫完本轮、尾巴追到任一版为止；末块给到算的 *)
(* 那一版。每块带 seen：算这一块时的位置。                                   *)
(* 缓存：一个请求拿到的可以是它在任何一个过去位置（请求发得出之后）现算的结果， *)
(* 也可以是现在现算的；订阅 N 按发出到算出之间任一时刻的令牌。请求接着的计划的订*)
(* 阅不是 N，就从设备落地的游标与订阅重新起计划；不在这一代就回整份（reset）。*)
(* 设备：块先暂存；回复的订阅或代与暂存的块不同，就丢掉暂存。末块不早于暂存各 *)
(* 块的 seen 才一起落地（游标、订阅跟着换），早于就当中间块，接着从它拉、带上  *)
(* seen 作下限（新的缓存键，不会再拿到旧的）。                               *)
(* 连接：设备连着广播分片，消息在这条连接上按序到达，连接可以断。连上时第一条 *)
(* 是分片问到的那一版（可能落后、可能是旧一代）：正好是设备的游标发空的补齐，  *)
(* 否则发提示；这一版只给这条连接用。之后分片推这条连接没推过的版本：接在推给它的  *)
(* 上一版上的通知（带这条连接的订阅看得见的改动，跨了规则变更或换代就不行），  *)
(* 或提示；与这条连接的订阅无关的版本可以不推，规则变更与换代推给每条连接。换代 *)
(* 时旧一代的扇出或换代前问到的答案可能晚到：这条连接上出现了不同代的位置，分片 *)
(* 就当作不连续，再问最新一版、推它的提示。分片                              *)
(* 怎么知道各版（扇出任务、分片发现不连续）在 Fanout.tla，这里只要它对每条连接 *)
(* 守住上面这些。                                                            *)
(* 设备：没有游标、有暂存、目标位置比游标新、或从连接上听到的订阅与落地的不同  *)
(* 时就拉，同一时刻只有一个拉取在路上；发出新起的请求时目标位置比游标新就带上 *)
(* 它作下限。通知在没在拉、没有暂存、游标正好是它的 base、订阅与落地的相同时才 *)
(* 应用；其余比游标新（另一代，或同一代里版本更大）就记成目标位置。带着目标作 *)
(* 下限的请求回来的不是目标那一代，就放下目标（分片过时了）；下限不在云端现在  *)
(* 这一代的请求只现算、不进缓存。设备会重启（内存里的目标位置与下限没了，库里 *)
(* 的都在）、断线；拉取会丢。令牌换了，连接要换一条才按新订阅推：旧令牌连的 *)
(* 连接最终到期、被分片关掉（接入方调 reconnect() 可以更早）；拉取落地的订阅与 *)
(* 这条连接上听到的不同，拉完也换一条。开新连接时听到的订阅作废。            *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS
    KeyOrder,       \* 共用表里的行，按（表, 主键）排好的序列
    TableOf,        \* 行 -> 所在的表
    BucketOrder,    \* 桶，排好的序列（加桶的扫描按这个次序）
    Rules,          \* Rules[t][g][c]：表 t 第 g 套规则下分桶列取 c 的行在哪些桶
    Subs, Sub0,     \* 订阅可取的几组桶、开始时的订阅
    Data0,          \* 第一代第 0 版的共用表
    MaxVersions,    \* 版本数上限（后台写与规则变更各记一版，各代合计）
    MaxRuleChanges, MaxSubChanges, MaxRebuilds,
    MaxChunks,      \* 非末块的块数上限
    MaxFaults,      \* 断线、设备重启、拉取丢失的次数上限
    MaxLatePushes,  \* 换代时跨代晚到的次数上限
    MaxTruncs       \* 截日志的次数上限

ASSUME MaxVersions < 100

Keys == {KeyOrder[i] : i \in 1..Len(KeyOrder)}
Tables == {TableOf[k] : k \in Keys}
K == Len(KeyOrder)
Absent == [w |-> 0, c |-> 0]       \* 行不在；在的行 w 是写它的那一版的编号，c 是分桶列
Empty == [k \in Keys |-> Absent]
NoCookie == -1
Max(s) == CHOOSE x \in s : \A y \in s : y <= x
Merge(a, b) == [k \in DOMAIN a \cup DOMAIN b |-> IF k \in DOMAIN b THEN b[k] ELSE a[k]]
\* 还没从这条连接上听到订阅（订阅不会是空的）
NoHeard == {}
ASSUME NoHeard \notin Subs

\* 位置：（代, 版本）编成一个数，按真实的先后（只给缓存的时间先后用，设备的判断只比代相等）
Pt(e, v) == e * 100 + v
EraOf(p) == p \div 100
VerOf(p) == p % 100

\* 计划：e 是哪一代，f、h 是这一轮的起点与水位（整份第一轮 f = -1），o 是落地的订阅（新加的桶 = N \ o，
\* 开下一轮时换成 N），at 是扫到的扫描项（Done 是本轮扫完了），p 是尾巴追到的一版
Plan(e, f, h, o, N, at, p) == [e |-> e, f |-> f, h |-> h, o |-> o, N |-> N, at |-> at, p |-> p]
NoPlan == Plan(0, -1, -1, {}, {}, 0, -1)
\* 请求：start 从设备的游标 c、落地的订阅 o 起一个计划，cont 接着暂存到的计划；floor 是下限（这个缓存键的响应只能在它之后算出）
Req(kind, c, o, plan, floor) == [kind |-> kind, c |-> c, o |-> o, plan |-> plan, floor |-> floor]
None == Req("none", NoCookie, {}, NoPlan, 0)
Notice(base, v, ops, s) == [type |-> "notice", base |-> base, cookie |-> v, ops |-> ops, sub |-> s]
Hint(v, s) == [type |-> "hint", cookie |-> v, sub |-> s]

\* 扫描项：1..K 是第 j 个行（扫描集里的表的行），K * i + j 是第 i 个桶里的第 j 个行（新加的桶）
Done == K * (Len(BucketOrder) + 1) + 1

VARIABLES
    sEras,      \* 云端各代：base 是第 0 版的表，gens 是第 0 版各表用第几套规则，log[i] 是第 i 版改到的键与 since 前进的表，
                \* hist[i] 是第 i 版之后的表与各表的规则（幽灵）；low 是日志下限：第 low 版及之前的提交截掉了，游标与位置要不早于它
    sub,        \* 云端按令牌算出的订阅
    cPushed,    \* 分片推给当前连接的最后一个位置
    cSub,       \* 当前连接的订阅
    chan,       \* 当前连接上在途的消息（按序到达）
    dConn,      \* 设备连着没有
    dTables, dCookie, dSub,  \* 设备表、游标、落地的订阅
    dHeard,     \* 设备从连接上听到的订阅（只在内存里，NoHeard：开新连接之后还没听到）
    dStale,     \* 拉取落地的订阅与这条连接上听到的不同：拉完就换连接（只在内存里）
    dStage,     \* 暂存的块：各部分（清空几张表、写几行）、seen、订阅
    dNext,      \* 设备下一个要发的请求
    dWant,      \* 设备的目标位置（只在内存里）
    dInflight,  \* 在路上的拉取请求，或 None
    pSubs,      \* 在路上的拉取发出以来令牌给过的订阅（云端收到请求时按令牌算，可能查当时的成员关系；没有拉取时是空的）
    versions, ruleChanges, subChanges, rebuilds, chunks, faults,
    latePushes, \* 旧一代的扇出晚到了几次
    truncs      \* 截了几次日志

vars == <<sEras, sub, cPushed, cSub, chan, dConn, dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, dInflight, pSubs,
          versions, ruleChanges, subChanges, rebuilds, chunks, faults, latePushes, truncs>>
server == <<sEras, sub, versions, ruleChanges, subChanges, rebuilds, truncs>>
conn == <<cPushed, cSub, chan, dConn>>
device == <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, dInflight, pSubs>>

Cur == Len(sEras)
Latest == Len(sEras[Cur].log)
Now == Pt(Cur, Latest)
LastOf(e) == Len(sEras[e].log)
\* 有过的位置
Points == UNION {{Pt(e, v) : v \in 0..LastOf(e)} : e \in 1..Cur}
LogAt(e, i) == sEras[e].log[i]
LowOf(e) == sEras[e].low
\* 读得到的提交：日志下限之后的（之前的已截掉）
Readable(e, from, upTo) == {i \in (from + 1)..upTo : i > LowOf(e)}
DataAt(p) == IF VerOf(p) = 0 THEN sEras[EraOf(p)].base ELSE sEras[EraOf(p)].hist[VerOf(p)].data
GensAt(p) == IF VerOf(p) = 0 THEN sEras[EraOf(p)].gens ELSE sEras[EraOf(p)].hist[VerOf(p)].gens

\* 一行（值 row，在表 t，规则用第 g 套）在哪些桶
Bk(row, t, g) == IF row.w = 0 THEN {} ELSE Rules[t][g][row.c]
BucketsAt(p, k) == Bk(DataAt(p)[k], TableOf[k], GensAt(p)[TableOf[k]])
\* 订阅 sb 在位置 p 看得见的行
VisAt(p, sb) == [k \in Keys |-> IF BucketsAt(p, k) \cap sb # {} THEN DataAt(p)[k] ELSE Absent]
\* 第 e 代第 i 版改到的行 k 改前或改后在 sb 的桶里（都按那一版的规则算）
Touches(e, i, k, sb) ==
    LET t == TableOf[k]
        g == GensAt(Pt(e, i))[t]
    IN (Bk(DataAt(Pt(e, i - 1))[k], t, g) \cup Bk(DataAt(Pt(e, i))[k], t, g)) \cap sb # {}

\* 位置 p 时表 t 的 since：最后一次规则变更的那一版（没有变过是 0）
SinceAt(p, t) == Max({0} \cup {i \in 1..VerOf(p) : t \in LogAt(EraOf(p), i).rule})
\* 扫描集：在位置 p 算，f 之后、h 及之前 since 前进了的表
S(p, f, h) == {t \in Tables : f < SinceAt(p, t) /\ SinceAt(p, t) <= h}

\* ---------------------------------------------------------------- 读取器
ScanSet(pl, p) == S(p, pl.f, pl.h)
\* 扫描项 s 在位置 p 时有没有：扫描集里的表的行都有；新加的桶里现在的行（表不在扫描集里）
Present(pl, p, s) ==
    IF s <= K THEN TableOf[KeyOrder[s]] \in ScanSet(pl, p)
    ELSE LET i == (s - 1) \div K
             k == KeyOrder[s - K * i]
         IN /\ BucketOrder[i] \in pl.N \ pl.o
            /\ TableOf[k] \notin ScanSet(pl, p)
            /\ BucketOrder[i] \in BucketsAt(p, k)
KeyOf(s) == KeyOrder[s - K * ((s - 1) \div K)]
\* 表 t 的第一个扫描项
FirstSlot(t) == CHOOSE j \in 1..K : TableOf[KeyOrder[j]] = t /\ \A i \in 1..(j - 1) : TableOf[KeyOrder[i]] # t
\* 这一轮还没扫的项
Rem(pl, p) == IF pl.at = Done THEN {} ELSE {s \in (pl.at + 1)..(Done - 1) : Present(pl, p, s)}
\* 扫描给的：扫到的项里订阅看得见的行的现在的值
ScanRows(pl, p, ss) ==
    LET vis == VisAt(p, pl.N)
        ks == {KeyOf(s) : s \in ss}
    IN [k \in {x \in ks : vis[x] # Absent} |-> vis[k]]
\* 扫到 hi 为止要先清空的表：扫描集里第一项落在这一段的表（整份的第一轮由整份开头的清空代替）
Drops(pl, p, hi) == IF pl.f = -1 THEN {} ELSE {t \in ScanSet(pl, p) : pl.at < FirstSlot(t) /\ FirstSlot(t) <= hi}
\* 尾巴里跳过的项：扫描集里的表 t 在 since(t) 及之前的
Skip(pl, p, i, t) == t \in ScanSet(pl, p) /\ i <= SinceAt(p, t)
\* 尾巴 (from, upTo] 里改前或改后在订阅里的行，给现在的值或「不在」
TailRows(pl, p, from, upTo) ==
    LET ks == UNION {{k \in LogAt(pl.e, i).keys : ~Skip(pl, p, i, TableOf[k]) /\ Touches(pl.e, i, k, pl.N)} : i \in Readable(pl.e, from, upTo)}
    IN [k \in ks |-> VisAt(p, pl.N)[k]]
\* 追到最新时 (h, 最新] 里又有表的 since 前进：开下一轮，新加的桶已在第一轮扫过
More(pl, p) == S(p, pl.h, VerOf(p)) # {}
NextRound(pl, p) == [pl EXCEPT !.f = pl.h, !.h = VerOf(p), !.o = pl.N, !.at = 0, !.p = VerOf(p)]

\* 块的一部分：先清空 drop 里的表，再写 rows
Part(drop, rows) == [drop |-> drop, rows |-> rows]
Chunk(parts, final, p, N, next) ==
    [parts |-> parts, final |-> final, seen |-> p, sub |-> N, next |-> next]

\* 在位置 p 按计划 pl 算出的块；clear：计划刚起、以整份开头（先清空全部表）。末块读完剩下的（追到时要开下一轮就把下一轮也扫完，
\* 下一轮的清空在这一轮的尾巴之后）；先给一块（次数有上限）：扫到某一项为止，或扫完本轮、尾巴追到某一版为止（可以一版也没追）
Chunks(req, pl, p, clear) ==
    LET t == VerOf(p)
        all == IF clear THEN Tables ELSE {}
        cont(np) == Req("cont", req.c, req.o, np, 0)
        upTo(e) == Part(all \cup Drops(pl, p, Done), Merge(ScanRows(pl, p, Rem(pl, p)), TailRows(pl, p, pl.p, e)))
        nr == NextRound(pl, p)
        after == IF More(pl, p) THEN [nr EXCEPT !.at = Done] ELSE [pl EXCEPT !.at = Done, !.p = t]
        final == Chunk(IF More(pl, p) THEN <<upTo(t), Part(Drops(nr, p, Done), ScanRows(nr, p, Rem(nr, p)))>> ELSE <<upTo(t)>>,
                       TRUE, p, pl.N, cont(after))
        scans == {Chunk(<<Part(all \cup Drops(pl, p, s), ScanRows(pl, p, {x \in Rem(pl, p) : x <= s}))>>, FALSE, p, pl.N,
                        cont([pl EXCEPT !.at = s])) : s \in Rem(pl, p)}
        tails == {Chunk(<<upTo(e)>>, FALSE, p, pl.N,
                        cont(IF e = t /\ More(pl, p) THEN nr ELSE [pl EXCEPT !.at = Done, !.p = e])) : e \in pl.p..t}
    IN {final} \cup (IF chunks < MaxChunks THEN scans \cup tails ELSE {})

\* 从设备的游标 c 与落地的订阅 o 起一个计划，在位置 p、订阅 N 下算：没有游标、游标不在这一代或早于日志下限（实现里回 reset，设备清空后
\* 从头整份）、订阅去掉了桶就整份，水位 h 取起点（整份是日志下限）到 p 之间任一版。模型按现在的下限算（缓存里截日志之前算的旧副本，
\* 实现里那时的下限更低，可能给的是增量）
Start(req, p, N) ==
    LET e == EraOf(p)
        t == VerOf(p)
        full == req.c = NoCookie \/ EraOf(req.c) # e \/ VerOf(req.c) < LowOf(e) \/ ~(req.o \subseteq N)
    IN IF full THEN UNION {Chunks(req, Plan(e, -1, h, N, N, 0, h), p, TRUE) : h \in LowOf(e)..t}
       ELSE UNION {Chunks(req, Plan(e, VerOf(req.c), h, req.o, N, 0, VerOf(req.c)), p, FALSE) : h \in VerOf(req.c)..t}

\* 请求在位置 p、订阅 N 下现算的响应：接着的计划不在这一代、或计划的订阅不是 N，就重新起计划；计划带的各版早于日志下限
\* （实现里回 reset，设备清空后从头整份）就整份
FreshAt(req, p, N) ==
    IF req.kind = "start" \/ req.plan.e # EraOf(p) \/ req.plan.N # N THEN Start(req, p, N)
    ELSE IF \E v \in {req.plan.h, req.plan.p} \cup (IF req.plan.f = -1 THEN {} ELSE {req.plan.f}) : v < LowOf(EraOf(p))
    THEN Start([req EXCEPT !.c = NoCookie], p, N)
    ELSE Chunks(req, req.plan, p, FALSE)

\* 请求最早在哪个位置发得出：要到了它带的各版（游标、这一轮的水位、尾巴追到的一版）与下限
Since(req) ==
    IF req.kind = "start" THEN Max({Pt(1, 0), req.c, req.floor})
    ELSE Max({Pt(req.plan.e, req.plan.h), Pt(req.plan.e, req.plan.p), req.floor})

\* ---------------------------------------------------------------- 设备
Apply(t, part) ==
    LET start == [k \in Keys |-> IF TableOf[k] \in part.drop THEN Absent ELSE t[k]]
    IN [k \in Keys |-> IF k \in DOMAIN part.rows THEN part.rows[k] ELSE start[k]]
RECURSIVE ApplyParts(_, _)
ApplyParts(t, ps) == IF ps = <<>> THEN t ELSE ApplyParts(Apply(t, Head(ps)), Tail(ps))
RECURSIVE ApplyAll(_, _)
ApplyAll(t, cs) == IF cs = <<>> THEN t ELSE ApplyAll(ApplyParts(t, Head(cs).parts), Tail(cs))
MaxSeen(cs) == Max({0} \cup {cs[i].seen : i \in 1..Len(cs)})

\* 代只比相等（代是建空间时定的随机数，不能比先后）：位置 a 比 b 新，是 b 没有、不是同一代，或同一代里版本更大
Newer(a, b) == b = NoCookie \/ EraOf(a) # EraOf(b) \/ VerOf(a) > VerOf(b)

\* 连接上的通知：base 之后到 v 改到的、改前或改后在 sb 里的行，按 v 时 sb 看得见的给
OpsSince(base, v, sb) ==
    LET e == EraOf(v)
        ks == UNION {{k \in LogAt(e, i).keys : Touches(e, i, k, sb)} : i \in Readable(e, VerOf(base), VerOf(v))}
    IN [k \in ks |-> VisAt(v, sb)[k]]
RuleIn(e, from, upTo) == \E i \in (from + 1)..upTo : LogAt(e, i).rule # {}

\* 设备要拉：没有游标、有暂存、落后于目标位置，或从连接上听到的订阅与落地的不同
Behind == dCookie = NoCookie \/ dStage # <<>> \/ (dWant # NoCookie /\ Newer(dWant, dCookie)) \/ dHeard \notin {NoHeard, dSub}

Init ==
    /\ sEras = <<[base |-> Data0, gens |-> [t \in Tables |-> 1], log |-> <<>>, hist |-> <<>>, low |-> 0]>>
    /\ sub = Sub0
    /\ cPushed = Pt(1, 0) /\ cSub = Sub0 /\ chan = <<>> /\ dConn = FALSE
    /\ dTables = Empty /\ dCookie = NoCookie /\ dSub = {} /\ dHeard = NoHeard /\ dStale = FALSE /\ dStage = <<>>
    /\ dNext = Req("start", NoCookie, {}, NoPlan, 0) /\ dWant = NoCookie /\ dInflight = None /\ pSubs = {}
    /\ versions = 0 /\ ruleChanges = 0 /\ subChanges = 0 /\ rebuilds = 0 /\ chunks = 0 /\ faults = 0 /\ latePushes = 0 /\ truncs = 0

\* ---------------------------------------------------------------- 云端
\* 记一版：改到的键 keys、since 前进的表 rule，之后的表是 data、各表的规则是 gens
Commit(keys, data, gens, rule) ==
    /\ versions < MaxVersions
    /\ versions' = versions + 1
    /\ sEras' = [sEras EXCEPT ![Cur].log = Append(@, [keys |-> keys, rule |-> rule]),
                              ![Cur].hist = Append(@, [data |-> data, gens |-> gens])]

\* 后台写一行：改值（含改分桶列，即在桶之间移动）或删掉（c = 0）
Write(k, c) ==
    /\ Commit({k}, [DataAt(Now) EXCEPT ![k] = IF c = 0 THEN Absent ELSE [w |-> versions + 1, c |-> c]], GensAt(Now), {})
    /\ UNCHANGED <<sub, ruleChanges, subChanges, rebuilds, chunks, faults, latePushes, truncs>> /\ UNCHANGED conn /\ UNCHANGED device

\* 部署改了表 t 的规则：since 设为这一版，记一版不带键的提交，之后按新规则算
RuleChange(t) ==
    /\ ruleChanges < MaxRuleChanges /\ GensAt(Now)[t] + 1 \in DOMAIN Rules[t]
    /\ ruleChanges' = ruleChanges + 1
    /\ Commit({}, DataAt(Now), [GensAt(Now) EXCEPT ![t] = @ + 1], {t})
    /\ UNCHANGED <<sub, subChanges, rebuilds, chunks, faults, latePushes, truncs>> /\ UNCHANGED conn /\ UNCHANGED device

\* 清空重建：新一代从第 0 版记起（数据与规则照旧），旧一代的游标都认不出
Rebuild ==
    /\ rebuilds < MaxRebuilds
    /\ rebuilds' = rebuilds + 1
    /\ sEras' = Append(sEras, [base |-> DataAt(Now), gens |-> GensAt(Now), log |-> <<>>, hist |-> <<>>, low |-> 0])
    /\ UNCHANGED <<sub, versions, ruleChanges, subChanges, chunks, faults, latePushes, truncs>> /\ UNCHANGED conn /\ UNCHANGED device

\* 截日志：这一代第 l 版及之前的提交删掉（最新一版不删），截到的那一版仍在当前历史上
Truncate ==
    /\ truncs < MaxTruncs
    /\ truncs' = truncs + 1
    /\ \E l \in (LowOf(Cur) + 1)..(Latest - 1) : sEras' = [sEras EXCEPT ![Cur].low = l]
    /\ UNCHANGED <<sub, versions, ruleChanges, subChanges, rebuilds, chunks, faults, latePushes>> /\ UNCHANGED conn /\ UNCHANGED device

\* 订阅变了（令牌换了）：连着的连接照旧按原来的订阅推，换一条才按新的（Expire）；在路上的拉取也可能按新的算
SubChange ==
    /\ subChanges < MaxSubChanges
    /\ subChanges' = subChanges + 1
    /\ \E N \in Subs \ {sub} : sub' = N /\ pSubs' = IF dInflight = None THEN pSubs ELSE pSubs \cup {N}
    /\ UNCHANGED <<sEras, versions, ruleChanges, rebuilds, chunks, faults, latePushes, truncs>> /\ UNCHANGED conn
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, dInflight>>

\* ---------------------------------------------------------------- 连接
\* 分片推这条连接没推过的位置 v：接在推给它的上一个位置上的通知（同一代、中间没有规则变更、上一个位置不早于日志下限），或提示
Push(v) ==
    /\ dConn /\ v \in Points /\ v > cPushed
    /\ \E m \in {Hint(v, cSub)} \cup
               (IF EraOf(v) = EraOf(cPushed) /\ ~RuleIn(EraOf(v), VerOf(cPushed), VerOf(v)) /\ VerOf(cPushed) >= LowOf(EraOf(v))
                THEN {Notice(cPushed, v, OpsSince(cPushed, v, cSub), cSub)} ELSE {}) :
           chan' = Append(chan, m)
    /\ cPushed' = v
    /\ UNCHANGED <<cSub, dConn>> /\ UNCHANGED server /\ UNCHANGED device /\ UNCHANGED <<chunks, faults, latePushes>>

\* 推给这条连接的位置之后有与它的订阅有关的：换了代、规则变了，或改到的行改前或改后在它的订阅里
Due ==
    \/ EraOf(cPushed) # Cur
    \/ \E i \in (VerOf(cPushed) + 1)..Latest : LogAt(Cur, i).rule # {} \/ \E k \in LogAt(Cur, i).keys : Touches(Cur, i, k, cSub)
PushDue == Due /\ Push(Now)

\* 换代时旧一代还在路上的扇出晚于新一代送到分片（不同 stub 之间不保序）。代是随机数，分片分不出哪一代新：收到的与推给这条连接的
\* 上一个位置不同代就当作不连续，问共用空间最新一版、推它的提示，记住它、不记旧一代；先把晚到的那一个位置的提示推出去也可以（这里
\* 查推了的）。不是故障，不计 faults；每次都以推最新一版收尾，次数上限只为限住状态数
LatePush ==
    /\ dConn /\ latePushes < MaxLatePushes
    /\ latePushes' = latePushes + 1
    /\ \E v \in Points : EraOf(v) < EraOf(cPushed) /\ chan' = chan \o <<Hint(v, cSub), Hint(Now, cSub)>>
    /\ cPushed' = Now
    /\ UNCHANGED <<cSub, dConn>> /\ UNCHANGED server /\ UNCHANGED device /\ UNCHANGED <<chunks, faults>>

\* 连上：第一条是分片问到的位置 k（可能落后、可能是旧一代），只给这条连接用：正好是设备的游标发空的补齐，否则发提示；
\* 也可以是补齐之前推来的提示（Fanout.tla：连上就进推送名单，补齐之前推的都是提示），所以 k 是设备的游标时也可以是提示。
\* 补齐之前推来的位置 j 可以与问到的 k 不同代（换代时旧一代的扇出、或换代前问到的答案晚到）：分片当作不连续，再问共用空间最新一版、
\* 推它的提示、记住它（再问时两边都到了，问到的是这一代）；与 LatePush 同算跨代晚到的次数
Connect ==
    /\ ~dConn /\ dCookie # NoCookie /\ dStage = <<>> /\ dInflight = None
    /\ \E k \in Points :
        \E m \in {Hint(k, sub)} \cup (IF k = dCookie THEN {Notice(dCookie, dCookie, [x \in {} |-> Absent], sub)} ELSE {}) :
            \/ chan' = <<m>> /\ cPushed' = k /\ UNCHANGED latePushes
            \/ /\ latePushes < MaxLatePushes /\ latePushes' = latePushes + 1
               /\ \E j \in Points : EraOf(j) # EraOf(k) /\ chan' = <<Hint(j, sub), m, Hint(Now, sub)>>
               /\ cPushed' = Now
    /\ cSub' = sub /\ dConn' = TRUE /\ dHeard' = NoHeard /\ dStale' = FALSE
    /\ UNCHANGED server /\ UNCHANGED <<dTables, dCookie, dSub, dStage, dNext, dWant, dInflight, pSubs>> /\ UNCHANGED <<chunks, faults>>

\* 连接断了：在途的消息都丢
Disconnect ==
    /\ dConn /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ dConn' = FALSE /\ chan' = <<>>
    /\ UNCHANGED <<cPushed, cSub>> /\ UNCHANGED server /\ UNCHANGED device /\ UNCHANGED <<chunks, latePushes>>

\* 旧令牌连的连接断开（不算故障）：身份到期，分片关掉它（推一轮时，或其间没有写、alarm 到了），设备取新令牌重连；接入方照约定调
\* reconnect() 是同一步、可以更早。在路上的拉取可能一起中止。令牌没换的连接到期与断线一样（Disconnect）
Expire ==
    /\ dConn /\ cSub # sub
    /\ dConn' = FALSE /\ chan' = <<>>
    /\ \/ UNCHANGED <<dInflight, pSubs>>
       \/ dInflight' = None /\ pSubs' = {}
    /\ UNCHANGED <<cPushed, cSub>> /\ UNCHANGED server /\ UNCHANGED <<chunks, faults, latePushes>>
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant>>

\* 拉取落地的订阅与这条连接上听到的不同：设备拉完自己换一条
Renew ==
    /\ dConn /\ dStale /\ dInflight = None
    /\ dConn' = FALSE /\ chan' = <<>>
    /\ UNCHANGED <<cPushed, cSub>> /\ UNCHANGED server /\ UNCHANGED <<chunks, faults, latePushes>> /\ UNCHANGED device

\* 接入方调 reconnect() 时没连上：中止按旧令牌发出的拉取（可以不调）
Reconnect ==
    /\ ~dConn /\ dInflight # None /\ pSubs # {sub}
    /\ dInflight' = None /\ pSubs' = {}
    /\ UNCHANGED conn /\ UNCHANGED server /\ UNCHANGED <<chunks, faults, latePushes>>
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant>>

\* 设备收到连接上的下一条消息，记下这条连接的订阅
Deliver ==
    /\ dConn /\ chan # <<>>
    /\ LET m == Head(chan)
       IN /\ IF m.type = "notice" /\ dInflight = None /\ dStage = <<>> /\ dCookie # NoCookie /\ dCookie = m.base /\ m.sub = dSub
             THEN /\ dTables' = Apply(dTables, Part({}, m.ops))
                  /\ dCookie' = m.cookie
                  /\ dNext' = Req("start", m.cookie, dSub, NoPlan, 0)
                  /\ UNCHANGED dWant
             ELSE /\ dWant' = CASE ~Newer(m.cookie, dCookie) -> dWant
                                 [] dWant = NoCookie \/ EraOf(dWant) # EraOf(m.cookie) -> m.cookie
                                 [] OTHER -> Max({dWant, m.cookie})
                  /\ UNCHANGED <<dTables, dCookie, dNext>>
          /\ dHeard' = m.sub
    /\ chan' = Tail(chan)
    /\ UNCHANGED <<cPushed, cSub, dConn, dSub, dStale, dStage, dInflight, pSubs>> /\ UNCHANGED server /\ UNCHANGED <<chunks, faults, latePushes>>

\* ---------------------------------------------------------------- 拉取
\* 发出的拉取：新起的、没有暂存时，目标位置比游标新就带上它作下限（收到提示后的第一个请求就带上）
Outgoing == IF dNext.kind = "start" /\ dStage = <<>> /\ dWant # NoCookie /\ Newer(dWant, dCookie)
            THEN [dNext EXCEPT !.floor = dWant] ELSE dNext

\* 设备落后就发一个拉取（连着也拉），同一时刻只有一个在路上
PullStart ==
    /\ dInflight = None /\ Behind
    /\ dInflight' = Outgoing /\ dNext' = Outgoing /\ pSubs' = {sub}
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dWant>> /\ UNCHANGED conn /\ UNCHANGED server
    /\ UNCHANGED <<chunks, faults, latePushes>>

\* 不落后也先拉一次：上次连上了却没等到补齐就断了（慢网），下次先 HTTP 拉再连（不要求它发生）
PullFirst ==
    /\ dInflight = None /\ ~dConn
    /\ dInflight' = Outgoing /\ dNext' = Outgoing /\ pSubs' = {sub}
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dWant>> /\ UNCHANGED conn /\ UNCHANGED server
    /\ UNCHANGED <<chunks, faults, latePushes>>

\* 设备收到一块：订阅或代与暂存的块不同（计划重起了）就丢掉暂存；末块不早于暂存各块的 seen（同一代里比）才一起落地，
\* 早于就当中间块，接着从它拉、带上 seen 作下限。这次请求带着目标位置作下限、回来的却不是它那一代，就放下目标（结果不早于
\* 下限，那一代过时了），落不落地都是；没带的（请求发出之后才有这个目标）留着，下一个请求带上它。落地的订阅与这条连接上听到的
\* 不同（连接是旧令牌连的）：听到的作废，拉完换连接
Receive(chunk) ==
    LET last == dStage[Len(dStage)]
        base == IF dStage # <<>> /\ (last.sub # chunk.sub \/ EraOf(last.seen) # EraOf(chunk.seen)) THEN <<>> ELSE dStage
        staged == Append(base, [parts |-> chunk.parts, seen |-> chunk.seen, sub |-> chunk.sub])
        want == IF dWant # NoCookie /\ EraOf(dWant) # EraOf(chunk.seen) /\ dInflight.floor = dWant THEN NoCookie ELSE dWant
    IN /\ chunks' = IF chunk.final THEN chunks ELSE chunks + 1
       /\ IF chunk.final /\ chunk.seen >= MaxSeen(staged)
          THEN /\ dTables' = ApplyAll(dTables, staged)
               /\ dCookie' = chunk.seen /\ dSub' = chunk.sub /\ dStage' = <<>> /\ dWant' = want
               /\ IF dHeard \notin {NoHeard, chunk.sub} THEN dHeard' = NoHeard /\ dStale' = TRUE ELSE UNCHANGED <<dHeard, dStale>>
               /\ dNext' = Req("start", chunk.seen, chunk.sub, NoPlan, IF want # NoCookie /\ Newer(want, chunk.seen) THEN want ELSE 0)
          ELSE /\ dStage' = staged
               /\ dNext' = IF chunk.final THEN [chunk.next EXCEPT !.floor = IF want # NoCookie /\ EraOf(want) # EraOf(chunk.seen) THEN want
                                                                          ELSE Max({MaxSeen(staged), want})]
                           ELSE chunk.next
               /\ dWant' = want
               /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale>>

\* 拉取回来：订阅 N 是请求发出以来令牌给过的任一个（云端收到请求时按令牌算，可能查当时的成员关系）；缓存给它在过去某个位置 p 现算的结果，p 是现在就是现算（p 不早于请求带的各版：
\* 请求发出之前算不出它的响应，这是真实的时间先后，设备比不出来）；下限不在云端现在这一代的请求只现算、不进缓存，所以缓存里
\* 只有下限那一代的结果；请求不是设备现在要发的（cursor 对不上）就丢掉
PullDone(p, N) ==
    /\ dInflight # None
    /\ p \in Points /\ p >= Since(dInflight)
    /\ dInflight.floor = 0 \/ EraOf(dInflight.floor) = EraOf(p) \/ p = Now
    /\ IF dInflight = dNext THEN \E chunk \in FreshAt(dInflight, p, N) : Receive(chunk)
       ELSE UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, chunks>>
    /\ dInflight' = None /\ pSubs' = {}
    /\ UNCHANGED conn /\ UNCHANGED server /\ UNCHANGED <<faults, latePushes>>

PullFresh == PullDone(Now, sub)

\* 设备重启：连接断、在路上的拉取不再收，内存里的目标位置、听到的订阅、要换连接与下限没了；库里的表、游标、订阅、暂存与接着拉的请求都在
\* （没有暂存时下一个请求的下限在内存里，没了；暂存了末块的下限由暂存的块定，还在）
Crash ==
    /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ dConn' = FALSE /\ chan' = <<>> /\ dInflight' = None /\ pSubs' = {} /\ dWant' = NoCookie /\ dHeard' = NoHeard /\ dStale' = FALSE
    /\ dNext' = IF dNext.kind = "start" /\ dStage = <<>> THEN [dNext EXCEPT !.floor = 0] ELSE dNext
    /\ UNCHANGED <<cPushed, cSub, dTables, dCookie, dSub, dStage>> /\ UNCHANGED server /\ UNCHANGED <<chunks, latePushes>>

\* 拉取失败（断网、超时）：不再等它，之后照样再发
PullLost ==
    /\ dInflight # None /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ dInflight' = None /\ pSubs' = {}
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant>> /\ UNCHANGED conn /\ UNCHANGED server
    /\ UNCHANGED <<chunks, latePushes>>

Next ==
    \/ \E k \in Keys : \E c \in {0} \cup DOMAIN Rules[TableOf[k]][1] : Write(k, c)
    \/ \E t \in Tables : RuleChange(t)
    \/ Rebuild \/ SubChange \/ Truncate
    \/ \E v \in Points : Push(v)
    \/ LatePush
    \/ Connect \/ Disconnect \/ Expire \/ Renew \/ Reconnect \/ Deliver \/ PullStart \/ PullFirst
    \/ \E p \in Points, N \in pSubs : PullDone(p, N)
    \/ Crash \/ PullLost

\* 分片推与连接有关的版本、断了会重连、旧令牌连的连接会到期、拉取落地的订阅过时会换连接、消息会收到、落后会去拉、拉取会回来
\* （接入方调不调 reconnect() 都行）；缓存过期之后总会现算：拉取现算这一步强公平。连接用强公平（照 Private.tla）：拉取在路上时连不了，
\* 拉完就连，不会一直只拉不连
Spec == Init /\ [][Next]_vars /\ WF_vars(PushDue) /\ SF_vars(Connect) /\ WF_vars(Expire) /\ WF_vars(Renew) /\ WF_vars(Deliver) /\ WF_vars(PullStart)
            /\ WF_vars(\E p \in Points, N \in pSubs : PullDone(p, N)) /\ SF_vars(PullFresh)

\* ---------------------------------------------------------------- 性质
\* S1：没有暂存时，设备表就是落地的订阅在设备游标那个位置看得见的行（不误删、不残留）
Consistent == dStage = <<>> /\ dCookie # NoCookie => dTables = VisAt(dCookie, dSub)

\* S2：写、订阅、规则、换代都停了之后，设备最终不再落后（不再拉）、落地在这一代、订阅是当前的、数据是当前订阅看得见的行
\* （与它的订阅无关的版本分片可以不推，游标可以停在之前）
Converges == <>[](~Behind /\ EraOf(dCookie) = Cur /\ dSub = sub /\ dTables = VisAt(Now, sub))
================================================================================
