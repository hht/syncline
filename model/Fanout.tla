-------------------------------- MODULE Fanout --------------------------------
(***************************************************************************)
(* Fanout model for Syncline shared spaces: tracks versions only; row      *)
(* contents and connection messages are modeled in Shared.tla. Checks      *)
(* properties required by Shared.tla: notices chain onto the previous      *)
(* version pushed to that connection and carry every relevant change since *)
(* it, versions advance monotonically, and changes relevant to the         *)
(* connection's subscription eventually deliver.                           *)
(*                                                                         *)
(* Cloud: each backend write records a version with touched buckets (before*)
(* union after); rule changes and rebuilds have no keys and affect every   *)
(* connection, treated as 'many'. The fanout keeps at most one round in    *)
(* flight per shard: a round (base, v] is built when sent, with base the   *)
(* shard's last acknowledged version cur[s] in memory and v the latest     *)
(* version at that moment, and reaches the shard later, possibly after     *)
(* further writes. cur advances to v when the shard acknowledges; conf is  *)
(* persisted only when all shards acknowledge the latest version. A round  *)
(* may be lost on the way, its send may time out while it waits for the   *)
(* shard's query, or its acknowledgment may be lost: progress does not     *)
(* advance and a new round goes out later. A round the fanout gave up on   *)
(* before it arrived never arrives later (not modeled: a late arrival).    *)
(* When the shared space restarts, rounds in flight are forgotten and cur  *)
(* rolls back to conf; a fresh fanout sends an empty round at the latest  *)
(* version. When too many buckets are touched, the round carries only     *)
(* 'many' and the shard pushes hints to all connections.                   *)
(* Broadcast shards: known tracks the latest version in memory (unknown    *)
(* when the shard starts, and after a reset; hibernating connections       *)
(* survive). A round chains when its base is at most known, or, with known *)
(* unknown, when the round is not empty: chained rounds advance known and  *)
(* push chained notices to connections whose subscriptions intersect       *)
(* touched buckets. A round that does not chain waits for the shard's query*)
(* for the latest version, then pushes hints to all connections at the     *)
(* answer, records it as known, and only then acknowledges. Queries answer *)
(* with the latest version when they complete; a shard reuses its last     *)
(* answer while it is fresh and not older than what the caller needs. A    *)
(* query may fail, and a reset loses the query, its waiters, and the last  *)
(* answer.                                                                 *)
(* Connections: connecting devices join the recipient list before asking   *)
(* for catch-up (if the answer matches the cookie the connection carried,  *)
(* sends an empty catch-up; otherwise sends a hint; on query failure, sends*)
(* a hint at known if known, never an empty catch-up); the first message   *)
(* pushed before catch-up is a hint (notices cannot chain yet). Querying   *)
(* before joining the recipient list is unsafe: rounds processed between   *)
(* query and join would be missed, and shard reset would prevent recovery. *)
(* Catch-up versions are scoped to the connection and never written to     *)
(* known, which would suppress fanout for other connections. A device that *)
(* hears nothing on a connection within its catch-up deadline gives up on  *)
(* it and connects again.                                                  *)
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
NoRound == [b |-> Unknown, v |-> Unknown, many |-> FALSE, waiting |-> FALSE]
Max(s) == CHOOSE x \in s : \A y \in s : y <= x
Notice(base, v) == [type |-> "notice", base |-> base, cookie |-> v]
Hint(v) == [type |-> "hint", cookie |-> v]

VARIABLES
    touched,    \* Cloud: touched[v].b is buckets touched at version v; wide indicates a keyless version affecting every connection (rule changes, rebuilds)
    cur,        \* Cloud (memory): last version acknowledged by shard (Unknown: no round sent yet)
    conf,       \* Cloud (persisted): version acknowledged by all shards (Unknown: no round sent yet)
    sent,       \* Cloud (memory): round in flight to each shard (NoRound if none); waiting: the shard received it and waits for its query
    known,      \* Broadcast shard (memory): latest version known
    asked,      \* Broadcast shard (memory): last query answer (Unknown if none)
    held,       \* Broadcast shard (memory): a round that did not chain waits for the query (possibly one the fanout has forgotten)
    asking,     \* Broadcast shard (memory): a query for the latest version is out
    dShard,     \* Shard connected to by the device
    dPhase,     \* "asking" connected and waiting for catch-up / "open" catch-up done or lost
    cCookie,    \* Cookie the device's connection carried (0 once catch-up ends: read only while waiting for it)
    cPushed,    \* Last version pushed to this device connection (Unknown: nothing pushed yet)
    chan,       \* In-flight messages pushed from shard to device
    aSeen,      \* Highest version received by the resident device
    dCookie, dWant, dInflight, dIssued,
    wasted,     \* Ghost: count of pulls returning a version lower than the requested target version
    gaps,       \* Ghost: count of notices missing a relevant change between the connection's previous version and the round's base
    faults, conns

shard == <<known, asked, held, asking>>
conn == <<dShard, dPhase, cCookie, cPushed, chan, aSeen, gaps>>
dev == <<dCookie, dWant, dInflight, dIssued, wasted>>
vars == <<touched, cur, conf, sent, shard, conn, dev, faults, conns>>

Latest == Len(touched)
TouchedIn(lo, hi) == UNION {touched[v].b : v \in lo + 1..hi}
Wide(lo, hi) == \E v \in lo + 1..hi : touched[v].wide
\* Latest version relevant to subscription S
RelLatestOf(S) == Max({0} \cup {v \in 1..Latest : touched[v].b \cap S # {} \/ touched[v].wide})

\* Shard s pushes round (base, v] to its connections: hints push to every connection; notices push only when subscription intersects bk, chaining onto the previous version pushed to this connection (hints pushed if nothing pushed yet);
\* connections already at or past v are skipped. A notice whose round starts past the connection's previous version misses what changed in between (gaps)
PushAll(s, base, v, bk, hint) ==
    /\ IF dShard = s /\ v > cPushed /\ (hint \/ bk \cap Sub # {})
       THEN /\ chan' = Append(chan, IF hint \/ cPushed = Unknown THEN Hint(v) ELSE Notice(cPushed, v))
            /\ cPushed' = v
            /\ gaps' = IF ~hint /\ cPushed # Unknown /\ base > cPushed /\ (TouchedIn(cPushed, base) \cap Sub # {} \/ Wide(cPushed, base))
                       THEN gaps + 1 ELSE gaps
       ELSE UNCHANGED <<chan, cPushed, gaps>>
    /\ aSeen' = IF s = ResShard /\ (hint \/ bk \cap ResSub # {}) THEN Max({aSeen, v}) ELSE aSeen

\* Catch-up message for the device's connection at k (scoped to this connection): if nothing pushed yet, an empty catch-up when k is a
\* query answer (`answered`) equal to the connection's cookie, else a hint; if already pushed, a hint only when k is newer
CatchupWith(k, answered) ==
    /\ IF cPushed = Unknown \/ k > cPushed
       THEN chan' = Append(chan, IF answered /\ cPushed = Unknown /\ k = cCookie THEN Notice(cCookie, cCookie) ELSE Hint(k)) /\ cPushed' = k
       ELSE UNCHANGED <<chan, cPushed>>
    /\ dPhase' = "open"

\* Acknowledgment of round r by shard s: cur advances to the round's version; conf advances once all shards acknowledge the latest version
Ack(s, r) ==
    /\ cur' = [cur EXCEPT ![s] = r.v]
    /\ conf' = IF \A x \in Shards : cur'[x] = Latest THEN Latest ELSE conf

Init ==
    /\ touched = <<>> /\ cur = [s \in Shards |-> Unknown] /\ conf = Unknown /\ sent = [s \in Shards |-> NoRound]
    /\ known = [s \in Shards |-> Unknown] /\ asked = [s \in Shards |-> Unknown] /\ held = [s \in Shards |-> FALSE] /\ asking = [s \in Shards |-> FALSE]
    /\ dShard = NoShard /\ dPhase = "open" /\ cCookie = 0 /\ cPushed = Unknown /\ chan = <<>> /\ aSeen = 0 /\ gaps = 0
    /\ dCookie = 0 /\ dWant = 0 /\ dInflight = Unknown /\ dIssued = 0 /\ wasted = 0
    /\ faults = 0 /\ conns = 0

Write(B, wide) ==
    /\ Latest < MaxWrites
    /\ touched' = Append(touched, [b |-> B, wide |-> wide])
    /\ UNCHANGED <<cur, conf, sent, shard, conn, dev, faults, conns>>

\* Starting version for round to shard s: fresh shards start at latest version (empty round establishing the incarnation)
Base(s) == IF cur[s] = Unknown THEN Latest ELSE cur[s]

\* Fanout sends (Base(s), latest] to shard s when none is in flight; rounds touching too many buckets (or containing keyless versions) carry only 'many'
Send(s) ==
    /\ sent[s] = NoRound /\ cur[s] < Latest
    /\ \E many \in IF Wide(Base(s), Latest) THEN {TRUE} ELSE BOOLEAN :
          sent' = [sent EXCEPT ![s] = [b |-> Base(s), v |-> Latest, many |-> many, waiting |-> FALSE]]
    /\ UNCHANGED <<touched, cur, conf, shard, conn, dev, faults, conns>>

\* Chaining rule: a round chains onto known, or, with known unknown, when it is not empty. A shard that lost known (reset or eviction)
\* still chains a non-empty round: its base is a version the shard acknowledged before (cur only advances on acknowledgment, and
\* restarts roll it back), so every connection already holds what came before it; only the empty round of a fresh fanout (base = v,
\* possibly ahead of what the shard processed) cannot chain
Chains(s, r) == IF known[s] = Unknown THEN r.b < r.v ELSE r.b <= known[s]

\* Round reaches shard s and chains: pushes if newer than known; `ack` says whether the acknowledgment reaches the fanout
ArriveChained(s, ack) ==
    LET r == sent[s] IN
    /\ r # NoRound /\ ~r.waiting /\ Chains(s, r)
    /\ IF r.v > known[s]
       THEN /\ known' = [known EXCEPT ![s] = r.v] /\ PushAll(s, r.b, r.v, TouchedIn(r.b, r.v), r.many)
            \* An answer below known is never used again (catch-up and rounds need one at or past known): forgotten, so states differing only by it merge
            /\ asked' = [asked EXCEPT ![s] = IF @ < r.v THEN Unknown ELSE @]
       ELSE UNCHANGED <<known, asked, chan, cPushed, aSeen, gaps>>
    /\ IF ack THEN Ack(s, r) /\ UNCHANGED faults ELSE faults < MaxFaults /\ faults' = faults + 1 /\ UNCHANGED <<cur, conf>>
    /\ sent' = [sent EXCEPT ![s] = NoRound]
    /\ UNCHANGED <<touched, held, asking, dShard, dPhase, cCookie, conns>> /\ UNCHANGED dev

\* Round reaches shard s and does not chain. With a fresh answer at or past its version, the shard settles it at once: hints to every
\* connection at the answer, which becomes known, then the acknowledgment (`ack` says whether it reaches the fanout). Otherwise the round
\* waits for the query, which the shard starts unless one is already out
ArriveUnchained(s, ack) ==
    LET r == sent[s] IN
    /\ r # NoRound /\ ~r.waiting /\ ~Chains(s, r)
    /\ \/ /\ asked[s] >= r.v
          /\ known' = [known EXCEPT ![s] = asked[s]] /\ PushAll(s, asked[s], asked[s], {}, TRUE)
          /\ sent' = [sent EXCEPT ![s] = NoRound]
          /\ IF ack THEN Ack(s, r) /\ UNCHANGED faults ELSE faults < MaxFaults /\ faults' = faults + 1 /\ UNCHANGED <<cur, conf>>
          /\ UNCHANGED <<held, asking>>
       \* A waiting round settles with hints at the answer: only its version (acknowledged) still matters
       \/ /\ ack
          /\ sent' = [sent EXCEPT ![s] = [NoRound EXCEPT !.v = r.v, !.waiting = TRUE]] /\ held' = [held EXCEPT ![s] = TRUE]
          /\ asking' = [asking EXCEPT ![s] = TRUE]
          /\ UNCHANGED <<known, cur, conf, chan, cPushed, aSeen, gaps, faults>>
    /\ UNCHANGED <<touched, asked, dShard, dPhase, cCookie, conns>> /\ UNCHANGED dev

\* The device's connection to shard s waits for catch-up
Asking(s) == dShard = s /\ dPhase = "asking"

\* Shard s's query answers with the latest version, which becomes its last answer. It settles the waiting round (hints to every
\* connection, known, acknowledgment if the fanout still waits for it) and the connection's catch-up, in the order they asked: catch-up
\* first sends its message and the hints then skip the connection; otherwise the hint reaches it first and catch-up skips. A query whose
\* callers have gone (the device disconnected) still answers
Answer(s) ==
    /\ asking[s]
    /\ asking' = [asking EXCEPT ![s] = FALSE] /\ asked' = [asked EXCEPT ![s] = Latest] /\ held' = [held EXCEPT ![s] = FALSE]
    /\ IF held[s]
       THEN /\ known' = [known EXCEPT ![s] = Latest]
            /\ IF sent[s].waiting THEN Ack(s, sent[s]) /\ sent' = [sent EXCEPT ![s] = NoRound] ELSE UNCHANGED <<cur, conf, sent>>
            /\ aSeen' = IF s = ResShard THEN Max({aSeen, Latest}) ELSE aSeen
       ELSE UNCHANGED <<known, cur, conf, sent, aSeen>>
    /\ \E first \in BOOLEAN :
          IF Asking(s) /\ (first \/ ~held[s])
          THEN CatchupWith(Latest, TRUE)
          ELSE /\ IF held[s] /\ dShard = s /\ Latest > cPushed
                  THEN chan' = Append(chan, Hint(Latest)) /\ cPushed' = Latest
                  ELSE UNCHANGED <<chan, cPushed>>
               /\ dPhase' = IF Asking(s) THEN "open" ELSE dPhase
    /\ cCookie' = IF Asking(s) THEN 0 ELSE cCookie
    /\ UNCHANGED <<touched, dShard, gaps, faults, conns>> /\ UNCHANGED dev

\* Shard s's query fails: the waiting round fails (no acknowledgment); catch-up falls back to a hint at known, or sends nothing
QueryFail(s) ==
    /\ asking[s]
    /\ faults < MaxFaults /\ faults' = faults + 1
    /\ asking' = [asking EXCEPT ![s] = FALSE] /\ held' = [held EXCEPT ![s] = FALSE]
    /\ sent' = IF sent[s].waiting THEN [sent EXCEPT ![s] = NoRound] ELSE sent
    /\ IF Asking(s)
       THEN IF known[s] # Unknown THEN CatchupWith(known[s], FALSE) ELSE dPhase' = "open" /\ UNCHANGED <<chan, cPushed>>
       ELSE UNCHANGED <<dPhase, chan, cPushed>>
    /\ cCookie' = IF Asking(s) THEN 0 ELSE cCookie
    /\ UNCHANGED <<touched, cur, conf, known, asked, dShard, aSeen, gaps, conns>> /\ UNCHANGED dev

\* A round in flight is lost, or its send times out while it waits for the shard's query (the shard still settles it, unacknowledged); the
\* fanout sends again later
SendFail(s) ==
    /\ sent[s] # NoRound /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ sent' = [sent EXCEPT ![s] = NoRound]
    /\ UNCHANGED <<touched, cur, conf, shard, conn, dev, conns>>

\* Broadcast shard reset: memory cleared (known, last answer, query and its waiters); hibernating connections preserved, and a connection waiting for catch-up never gets it
ShardReset(s) ==
    /\ faults < MaxFaults /\ (known[s] # Unknown \/ asked[s] # Unknown \/ asking[s])
    /\ faults' = faults + 1
    /\ known' = [known EXCEPT ![s] = Unknown] /\ asked' = [asked EXCEPT ![s] = Unknown]
    /\ held' = [held EXCEPT ![s] = FALSE] /\ asking' = [asking EXCEPT ![s] = FALSE]
    /\ sent' = IF sent[s].waiting THEN [sent EXCEPT ![s] = NoRound] ELSE sent
    /\ dPhase' = IF Asking(s) THEN "open" ELSE dPhase
    /\ cCookie' = IF Asking(s) THEN 0 ELSE cCookie
    /\ UNCHANGED <<touched, cur, conf, dShard, cPushed, chan, aSeen, gaps, conns>> /\ UNCHANGED dev

\* Shared space restart (deploy, memory eviction): rounds in flight are forgotten (rounds waiting for a shard's query still settle there,
\* unacknowledged; rounds not yet arrived never arrive), and per-shard acknowledged versions roll back to persisted conf
Restart ==
    /\ faults < MaxFaults /\ \E s \in Shards : cur[s] # conf \/ sent[s] # NoRound
    /\ faults' = faults + 1
    /\ cur' = [s \in Shards |-> conf] /\ sent' = [s \in Shards |-> NoRound]
    /\ UNCHANGED <<touched, conf, shard, conn, dev, conns>>

\* Device connects to shard s carrying its cookie and joins the recipient list. Catch-up comes at once from the shard's last answer while it
\* is fresh and not older than known; otherwise the connection waits for the query, which the shard starts unless one is already out
Connect(s) ==
    /\ dShard = NoShard /\ conns < MaxConns
    /\ conns' = conns + 1
    /\ dShard' = s
    /\ \/ /\ asked[s] # Unknown /\ asked[s] >= known[s]
          /\ chan' = Append(chan, IF asked[s] = dCookie THEN Notice(dCookie, dCookie) ELSE Hint(asked[s])) /\ cPushed' = asked[s]
          /\ dPhase' = "open" /\ UNCHANGED <<cCookie, asking>>
       \/ /\ dPhase' = "asking" /\ cCookie' = dCookie /\ cPushed' = Unknown /\ asking' = [asking EXCEPT ![s] = TRUE]
          /\ UNCHANGED chan
    /\ UNCHANGED <<touched, cur, conf, sent, known, asked, held, aSeen, gaps, faults>> /\ UNCHANGED dev

\* Disconnect: reconnects allowed while connection budget remains
Disconnect ==
    /\ dShard # NoShard /\ conns < MaxConns
    /\ dShard' = NoShard /\ dPhase' = "open" /\ cCookie' = 0 /\ chan' = <<>>
    /\ UNCHANGED <<touched, cur, conf, sent, shard, cPushed, aSeen, gaps, faults, conns>> /\ UNCHANGED dev

\* Catch-up deadline: a connection that heard nothing after its catch-up was lost (query failure with nothing known, or shard reset) is
\* given up, without spending the connection budget (each loss already spends a fault)
GiveUp ==
    /\ dShard # NoShard /\ dPhase = "open" /\ cPushed = Unknown
    /\ dShard' = NoShard /\ conns' = conns - 1
    /\ UNCHANGED <<touched, cur, conf, sent, shard, dPhase, cCookie, cPushed, chan, aSeen, gaps, faults>> /\ UNCHANGED dev

Deliver ==
    /\ dShard # NoShard /\ chan # <<>>
    /\ LET m == Head(chan)
       IN IF m.type = "notice" /\ dInflight = Unknown /\ m.base = dCookie
          THEN dCookie' = m.cookie /\ UNCHANGED dWant
          ELSE dWant' = Max({dWant, m.cookie}) /\ UNCHANGED dCookie
    /\ chan' = Tail(chan)
    /\ UNCHANGED <<touched, cur, conf, sent, shard, dShard, dPhase, cCookie, cPushed, aSeen, gaps, faults, conns, dInflight, dIssued, wasted>>

\* Pull when behind, using target version as floor
PullStart ==
    /\ dInflight = Unknown /\ dWant > dCookie
    /\ dInflight' = dWant /\ dIssued' = dWant
    /\ UNCHANGED <<touched, cur, conf, sent, shard, conn, faults, conns, dCookie, dWant, wasted>>

\* Pull response: cache returns freshly computed response at or after the floor
PullDone(t) ==
    /\ dInflight # Unknown /\ t \in dInflight..Latest
    /\ dCookie' = Max({dCookie, t})
    /\ wasted' = IF t < dIssued THEN wasted + 1 ELSE wasted
    /\ dInflight' = Unknown /\ dIssued' = 0
    /\ UNCHANGED <<touched, cur, conf, sent, shard, conn, faults, conns, dWant>>

Next ==
    \/ \E B \in SUBSET Buckets \ {{}} : Write(B, FALSE)
    \/ Write({}, TRUE)
    \/ \E s \in Shards :
          \/ Send(s) \/ ArriveChained(s, TRUE) \/ ArriveChained(s, FALSE) \/ ArriveUnchained(s, TRUE) \/ ArriveUnchained(s, FALSE)
          \/ Answer(s) \/ QueryFail(s) \/ SendFail(s) \/ ShardReset(s) \/ Connect(s)
    \/ Restart \/ Disconnect \/ GiveUp \/ Deliver \/ PullStart
    \/ \E t \in 0..Latest : PullDone(t)

\* Fairness: fanout steps, query answers (assumes a shard's query to the shared space eventually settles), connection lifecycle, message
\* delivery, and pulls proceed; cache expiry eventually forces fresh computation
Spec == Init /\ [][Next]_vars
            /\ \A s \in Shards : WF_vars(Send(s)) /\ WF_vars(ArriveChained(s, TRUE)) /\ WF_vars(ArriveUnchained(s, TRUE)) /\ WF_vars(Answer(s))
            /\ WF_vars(\E x \in Shards : Connect(x)) /\ WF_vars(GiveUp)
            /\ WF_vars(Deliver) /\ WF_vars(PullStart)
            /\ WF_vars(\E t \in 0..Latest : PullDone(t)) /\ SF_vars(PullDone(Latest))

\* ---------------------------------------------------------------- Properties
\* Pulls following a hint never receive stale responses below the target version (no redundant pulls). True by construction here (PullDone
\* answers at or past the floor); the fanout simulation checks the part that can fail: no hint names a version past head
NoWastedPull == wasted = 0
\* No missed changes: between the version pushed to this connection and the version known to the shard, no relevant changes were skipped
Covers == dShard # NoShard /\ cPushed # Unknown /\ known[dShard] # Unknown =>
              TouchedIn(cPushed, known[dShard]) \cap Sub = {} /\ ~Wide(cPushed, known[dShard])
\* Every notice carries every relevant change since the version previously pushed to its connection
Complete == gaps = 0
\* S2: after backend writes quiesce, the device eventually catches up to its relevant head, and the resident device receives its relevant head
CatchesUp == <>[](dCookie >= RelLatestOf(Sub) /\ aSeen >= RelLatestOf(ResSub))
================================================================================
