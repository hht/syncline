----------------------------- MODULE TraceShared -----------------------------
(***************************************************************************)
(* Shared space trace validation (following TracePrivate.tla): Shared.tla   *)
(* models a single device, so the simulation records one trace per device   *)
(* (src/test/test-shared-trace.ts), repeating cloud backend writes and      *)
(* deploys in every trace. Each step executes the recorded actions once in  *)
(* any order (actions marked 'o' are optional), matching observable state   *)
(* (cookie version, staged chunk count, landed subscription, token          *)
(* subscription, and cloud head version). Invariant Unmatched is violated   *)
(* when the entire trace matches.                                          *)
(* Simulated cloud (src/test/test-shared-cloud.ts): table 'program' with 12 *)
(* rows; buckets 'all', 'public', 'team.a', 'team.b'; bucket columns status *)
(* and team encoded as 'c'; deployments toggle the 'public' condition       *)
(* between two rule sets.                                                   *)
(***************************************************************************)
EXTENDS Shared, TraceLog, TLC

TraceKeyOrder == <<"p00", "p01", "p02", "p03", "p04", "p05", "p06", "p07", "p08", "p09", "p10", "p11">>
TraceTableOf == [k \in {TraceKeyOrder[i] : i \in 1..Len(TraceKeyOrder)} |-> 1]
TraceBucketOrder == <<"all", "public", "team.a", "team.b">>
\* Bucket column c = (status - 1) * 3 + team: status 1 draft, 2 published, 3 featured; team 1 a, 2 b, 3 none
StatusOf(c) == ((c - 1) \div 3) + 1
TeamOf(c) == ((c - 1) % 3) + 1
\* Rule set g (deployed g - 1 times): odd numbers use rule set 1 (public includes only published), even numbers use rule set 2 (published and featured)
InBuckets(g, c) ==
    {"all"} \cup (IF StatusOf(c) = 2 \/ (g % 2 = 0 /\ StatusOf(c) = 3) THEN {"public"} ELSE {})
            \cup (IF TeamOf(c) = 1 THEN {"team.a"} ELSE IF TeamOf(c) = 2 THEN {"team.b"} ELSE {})
TraceRules == 1 :> [g \in 1..100 |-> [c \in 1..9 |-> InBuckets(g, c)]]
\* Subscriptions granted by tokens (buckets in test-shared-cloud.ts)
TraceSubs == {{"public"}, {"all"}, {"team.a"}, {"public", "team.a"}, {"team.a", "team.b"}}
TraceData0 == [k \in DOMAIN TraceTableOf |-> Absent]

VARIABLES
    l,     \* Next trace line to match
    done   \* Actions already executed in this line (indices in acts)

traceVars == <<vars, l, done>>

\* Observable state: cookie version (-1 if no cookie), staged chunks, landed subscription, token subscription, and cloud head version
Matches(line) ==
    /\ (IF dCookie = NoCookie THEN -1 ELSE VerOf(dCookie)) = line.cookie
    /\ Len(dStage) = line.staged
    /\ dSub = line.landed
    /\ sub = line.sub
    /\ Latest = line.head

\* Recorded connection message (Message in test-trace.ts): matching type and matching version if recorded (-2 means unrecorded)
Is(x, m) ==
    /\ m.type = x.t
    /\ x.t = "notice" => VerOf(m.base) = x.b
    /\ x.c = -2 \/ VerOf(m.cookie) = x.c

\* Single recorded trace action (Act in test-shared-trace.ts)
Do(x) ==
    \/ x.a = "Write" /\ Write(x.k, x.c)
    \/ x.a = "RuleChange" /\ RuleChange(1)
    \/ x.a = "SubChange" /\ SubChange /\ sub' = x.u
    \/ x.a = "Connect" /\ Connect /\ Is(x, Head(chan'))
    \/ x.a = "Push" /\ \E v \in Points : Push(v) /\ Is(x, chan'[Len(chan')])
    \/ x.a = "Deliver" /\ chan # <<>> /\ Is(x, Head(chan)) /\ Deliver
    \* Client-side disconnect: connection closed, or replaced by a new connection (token expired and closed by shard, integrator called reconnect(), or landed subscription differs from heard subscription on this connection)
    \/ x.a = "Disconnect" /\ dConn /\ (Disconnect \/ Expire \/ Renew)
    \/ x.a = "PullStart" /\ (PullStart \/ PullFirst)
    \* Pull response: cached response was computed at version c for subscription u
    \/ x.a = "PullDone" /\ x.u \in pSubs /\ \E p \in Points : VerOf(p) = x.c /\ PullDone(p, x.u)
    \/ x.a = "PullLost" /\ PullLost
    \/ x.a = "Crash" /\ Crash

TraceInit == Init /\ l = 1 /\ done = {} /\ TLCSet(1, 0)

\* Action groups executed in recorded order: backend writes and deploys (fixed version sequence); pull start, pull done, and pull lost (prevents pull done from matching a pull started in the same step)
Chains == {{"Write", "RuleChange"}, {"PullStart", "PullDone", "PullLost"}}
\* Execute another recorded action not yet completed in the current trace line; actions in the same group follow recorded order
Hidden ==
    /\ l <= Len(TraceLog)
    /\ \E i \in (1..Len(TraceLog[l].acts)) \ done :
          /\ \A g \in Chains : TraceLog[l].acts[i].a \in g =>
                \A j \in 1..(i - 1) : TraceLog[l].acts[j].a \in g => j \in done
          /\ Do(TraceLog[l].acts[i])
          /\ done' = done \cup {i}
    /\ UNCHANGED l

\* Step completed: all non-optional actions executed, state matches observations; advance to next trace line
Observe ==
    /\ l <= Len(TraceLog)
    /\ \A i \in 1..Len(TraceLog[l].acts) : i \in done \/ TraceLog[l].acts[i].o
    /\ Matches(TraceLog[l])
    /\ l' = l + 1 /\ done' = {}
    /\ UNCHANGED vars
    \* Print when the matched line count reaches a new high to pinpoint failures (run with a single worker)
    /\ IF l > TLCGet(1) THEN TLCSet(1, l) /\ PrintT(<<"matched", l>>) ELSE TRUE

TraceSpec == TraceInit /\ [][Hidden \/ Observe]_traceVars

\* TLC view ignores bounding counters (trace budget is sufficient): paths differing only by counter values merge into the same state
TraceView == <<sEras, sub, cPushed, cSub, chan, dConn, dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, dInflight, pSubs,
               l, done>>

\* Violated when the entire trace matches
Unmatched == l <= Len(TraceLog)
=============================================================================
