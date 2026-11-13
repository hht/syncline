-------------------------------- MODULE Private --------------------------------
(***************************************************************************)
(* Protocol model for Syncline private spaces.                             *)
(*                                                                         *)
(* Architecture follows Replicache's push/pull/poke pattern with one       *)
(* version per space. The cloud is a single Durable Object: each processed *)
(* write records a commit in the commit log (version, nonce, touched       *)
(* keys). Devices store synced tables, pending writes (each with undo      *)
(* info), and a cookie. On receiving cloud changes, the device reverts all *)
(* pending writes to the cookie version, applies changes, drops confirmed  *)
(* writes, and replays remaining pending writes.                           *)
(*                                                                         *)
(* Business mutators: inc(k) increments k, rejecting if exceeding MaxVal;  *)
(* del(k) deletes the row; both no-op if the row is absent. Results depend *)
(* on current values, so device predictions can diverge from cloud         *)
(* execution, exercising replay, rejection, and deletion.                  *)
(*                                                                         *)
(* Tables: NT tables with NR rows each; keys 1..NT*NR ordered by (table,   *)
(* primary key); T(k) maps a key to its table.                             *)
(* Network: consumed on arrival; message drops and duplicate deliveries    *)
(* have finite bounds, with arbitrary reordering. Lost connection messages *)
(* model disconnects (WebSocket over TCP does not drop individual frames). *)
(* Transport: on WebSocket connect, URL carries a cookie; cloud validates  *)
(* it and reads from the cookie (sharing the pull reader): if it fits, it  *)
(* sends a catch-up poke; otherwise sends a hint. HTTP pull: used before   *)
(* connecting (clean install, after reset) or on receiving a hint (catch-up*)
(* or poke too large; switches to HTTP without closing WebSocket); un-     *)
(* chainable pokes arriving while a pull is in flight are discarded        *)
(* without disconnecting.                                                  *)
(* Pull reader: position steps within a round by scanning then chasing the *)
(* tail. Scan set S(f, h) consists of tables that entered sync after round *)
(* start f and at or before watermark h (for a full pull f is empty,       *)
(* scanning all synced tables at h) in ascending key order, yielding       *)
(* current value or absent (clear then scan). The tail walks from round    *)
(* start to head, skipping entries for table t in S at or before since(t)  *)
(* (including deletions). If tables enter in (h, head] upon reaching head, *)
(* opens a next round. Pulls can yield chunks (staged locally without      *)
(* moving cookie) and resume via cursor (position and head seen when the   *)
(* chunk was computed), landing together on the final chunk. If position   *)
(* is off history, falls back to a full refetch from scratch.              *)
(* Mutation identity: (client, id) is immutable once generated. The client *)
(* table tracks each client's last mutation ID (lmid) and is never pruned. *)
(* Pushes carry the earliest pending mutation ID for each client; when     *)
(* greater than lmid + 1, cloud jumps lmid to just before it (jumping up   *)
(* only) atomically with that write.                                       *)
(* Commit log: upkeep truncates commits before the log floor, recording    *)
(* floor version and nonce; cookies below floor trigger a full pull.       *)
(* Faults: dropped, duplicated, and reordered messages; device crash and   *)
(* restart (new client ID); deploy disconnecting all connections;          *)
(* point-in-time recovery (rolling back storage and restarting DO without  *)
(* fencing; devices with off-history cookies refetch and keep pending      *)
(* writes); backup restore and cloning to another device; storage error on *)
(* push; corrupted local row (detected by checksum, repaired by range      *)
(* pull); manual resync (disconnects, full-pulls from scratch, preserves   *)
(* pending writes, reconnects after catching up).                          *)
(* Backend writes (imports, server writes): cloud executes a write locally,*)
(* recording a commit and poking devices just like device writes.          *)
(* Sync scope: scope table tracks whether each table is synced and its     *)
(* latest enter version (since). Entering sync (cloud-only table or        *)
(* returning table) updates since and records a keyless commit, with rows  *)
(* emitted by pull scans. Leaving sync records a drop commit; devices clear*)
(* all rows; while out of sync, cloud may modify rows directly without     *)
(* commits.                                                                *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
    Devices,       \* Set of devices
    NT,            \* Number of tables
    NR,            \* Number of rows per table
    MaxVal,        \* inc rejects if exceeding this value
    MaxMuts,       \* Maximum total mutations generated across all devices
    MaxDeletes,    \* Maximum deletions among mutations (including backend writes)
    MaxCrashes,    \* Maximum device crash and restart events
    MaxDeploys,    \* Maximum deploys
    MaxRestores,   \* Maximum point-in-time recoveries
    MaxBackups,    \* Maximum device backups (each overwriting the single backup slot)
    MaxDrops,      \* Maximum dropped network messages (unbounded drops preclude convergence)
    MaxDups,       \* Maximum duplicate message deliveries
    MaxBackendWrites, \* Maximum backend writes (server writes such as imports)
    MaxChunks,     \* Maximum pull chunks (staged on device, resumed with cursor)
    MaxStorageErrors, \* Maximum storage errors when processing pushes on cloud
    Later,         \* Cloud-only tables: enter sync after deploy
    Retiring,      \* Synced tables: leave sync after deploy
    MaxReturns,    \* Maximum re-entries for tables that left sync (0 means permanently dropped)
    MaxHints,      \* Maximum hints (oversized catch-up or poke): catch-up unreadable or switched to HTTP pull
    MaxTruncs,     \* Maximum log truncations by upkeep
    MaxCorrupts,   \* Maximum corrupted local rows
    MaxRefetches   \* Maximum manual resync requests

ASSUME MaxRestores \in {0, 1, 2}
ASSUME Later \cup Retiring \subseteq 1..NT /\ Later \cap Retiring = {}
\* Row corruption and backup are not checked together (backup rollback of corrupted rows is not modeled)
ASSUME MaxCorrupts = 0 \/ MaxBackups = 0

Tables == 1..NT
Keys == 1..(NT * NR)
T(k) == ((k - 1) \div NR) + 1
KeysOf(ts) == {k \in Keys : T(k) \in ts}

CNil == [nil |-> TRUE]     \* Cookie after reset before any pull
NoConn == 0               \* Disconnected (connection IDs start at 1)
Backend == 0              \* Commits for backend writes and scope changes (client IDs start at 1)
NoSnap == [none |-> TRUE]  \* Empty backup slot
NoStage == [none |-> TRUE] \* No staged chunks
Absent == -1              \* Row does not exist
Init0 == [k \in Keys |-> 0]                                     \* Initial cloud table (includes rows in cloud-only tables)
In0 == [t \in Tables |-> t \notin Later]                         \* Tables initially in sync
Since0 == [t \in Tables |-> 0]                                   \* Initial since versions
DevInit == [k \in Keys |-> IF T(k) \in Later THEN Absent ELSE 0]  \* Freshly installed device: lacks cloud-only tables
Head0 == [v |-> 0, n |-> 0]          \* Cookie for empty database: version 0, nonce 0
NoKey == 1                          \* Scope commits are not writes; key and op are ignored
NoUid == 0                          \* Non-client commits have no mutation UID (client writes numbered from 1)
Merge(a, b) == [k \in DOMAIN a \cup DOMAIN b |-> IF k \in DOMAIN b THEN b[k] ELSE a[k]]
SetMax(S) == CHOOSE x \in S : \A y \in S : y <= x
SetMin(S) == CHOOSE x \in S : \A y \in S : x <= y
SyncedOf(in) == KeysOf({t \in Tables : in[t]})

\* Mutators: inc(k), del(k); no-op when row is absent (patch and del in rows.ts). w: row actually modified (RETURNING rows recorded in commit)
Run(t, k, op) ==
    IF t[k] = Absent THEN [ok |-> TRUE, w |-> FALSE, t |-> t]
    ELSE IF op = "del" THEN [ok |-> TRUE, w |-> TRUE, t |-> [t EXCEPT ![k] = Absent]]
    ELSE IF t[k] + 1 > MaxVal THEN [ok |-> FALSE, w |-> FALSE, t |-> t]
    ELSE [ok |-> TRUE, w |-> TRUE, t |-> [t EXCEPT ![k] = @ + 1]]

\* Cloud executes a client write: rejects writes modifying non-synced tables (fails every execution, held)
Exec(t, syn, k, op) == IF k \in syn THEN Run(t, k, op) ELSE [ok |-> FALSE, w |-> FALSE, t |-> t]

VARIABLES
    sData,        \* Cloud tables
    sCommits,     \* Commit log, where index i is version i (truncated commits kept as ghost variables; readers access only commits after log floor)
    sHist,        \* Ghost: sHist[i] = cloud tables after version i (used on restore)
    sLow,         \* Log floor: commits at or before this version are truncated, recording version and nonce
    sLowHist,     \* Ghost: sLowHist[i] = log floor when version i was committed (used on restore)
    sIn, sSince,  \* Scope table: whether each table is synced and its latest enter version
    sConns,       \* Active connection IDs tracked by cloud
    nonceOf,      \* Ghost: nonce -> cloud tables and expected device rows at that version (preserved across timelines for invariants)
    nextNonce,    \* Models unique nonces across commits
    gapSeen,      \* Ghost: mutation ID gap observed in push (used by P3)
    dTables,      \* Device tables
    dCookie,      \* Device cookie; CNil indicates post-reset state before first pull
    dPending,     \* Device pending writes: <<[client, mid, key, op, undo, uid]>>; uid is ghost global ID nextUid assigned at commit (P8k, P8r, P11)
    dClient,      \* Client ID for device's current session
    dNextMid,     \* Next mutation ID for current session
    dConn,        \* Device current connection ID; NoConn means disconnected
    dWant,        \* Target version to catch up to (wanted): unchainable poke discarded, or hint received; pulls if newer than cookie; reset to 0 on new connection or restart
    dStaged,      \* Device staged pull chunk: resume position (pos), head seen when computed (seen), and accumulated rows (rows); NoStage if none
    dBad,         \* Ghost: local keys corrupted and not yet refetched
    dRefetch,     \* Flag indicating device needs full refetch (manual resync; persisted in cookie row): pull requests full refetch; cleared when cookie advances (landed);
                  \* survives restarts. Local schema upgrades and failed reverts also set this flag (keeping connection open); not modeled here
    net,          \* In-flight messages: subject to drop, duplicate delivery, and reordering
    nextClient, nextConn,
    muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
    bSnap,        \* Single device backup slot
    nextUid,      \* Ghost: ID for next device write (ghost checks only: one per write)
    rolled,       \* Ghost: writes rolled back by PITR (uids truncated from commit log); only these may be lost (P8k)
    forbidden,    \* Ghost: rolled-back writes not retained in pending writes of any device or backup at restore time: forbidden from commit log (P8r)
    lostByBackup  \* Ghost: pending writes lost when restoring device from backup (written after backup)

\* Cloud-persisted state (modified by push, backend write, scope change, restore, truncation)
logVars == <<sData, sCommits, sHist, sLow, sLowHist, sIn, sSince, nonceOf, nextNonce, gapSeen>>
devVars == <<dTables, dCookie, dPending, dClient, dNextMid, nextClient, dWant, dStaged, dBad, dRefetch>>
counters == <<muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts,
             refetches>>
\* Unchanged counter values during message reception (duplicate deliveries tracked in Take)
fixed == <<muts, dels, crashes, deploys, restores, backups, drops, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches>>
ghostVars == <<nextUid, rolled, forbidden, lostByBackup>>
vars == <<logVars, sConns, devVars, dConn, net, nextConn, counters, bSnap, ghostVars>>

\* Keys belonging to synced tables
sSynced == SyncedOf(sIn)

\* ---------------------------------------------------------------- Cloud operators
\* Available mutators: del has an upper bound
Ops == IF dels < MaxDeletes THEN {"inc", "del"} ELSE {"inc"}

HeadOf(cs) == IF cs = <<>> THEN Head0 ELSE [v |-> Len(cs), n |-> cs[Len(cs)].nonce]
HistAt(h, i) == IF i = 0 THEN Init0 ELSE h[i]

\* Client table: tracks last mutation ID processed for client, never pruned. Jumps happen atomically
\* with the client's next write just before it, so lmid is always its latest committed mutation ID (truncated commits count: client table survives truncation)
Lmid(cs, c) == SetMax({0} \cup {cs[i].mid : i \in {i \in 1..Len(cs) : cs[i].client = c}})
\* Final chunk provides lmids for processed clients (pull requests list pending clients; results are equivalent)
AllLmids(cs) == [c \in {cs[i].client : i \in 1..Len(cs)} |-> Lmid(cs, c)]
\* Poke provides lmids for clients with commits after version from
LmidsSince(cs, from) == [c \in {cs[i].client : i \in (from + 1)..Len(cs)} |-> Lmid(cs, c)]

\* Checks if cookie is on current history: at or above log floor (matching floor nonce if equal), not past head, with matching nonce (onHistory in commits.ts)
OnHist(c) == /\ c # CNil
             /\ c.v >= sLow.v /\ c.v <= Len(sCommits)
             /\ IF c.v = sLow.v THEN c.n = sLow.n ELSE sCommits[c.v].nonce = c.n
\* Cookie for a version on current history
At(v) == IF v = sLow.v THEN sLow ELSE [v |-> v, n |-> sCommits[v].nonce]
\* All cookies on current history (formulated independently of OnHist for property P8a)
HistCookies == {sLow} \cup {[v |-> i, n |-> sCommits[i].nonce] : i \in (sLow.v + 1)..Len(sCommits)}

\* Commit log entry: touched keys, dropped tables drop. syn, in, since, key, op, uid are ghost:
\* synced tables (expected device rows) and scope table at commit time (used on restore), client write itself (P2, P8k, P8r, P11)
Entry(nonce, client, mid, key, op, keys, uid) ==
    [nonce |-> nonce, client |-> client, mid |-> mid, key |-> key, op |-> op, keys |-> keys, drop |-> {},
     uid |-> uid, syn |-> sSynced, in |-> sIn, since |-> sSince]
\* Commit for scope change (client is Backend, keyless): dropped tables drop, updated scope table
Rescoped(cs, drop, in, since) ==
    [Entry(nextNonce, Backend, Lmid(cs, Backend) + 1, NoKey, "none", {}, NoUid)
        EXCEPT !.drop = drop, !.syn = SyncedOf(in), !.in = in, !.since = since]

\* Poke; onHist is ghost, allowing P8a to check incremental pokes are sent only to cookies on current history
Poke(d, conn, base, cookie, lm, patch) ==
    [type |-> "poke", to |-> d, conn |-> conn, base |-> base, cookie |-> cookie, lmids |-> lm,
     patch |-> patch, onHist |-> base \in HistCookies]

\* Processes batch of mutations sequentially: skips duplicates; processes mutations sequentially following lmid;
\* jumps lmid then processes if id > lmid + 1 and mutation is first pending on client (PITR rolled back earlier confirmed writes);
\* skips future mutations with gaps (records gapSeen). Rejections also advance mutation ID
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

\* ---------------------------------------------------------------- Reader
\* Position: full (starts with full pull), f (round start, CNil for first round of full pull), h (watermark), at (scan key),
\* p (tail commit version), rng (requested range keys), heal (ghost: corrupted rows repaired on land)
From(pos) == IF pos.f = CNil THEN -1 ELSE pos.f.v
\* Scan set: tables that entered sync after f and at or before h, and remain synced
S(f, h) == {t \in Tables : sIn[t] /\ f < sSince[t] /\ sSince[t] <= h}
\* Keys remaining to scan this round: keys of tables in scan set plus range keys requested by device
Rem(pos) == {k \in KeysOf(S(From(pos), pos.h.v)) \cup pos.rng : k > pos.at}
\* Emitted by scan: current value for each key, Absent if not synced
ScanRows(K) == [k \in K |-> IF k \in sSynced THEN sData[k] ELSE Absent]
\* Commits can be read only after log floor (earlier commits truncated)
Readable(from, upTo) == {i \in (from + 1)..upTo : i > sLow.v}
\* Tail items skipped: table t in scan set at or before since(t) (scan already yielded current values)
Skip(i, t, pos) == t \in S(From(pos), pos.h.v) /\ i <= sSince[t]
\* Changes in tail (from, upTo]: current value for touched synced rows, Absent for dropped tables, excluding skipped items
TailRows(from, upTo, pos) ==
    LET is == Readable(from, upTo)
        changed == UNION {{k \in sCommits[i].keys : ~Skip(i, T(k), pos)} : i \in is} \cap sSynced
        dropped == KeysOf(UNION {{t \in sCommits[i].drop : ~Skip(i, t, pos)} : i \in is})
    IN [k \in changed \cup dropped |-> IF k \in changed THEN sData[k] ELSE Absent]
\* If tables entered sync in (h, head] upon reaching head, open next round
More(pos) == S(pos.h.v, Len(sCommits)) # {}
NextRound(pos) == [pos EXCEPT !.f = pos.h, !.h = HeadOf(sCommits), !.at = 0, !.p = HeadOf(sCommits), !.rng = {}]
\* Reads remaining rows: scans remaining keys in current round, tail catches up to head; if next round is needed upon reaching head, completes its scan (tail already at head)
FinalRows(pos) ==
    LET r1 == Merge(ScanRows(Rem(pos)), TailRows(pos.p.v, Len(sCommits), pos))
    IN IF More(pos) THEN Merge(r1, ScanRows(Rem(NextRound(pos)))) ELSE r1
\* Initial position: full pull scans all synced tables at head; incremental starts from cookie, adding requested range keys to scan set
StartPos(cookie, rng, full) ==
    [full |-> full, f |-> IF full THEN CNil ELSE cookie, h |-> HeadOf(sCommits), at |-> 0,
     p |-> IF full THEN HeadOf(sCommits) ELSE cookie, rng |-> IF full THEN {} ELSE rng,
     heal |-> IF full THEN Keys ELSE rng]
\* Validates cursor returned by device: head seen when computed, position versions, and incremental cookie must be on current history
Valid(m) ==
    LET pos == m.cursor.pos
    IN /\ OnHist(m.cursor.seen) /\ OnHist(pos.h) /\ OnHist(pos.p)
       /\ (pos.f # CNil => OnHist(pos.f))
       /\ (~pos.full => OnHist(m.cookie))

\* ---------------------------------------------------------------- Device operators
\* Reverts one pending write
Undo(t, p) == IF p.undo = <<>> THEN t ELSE [t EXCEPT ![p.undo[1]] = p.undo[2]]
RECURSIVE Rewind(_, _)
Rewind(t, ps) == IF ps = <<>> THEN t ELSE Rewind(Undo(t, ps[Len(ps)]), SubSeq(ps, 1, Len(ps) - 1))

\* Replays pending writes: re-executes and re-records undo info; empty undo if local prediction fails, uploaded regardless
RECURSIVE Replay(_, _)
Replay(t, ps) ==
    IF ps = <<>> THEN [t |-> t, ps |-> <<>>]
    ELSE LET p == Head(ps)
             r == Run(t, p.key, p.op)
             p2 == [p EXCEPT !.undo = IF r.ok THEN <<p.key, t[p.key]>> ELSE <<>>]
             rest == Replay(r.t, Tail(ps))
         IN [t |-> rest.t, ps |-> <<p2>> \o rest.ps]

LmidIn(lm, c) == IF c \in DOMAIN lm THEN lm[c] ELSE 0

\* Applies cloud changes (shared by pokes and pull responses) in a single local transaction: reverts pending writes, applies rows (unmentioned keys Absent on full pull), drops confirmed writes, and replays remaining pending writes (preserving mutation IDs)
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

\* Consumes a message and enqueues new messages; duplicate delivery leaves original message in network
Take(m, new) ==
    \/ /\ net' = (net \ {m}) \cup new
       /\ UNCHANGED dups
    \/ /\ dups < MaxDups
       /\ dups' = dups + 1
       /\ net' = net \cup new

\* Close message sent to devices when cloud closes connections: sequenced behind messages already sent on connection; device detects disconnect on receipt (earlier pokes still delivered)
Closing(conns) == {[type |-> "close", to |-> d, conn |-> dConn[d]] : d \in {e \in Devices : dConn[e] \in conns}}

\* Drops all connections (deploy, DO restart): cloud forgets them; each device receives a close message
DropAll ==
    /\ sConns' = {}
    /\ net' = net \cup Closing(sConns)

\* ---------------------------------------------------------------- Initial state
Init ==
    /\ sData = Init0 /\ sCommits = <<>> /\ sHist = <<>> /\ sLow = Head0 /\ sLowHist = <<>>
    /\ sIn = In0 /\ sSince = Since0
    /\ sConns = {}
    /\ nonceOf = [n \in {0} |-> [t |-> Init0, vis |-> SyncedOf(In0)]] /\ nextNonce = 1
    /\ gapSeen = FALSE
    /\ dTables = [d \in Devices |-> DevInit]
    /\ dCookie = [d \in Devices |-> CNil]     \* Fresh install: starts with full pull
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

\* ---------------------------------------------------------------- Device actions
\* Local write: does not wait for network. No write produced if local prediction fails (exceeds MaxVal). Device code mirrors cloud, writing only synced tables
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

\* Cursor sent on pull: position and head seen when computed
CursorOf(s) == IF s = NoStage THEN NoStage ELSE [pos |-> s.pos, seen |-> s.seen]

\* Pull in flight (request or response): suppresses WebSocket connection and further pull requests
PullInFlight(d) ==
    \E m \in net : \/ m.type = "pullreq" /\ m.from = d
                   \/ m.type \in {"pullresp", "chunk"} /\ m.to = d

\* Opens WebSocket, URL carrying cookie: cookie must be on current history (off-history closed with 4000; device full-pulls before reconnecting, modeled as connection failure allowing only pull).
\* Reads from cookie on connect: if within budget, sends catch-up poke (empty poke if already at head; includes scan if tables entered sync);
\* if exceeding single-request budget, sends hint, prompting device to pull over HTTP while keeping WebSocket open; subsequent pokes queue behind it
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

\* Pushes all pending writes, carrying earliest pending mutation ID for each client (first)
PushMsg(d) ==
    LET ps == dPending[d]
    IN [type |-> "push", from |-> d, conn |-> dConn[d],
        muts |-> [i \in 1..Len(ps) |-> [client |-> ps[i].client, mid |-> ps[i].mid, key |-> ps[i].key, op |-> ps[i].op, uid |-> ps[i].uid]],
        first |-> [c \in {ps[i].client : i \in 1..Len(ps)} |-> SetMin({ps[i].mid : i \in {j \in 1..Len(ps) : ps[j].client = c}})]]

\* Push (sent only over active connection; suppressed if identical push is already in flight)
Push(d) ==
    /\ dConn[d] # NoConn /\ dPending[d] # <<>>
    /\ PushMsg(d) \notin net
    /\ net' = net \cup {PushMsg(d)}
    /\ UNCHANGED <<logVars, sConns, devVars, dConn, nextConn, counters, bSnap, ghostVars>>

\* Range keys requested by device (after checksum mismatch): contiguous range by (table, primary key), potentially spanning multiple tables
\* (tail of first table, full intermediate tables, head of last table; partial ranges expand to full tables); last range may include full non-synced tables
\* (detecting leftover rows on device); together contains at least one corrupted row, combined into one pull request; allowed only without staged chunks (staged pulls resume without ranges).
\* Pending writes are allowed: range pull returns current head values; land reverts and replays pending writes as usual (empty pending queue is a prerequisite for checksum comparison, which is outside the model)
Ranges(d) ==
    IF dStaged[d] = NoStage /\ dBad[d] # {}
    THEN {r \in {seg \cup rest : seg \in {{k \in Keys : a <= k /\ k <= b} : a, b \in Keys},
                                rest \in {{}, KeysOf({t \in Tables : ~sIn[t]})}} : r \cap dBad[d] # {}}
    ELSE {}

\* HTTP pull: disconnected (clean install, after reset), or connected but behind target version (Wanting), or receiving hint that catch-up or poke is oversized
\* (switches to HTTP while keeping connection open; hints may arrive anytime without explicit message, bounded by MaxHints), or requesting range pull; at most one in flight at a time.
\* Resumes with cursor when chunks are staged
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

\* Receives poke: matches active connection, base equals device cookie, and no staged chunks (cookie does not advance mid-chunk, so pokes chaining onto cookie are not applied)
RecvPokeOf(d, m) ==
    /\ m.type = "poke" /\ m.to = d /\ m.conn = dConn[d] /\ m.base = dCookie[d] /\ dStaged[d] = NoStage
    /\ ApplyPatch(d, m.cookie, m.lmids, m.patch, FALSE)
    /\ dRefetch' = [dRefetch EXCEPT ![d] = FALSE]
    /\ Take(m, {})
    /\ UNCHANGED <<logVars, sConns, dClient, dNextMid, nextClient, dWant, dStaged, dBad, dConn, nextConn, fixed, bSnap, ghostVars>>
RecvPoke(d) == \E m \in net : RecvPokeOf(d, m)

\* Landed or staged values: fresh chunk for reset or when no staged chunks exist; accumulated onto staged rows otherwise
Landed(d, m) == IF m.reset \/ dStaged[d] = NoStage THEN m.rows ELSE Merge(dStaged[d].rows, m.rows)

\* Receives pull response: base must match device cookie, cursor must match staged position; final chunk lands with staged chunks, clears staging, and repairs requested corrupted rows
RecvPullOf(d, m) ==
    /\ m.type = "pullresp" /\ m.to = d /\ m.base = dCookie[d] /\ m.cursor = CursorOf(dStaged[d])
    /\ ApplyPatch(d, m.cookie, m.lmids, Landed(d, m), m.full)
    /\ dStaged' = [dStaged EXCEPT ![d] = NoStage]
    /\ dBad' = [dBad EXCEPT ![d] = @ \ m.heal]
    /\ dRefetch' = [dRefetch EXCEPT ![d] = FALSE]
    /\ Take(m, {})
    /\ UNCHANGED <<logVars, sConns, dClient, dNextMid, nextClient, dWant, dConn, nextConn, fixed, bSnap, ghostVars>>
RecvPull(d) == \E m \in net : RecvPullOf(d, m)

\* Receives intermediate chunk: stages rows without advancing cookie, records resume position; cursor must match staged position
RecvChunkOf(d, m) ==
    /\ m.type = "chunk" /\ m.to = d /\ m.base = dCookie[d] /\ m.cursor = CursorOf(dStaged[d])
    /\ dStaged' = [dStaged EXCEPT ![d] = [pos |-> m.pos, seen |-> m.seen, rows |-> Landed(d, m)]]
    /\ Take(m, {})
    /\ UNCHANGED <<logVars, sConns, dTables, dCookie, dPending, dClient, dNextMid, nextClient, dWant, dBad, dRefetch, dConn, nextConn,
                   fixed, bSnap, ghostVars>>
RecvChunk(d) == \E m \in net : RecvChunkOf(d, m)

\* Stale messages addressed to device (pokes, hints, and closes on old connections; pull responses with mismatched base or cursor): discarded.
\* Poke on active connection that cannot chain onto device cookie or arrives while chunks are staged: pull is in flight or mid-stream
\* (switched to HTTP while connected) and target version is not yet reached; discarded and records target version to catch up to
\* (resumes pull if cookie remains behind after pull completes); discarded if pull already advanced device past this version;
\* otherwise indicates reordered messages on connection, prompting disconnect and reconnect with catch-up
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

\* Device receives hint on active connection (oversized catch-up on connect; storage error during push leaving commits without pokes):
\* records target version to catch up to, pulling over HTTP while keeping connection open
RecvHintOf(d, m) ==
    /\ m.type = "hint" /\ m.to = d /\ m.conn = dConn[d]
    /\ dWant' = [dWant EXCEPT ![d] = IF m.cookie.v > @ THEN m.cookie.v ELSE @]
    /\ net' = net \ {m}
    /\ UNCHANGED <<logVars, sConns, dTables, dCookie, dPending, dClient, dNextMid, nextClient, dStaged, dBad, dRefetch, dConn, nextConn,
                   counters, bSnap, ghostVars>>
RecvHint(d) == \E m \in net : RecvHintOf(d, m)

\* Device receives close on active connection (closed by cloud): all earlier sent messages have been received; device transitions to disconnected
RecvClose(d) ==
    \E m \in net :
       /\ m.type = "close" /\ m.to = d /\ m.conn = dConn[d]
       /\ dConn' = [dConn EXCEPT ![d] = NoConn]
       /\ net' = net \ {m}
       /\ UNCHANGED <<logVars, sConns, devVars, nextConn, counters, bSnap, ghostVars>>

\* Device crash and restart: memory lost, disconnected, new client ID; persisted database intact
Crash(d) ==
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ dConn' = [dConn EXCEPT ![d] = NoConn]
    /\ dWant' = [dWant EXCEPT ![d] = 0]
    /\ NewSession(d)
    /\ UNCHANGED <<logVars, sConns, dTables, dCookie, dPending, dStaged, dBad, dRefetch, net, nextConn,
                   muts, dels, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* System backup (snapshots persistent database contents only)
Backup(d) ==
    /\ backups < MaxBackups
    /\ backups' = backups + 1
    /\ bSnap' = [t |-> dTables[d], c |-> dCookie[d], p |-> dPending[d], s |-> dStaged[d], f |-> dRefetch[d]]
    /\ UNCHANGED <<logVars, sConns, devVars, dConn, net, nextConn,
                   muts, dels, crashes, deploys, restores, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   ghostVars>>

\* Restore from backup (may restore onto another device, modeling cloning); behaves as a restart post-restore
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
    \* Writes created after backup and not yet uploaded revert with database to past state
    /\ lostByBackup' = lostByBackup \cup ({dPending[d][i].uid : i \in 1..Len(dPending[d])} \ {bSnap.p[i].uid : i \in 1..Len(bSnap.p)})
    /\ UNCHANGED <<logVars, sConns, dBad, net, nextConn, counters, nextUid, rolled, forbidden>>

\* Local row corrupted (outside model: disk corruption, non-Syncline writes); detected by checksum, repaired by range pull
Corrupt(d, k) ==
    /\ corrupts < MaxCorrupts /\ k \in sSynced
    /\ corrupts' = corrupts + 1
    /\ \E v \in ({Absent} \cup 0..MaxVal) \ {dTables[d][k]} : dTables' = [dTables EXCEPT ![d][k] = v]
    /\ dBad' = [dBad EXCEPT ![d] = @ \cup {k}]
    /\ UNCHANGED <<logVars, sConns, dCookie, dPending, dClient, dNextMid, nextClient, dWant, dStaged, dRefetch, dConn, net, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, refetches,
                   bSnap, ghostVars>>

\* Manual resync (preserves pending writes): disconnects, drops staged chunks and target version, flags full refetch (persisted, survives restart);
\* suppresses reconnect until caught up to head (landed, cookie updated); replays and pushes pending writes on land as usual
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

\* ---------------------------------------------------------------- Cloud actions
\* Records Process results (commits and ghost variables)
Record(r) ==
    /\ sData' = r.data /\ sCommits' = r.cs /\ sHist' = r.hist /\ nextNonce' = r.nonce
    /\ sLowHist' = sLowHist \o [i \in 1..(Len(r.cs) - Len(sCommits)) |-> sLow]
    /\ nonceOf' = nonceOf @@ [n \in {r.cs[i].nonce : i \in (Len(sCommits) + 1)..Len(r.cs)} |->
                     LET i == CHOOSE i \in (Len(sCommits) + 1)..Len(r.cs) : r.cs[i].nonce = n
                     IN [t |-> r.hist[i], vis |-> r.cs[i].syn]]
    /\ gapSeen' = (gapSeen \/ r.gap)

\* Processes ms (all or prefix) from push batch m, commits, and notifies online devices; partial requires at least one executed write to ensure progress
Handled(m, ms, partial) ==
    LET r == Process(sData, sCommits, sHist, nextNonce, FALSE, ms, m.first)
        base == HeadOf(sCommits)
        patch == [k \in UNION {r.cs[i].keys : i \in (Len(sCommits) + 1)..Len(r.cs)} |-> r.data[k]]
    IN /\ partial => Len(r.cs) > Len(sCommits)
       /\ Record(r)
       \* Output gate: pokes are sent only after commits are persisted, appearing in the same step
       /\ Take(m, IF Len(r.cs) = Len(sCommits) THEN {}
                  ELSE {Poke(d, dConn[d], base, HeadOf(r.cs), LmidsSince(r.cs, Len(sCommits)), patch)
                        : d \in {e \in Devices : dConn[e] \in sConns}})
       /\ UNCHANGED <<sConns, errs>>

\* Processes push batch; pushes on old connections discarded (including pre-PITR pushes); duplicates producing no new commits omit pokes (partitioned by device for per-device fairness).
\* Storage error (disk full, IO error, unrelated to write validity): retains first n committed writes; uncommitted writes not processed without advancing mutation ID;
\* n = all models error building poke. Closes pusher connection (reconnects with catch-up and repushes); sends hints to other connected devices if commits were recorded without pokes, prompting HTTP pull
HandlePushOf(src, m) ==
    /\ m.type = "push" /\ m.from = src
    /\ IF m.conn \notin sConns
       THEN /\ net' = net \ {m}
            /\ UNCHANGED <<sData, sCommits, sHist, sLowHist, nonceOf, nextNonce, gapSeen, sConns, dups, errs>>
       ELSE \/ Handled(m, m.muts, FALSE)
            \* Batch workload budget exceeded (writeRows in the protocol limits, accumulated row changes): processes prefix, stopping after executed write, pokes as usual without disconnect;
            \* device pushes remaining writes after confirmation (Push enabled anytime in model)
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

\* Handles pull: without cursor opens new position (full pull if cookie is off current history); with cursor validates it (Valid), falling back to full pull if invalid.
\* Emits final chunk (reads remaining rows, echoes cursor for device staging validation) or intermediate chunk (bounded by MaxChunks, sliced at arbitrary budget point):
\* within scan phase up to a key, or finishing current scan and walking tail up to a version (possibly 0 commits: chunk split mid-commit in implementation);
\* advances to next round position if needed upon reaching head.
\* reset: full refetch replacing device staged chunks; ghost onHist allows P8a to check tail start and incremental cookie are on current history
HandlePullOf(src, m) ==
    /\ m.type = "pullreq" /\ m.from = src
    /\ LET fresh == m.cursor = NoStage \/ ~Valid(m)
           \* Unrecognized cursor, or missing cursor with off-history cookie or full refetch requested: full pull
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

\* Deploy: disconnects all connections
Deploy ==
    /\ deploys < MaxDeploys
    /\ deploys' = deploys + 1
    /\ DropAll
    /\ UNCHANGED <<logVars, devVars, dConn, nextConn,
                   muts, dels, crashes, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* Records commit e with resulting cloud table data: updates commits, ghost history, and nonce
RecordEntry(e, data) ==
    /\ sCommits' = Append(sCommits, e) /\ sHist' = Append(sHist, data)
    /\ sLowHist' = Append(sLowHist, sLow)
    /\ nonceOf' = nonceOf @@ [n \in {e.nonce} |-> [t |-> data, vis |-> e.syn]]
    /\ nextNonce' = nextNonce + 1

\* Deploys code bringing a table into sync (cloud-only table enters sync, or returning table re-enters): sets since to next version and records keyless commit;
\* restarts DO (disconnects all connections). Model checking restricts enters to Later and Retiring
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

\* Deploys code removing table from sync (dropped or rolled back): records drop commit for table; restarts DO (disconnects all connections).
\* Cloud stops recording or broadcasting table; pushed writes modifying it are rejected. Model checking restricts leaves to Retiring; trace validation (TracePrivate.tla) also allows entered Later tables to leave
Leave(t) ==
    /\ sIn[t]
    /\ sIn' = [sIn EXCEPT ![t] = FALSE]
    /\ RecordEntry(Rescoped(sCommits, {t}, sIn', sSince), sData)
    /\ DropAll
    /\ UNCHANGED <<sData, sLow, sSince, gapSeen, devVars, dConn, nextConn, counters, bSnap, ghostVars>>

\* Writes still retained in pending writes of any device (or backup slot): among writes rolled back by PITR, only these will be replayed and pushed again by devices
PendingAnywhere ==
    UNION {{dPending[d][i].uid : i \in 1..Len(dPending[d])} : d \in Devices}
    \cup (IF bSnap = NoSnap THEN {} ELSE {bSnap.p[i].uid : i \in 1..Len(bSnap.p)})

\* Log floor at some point during the interval of version k: log truncations may have occurred during that interval; picks any version between the floor at interval start and end (start of next interval)
LowsIn(k) ==
    LET from == IF k = 0 THEN 0 ELSE sLowHist[k].v
    IN {IF v = 0 THEN Head0 ELSE [v |-> v, n |-> sCommits[v].nonce] : v \in from..sLowHist[k + 1].v}

\* Point-in-time recovery to some point during interval of version k: tables, commits, scope table, log floor (LowsIn), and client table roll back together; restarts DO and drops all connections without fencing.
\* Compares scope against current code on restart: tables newly present get since set to next version; tables removed record a drop commit.
\* Ghost: rolled-back writes recorded in rolled; writes among them not retained in pending writes on any device at restore time recorded in forbidden (no revival)
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

\* Log truncation by upkeep: advances log floor to v (head commit never deleted), recording nonce of v
Truncate ==
    /\ truncs < MaxTruncs
    /\ truncs' = truncs + 1
    /\ \E v \in (sLow.v + 1)..(Len(sCommits) - 1) : sLow' = At(v)
    /\ UNCHANGED <<sData, sCommits, sHist, sLowHist, sIn, sSince, nonceOf, nextNonce, gapSeen, sConns, devVars, dConn, net, nextConn,
                   muts, dels, crashes, deploys, restores, backups, drops, dups, bwrites, errs, returns, hints, chunks, corrupts, refetches,
                   bSnap, ghostVars>>

\* Backend write (server writes such as imports): executes inc(k) or del(k) on cloud, recording a commit (client is Backend) like device writes,
\* poking all connected devices. If value exceeds cap, leaves row unchanged and still records a commit in model; implementation omits commit and poke if no synced rows changed (#commit in space.ts),
\* resulting in identical data with one fewer version.
\* Modifying cloud tables directly without a commit would hide changes from devices already at head
BackendWrite(k, op) ==
    /\ bwrites < MaxBackendWrites /\ k \in sSynced
    /\ bwrites' = bwrites + 1
    /\ dels' = IF op = "del" THEN dels + 1 ELSE dels
    /\ sData' = Run(sData, k, op).t
    /\ RecordEntry(Entry(nextNonce, Backend, Lmid(sCommits, Backend) + 1, k, op, {k}, NoUid), sData')
    \* Output gate: pokes are sent only after commits are persisted
    /\ net' = net \cup {Poke(d, dConn[d], HeadOf(sCommits), HeadOf(sCommits'),
                             LmidsSince(sCommits', Len(sCommits)), [j \in {k} |-> sData'[j]])
                        : d \in {e \in Devices : dConn[e] \in sConns}}
    /\ UNCHANGED <<sLow, sIn, sSince, gapSeen, sConns, devVars, dConn, nextConn,
                   muts, crashes, deploys, restores, backups, drops, dups, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* Cloud writes directly to non-synced rows (cloud-only tables, tables that left sync): no commits recorded, no pokes sent
DirectWrite(k, op) ==
    /\ bwrites < MaxBackendWrites /\ k \notin sSynced
    /\ bwrites' = bwrites + 1
    /\ dels' = IF op = "del" THEN dels + 1 ELSE dels
    /\ sData' = Run(sData, k, op).t
    /\ UNCHANGED <<sCommits, sHist, sLow, sLowHist, sIn, sSince, nonceOf, nextNonce, gapSeen, sConns,
                   devVars, dConn, net, nextConn,
                   muts, crashes, deploys, restores, backups, drops, dups, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* Network drops message; dropping connection-bound message (push, poke) breaks connection, disconnecting device
DropOf(m) ==
    /\ drops < MaxDrops
    /\ net' = net \ {m}
    /\ dConn' = [d \in Devices |-> IF "conn" \in DOMAIN m /\ dConn[d] = m.conn THEN NoConn ELSE dConn[d]]
    /\ drops' = drops + 1
    /\ UNCHANGED <<logVars, sConns, devVars, nextConn,
                   muts, dels, crashes, deploys, restores, backups, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>
Drop == \E m \in net : DropOf(m)

\* Connection drops on device side with no messages in flight on it (app backgrounds, heartbeat detects silent disconnect, cloud closes connection): device transitions to disconnected;
\* cloud still tracks connection, processing earlier pushes in flight on it (matching FIFO frame processing in implementation). Shares counter cap with dropped messages
Disconnect(d) ==
    /\ dConn[d] # NoConn /\ drops < MaxDrops
    /\ drops' = drops + 1
    /\ dConn' = [dConn EXCEPT ![d] = NoConn]
    /\ UNCHANGED <<logVars, sConns, devVars, net, nextConn,
                   muts, dels, crashes, deploys, restores, backups, dups, bwrites, errs, returns, hints, chunks, truncs, corrupts, refetches,
                   bSnap, ghostVars>>

\* Protocol actions (liveness checking requires these to eventually happen)
Protocol ==
    \/ \E d \in Devices : Connect(d) \/ Push(d) \/ PullReq(d) \/ RecvPoke(d) \/ RecvPull(d)
                         \/ RecvChunk(d) \/ RecvHint(d) \/ RecvClose(d) \/ Stale(d)
    \/ \E d \in Devices : HandlePush(d) \/ HandlePull(d)

\* User actions, deploys, and faults (not required to occur, bounded by counts)
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

\* Liveness specification: protocol actions eventually execute if continuously enabled (weak fairness).
\* Connect uses strong fairness: connecting is disabled while pull is in flight and re-enabled once pull completes, preventing starvation by repeated pulls
Fair ==
    /\ \A d \in Devices : /\ SF_vars(Connect(d)) /\ WF_vars(Push(d)) /\ WF_vars(PullReq(d))
                         /\ WF_vars(RecvPoke(d)) /\ WF_vars(RecvPull(d)) /\ WF_vars(RecvChunk(d))
                         /\ WF_vars(RecvHint(d)) /\ WF_vars(RecvClose(d)) /\ WF_vars(Stale(d))
                         /\ WF_vars(HandlePush(d)) /\ WF_vars(HandlePull(d))
LiveSpec == Spec /\ Fair

\* Devices are symmetric (initial client ID assignments cover permutations; actions and properties are device-neutral): states differing only by swapped device names are equivalent.
\* Used only for safety model checking: symmetry under liveness can produce false negatives.
\* @see https://learntla.com/topics/optimization.html
Symmetry == Permutations(Devices)

\* ---------------------------------------------------------------- Properties
BaseOf(c) == IF c = CNil THEN DevInit ELSE nonceOf[c.n].t
\* Expected device rows at cookie version: rows in synced tables at that version that remain synced (unsynced devices expect all rows, matching fresh install)
VisOf(c) == (IF c = CNil THEN Keys ELSE nonceOf[c.n].vis) \cap sSynced

\* P1: Mutation IDs for the same client in commit log are strictly monotonic without duplicates
P1_AtMostOnceInOrder ==
    \A i, j \in 1..Len(sCommits) :
        (i < j /\ sCommits[i].client = sCommits[j].client) => sCommits[j].mid > sCommits[i].mid

\* P2 (No lost writes): every device write that advanced mutation ID executed against previous cloud version: recorded touched keys when modifying rows;
\*     unmodified tables occur only from business rejection, absent rows, or modifying non-synced tables (storage errors do not advance mutation ID).
\*     Compares synced tables only: non-synced rows may be modified directly on cloud without commits
P2_NoLostWrite ==
    \A i \in 1..Len(sCommits) : sCommits[i].client # Backend =>
        LET r == Exec(HistAt(sHist, i - 1), sCommits[i].syn, sCommits[i].key, sCommits[i].op)
        IN /\ \A x \in sCommits[i].syn : sHist[i][x] = r.t[x]
           /\ sCommits[i].keys = IF r.w THEN {sCommits[i].key} ELSE {}

\* P3: Pushes never exhibit mutation ID gaps (future mutations that are not client's earliest pending write); gaps indicate implementation defects; cloud skips and logs them
P3_NoGap == ~gapSeen

\* Commit log consistent with cloud tables: latest committed version matches current tables (synced rows; non-synced rows may be modified directly); every version recorded in ghost mapping
HistConsistent ==
    /\ \A x \in sSynced : sData[x] = HistAt(sHist, Len(sCommits))[x]
    /\ \A i \in 1..Len(sCommits) : nonceOf[sCommits[i].nonce] = [t |-> sHist[i], vis |-> sCommits[i].syn]

\* P5 (Core invariant): device tables = cloud tables at cookie version + sequential replay of all pending writes;
\*     undo info of each pending write exactly reverts itself (sequential revert returns to cookie version).
\*     Rows entering sync after that version are absent after revert or match that version's value (supplied by full pull). Corrupted rows awaiting refetch excluded
P5_ClientView ==
    \A d \in Devices :
        LET c == dCookie[d]
            replayed == Replay(BaseOf(c), dPending[d]).t
            rewound == Rewind(dTables[d], dPending[d])
        IN /\ \A k \in VisOf(c) \ dBad[d] : dTables[d][k] = replayed[k] /\ rewound[k] = BaseOf(c)[k]
           /\ \A k \in (sSynced \ VisOf(c)) \ dBad[d] : rewound[k] \in {Absent, BaseOf(c)[k]}

\* P6: When pending queue is empty and cookie is at head of current history, device matches cloud exactly (excluding corrupted rows awaiting refetch)
P6_Converged ==
    \A d \in Devices :
        (dPending[d] = <<>> /\ dCookie[d] # CNil /\ dCookie[d] = HeadOf(sCommits)) =>
            \A k \in VisOf(dCookie[d]) \ dBad[d] : dTables[d][k] = sData[k]

\* P7: When device reaches cloud head, all confirmed pending writes have been dropped
P7_AckedDropped ==
    \A d \in Devices :
        dCookie[d] = HeadOf(sCommits) =>
            \A i \in 1..Len(dPending[d]) : dPending[d][i].mid > Lmid(sCommits, dPending[d][i].client)

\* Committed writes (on current history, including truncated commits); all writes ever originated by devices
CommittedUids == {sCommits[i].uid : i \in 1..Len(sCommits)} \ {NoUid}
EverWritten == 1..(nextUid - 1)

\* P8k (Pending writes preserved across recovery): every write originated by a device is either retained in pending writes of some device (or backup) or committed on current history;
\*      lost writes are strictly limited to those rolled back by PITR (including writes confirmed before restore and dropped by devices) or lost on backup restore
P8k_PendingKept == \A u \in EverWritten : u \in PendingAnywhere \cup CommittedUids \cup rolled \cup lostByBackup

\* P8r (Rolled-back writes do not revive): a write rolled back by restore appears in commit log again only if retained in pending writes of some device (or backup) at restore time and replayed/pushed afterwards
P8r_NoRevival == \A i \in 1..Len(sCommits) : sCommits[i].uid \notin forbidden

\* P8a: Incremental delivery (pokes, incremental final chunks) sent only to devices with cookies on current cloud history (prevents silent forks after server restore)
P8a_IncrementalOnHistory ==
    \A m \in net : m.type \in {"poke", "pullresp"} => m.onHist

\* P10: When device reaches cloud head with empty pending queue, all rows outside sync scope are Absent (dropped tables receive drop commit; cloud-only tables never sent)
P10_ScopeOnly ==
    \A d \in Devices :
        (dPending[d] = <<>> /\ dCookie[d] = HeadOf(sCommits)) => \A k \in (Keys \ sSynced) \ dBad[d] : dTables[d][k] = Absent

\* P11: Each client write appears at most once in commit log (including truncated commits), even across PITR, backup restore, and cloning
P11_ExecutedOnce ==
    \A i, j \in 1..Len(sCommits) : (i < j /\ sCommits[i].uid # NoUid) => sCommits[i].uid # sCommits[j].uid

\* P9: After faults cease, all devices eventually have empty pending queues and converge with cloud synced tables
P9_Converges == <>[](\A d \in Devices : dPending[d] = <<>> /\ \A k \in sSynced : dTables[d][k] = sData[k])
=============================================================================
