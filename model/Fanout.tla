-------------------------------- MODULE Fanout --------------------------------
(***************************************************************************)
(* Fanout model for Syncline shared spaces: tracks versions only; row      *)
(* contents and connection messages are modeled in Shared.tla. Checks      *)
(* properties required by Shared.tla: notices chain onto the previous      *)
(* version pushed to that connection, versions advance monotonically, and  *)
(* changes relevant to the connection's subscription eventually deliver.   *)
(*                                                                         *)
(* Cloud: each backend write records a version with touched buckets (before*)
(* union after); rule changes and rebuilds have no keys and affect every   *)
(* connection, treated as 'many'. Each round of the fanout chore sends     *)
(* (base, latest] to all shards: base is shard s's last acknowledged      *)
(* version cur[s] in memory; conf is persisted only when all shards       *)
(* acknowledge the latest version; in-flight rounds coalesce into one. When*)
(* the shared space restarts, cur rolls back to conf; a fresh space sends  *)
(* an empty round at the latest version. Deliveries may drop; if a shard   *)
(* processes a round but the ack drops, progress does not advance and the  *)
(* round retransmits. When too many buckets are touched, the round carries *)
(* only 'many' and the shard pushes hints to all connections.              *)
(* Broadcast shards: known tracks the latest version in memory; after a    *)
(* reset, known is unknown (hibernating connections survive). If the       *)
(* received base is greater than known, delivery is non-contiguous: the    *)
(* shard queries the shared space for the latest version and pushes hints  *)
(* to all connections; if contiguous, known advances and the shard pushes  *)
(* chained notices to connections whose subscriptions intersect touched    *)
(* buckets.                                                                *)
(* Connections: connecting devices join the recipient list before querying *)
(* the shared space for catch-up (if the latest version matches the        *)
(* device cookie, sends an empty catch-up; otherwise sends a hint; on query*)
(* failure, sends a hint or closes the connection, never sending an empty  *)
(* catch-up); the first message pushed before catch-up is a hint (notices  *)
(* cannot chain yet). Querying before joining the recipient list is unsafe:*)
(* rounds processed between query and join would be missed, and shard reset*)
(* would prevent recovery. Catch-up versions are scoped to the connection  *)
(* and never written to known, which would suppress fanout for other       *)
(* connections.                                                            *)
(* Resident device: permanently connected to ResShard with ResSub, tracking*)
(* the highest pushed version in aSeen.                                    *)
(* Device: chains and lands notices matching cookie, otherwise records the *)
(* target version; pulls when behind, using the target version as floor;   *)
(* cached pulls return freshly computed responses at or after the floor.  *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS
    Buckets, Shards,
    Sub,              \* Buckets subscribed by the device
    ResShard, ResSub, \* Shard and subscribed buckets for the resident device
    MaxWrites, MaxFaults, MaxConns

NoShard == "none"
Unknown == -1
Max(s) == CHOOSE x \in s : \A y \in s : y <= x
Notice(base, v) == [type |-> "notice", base |-> base, cookie |-> v]
Hint(v) == [type |-> "hint", cookie |-> v]

VARIABLES
    touched,    \* Cloud: touched[v].b is buckets touched at version v; wide indicates a keyless version affecting every connection (rule changes, rebuilds)
    cur,        \* Cloud (memory): last version acknowledged by shard (Unknown: no round sent yet)
    conf,       \* Cloud (persisted): version acknowledged by all shards (Unknown: no round sent yet)
    known,      \* Broadcast shard (memory): latest version known
    dShard,     \* Shard connected to by the device
    dPhase,     \* "asking" connected and querying latest version / "open" caught up
    cPushed,    \* Last version pushed to this device connection (Unknown: nothing pushed yet)
    chan,       \* In-flight messages pushed from shard to device
    aSeen,      \* Highest version received by the resident device
    dCookie, dWant, dInflight, dIssued,
    wasted,     \* Ghost: count of pulls returning a version lower than the requested target version
    faults, conns

vars == <<touched, cur, conf, known, dShard, dPhase, cPushed, chan, aSeen, dCookie, dWant, dInflight, dIssued, wasted, faults, conns>>
dev == <<dCookie, dWant, dInflight, dIssued, wasted>>

Latest == Len(touched)
TouchedIn(lo, hi) == UNION {touched[v].b : v \in lo + 1..hi}
Wide(lo, hi) == \E v \in lo + 1..hi : touched[v].wide
\* Latest version relevant to subscription S
RelLatestOf(S) == Max({0} \cup {v \in 1..Latest : touched[v].b \cap S # {} \/ touched[v].wide})

\* Shard s pushes version v to its connections: hints push to every connection; notices push only when subscription intersects bk, chaining onto the previous version pushed to this connection (hints pushed if nothing pushed yet);
\* connections already at or past v (via catch-up) are skipped
PushAll(s, v, bk, hint) ==
    /\ IF dShard = s /\ v > cPushed /\ (hint \/ bk \cap Sub # {})
       THEN chan' = Append(chan, IF hint \/ cPushed = Unknown THEN Hint(v) ELSE Notice(cPushed, v)) /\ cPushed' = v
       ELSE UNCHANGED <<chan, cPushed>>
    /\ aSeen' = IF s = ResShard /\ (hint \/ bk \cap ResSub # {}) THEN Max({aSeen, v}) ELSE aSeen

\* Shard receives round (base, v] with touched buckets bk (many: too many touched buckets, carries only this flag); non-contiguous base queries latest version and pushes hints; contiguous base advances known
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

\* Starting version for round to shard s: fresh shards start at latest version (empty round establishing the incarnation)
Base(s) == IF cur[s] = Unknown THEN Latest ELSE cur[s]
\* Rounds touching too many buckets (or containing keyless versions) carry only 'many'
Many(s) == IF Wide(Base(s), Latest) THEN {TRUE} ELSE BOOLEAN

\* Fanout chore sends (Base(s), latest] to shard s; cur advances upon delivery and ack; persisted conf advances once all shards acknowledge latest
FanTo(s) ==
    /\ cur[s] < Latest
    /\ \E many \in Many(s) : ShardReceive(s, Base(s), Latest, TouchedIn(Base(s), Latest), many)
    /\ cur' = [cur EXCEPT ![s] = Latest]
    /\ conf' = IF \A x \in Shards : cur'[x] = Latest THEN Latest ELSE conf
    /\ UNCHANGED <<touched, dShard, dPhase, faults, conns>> /\ UNCHANGED dev

\* Shard processed round but ack was lost (RPC timeout): progress does not advance; round retransmits later
FanNoAck(s) ==
    /\ cur[s] < Latest /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ \E many \in Many(s) : ShardReceive(s, Base(s), Latest, TouchedIn(Base(s), Latest), many)
    /\ UNCHANGED <<touched, cur, conf, dShard, dPhase, conns>> /\ UNCHANGED dev

\* Broadcast shard reset: in-memory version cleared; hibernating connections preserved
ShardReset(s) ==
    /\ faults < MaxFaults /\ known[s] # Unknown
    /\ faults' = faults + 1
    /\ known' = [known EXCEPT ![s] = Unknown]
    /\ UNCHANGED <<touched, cur, conf, dShard, dPhase, cPushed, chan, aSeen, conns>> /\ UNCHANGED dev

\* Shared space restart (deploy, memory eviction): per-shard acknowledged versions roll back to persisted conf
Restart ==
    /\ faults < MaxFaults /\ \E s \in Shards : cur[s] # conf
    /\ faults' = faults + 1
    /\ cur' = [s \in Shards |-> conf]
    /\ UNCHANGED <<touched, conf, known, dShard, dPhase, cPushed, chan, aSeen, conns>> /\ UNCHANGED dev

\* Device connects to shard s: joins recipient list and queries shared space for latest version
Connect(s) ==
    /\ dShard = NoShard /\ conns < MaxConns
    /\ conns' = conns + 1
    /\ dShard' = s /\ dPhase' = "asking" /\ cPushed' = Unknown
    /\ UNCHANGED <<touched, cur, conf, known, chan, aSeen, faults>> /\ UNCHANGED dev

\* Catch-up with latest version k (scoped to this connection): if nothing pushed yet, sends empty catch-up when k equals device cookie, else sends hint; if already pushed, sends hint only when k is newer
Catchup ==
    /\ dShard # NoShard /\ dPhase = "asking"
    /\ LET k == Latest
       IN IF cPushed = Unknown \/ k > cPushed
          THEN chan' = Append(chan, IF cPushed = Unknown /\ k = dCookie THEN Notice(dCookie, dCookie) ELSE Hint(k)) /\ cPushed' = k
          ELSE UNCHANGED <<chan, cPushed>>
    /\ dPhase' = "open"
    /\ UNCHANGED <<touched, cur, conf, known, dShard, aSeen, faults, conns>> /\ UNCHANGED dev

\* Disconnect: reconnects allowed while connection budget remains
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

\* Pull when behind, using target version as floor
PullStart ==
    /\ dInflight = Unknown /\ dWant > dCookie
    /\ dInflight' = dWant /\ dIssued' = dWant
    /\ UNCHANGED <<touched, cur, conf, known, dShard, dPhase, cPushed, chan, aSeen, faults, conns, dCookie, dWant, wasted>>

\* Pull response: cache returns freshly computed response at or after the floor
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

\* Fairness: fanout steps, connection lifecycle, message delivery, and pulls proceed; cache expiry eventually forces fresh computation
Spec == Init /\ [][Next]_vars
            /\ \A s \in Shards : WF_vars(FanTo(s))
            /\ WF_vars(\E x \in Shards : Connect(x)) /\ WF_vars(Catchup)
            /\ WF_vars(Deliver) /\ WF_vars(PullStart)
            /\ WF_vars(\E t \in 0..Latest : PullDone(t)) /\ SF_vars(PullDone(Latest))

\* ---------------------------------------------------------------- Properties
\* Pulls following a hint never receive stale responses below the target version (no redundant pulls)
NoWastedPull == wasted = 0
\* No missed changes: between the version pushed to this connection and the version known to the shard, no relevant changes were skipped
Covers == dShard # NoShard /\ cPushed # Unknown /\ known[dShard] # Unknown =>
              TouchedIn(cPushed, known[dShard]) \cap Sub = {} /\ ~Wide(cPushed, known[dShard])
\* S2: after backend writes quiesce, the device eventually catches up to its relevant head, and the resident device receives its relevant head
CatchesUp == <>[](dCookie >= RelLatestOf(Sub) /\ aSeen >= RelLatestOf(ResSub))
================================================================================
