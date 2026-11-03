-------------------------------- MODULE Fanout --------------------------------
(***************************************************************************)
(* Syncline 共用空间的扇出模型：只看版本，行的内容与连接上的消息怎么用在     *)
(* Shared.tla。这里查分片推给每条连接的守住 Shared.tla 要的：通知接在推给这条 *)
(* 连接的上一版上、版本只往前，与这条连接的订阅有关的改动最终推到。            *)
(*                                                                         *)
(* 云端：每次后台写记一版，带改到的桶（改前 ∪ 改后）；规则变更与换代的那一版 *)
(* 不带键、与每条连接都有关，按「太多」处理。扇出任务每一轮把        *)
(* (base, 最新] 发给全部分片：base 是分片 s 确认收到的上一版 cur[s]，只在内存 *)
(* 里，全体确认到最新一版才落库成 conf；有在途就合并成一条。共用空间对象重启 *)
(* 时 cur 退回 conf；一轮也没发过（新库）的从最新一版发一轮空的。           *)
(* 投递可以丢；分片处理了、确认却丢了也算丢，进度不动、之后重发。改到的桶太多  *)
(* 时只带「太多」，分片给每条连接推提示。                                    *)
(* 分片：内存里 known（知道到第几版），重置后不知道（连接靠休眠留着）。收到的  *)
(* base 晚于 known 就是不连续，问共用空间最新一版、给它的每条连接推提示；接得 *)
(* 上就前进，给订阅与改到的桶有交集的连接推接在这条连接上一版上的通知。       *)
(* 连接：设备连上分片就进推送名单，再问共用空间最新一版补齐（正好是设备的游标 *)
(* 发空的补齐，否则发提示；问不到就发提示或关连接，不发空补齐）；补齐之前推给 *)
(* 它的第一条是提示（还没推过，通知接不上）。先问再进名单不行：问到  *)
(* 之后、进名单之前分片处理的轮次推不到它，分片其间重置就再也补不回来。问到的  *)
(* 只给这条连接用，不写进 known：写进去会吞掉别的连接要收的扇出。            *)
(* 常驻设备：一直连着 ResShard、订阅 ResSub，只记推到它的最高一版 aSeen。      *)
(* 设备：通知接得上游标就落地，否则只记目标版本；落后就拉，带目标版本作下限；  *)
(* 拉取经缓存，给下限之后任何一版现算的结果。                                 *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS
    Buckets, Shards,
    Sub,              \* 设备订阅的桶
    ResShard, ResSub, \* 常驻设备连着的分片、订阅的桶
    MaxWrites, MaxFaults, MaxConns

NoShard == "none"
Unknown == -1
Max(s) == CHOOSE x \in s : \A y \in s : y <= x
Notice(base, v) == [type |-> "notice", base |-> base, cookie |-> v]
Hint(v) == [type |-> "hint", cookie |-> v]

VARIABLES
    touched,    \* 云端：touched[v].b 是第 v 版改到的桶，wide 是不带键、与每条连接都有关的一版（规则变更、换代）
    cur,        \* 云端（内存）：分片确认收到的上一版（Unknown：一轮也没发过）
    conf,       \* 云端（落库）：全体分片都确认到的那一版（Unknown：一轮也没发过）
    known,      \* 分片（内存）：知道到第几版
    dShard,     \* 设备连着的分片
    dPhase,     \* "asking" 连上了、在问最新一版 / "open" 补齐了
    cPushed,    \* 分片推给设备这条连接的最后一版（Unknown：还没推过）
    chan,       \* 分片推给设备、在途的消息
    aSeen,      \* 常驻设备收到的最高一版
    dCookie, dWant, dInflight, dIssued,
    wasted,     \* 幽灵：拉回来的版本低于发出时的目标版本的次数
    faults, conns

vars == <<touched, cur, conf, known, dShard, dPhase, cPushed, chan, aSeen, dCookie, dWant, dInflight, dIssued, wasted, faults, conns>>
dev == <<dCookie, dWant, dInflight, dIssued, wasted>>

Latest == Len(touched)
TouchedIn(lo, hi) == UNION {touched[v].b : v \in lo + 1..hi}
Wide(lo, hi) == \E v \in lo + 1..hi : touched[v].wide
\* 与订阅 S 有关的最新一版
RelLatestOf(S) == Max({0} \cup {v \in 1..Latest : touched[v].b \cap S # {} \/ touched[v].wide})

\* 分片 s 给它的连接推第 v 版：提示推给每条连接；通知只推给订阅与 bk 有交集的，接在推给这条连接的上一版上（还没推过的推提示）；
\* 推过 v 的连接（补齐给到了更新的）不再推
PushAll(s, v, bk, hint) ==
    /\ IF dShard = s /\ v > cPushed /\ (hint \/ bk \cap Sub # {})
       THEN chan' = Append(chan, IF hint \/ cPushed = Unknown THEN Hint(v) ELSE Notice(cPushed, v)) /\ cPushed' = v
       ELSE UNCHANGED <<chan, cPushed>>
    /\ aSeen' = IF s = ResShard /\ (hint \/ bk \cap ResSub # {}) THEN Max({aSeen, v}) ELSE aSeen

\* 分片收到一轮 (base, v]，改到的桶 bk（many：太多，只带这一条）：不连续就问最新一版、推提示；接得上就前进
ShardReceive(s, base, v, bk, many) ==
    IF known[s] = Unknown \/ base > known[s]
    THEN known' = [known EXCEPT ![s] = Latest] /\ PushAll(s, Latest, {}, TRUE)
    ELSE IF v > known[s]
         THEN known' = [known EXCEPT ![s] = v] /\ PushAll(s, v, bk, many)
         ELSE UNCHANGED <<known, chan, cPushed, aSeen>>

Init ==
    /\ touched = <<>> /\ cur = [s \in Shards |-> Unknown] /\ conf = Unknown /\ known = [s \in Shards |-> 0]
    /\ dShard = NoShard /\ dPhase = "asking" /\ cPushed = Unknown /\ chan = <<>> /\ aSeen = 0
    /\ dCookie = 0 /\ dWant = 0 /\ dInflight = Unknown /\ dIssued = 0 /\ wasted = 0
    /\ faults = 0 /\ conns = 0

Write(B, wide) ==
    /\ Latest < MaxWrites
    /\ touched' = Append(touched, [b |-> B, wide |-> wide])
    /\ UNCHANGED <<cur, conf, known, dShard, dPhase, cPushed, chan, aSeen, faults, conns>> /\ UNCHANGED dev

\* 发给分片 s 的这一轮的起点：一轮也没发过的从最新一版起（空的一轮，分片据此知道这一代）
Base(s) == IF cur[s] = Unknown THEN Latest ELSE cur[s]
\* 这一轮改到的桶太多（或有不带键的一版）时只带「太多」
Many(s) == IF Wide(Base(s), Latest) THEN {TRUE} ELSE BOOLEAN

\* 扇出任务给分片 s 发 (Base(s), 最新]，送到、确认后进度前进；全体都确认到最新一版才落库
FanTo(s) ==
    /\ cur[s] < Latest
    /\ \E many \in Many(s) : ShardReceive(s, Base(s), Latest, TouchedIn(Base(s), Latest), many)
    /\ cur' = [cur EXCEPT ![s] = Latest]
    /\ conf' = IF \A x \in Shards : cur'[x] = Latest THEN Latest ELSE conf
    /\ UNCHANGED <<touched, dShard, dPhase, faults, conns>> /\ UNCHANGED dev

\* 分片处理了、确认丢了（RPC 超时）：进度不动，之后重发
FanNoAck(s) ==
    /\ cur[s] < Latest /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ \E many \in Many(s) : ShardReceive(s, Base(s), Latest, TouchedIn(Base(s), Latest), many)
    /\ UNCHANGED <<touched, cur, conf, dShard, dPhase, conns>> /\ UNCHANGED dev

\* 分片对象重置：内存里的版本没了，连接（休眠）留着
ShardReset(s) ==
    /\ faults < MaxFaults /\ known[s] # Unknown
    /\ faults' = faults + 1
    /\ known' = [known EXCEPT ![s] = Unknown]
    /\ UNCHANGED <<touched, cur, conf, dShard, dPhase, cPushed, chan, aSeen, conns>> /\ UNCHANGED dev

\* 共用空间对象重启（部署、被逐出内存）：各分片的确认退回落库的那一版
Restart ==
    /\ faults < MaxFaults /\ \E s \in Shards : cur[s] # conf
    /\ faults' = faults + 1
    /\ cur' = [s \in Shards |-> conf]
    /\ UNCHANGED <<touched, conf, known, dShard, dPhase, cPushed, chan, aSeen, conns>> /\ UNCHANGED dev

\* 设备连上分片 s：进推送名单，去问共用空间最新一版
Connect(s) ==
    /\ dShard = NoShard /\ conns < MaxConns
    /\ conns' = conns + 1
    /\ dShard' = s /\ dPhase' = "asking" /\ cPushed' = Unknown
    /\ UNCHANGED <<touched, cur, conf, known, chan, aSeen, faults>> /\ UNCHANGED dev

\* 问到了最新一版 k，补齐（只给这条连接用）：还没推过的，正好是设备的游标发空的补齐，否则发提示；推过的只在 k 更新时发提示
Catchup ==
    /\ dShard # NoShard /\ dPhase = "asking"
    /\ LET k == Latest
       IN IF cPushed = Unknown \/ k > cPushed
          THEN chan' = Append(chan, IF cPushed = Unknown /\ k = dCookie THEN Notice(dCookie, dCookie) ELSE Hint(k)) /\ cPushed' = k
          ELSE UNCHANGED <<chan, cPushed>>
    /\ dPhase' = "open"
    /\ UNCHANGED <<touched, cur, conf, known, dShard, aSeen, faults, conns>> /\ UNCHANGED dev

\* 连接断了；断了总能再连（连的次数用完就不再断）
Disconnect ==
    /\ dShard # NoShard /\ conns < MaxConns
    /\ dShard' = NoShard /\ dPhase' = "asking" /\ chan' = <<>>
    /\ UNCHANGED <<touched, cur, conf, known, cPushed, aSeen, faults, conns>> /\ UNCHANGED dev

Deliver ==
    /\ dShard # NoShard /\ chan # <<>>
    /\ LET m == Head(chan)
       IN IF m.type = "notice" /\ dInflight = Unknown /\ m.base = dCookie
          THEN dCookie' = m.cookie /\ UNCHANGED dWant
          ELSE dWant' = Max({dWant, m.cookie}) /\ UNCHANGED dCookie
    /\ chan' = Tail(chan)
    /\ UNCHANGED <<touched, cur, conf, known, dShard, dPhase, cPushed, aSeen, faults, conns, dInflight, dIssued, wasted>>

\* 落后就拉，带目标版本作下限
PullStart ==
    /\ dInflight = Unknown /\ dWant > dCookie
    /\ dInflight' = dWant /\ dIssued' = dWant
    /\ UNCHANGED <<touched, cur, conf, known, dShard, dPhase, cPushed, chan, aSeen, faults, conns, dCookie, dWant, wasted>>

\* 拉回来：缓存给下限之后任何一版现算的结果
PullDone(t) ==
    /\ dInflight # Unknown /\ t \in dInflight..Latest
    /\ dCookie' = Max({dCookie, t})
    /\ wasted' = IF t < dIssued THEN wasted + 1 ELSE wasted
    /\ dInflight' = Unknown
    /\ UNCHANGED <<touched, cur, conf, known, dShard, dPhase, cPushed, chan, aSeen, faults, conns, dWant, dIssued>>

Next ==
    \/ \E B \in SUBSET Buckets \ {{}} : Write(B, FALSE)
    \/ Write({}, TRUE)
    \/ \E s \in Shards : FanTo(s) \/ FanNoAck(s) \/ ShardReset(s) \/ Connect(s)
    \/ Restart \/ Catchup \/ Disconnect \/ Deliver \/ PullStart
    \/ \E t \in 0..Latest : PullDone(t)

\* 扇出任务续做、设备连上与收消息、拉取都会发生；缓存过期之后总会现算
Spec == Init /\ [][Next]_vars
            /\ \A s \in Shards : WF_vars(FanTo(s))
            /\ WF_vars(\E x \in Shards : Connect(x)) /\ WF_vars(Catchup)
            /\ WF_vars(Deliver) /\ WF_vars(PullStart)
            /\ WF_vars(\E t \in 0..Latest : PullDone(t)) /\ SF_vars(PullDone(Latest))

\* ---------------------------------------------------------------- 性质
\* 收到提示后的拉取不会拿到低于目标版本的旧结果（多拉一次）
NoWastedPull == wasted = 0
\* 分片推给这条连接的那一版到分片知道的那一版之间，没有与它的订阅有关、却没推给它的改动
Covers == dShard # NoShard /\ cPushed # Unknown /\ known[dShard] # Unknown =>
              TouchedIn(cPushed, known[dShard]) \cap Sub = {} /\ ~Wide(cPushed, known[dShard])
\* S2：后台写停了之后，设备最终追上与它有关的最新一版，常驻设备也收到与它有关的最新一版
CatchesUp == <>[](dCookie >= RelLatestOf(Sub) /\ aSeen >= RelLatestOf(ResSub))
================================================================================
