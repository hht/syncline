-------------------------------- MODULE Shared --------------------------------
(***************************************************************************)
(* Sync protocol model for Syncline shared spaces.                         *)
(*                                                                         *)
(* Shared spaces are written only by backend writes; devices are read-only *)
(* and pull responses are served through edge HTTP cache (following        *)
(* ElectricSQL's Shape HTTP protocol). Durable Objects do not keep         *)
(* historical versions; rows in a pull response read current values at     *)
(* the moment that chunk is computed, so cached copies can differ from     *)
(* fresh copies computed later.                                            *)
(*                                                                         *)
(* Visibility is partitioned by buckets: a row belongs to buckets         *)
(* determined by its bucket columns under the table's bucket rules (a      *)
(* table can have multiple rules; a row can belong to multiple buckets).   *)
(* A subscription is a set of buckets computed by the cloud from a token,  *)
(* which may change when the token updates. A device holds the rows        *)
(* visible to its subscription under a single global cookie.               *)
(*                                                                         *)
(* Cloud: a backend write modifies a row (updating values, changing bucket *)
(* columns to move between buckets, or deleting), recording a version with *)
(* only touched keys; before/after bucket membership is computed from that *)
(* version's values and rules. Deployments can alter a table's bucket      *)
(* rules: the table's since is set to the next version, recording a commit *)
(* without keys, after which evaluation follows the new rules. Rebuild     *)
(* (new incarnation): a new incarnation starts from version 0, invalidating*)
(* all cookies from older incarnations. Log truncation deletes the oldest  *)
(* commits in an incarnation; requests with cookies or cursors below the   *)
(* log floor fall back to a full pull (the implementation returns reset).  *)
(* Incarnation is a random nonce generated at space creation; devices and  *)
(* the cloud only check equality, never ordering. The model orders         *)
(* (incarnation, version) positions sequentially only to capture the       *)
(* invariant that a response cannot be computed before its request is sent.*)
(*                                                                         *)
(* Reader (following the linear three phases of private spaces): a plan    *)
(* executes one round by scanning first, then chasing the tail. The scan   *)
(* set S(f, h) contains tables whose since advanced after the round's      *)
(* start f and up to the watermark h (a full pull takes all tables at h);  *)
(* these tables are cleared before returning rows visible to the           *)
(* subscription. The first round of an incremental pull also scans newly   *)
(* added buckets (outside landed subscription o), emitting current rows.   *)
(* The tail walks commits from the chased version up to the latest head,   *)
(* emitting rows touched before or after within subscription N (skipping   *)
(* entries for table t at or before since(t) covered by the scan set); row *)
(* values reflect current buckets intersected with N, where an empty       *)
(* intersection means absent. If additional tables advance their since in   *)
(* (h, latest] while tailing to head, the reader opens another round. If a *)
(* device has no cookie, its cookie belongs to another incarnation, or its *)
(* subscription drops buckets (o is not a subset of N), it performs a full *)
(* pull: clearing all tables and scanning all tables in the first round.   *)
(* Watermark h can be any version between the start and the computed       *)
(* version (the implementation aligns it to chunk boundaries so concurrent *)
(* initial pulls share edge cache). A chunk can split after any scan item, *)
(* or after finishing the scan and tailing up to any version; the final    *)
(* chunk advances up to the computed version. Each chunk carries seen: the *)
(* position at which that chunk was computed.                              *)
(*                                                                         *)
(* Cache: a request may receive either a cached response computed at any   *)
(* past position after the request was sent, or a freshly computed         *)
(* response; subscription N reflects the token at any point between        *)
(* request send and response generation. If the resumed plan does not      *)
(* match subscription N, the reader starts a new plan from the device's   *)
(* landed cookie and subscription; if outside the current incarnation, it  *)
(* returns a full pull (reset).                                            *)
(*                                                                         *)
(* Device: chunks are staged first; if the returned subscription or        *)
(* incarnation mismatches staged chunks, staged chunks are discarded. The  *)
(* final chunk lands atomically (updating cookie and subscription) only if *)
(* its seen position is at or ahead of all staged chunks; if behind, it is *)
(* treated as an intermediate chunk and resumed with seen as floor (a new  *)
(* cache key, avoiding stale cached chunks).                               *)
(*                                                                         *)
(* Connection: devices connect to a broadcast shard; messages arrive in    *)
(* order over the connection, which can disconnect. On connect, the first  *)
(* message is the version read by the shard (which may lag or belong to an *)
(* older incarnation): sending a catch-up if matching the device cookie,   *)
(* or a hint otherwise; this version is private to that connection. The    *)
(* shard then pushes subsequent unseen versions: a notice chained onto the *)
(* previously pushed version (carrying changes visible to this             *)
(* connection's subscription, unless crossing a rule change or rebuild),   *)
(* or a hint; versions irrelevant to this subscription may be skipped, but *)
(* rule changes and rebuilds are pushed to every connection. On a rebuild, *)
(* fanout from the old incarnation or pre-rebuild queries may arrive late; *)
(* if positions from different incarnations appear on the connection, the   *)
(* shard treats it as a discontinuity, queries the latest head, and pushes *)
(* its hint. Shard state and fanout mechanics are modeled in Fanout.tla;   *)
(* this module only requires these connection-level invariants.            *)
(*                                                                         *)
(* Device pulling and notifications: a device pulls whenever it has no     *)
(* cookie, has staged chunks, has a target position newer than its cookie, *)
(* or hears a subscription on the connection differing from its landed     *)
(* subscription. At most one pull is in flight at a time; new requests     *)
(* carry the target position as floor if newer than the cookie. A notice   *)
(* applies directly only when no pull is in flight, no chunks are staged,  *)
(* its base equals the cookie, and subscription matches landed; otherwise, *)
(* if newer than the cookie (another incarnation or higher version), it is *)
(* recorded as target position. If a request carrying a floor returns from *)
(* a different incarnation, the device drops the target (the shard was     *)
(* stale); requests whose floor does not match the cloud's current         *)
(* incarnation are computed live without entering cache. Devices can       *)
(* restart (clearing in-memory target position and floor while preserving  *)
(* local database state) or disconnect; pulls may be dropped. When a token *)
(* changes, the device reconnects to receive pushes under the new          *)
(* subscription: the old connection eventually expires and closes (or      *)
(* earlier if the integrator calls reconnect()); if a landing pull's       *)
(* subscription differs from heard on the connection, the connection is   *)
(* replaced after landing. Connecting to a new connection voids heard.     *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS
    KeyOrder,       \* Rows in shared tables, ordered by (table, primary key)
    TableOf,        \* Row -> table it belongs to
    BucketOrder,    \* Buckets in canonical order (added-bucket scans follow this order)
    Rules,          \* Rules[t][g][c]: buckets containing a row in table t with bucket column value c under rule generation g
    Subs, Sub0,     \* Possible subscriptions (bucket sets), initial subscription
    Data0,          \* Initial shared tables at incarnation 1, version 0
    MaxVersions,    \* Version limit (backend writes and rule changes each record one version, across all incarnations)
    MaxRuleChanges, MaxSubChanges, MaxRebuilds,
    MaxChunks,      \* Limit on intermediate chunks
    MaxFaults,      \* Limit on disconnects, device restarts, and dropped pulls
    MaxLatePushes,  \* Limit on late cross-incarnation pushes during rebuilds
    MaxTruncs       \* Limit on log truncations

ASSUME MaxVersions < 100

Keys == {KeyOrder[i] : i \in 1..Len(KeyOrder)}
Tables == {TableOf[k] : k \in Keys}
K == Len(KeyOrder)
Absent == [w |-> 0, c |-> 0]       \* Row is absent; present rows have version w that wrote it and bucket column value c
Empty == [k \in Keys |-> Absent]
NoCookie == -1
Max(s) == CHOOSE x \in s : \A y \in s : y <= x
Merge(a, b) == [k \in DOMAIN a \cup DOMAIN b |-> IF k \in DOMAIN b THEN b[k] ELSE a[k]]
\* No subscription heard from this connection yet (subscriptions are non-empty)
NoHeard == {}
ASSUME NoHeard \notin Subs

\* Position: (incarnation, version) encoded as a number ordered chronologically (used only for cache causality; devices only check incarnation equality)
Pt(e, v) == e * 100 + v
EraOf(p) == p \div 100
VerOf(p) == p % 100

\* Plan: e is incarnation, f and h are the round's start and watermark (f = -1 for initial full pull), o is landed subscription (added buckets = N \ o,
\* replaced by N on the next round), at is current scan item (Done when scan finishes), p is tail-chased version
Plan(e, f, h, o, N, at, p) == [e |-> e, f |-> f, h |-> h, o |-> o, N |-> N, at |-> at, p |-> p]
NoPlan == Plan(0, -1, -1, {}, {}, 0, -1)
\* Request: start creates a plan from device cookie c and landed subscription o, cont resumes staged plan; floor is cache lower bound (response must be computed after it)
Req(kind, c, o, plan, floor) == [kind |-> kind, c |-> c, o |-> o, plan |-> plan, floor |-> floor]
None == Req("none", NoCookie, {}, NoPlan, 0)
Notice(base, v, ops, s) == [type |-> "notice", base |-> base, cookie |-> v, ops |-> ops, sub |-> s]
Hint(v, s) == [type |-> "hint", cookie |-> v, sub |-> s]

\* Scan item: 1..K is row j (rows in scan-set tables), K * i + j is row j in bucket i (added buckets)
Done == K * (Len(BucketOrder) + 1) + 1

VARIABLES
    sEras,      \* Cloud incarnations: base is tables at version 0, gens is rule generations at version 0, log[i] is touched keys and advanced tables at version i,
                \* hist[i] is tables and rule generations after version i (ghost); low is log floor: commits at or before low are truncated, cookies and positions must be at or after it
    sub,        \* Cloud subscription computed from token
    cPushed,    \* Last position pushed by shard to current connection
    cSub,       \* Subscription of current connection
    chan,       \* In-flight messages on current connection (in-order delivery)
    dConn,      \* Device connection status
    dTables, dCookie, dSub,  \* Device tables, cookie, landed subscription
    dHeard,     \* Subscription heard from connection (in-memory only, NoHeard before first message on new connection)
    dStale,     \* Landed subscription differs from heard on connection: reconnect after landing (in-memory only)
    dStage,     \* Staged chunks: ops (cleared tables, written rows), seen, subscription
    dNext,      \* Next request to send from device
    dWant,      \* Target position of device (in-memory only)
    dInflight,  \* In-flight pull request, or None
    pSubs,      \* Subscriptions from token while pull is in flight (computed by cloud on request receipt, checking membership at that time; empty when idle)
    versions, ruleChanges, subChanges, rebuilds, chunks, faults,
    latePushes, \* Count of late fanout pushes from older incarnations
    truncs      \* Count of log truncations

vars == <<sEras, sub, cPushed, cSub, chan, dConn, dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, dInflight, pSubs,
          versions, ruleChanges, subChanges, rebuilds, chunks, faults, latePushes, truncs>>
server == <<sEras, sub, versions, ruleChanges, subChanges, rebuilds, truncs>>
conn == <<cPushed, cSub, chan, dConn>>
device == <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, dInflight, pSubs>>

Cur == Len(sEras)
Latest == Len(sEras[Cur].log)
Now == Pt(Cur, Latest)
LastOf(e) == Len(sEras[e].log)
\* All historical positions
Points == UNION {{Pt(e, v) : v \in 0..LastOf(e)} : e \in 1..Cur}
LogAt(e, i) == sEras[e].log[i]
LowOf(e) == sEras[e].low
\* Readable commits: strictly after log floor (earlier commits are truncated)
Readable(e, from, upTo) == {i \in (from + 1)..upTo : i > LowOf(e)}
DataAt(p) == IF VerOf(p) = 0 THEN sEras[EraOf(p)].base ELSE sEras[EraOf(p)].hist[VerOf(p)].data
GensAt(p) == IF VerOf(p) = 0 THEN sEras[EraOf(p)].gens ELSE sEras[EraOf(p)].hist[VerOf(p)].gens

\* Buckets containing a row (value row, in table t, under rule generation g)
Bk(row, t, g) == IF row.w = 0 THEN {} ELSE Rules[t][g][row.c]
BucketsAt(p, k) == Bk(DataAt(p)[k], TableOf[k], GensAt(p)[TableOf[k]])
\* Rows visible to subscription sb at position p
VisAt(p, sb) == [k \in Keys |-> IF BucketsAt(p, k) \cap sb # {} THEN DataAt(p)[k] ELSE Absent]
\* Row k touched at incarnation e, version i was in sb buckets before or after the commit (under that version's rules)
Touches(e, i, k, sb) ==
    LET t == TableOf[k]
        g == GensAt(Pt(e, i))[t]
    IN (Bk(DataAt(Pt(e, i - 1))[k], t, g) \cup Bk(DataAt(Pt(e, i))[k], t, g)) \cap sb # {}

\* Table t since at position p: version of its latest rule change (0 if unchanged)
SinceAt(p, t) == Max({0} \cup {i \in 1..VerOf(p) : t \in LogAt(EraOf(p), i).rule})
\* Scan set: tables whose since advanced after f and up to h, evaluated at position p
S(p, f, h) == {t \in Tables : f < SinceAt(p, t) /\ SinceAt(p, t) <= h}

\* ---------------------------------------------------------------- Reader
ScanSet(pl, p) == S(p, pl.f, pl.h)
\* Whether scan item s is present at position p: all rows of tables in scan set; current rows in added buckets (for tables outside scan set)
Present(pl, p, s) ==
    IF s <= K THEN TableOf[KeyOrder[s]] \in ScanSet(pl, p)
    ELSE LET i == (s - 1) \div K
             k == KeyOrder[s - K * i]
         IN /\ BucketOrder[i] \in pl.N \ pl.o
            /\ TableOf[k] \notin ScanSet(pl, p)
            /\ BucketOrder[i] \in BucketsAt(p, k)
KeyOf(s) == KeyOrder[s - K * ((s - 1) \div K)]
\* First scan item for table t
FirstSlot(t) == CHOOSE j \in 1..K : TableOf[KeyOrder[j]] = t /\ \A i \in 1..(j - 1) : TableOf[KeyOrder[i]] # t
\* Remaining items to scan in this round
Rem(pl, p) == IF pl.at = Done THEN {} ELSE {s \in (pl.at + 1)..(Done - 1) : Present(pl, p, s)}
\* Emitted by scan: current values of rows visible to subscription among scanned items
ScanRows(pl, p, ss) ==
    LET vis == VisAt(p, pl.N)
        ks == {KeyOf(s) : s \in ss}
    IN [k \in {x \in ks : vis[x] # Absent} |-> vis[k]]
\* Tables to drop before scanning up to hi: tables in scan set whose first item falls in this range (the initial clear of a full pull replaces this for round 1)
Drops(pl, p, hi) == IF pl.f = -1 THEN {} ELSE {t \in ScanSet(pl, p) : pl.at < FirstSlot(t) /\ FirstSlot(t) <= hi}
\* Items skipped in tail: commits at or before since(t) for table t in scan set
Skip(pl, p, i, t) == t \in ScanSet(pl, p) /\ i <= SinceAt(p, t)
\* Rows in tail (from, upTo] touched before or after within subscription, emitting current value or absent
TailRows(pl, p, from, upTo) ==
    LET ks == UNION {{k \in LogAt(pl.e, i).keys : ~Skip(pl, p, i, TableOf[k]) /\ Touches(pl.e, i, k, pl.N)} : i \in Readable(pl.e, from, upTo)}
    IN [k \in ks |-> VisAt(p, pl.N)[k]]
\* When tailing to head, additional tables advance their since in (h, head]: opens next round (added buckets were already scanned in round 1)
More(pl, p) == S(p, pl.h, VerOf(p)) # {}
NextRound(pl, p) == [pl EXCEPT !.f = pl.h, !.h = VerOf(p), !.o = pl.N, !.at = 0, !.p = VerOf(p)]

\* Chunk part: drop tables in drop first, then write rows
Part(drop, rows) == [drop |-> drop, rows |-> rows]
Chunk(parts, final, p, N, next) ==
    [parts |-> parts, final |-> final, seen |-> p, sub |-> N, next |-> next]

\* Chunks computed at position p for plan pl; clear indicates a newly started plan beginning with a full pull (clearing all tables first). The final chunk exhausts remainder (if reaching head opens another round, that round is scanned in full too, with its drops placed after this round's tail); intermediate chunks (bounded by MaxChunks) cut after a scan item or after completing the scan and tailing up to a version (possibly 0 commits tailed)
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

\* Start a plan from device cookie c and landed subscription o, computed at position p under subscription N: full pull if cookie is missing, belongs to another incarnation, is below log floor (returns reset in the implementation, prompting the device to clear and full-pull from scratch), or subscription dropped buckets; watermark h takes any version between start (log floor for full pull) and p. The model evaluates against current log floor (cached copies computed before truncation had a lower floor in the implementation and could serve incremental pulls)
Start(req, p, N) ==
    LET e == EraOf(p)
        t == VerOf(p)
        full == req.c = NoCookie \/ EraOf(req.c) # e \/ VerOf(req.c) < LowOf(e) \/ ~(req.o \subseteq N)
    IN IF full THEN UNION {Chunks(req, Plan(e, -1, h, N, N, 0, h), p, TRUE) : h \in LowOf(e)..t}
       ELSE UNION {Chunks(req, Plan(e, VerOf(req.c), h, req.o, N, 0, VerOf(req.c)), p, FALSE) : h \in VerOf(req.c)..t}

\* Fresh response computed at position p under subscription N for request: restarts plan if resumed plan is from another incarnation or its subscription is not N; performs a full pull if any version in the plan falls below log floor (the implementation returns reset, causing device to clear and full-pull)
FreshAt(req, p, N) ==
    IF req.kind = "start" \/ req.plan.e # EraOf(p) \/ req.plan.N # N THEN Start(req, p, N)
    ELSE IF \E v \in {req.plan.h, req.plan.p} \cup (IF req.plan.f = -1 THEN {} ELSE {req.plan.f}) : v < LowOf(EraOf(p))
    THEN Start([req EXCEPT !.c = NoCookie], p, N)
    ELSE Chunks(req, req.plan, p, FALSE)

\* Earliest position at which request could be sent: requires all versions it carries (cookie, round watermark, tail-chased version) and floor
Since(req) ==
    IF req.kind = "start" THEN Max({Pt(1, 0), req.c, req.floor})
    ELSE Max({Pt(req.plan.e, req.plan.h), Pt(req.plan.e, req.plan.p), req.floor})

\* ---------------------------------------------------------------- Device
Apply(t, part) ==
    LET start == [k \in Keys |-> IF TableOf[k] \in part.drop THEN Absent ELSE t[k]]
    IN [k \in Keys |-> IF k \in DOMAIN part.rows THEN part.rows[k] ELSE start[k]]
RECURSIVE ApplyParts(_, _)
ApplyParts(t, ps) == IF ps = <<>> THEN t ELSE ApplyParts(Apply(t, Head(ps)), Tail(ps))
RECURSIVE ApplyAll(_, _)
ApplyAll(t, cs) == IF cs = <<>> THEN t ELSE ApplyAll(ApplyParts(t, Head(cs).parts), Tail(cs))
MaxSeen(cs) == Max({0} \cup {cs[i].seen : i \in 1..Len(cs)})

\* Incarnations only check equality (incarnation is a random nonce generated at space creation, without chronological ordering): position a is newer than b if b is absent, in a different incarnation, or has a higher version within the same incarnation
Newer(a, b) == b = NoCookie \/ EraOf(a) # EraOf(b) \/ VerOf(a) > VerOf(b)

\* Notice on connection: rows touched strictly after base up to v, present in sb before or after, emitted as visible to sb at v
OpsSince(base, v, sb) ==
    LET e == EraOf(v)
        ks == UNION {{k \in LogAt(e, i).keys : Touches(e, i, k, sb)} : i \in Readable(e, VerOf(base), VerOf(v))}
    IN [k \in ks |-> VisAt(v, sb)[k]]
RuleIn(e, from, upTo) == \E i \in (from + 1)..upTo : LogAt(e, i).rule # {}

\* Device needs to pull: no cookie, staged chunks present, lagging behind target position, or heard subscription on connection differs from landed
Behind == dCookie = NoCookie \/ dStage # <<>> \/ (dWant # NoCookie /\ Newer(dWant, dCookie)) \/ dHeard \notin {NoHeard, dSub}

Init ==
    /\ sEras = <<[base |-> Data0, gens |-> [t \in Tables |-> 1], log |-> <<>>, hist |-> <<>>, low |-> 0]>>
    /\ sub = Sub0
    /\ cPushed = Pt(1, 0) /\ cSub = Sub0 /\ chan = <<>> /\ dConn = FALSE
    /\ dTables = Empty /\ dCookie = NoCookie /\ dSub = {} /\ dHeard = NoHeard /\ dStale = FALSE /\ dStage = <<>>
    /\ dNext = Req("start", NoCookie, {}, NoPlan, 0) /\ dWant = NoCookie /\ dInflight = None /\ pSubs = {}
    /\ versions = 0 /\ ruleChanges = 0 /\ subChanges = 0 /\ rebuilds = 0 /\ chunks = 0 /\ faults = 0 /\ latePushes = 0 /\ truncs = 0

\* ---------------------------------------------------------------- Cloud
\* Record a commit: touched keys, tables whose since advanced in rule, resulting tables in data, and rule generations in gens
Commit(keys, data, gens, rule) ==
    /\ versions < MaxVersions
    /\ versions' = versions + 1
    /\ sEras' = [sEras EXCEPT ![Cur].log = Append(@, [keys |-> keys, rule |-> rule]),
                              ![Cur].hist = Append(@, [data |-> data, gens |-> gens])]

\* Backend write touching a row: update value (including changing bucket column, moving between buckets) or delete (c = 0)
Write(k, c) ==
    /\ Commit({k}, [DataAt(Now) EXCEPT ![k] = IF c = 0 THEN Absent ELSE [w |-> versions + 1, c |-> c]], GensAt(Now), {})
    /\ UNCHANGED <<sub, ruleChanges, subChanges, rebuilds, chunks, faults, latePushes, truncs>> /\ UNCHANGED conn /\ UNCHANGED device

\* Deployment changes bucket rules for table t: since advances to this version, recording a commit without keys, evaluated under new rules thereafter
RuleChange(t) ==
    /\ ruleChanges < MaxRuleChanges /\ GensAt(Now)[t] + 1 \in DOMAIN Rules[t]
    /\ ruleChanges' = ruleChanges + 1
    /\ Commit({}, DataAt(Now), [GensAt(Now) EXCEPT ![t] = @ + 1], {t})
    /\ UNCHANGED <<sub, subChanges, rebuilds, chunks, faults, latePushes, truncs>> /\ UNCHANGED conn /\ UNCHANGED device

\* Rebuild: new incarnation starts from version 0 (retaining existing data and rules), invalidating all cookies from earlier incarnations
Rebuild ==
    /\ rebuilds < MaxRebuilds
    /\ rebuilds' = rebuilds + 1
    /\ sEras' = Append(sEras, [base |-> DataAt(Now), gens |-> GensAt(Now), log |-> <<>>, hist |-> <<>>, low |-> 0])
    /\ UNCHANGED <<sub, versions, ruleChanges, subChanges, chunks, faults, latePushes, truncs>> /\ UNCHANGED conn /\ UNCHANGED device

\* Log truncation: commits at or before version l in this incarnation are deleted (keeping latest head), where truncated version l remains on current history
Truncate ==
    /\ truncs < MaxTruncs
    /\ truncs' = truncs + 1
    /\ \E l \in (LowOf(Cur) + 1)..(Latest - 1) : sEras' = [sEras EXCEPT ![Cur].low = l]
    /\ UNCHANGED <<sub, versions, ruleChanges, subChanges, rebuilds, chunks, faults, latePushes>> /\ UNCHANGED conn /\ UNCHANGED device

\* Subscription changes (token updated): existing connection continues pushing under previous subscription until replaced by a new connection (Expire); in-flight pull may also evaluate under the new subscription
SubChange ==
    /\ subChanges < MaxSubChanges
    /\ subChanges' = subChanges + 1
    /\ \E N \in Subs \ {sub} : sub' = N /\ pSubs' = IF dInflight = None THEN pSubs ELSE pSubs \cup {N}
    /\ UNCHANGED <<sEras, versions, ruleChanges, rebuilds, chunks, faults, latePushes, truncs>> /\ UNCHANGED conn
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, dInflight>>

\* ---------------------------------------------------------------- Connection
\* Shard pushes unseen position v to this connection: notice chained onto previously pushed position (same incarnation, no intermediate rule changes, previous position at or above log floor), or hint
Push(v) ==
    /\ dConn /\ v \in Points /\ v > cPushed
    /\ \E m \in {Hint(v, cSub)} \cup
               (IF EraOf(v) = EraOf(cPushed) /\ ~RuleIn(EraOf(v), VerOf(cPushed), VerOf(v)) /\ VerOf(cPushed) >= LowOf(EraOf(v))
                THEN {Notice(cPushed, v, OpsSince(cPushed, v, cSub), cSub)} ELSE {}) :
           chan' = Append(chan, m)
    /\ cPushed' = v
    /\ UNCHANGED <<cSub, dConn>> /\ UNCHANGED server /\ UNCHANGED device /\ UNCHANGED <<chunks, faults, latePushes>>

\* Updates relevant to connection subscription exist after pushed position: new incarnation, rule change, or touched row was in subscription before or after
Due ==
    \/ EraOf(cPushed) # Cur
    \/ \E i \in (VerOf(cPushed) + 1)..Latest : LogAt(Cur, i).rule # {} \/ \E k \in LogAt(Cur, i).keys : Touches(Cur, i, k, cSub)
PushDue == Due /\ Push(Now)

\* During a rebuild, in-flight fanout from the older incarnation arrives at shard after the new incarnation (order is not preserved across stubs). Incarnations are random nonces, so the shard cannot determine which is newer: receiving an incarnation differing from the previously pushed position is treated as a discontinuity, querying the latest head from the shared space, pushing its hint, and recording head rather than the older incarnation; pushing the late position's hint first is also valid (modeled here). This is expected behavior rather than a fault (not counted in faults); each sequence ends with pushing the latest head, bounded by MaxLatePushes only to constrain state space
LatePush ==
    /\ dConn /\ latePushes < MaxLatePushes
    /\ latePushes' = latePushes + 1
    /\ \E v \in Points : EraOf(v) < EraOf(cPushed) /\ chan' = chan \o <<Hint(v, cSub), Hint(Now, cSub)>>
    /\ cPushed' = Now
    /\ UNCHANGED <<cSub, dConn>> /\ UNCHANGED server /\ UNCHANGED device /\ UNCHANGED <<chunks, faults>>

\* Connect: the first message is version k queried by the shard (which may lag or belong to an older incarnation), private to this connection: sending an empty catch-up if matching the device cookie, or a hint otherwise;
\* it can also be a hint pushed prior to catch-up (in Fanout.tla, connections join the fanout list immediately on connect, receiving hints before catch-up completes), so k matching the device cookie may also send a hint.
\* Position j pushed before catch-up can belong to a different incarnation than queried k (late fanout from the older incarnation or a query response from before the rebuild): the shard treats this as a discontinuity, queries the shared space for its latest head,
\* pushes its hint, and records head (both stubs have arrived on requery, returning the current incarnation); counts toward late cross-incarnation pushes alongside LatePush
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

\* Connection disconnects: all in-flight messages are dropped
Disconnect ==
    /\ dConn /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ dConn' = FALSE /\ chan' = <<>>
    /\ UNCHANGED <<cPushed, cSub>> /\ UNCHANGED server /\ UNCHANGED device /\ UNCHANGED <<chunks, latePushes>>

\* Disconnect connection authenticated under expired token (not a fault): auth expires and shard closes it (during a round push, or when an alarm fires after a quiescent period), prompting the device to reconnect with a new token; calling
\* reconnect() achieves the same effect and can be invoked earlier. In-flight pulls may abort concurrently. Token expiration without changes behaves identically to Disconnect
Expire ==
    /\ dConn /\ cSub # sub
    /\ dConn' = FALSE /\ chan' = <<>>
    /\ \/ UNCHANGED <<dInflight, pSubs>>
       \/ dInflight' = None /\ pSubs' = {}
    /\ UNCHANGED <<cPushed, cSub>> /\ UNCHANGED server /\ UNCHANGED <<chunks, faults, latePushes>>
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant>>

\* Landed subscription from pull differs from heard on connection: device reconnects after landing
Renew ==
    /\ dConn /\ dStale /\ dInflight = None
    /\ dConn' = FALSE /\ chan' = <<>>
    /\ UNCHANGED <<cPushed, cSub>> /\ UNCHANGED server /\ UNCHANGED <<chunks, faults, latePushes>> /\ UNCHANGED device

\* Disconnected when caller calls reconnect(): aborts in-flight pulls sent under the previous token
Reconnect ==
    /\ ~dConn /\ dInflight # None /\ pSubs # {sub}
    /\ dInflight' = None /\ pSubs' = {}
    /\ UNCHANGED conn /\ UNCHANGED server /\ UNCHANGED <<chunks, faults, latePushes>>
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant>>

\* Device receives next message from connection, recording the connection's subscription
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

\* ---------------------------------------------------------------- Pull
\* Outgoing pull: when starting fresh without staged chunks, attaches target position as floor if newer than cookie (attached to first request after receiving a hint)
Outgoing == IF dNext.kind = "start" /\ dStage = <<>> /\ dWant # NoCookie /\ Newer(dWant, dCookie)
            THEN [dNext EXCEPT !.floor = dWant] ELSE dNext

\* Device initiates a pull when behind (even while connected); at most one pull is in flight at a time
PullStart ==
    /\ dInflight = None /\ Behind
    /\ dInflight' = Outgoing /\ dNext' = Outgoing /\ pSubs' = {sub}
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dWant>> /\ UNCHANGED conn /\ UNCHANGED server
    /\ UNCHANGED <<chunks, faults, latePushes>>

\* Proactive pull when not behind: previous connection disconnected before catch-up completed (slow network), pulling over HTTP prior to reconnecting
PullFirst ==
    /\ dInflight = None /\ ~dConn
    /\ dInflight' = Outgoing /\ dNext' = Outgoing /\ pSubs' = {sub}
    /\ UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dWant>> /\ UNCHANGED conn /\ UNCHANGED server
    /\ UNCHANGED <<chunks, faults, latePushes>>

\* Device receives a chunk: discards staged chunks if subscription or incarnation differs from staged chunks (plan restarted); final chunk lands atomically only if its seen is at or ahead of all staged chunks (within the same incarnation),
\* otherwise treated as intermediate chunk and resumed with seen as floor. If this request carried the target position as floor and the response returned from a different incarnation, drops target (results are at or ahead of
\* floor; that incarnation is stale), whether landing or not; requests without floor (target learned after sending) preserve target for the next request. If landed subscription differs from heard on connection
\* (connection opened under older token), clears heard and marks connection stale to reconnect after landing
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

\* Pull response arrives: subscription N is any subscription assigned by the token while the request was in flight (computed by cloud on receipt, evaluating group membership at that time); cache returns result evaluated at some past position p, or fresh if p is head (p is at or ahead of all versions in request:
\* a response cannot be computed before its request is sent, reflecting real time ordering); requests whose floor does not match the cloud's current incarnation are evaluated live without entering edge cache, so cache
\* contains only entries from that incarnation; responses mismatching current dNext (cursor mismatch) are dropped
PullDone(p, N) ==
    /\ dInflight # None
    /\ p \in Points /\ p >= Since(dInflight)
    /\ dInflight.floor = 0 \/ EraOf(dInflight.floor) = EraOf(p) \/ p = Now
    /\ IF dInflight = dNext THEN \E chunk \in FreshAt(dInflight, p, N) : Receive(chunk)
       ELSE UNCHANGED <<dTables, dCookie, dSub, dHeard, dStale, dStage, dNext, dWant, chunks>>
    /\ dInflight' = None /\ pSubs' = {}
    /\ UNCHANGED conn /\ UNCHANGED server /\ UNCHANGED <<faults, latePushes>>

PullFresh == PullDone(Now, sub)

\* Device restarts: connection closes, in-flight pull is abandoned, in-memory target position, heard subscription, stale connection flag, and request floor are cleared; local database tables, cookie, landed subscription, staged chunks, and resumption request are preserved
\* (floor for a fresh request without staged chunks is in-memory and lost; floor from a staged final chunk is determined by staged chunks and retained)
Crash ==
    /\ faults < MaxFaults
    /\ faults' = faults + 1
    /\ dConn' = FALSE /\ chan' = <<>> /\ dInflight' = None /\ pSubs' = {} /\ dWant' = NoCookie /\ dHeard' = NoHeard /\ dStale' = FALSE
    /\ dNext' = IF dNext.kind = "start" /\ dStage = <<>> THEN [dNext EXCEPT !.floor = 0] ELSE dNext
    /\ UNCHANGED <<cPushed, cSub, dTables, dCookie, dSub, dStage>> /\ UNCHANGED server /\ UNCHANGED <<chunks, latePushes>>

\* Pull fails (network error, timeout): abandons in-flight request to retry later
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

\* Shards push relevant versions, disconnects trigger reconnect, connections under expired tokens expire, connections with stale subscriptions are renewed, messages are delivered, lagging devices pull, and pulls complete
\* (regardless of whether reconnect() is invoked); cache expiration eventually triggers fresh evaluation: live pulls are strongly fair. Connect is strongly fair (following Private.tla): connection cannot open while a pull is in flight,
\* opening once the pull lands without starving connection attempts
Spec == Init /\ [][Next]_vars /\ WF_vars(PushDue) /\ SF_vars(Connect) /\ WF_vars(Expire) /\ WF_vars(Renew) /\ WF_vars(Deliver) /\ WF_vars(PullStart)
            /\ WF_vars(\E p \in Points, N \in pSubs : PullDone(p, N)) /\ SF_vars(PullFresh)

\* ---------------------------------------------------------------- Properties
\* S1: when no chunks are staged, device tables match rows visible to landed subscription at the device cookie (no missed deletes, no stale rows)
Consistent == dStage = <<>> /\ dCookie # NoCookie => dTables = VisAt(dCookie, dSub)

\* S2: after writes, subscriptions, bucket rules, and rebuilds quiesce, the device eventually catches up (no pending pulls), lands in the current incarnation, matches the current subscription, and reflects visible rows under that subscription
\* (shards may skip versions irrelevant to its subscription, so cookie can halt at an earlier version)
Converges == <>[](~Behind /\ EraOf(dCookie) = Cur /\ dSub = sub /\ dTables = VisAt(Now, sub))
================================================================================
