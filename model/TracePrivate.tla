----------------------------- MODULE TracePrivate ------------------------------
(***************************************************************************)
(* 轨迹核对（照 Microsoft CCF 的 trace validation）：确定性模拟跑真的实现，   *)
(* 每走一步记下这一步里实现做了哪些在模型里有对应动作的事，与走完之后看得见  *)
(* 的状态（各台设备的游标版本、待上传几条，云端最新一版），见               *)
(* src/test/test-trace.ts。这里找一条 Private.tla 的执行：每一步把记下的动作  *)
(* 按任意次序各做一次（标了 o 的可以不做），走完与看见的状态一致。          *)
(* 不变量 Unmatched 被违反就是整条轨迹都对上了（pnpm model:trace 据此判）；   *)
(* TLC 跑完都没违反，就是实现做了模型不允许的事，或 test-trace.ts 的对应写错了。*)
(* 只核对控制流：写的内容不比，模拟里的写都对应表 1 唯一一行上的 inc，后台写  *)
(* 同样；只在云端、之后进入同步又离开的是表 2（Later）。                       *)
(***************************************************************************)
EXTENDS Private, TraceLog

CONSTANTS d1, d2, d3

\* 模拟的第 i 台设备（从 1 起）
D == <<d1, d2, d3>>

VARIABLES
    l,     \* 下一条要对上的轨迹
    done   \* 这一条里已经做了的动作（在 acts 里的下标）

traceVars == <<vars, l, done>>

\* 看得见的：游标版本（没有游标是 -1）、待上传几条、暂存到哪（尾巴追到的那一版，没有是 -1）、云端最新一版
VersionOf(c) == IF c = CNil THEN -1 ELSE c.v
Staged(d) == IF dStaged[d] = NoStage THEN -1 ELSE dStaged[d].pos.p.v
Matches(line) ==
    /\ \A i \in 1..Len(line.cookie) :
          VersionOf(dCookie[D[i]]) = line.cookie[i] /\ Len(dPending[D[i]]) = line.pending[i] /\ Staged(D[i]) = line.staged[i]
    /\ Len(sCommits) = line.head

\* 记下的那条消息（test-trace.ts 的 Message）：种类对、是这台设备发的或发给它的，记了的版本与条数都对得上（-2 是没记）
\* 在动作里求值，析取的每一支 TLC 都会走：没有的字段用 IF 挡住
Is(x, m) ==
    /\ m.type = x.t
    /\ IF m.type \in {"push", "pullreq"} THEN m.from = D[x.d] ELSE m.to = D[x.d]
    /\ IF x.b = -2 THEN TRUE ELSE IF m.type = "pullreq" THEN VersionOf(m.cookie) = x.b ELSE VersionOf(m.base) = x.b
    /\ IF x.c = -2 THEN TRUE ELSE IF m.type = "chunk" THEN m.pos.p.v = x.c ELSE m.cookie.v = x.c
    /\ IF x.n = -2 THEN TRUE ELSE Len(m.muts) = x.n

\* 收下记下的那条消息、不断开：收下，或当作用不上的丢掉；实现里收到时那次连接已经作废的，模型里是丢了这条消息
Keep(x) ==
    \E m \in net : /\ Is(x, m)
                  /\ \/ RecvPokeOf(D[x.d], m) \/ RecvPullOf(D[x.d], m) \/ RecvChunkOf(D[x.d], m) \/ RecvHintOf(D[x.d], m)
                     \/ StaleOf(D[x.d], m) \/ DropOf(m)
                  /\ dConn'[D[x.d]] = dConn[D[x.d]]

\* 轨迹里记下的一个动作（test-trace.ts 的 Act）
Do(x) ==
    \/ x.a = "Mutate" /\ Mutate(D[x.d], 1, "inc")
    \/ x.a = "Push" /\ Push(D[x.d])
    \/ x.a = "HandlePush" /\ \E m \in net : Is(x, m) /\ HandlePushOf(D[x.d], m)
    \/ x.a = "Connect" /\ Connect(D[x.d])
    \/ x.a = "PullReq" /\ PullReq(D[x.d])
    \* 算出的应答也对得上：种类、接在哪一版、给到哪一版
    \/ x.a = "HandlePull" /\ \E m \in net : m.type = "pullreq" /\ m.from = D[x.d] /\ HandlePullOf(D[x.d], m)
                                              /\ \E r \in net' \ net : Is(x, r)
    \* 收到一条消息（HTTP 拉取的结果一定收得下）：连接上的通知与提示，模型里收得下、不用断开就收下（Keep），收不下的什么也不做。
    \* 实现收到后断开了的另记一次断开，由它断；没断开的（云端通知太大改发了提示：模型里没有这条提示、设备没记下要追的版本，
    \* 之后接不上的通知在模型里只能断开）模型也不断开，那条通知留在网络里。前提是实现收下接得上的通知就应用：模拟不注入设备存储故障、
    \* 撤回失败，有了它们（收下、不应用、断开）这里会逼着模型应用而判错
    \/ x.a = "Recv" /\ IF x.t \notin {"poke", "hint"} \/ ENABLED Keep(x) THEN Keep(x) ELSE UNCHANGED vars
    \/ x.a = "Drop" /\ \E m \in net : Is(x, m) /\ DropOf(m)
    \* 设备那一头断了（每条连接只记第一次）：收到云端的关闭，或自己断开；模型里已经断了（崩溃了、从备份恢复了、丢了消息或通知接不上
    \* 已断、这条连接在模型里没连上）就什么也不做
    \/ x.a = "Disconnect" /\ (Disconnect(D[x.d]) \/ RecvClose(D[x.d]) \/ (dConn[D[x.d]] = NoConn /\ UNCHANGED vars))
    \/ x.a = "Crash" /\ Crash(D[x.d])
    \/ x.a = "Backup" /\ Backup(D[x.d])
    \/ x.a = "RestoreBackup" /\ RestoreBackup(D[x.d])
    \/ x.a = "Deploy" /\ Deploy
    \/ x.a = "BackendWrite" /\ BackendWrite(1, "inc")
    \/ x.a = "Enter" /\ Enter(2)
    \/ x.a = "Leave" /\ Leave(2)
    \* 模拟恢复到那段时间末尾的整库（src/test/test-counter.ts 的 reimage）：下限是那段时间最后一次截到的，即下一段开始时的
    \/ x.a = "Restore" /\ Restore(x.k) /\ sLow' = sLowHist[x.k + 1]
    \* 截日志：下限推到第 k 版
    \/ x.a = "Truncate" /\ Truncate /\ sLow'.v = x.k

\* 客户端编号的哪一种分法都一样（对称）：取一种，不让 TLC 把同一条轨迹走 6 遍
TraceInit == Init /\ dClient = (d1 :> 1 @@ d2 :> 2 @@ d3 :> 3) /\ l = 1 /\ done = {} /\ TLCSet(1, 0)

\* 这一条里再做一个记下的、还没做的动作
Hidden ==
    /\ l <= Len(TraceLog)
    /\ \E i \in (1..Len(TraceLog[l].acts)) \ done :
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

\* TLC 认状态时不看只用来设上限的次数（轨迹里都给够了）：只是次数不同的几条路是同一个状态，不然对得上的路越走越多
\* 再也起不了作用的消息也不看，在不在网络里都一样（连接编号只增不减，旧的不会再成为设备当前的连接、也不会再回到云端记着的连接里）：
\* 旧连接上的通知与关闭只能被当作用不上的丢掉；云端不再记着的连接上的推送，处理时直接丢掉
Live == {m \in net : ~(m.type \in {"poke", "close"} /\ m.conn # dConn[m.to]) /\ ~(m.type = "push" /\ m.conn \notin sConns)}
TraceView == <<sData, sCommits, sHist, sLow, sLowHist, sIn, sSince, sConns, nonceOf, nextNonce, gapSeen,
               dTables, dCookie, dPending, dClient, dNextMid, dConn, Live, nextClient, nextConn, restores, bSnap,
               dStaged, dBad, dRefetch, rolled, forbidden, lostByBackup, l, done>>

\* 违反它就是整条轨迹都对上了
Unmatched == l <= Len(TraceLog)
=============================================================================
