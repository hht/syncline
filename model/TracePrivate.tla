----------------------------- MODULE TracePrivate ------------------------------
(***************************************************************************)
(* Trace validation (following Microsoft CCF trace validation):            *)
(* deterministic simulation executes the real implementation, recording at *)
(* each step which actions correspond to transitions in the model, along   *)
(* with observable post-step state (per-device cookie versions, pending     *)
(* write counts, and cloud head version; see src/test/test-trace.ts). TLC  *)
(* searches for an execution of Private.tla: each step executes the        *)
(* recorded actions once in any order (actions marked 'o' are optional),    *)
(* matching the observed state upon completion. Invariant Unmatched is     *)
(* violated when the entire trace matches (used by `pnpm model:trace`). If  *)
(* TLC completes without violating Unmatched, the implementation took an   *)
(* action not permitted by the model, or the mapping in test-trace.ts is   *)
(* incorrect. Checks control flow only without comparing written values:   *)
(* simulation writes map to 'inc' on the single row of table 1, as do      *)
(* backend writes; table 2 (Later) is cloud-only, then enters and leaves   *)
(* sync.                                                                   *)
(***************************************************************************)
EXTENDS Private, TraceLog

CONSTANTS d1, d2, d3

\* Simulated device i (1-based)
D == <<d1, d2, d3>>

VARIABLES
    l,     \* Next trace line to match
    done   \* Actions already executed in this line (indices in acts)

traceVars == <<vars, l, done>>

\* Observable state: cookie version (-1 if no cookie), pending writes, stage point (tail version reached, -1 if none), and cloud head version
VersionOf(c) == IF c = CNil THEN -1 ELSE c.v
Staged(d) == IF dStaged[d] = NoStage THEN -1 ELSE dStaged[d].pos.p.v
Matches(line) ==
    /\ \A i \in 1..Len(line.cookie) :
          VersionOf(dCookie[D[i]]) = line.cookie[i] /\ Len(dPending[D[i]]) = line.pending[i] /\ Staged(D[i]) = line.staged[i]
    /\ Len(sCommits) = line.head

\* Recorded message (Message in test-trace.ts): matching type, sent by or to this device, with matching version and count if recorded (-2 means unrecorded).
\* Evaluated in actions where TLC explores every disjunct: missing fields are guarded by IF.
Is(x, m) ==
    /\ m.type = x.t
    /\ IF m.type \in {"push", "pullreq"} THEN m.from = D[x.d] ELSE m.to = D[x.d]
    /\ IF x.b = -2 THEN TRUE ELSE IF m.type = "pullreq" THEN VersionOf(m.cookie) = x.b ELSE VersionOf(m.base) = x.b
    /\ IF x.c = -2 THEN TRUE ELSE IF m.type = "chunk" THEN m.pos.p.v = x.c ELSE m.cookie.v = x.c
    /\ IF x.n = -2 THEN TRUE ELSE Len(m.muts) = x.n

\* Receive the recorded message without disconnecting: accept it, or drop it as stale; messages received after the connection was invalidated in the implementation correspond to dropped messages in the model.
Keep(x) ==
    \E m \in net : /\ Is(x, m)
                  /\ \/ RecvPokeOf(D[x.d], m) \/ RecvPullOf(D[x.d], m) \/ RecvChunkOf(D[x.d], m) \/ RecvHintOf(D[x.d], m)
                     \/ StaleOf(D[x.d], m) \/ DropOf(m)
                  /\ dConn'[D[x.d]] = dConn[D[x.d]]

\* Single recorded trace action (Act in test-trace.ts)
Do(x) ==
    \/ x.a = "Mutate" /\ Mutate(D[x.d], 1, "inc")
    \/ x.a = "Push" /\ Push(D[x.d])
    \/ x.a = "HandlePush" /\ \E m \in net : Is(x, m) /\ HandlePushOf(D[x.d], m)
    \/ x.a = "Connect" /\ Connect(D[x.d])
    \/ x.a = "PullReq" /\ PullReq(D[x.d])
    \* Computed response matches: message type, base version, and target version
    \/ x.a = "HandlePull" /\ \E m \in net : m.type = "pullreq" /\ m.from = D[x.d] /\ HandlePullOf(D[x.d], m)
                                              /\ \E r \in net' \ net : Is(x, r)
    \* Receive a message (HTTP pull responses always fit): for notices and hints on a connection, accept them without disconnecting if they fit in the model (Keep); otherwise take no action.
    \* If the implementation disconnected upon receipt, a separate Disconnect is recorded and handled; if it did not disconnect (e.g. server sent a hint because the notice was too large, so the model has no hint, the device records no target version, and a subsequent unchainable notice forces a disconnect in the model), the model leaves the connection open and keeps the notice in the network.
    \* Assumes the implementation applies chainable notices upon receipt: the simulation does not inject storage faults or revert failures.
    \/ x.a = "Recv" /\ IF x.t \notin {"poke", "hint"} \/ ENABLED Keep(x) THEN Keep(x) ELSE UNCHANGED vars
    \/ x.a = "Drop" /\ \E m \in net : Is(x, m) /\ DropOf(m)
    \* Client-side disconnect (recorded once per connection): received server close, or client disconnected; if already disconnected in the model (crashed, restored from backup, or disconnected from dropped/unchainable messages, or connection not yet open in the model), take no action.
    \/ x.a = "Disconnect" /\ (Disconnect(D[x.d]) \/ RecvClose(D[x.d]) \/ (dConn[D[x.d]] = NoConn /\ UNCHANGED vars))
    \/ x.a = "Crash" /\ Crash(D[x.d])
    \/ x.a = "Backup" /\ Backup(D[x.d])
    \/ x.a = "RestoreBackup" /\ RestoreBackup(D[x.d])
    \/ x.a = "Deploy" /\ Deploy
    \/ x.a = "BackendWrite" /\ BackendWrite(1, "inc")
    \/ x.a = "Enter" /\ Enter(2)
    \/ x.a = "Leave" /\ Leave(2)
    \* Simulation restores full database snapshot at the end of that interval (reimage in test-counter.ts): low floor matches the final truncation of that interval, which is the start of the next interval
    \/ x.a = "Restore" /\ Restore(x.k) /\ sLow' = sLowHist[x.k + 1]
    \* Log truncation: advances floor to version k
    \/ x.a = "Truncate" /\ Truncate /\ sLow'.v = x.k

\* Client ID assignments are symmetric: fix one permutation to prevent TLC from checking each trace 6 times
TraceInit == Init /\ dClient = (d1 :> 1 @@ d2 :> 2 @@ d3 :> 3) /\ l = 1 /\ done = {} /\ TLCSet(1, 0)

\* Execute another recorded action not yet completed in the current trace line
Hidden ==
    /\ l <= Len(TraceLog)
    /\ \E i \in (1..Len(TraceLog[l].acts)) \ done :
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

\* TLC view ignores bounding counters (trace budget is sufficient): paths differing only by counter values merge into the same state to avoid state space explosion.
\* Dead messages are omitted from the view (connection IDs are strictly monotonic, so stale connections never become active again or reappear on the server):
\* notices and closes on stale connections are discarded; pushes on connections no longer tracked by the server are dropped upon handling.
Live == {m \in net : ~(m.type \in {"poke", "close"} /\ m.conn # dConn[m.to]) /\ ~(m.type = "push" /\ m.conn \notin sConns)}
TraceView == <<sData, sCommits, sHist, sLow, sLowHist, sIn, sSince, sConns, nonceOf, nextNonce, gapSeen,
               dTables, dCookie, dPending, dClient, dNextMid, dConn, Live, nextClient, nextConn, restores, bSnap,
               dStaged, dBad, dRefetch, rolled, forbidden, lostByBackup, l, done>>

\* Violated when the entire trace matches
Unmatched == l <= Len(TraceLog)
=============================================================================
