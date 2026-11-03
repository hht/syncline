----------------------------- MODULE TraceShared -----------------------------
(***************************************************************************)
(* 共用空间的轨迹核对（照 TracePrivate.tla）：Shared.tla 只有一台设备，所以模拟 *)
(* 里每台设备各一条轨迹（src/test/test-shared-trace.ts），云端的后台写与部署  *)
(* 记进每一条。每一步把记下的动作按任意次序各做一次（标了 o 的可以不做），走完 *)
(* 与看见的状态（游标版本、暂存了几块、落地的订阅、令牌给的订阅、云端最新一版）*)
(* 一致。不变量 Unmatched 被违反就是整条轨迹都对上了。                        *)
(* 模拟的云端（src/test/test-shared-cloud.ts）：一张表 program 12 行，桶 all、 *)
(* public、team.a、team.b；分桶列是 status 与 team，编成 c；部署在两套规则之间 *)
(* 来回改 public 的条件。                                                     *)
(***************************************************************************)
EXTENDS Shared, TraceLog, TLC

TraceKeyOrder == <<"p00", "p01", "p02", "p03", "p04", "p05", "p06", "p07", "p08", "p09", "p10", "p11">>
TraceTableOf == [k \in {TraceKeyOrder[i] : i \in 1..Len(TraceKeyOrder)} |-> 1]
TraceBucketOrder == <<"all", "public", "team.a", "team.b">>
\* 分桶列 c = (status - 1) * 3 + team：status 1 draft、2 published、3 featured，team 1 a、2 b、3 没有
StatusOf(c) == ((c - 1) \div 3) + 1
TeamOf(c) == ((c - 1) % 3) + 1
\* 第 g 套规则（部署了 g - 1 次）：单数是模拟的第一套（公开的只有 published），双数是第二套（published 与 featured）
InBuckets(g, c) ==
    {"all"} \cup (IF StatusOf(c) = 2 \/ (g % 2 = 0 /\ StatusOf(c) = 3) THEN {"public"} ELSE {})
            \cup (IF TeamOf(c) = 1 THEN {"team.a"} ELSE IF TeamOf(c) = 2 THEN {"team.b"} ELSE {})
TraceRules == 1 :> [g \in 1..100 |-> [c \in 1..9 |-> InBuckets(g, c)]]
\* 令牌给的几种订阅（test-shared-cloud.ts 的 buckets）
TraceSubs == {{"public"}, {"all"}, {"team.a"}, {"public", "team.a"}, {"team.a", "team.b"}}
TraceData0 == [k \in DOMAIN TraceTableOf |-> Absent]

VARIABLES
    l,     \* 下一条要对上的轨迹
    done   \* 这一条里已经做了的动作（在 acts 里的下标）

traceVars == <<vars, l, done>>

\* 看得见的：游标版本（没有游标是 -1）、暂存了几块、落地的订阅、令牌给的订阅、云端最新一版
Matches(line) ==
    /\ (IF dCookie = NoCookie THEN -1 ELSE VerOf(dCookie)) = line.cookie
    /\ Len(dStage) = line.staged
    /\ dSub = line.landed
    /\ sub = line.sub
    /\ Latest = line.head

\* 记下的那条连接上的消息（test-trace.ts 的 Message）：种类对，记了的版本对得上（-2 是没记）
Is(x, m) ==
    /\ m.type = x.t
    /\ x.t = "notice" => VerOf(m.base) = x.b
    /\ x.c = -2 \/ VerOf(m.cookie) = x.c

\* 轨迹里记下的一个动作（test-shared-trace.ts 的 Act）
Do(x) ==
    \/ x.a = "Write" /\ Write(x.k, x.c)
    \/ x.a = "RuleChange" /\ RuleChange(1)
    \/ x.a = "SubChange" /\ SubChange /\ sub' = x.u
    \/ x.a = "Connect" /\ Connect /\ Is(x, Head(chan'))
    \/ x.a = "Push" /\ \E v \in Points : Push(v) /\ Is(x, chan'[Len(chan')])
    \/ x.a = "Deliver" /\ chan # <<>> /\ Is(x, Head(chan)) /\ Deliver
    \* 设备那一头断了：断线，或换一条连接（旧令牌连的连接到期被分片关掉或接入方调了 reconnect()、拉取落地的订阅与这条连接上听到的不同）
    \/ x.a = "Disconnect" /\ dConn /\ (Disconnect \/ Expire \/ Renew)
    \/ x.a = "PullStart" /\ (PullStart \/ PullFirst)
    \* 拉取回来：缓存里的是第 c 版时算的，按的订阅是 u
    \/ x.a = "PullDone" /\ x.u \in pSubs /\ \E p \in Points : VerOf(p) = x.c /\ PullDone(p, x.u)
    \/ x.a = "PullLost" /\ PullLost
    \/ x.a = "Crash" /\ Crash

TraceInit == Init /\ l = 1 /\ done = {} /\ TLCSet(1, 0)

\* 按记下的先后做的几组：后台写与部署（各是哪一版是定了的），拉取的发起、回来与丢失（不然同一步里「回来」可以配上同一步才发的那个）
Chains == {{"Write", "RuleChange"}, {"PullStart", "PullDone", "PullLost"}}
\* 这一条里再做一个记下的、还没做的动作；同一组的按记下的先后
Hidden ==
    /\ l <= Len(TraceLog)
    /\ \E i \in (1..Len(TraceLog[l].acts)) \ done :
          /\ \A g \in Chains : TraceLog[l].acts[i].a \in g =>
                \A j \in 1..(i - 1) : TraceLog[l].acts[j].a \in g => j \in done
          /\ Do(TraceLog[l].acts[i])
          /\ done' = done \cup {i}
    /\ UNCHANGED l

\* 这一条走完：没标 o 的都做了，与看见的状态一致，接着对下一条
Observe ==
    /\ l <= Len(TraceLog)
    /\ \A i \in 1..Len(TraceLog[l].acts) : i \in done \/ TraceLog[l].acts[i].o
    /\ Matches(TraceLog[l])
    /\ l' = l + 1 /\ done' = {}
    /\ UNCHANGED vars
    \* 对上的条数创了新高就打出来：跑不通时看卡在哪一条（只用一个 worker 跑）
    /\ IF l > TLCGet(1) THEN TLCSet(1, l) /\ PrintT(<<"matched", l>>) ELSE TRUE

TraceSpec == TraceInit /\ [][Hidden \/ Observe]_traceVars

\* TLC 认状态时不看只用来设上限的次数（轨迹里都给够了）：只是次数不同的几条路是同一个状态
TraceView == <<sEras, sub, cPushed, cSub, chan, dConn, dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, dInflight, pSubs,
               l, done>>

\* 违反它就是整条轨迹都对上了
Unmatched == l <= Len(TraceLog)
=============================================================================
