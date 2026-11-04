------------------------------ MODULE Ownership ------------------------------
(***************************************************************************)
(* Ownership model for Syncline devices: which rows a local table holds as *)
(* app releases move tables between the private space (P), shared spaces,  *)
(* and local-only use, and as the signed-in owner or a shared space's      *)
(* owner (the user it was opened for) changes. Rows are abstracted to tags *)
(* <<space, user>>: rows a space pulled for a user, or <<Local, user>> for *)
(* local-only writes. Sync itself is abstracted: a full pull replaces a    *)
(* declared table with the space's rows; an incremental pull (with a       *)
(* cookie) only adds the space's rows, so rows from elsewhere are never    *)
(* removed by it. A space receives rows of tables it does not declare yet  *)
(* (kept as unknown rows until its owner switches, even across a refetch), *)
(* so a table it declares for the first time shows them on open.           *)
(*                                                                         *)
(* A session opens P first (upgrade, then owner claim), then any shared    *)
(* spaces in any order, each declaring disjoint tables. Owners are         *)
(* optional and independent: a shared space's owner need not be P's. Every *)
(* synced table has at most one owning space (record). While the database  *)
(* is closed, the app may drop any table; declaring it recreates it empty, *)
(* without _extra. On open, a space wipes and refetches tables it takes    *)
(* over (returning: synced before or holding rows, and not recorded for it *)
(* or recreated since); a shared space also wipes the tables it no longer  *)
(* declares, while P leaves them to its owner switch. P's owner switch     *)
(* wipes its tables, local-only tables, and tables no space records (if    *)
(* they carry _extra), keeping shared spaces; a table turning local-only   *)
(* from a shared space is wiped first; a shared space's owner switch wipes *)
(* its tables and the ones it recorded last time, even if its open then    *)
(* fails. Retired tables stay retired in every later release and neither a *)
(* space nor local-only use declares them again; P's open drops the ones a *)
(* space recorded (tables that left sync earlier wait for an owner switch, *)
(* and the app's own are left alone).                                      *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Tables, Shared, Users, MaxSessions

P == "P"
Local == "local"
None == "none"
Spaces == {P} \cup Shared

VARIABLES
    privOwner,  \* Stored owner of the private space
    owner,      \* Stored owner of each shared space
    record,     \* Owning space of each table (_syncline_declared), or None
    synced,     \* Table was synced at some point (_syncline_columns records it, also after it leaves sync)
    extra,      \* Table carries _extra (added when a space first declares it; lost when the app drops the table)
    content,    \* Tags of the rows the table holds
    cookie,     \* Space holds a cookie (incremental pulls continue from it)
    unknown,    \* Space holds rows of the tables it does not declare (pulled since its last owner switch)
    decl,       \* Tables each space declares in this session ({} if not opened)
    local,      \* Local-only tables in this session
    phase,      \* "closed" / "open" (P opened, shared spaces may open)
    retired,    \* Retired tables (only ever grows)
    left,       \* Ghost: tables that held local-only rows and were then neither local-only nor synced, without _extra (the app's own tables since)
    sessions

vars == <<privOwner, owner, record, synced, extra, content, cookie, unknown, decl, local, phase, retired, left, sessions>>

OwnerOf(s) == IF s = P THEN privOwner ELSE owner[s]
Tag(s) == <<s, OwnerOf(s)>>

Init ==
    /\ privOwner = None /\ owner = [s \in Shared |-> None]
    /\ record = [t \in Tables |-> None] /\ synced = [t \in Tables |-> FALSE] /\ extra = [t \in Tables |-> FALSE] /\ content = [t \in Tables |-> {}]
    /\ cookie = [s \in Spaces |-> FALSE] /\ unknown = [s \in Spaces |-> FALSE] /\ decl = [s \in Spaces |-> {}] /\ local = {}
    /\ phase = "closed" /\ retired = {} /\ left = {} /\ sessions = 0

\* Tables a space takes over on open: synced before but not recorded for it, or recreated since (no _extra: the app dropped it),
\* or never synced but holding rows (local-only writes)
Returning(s, D, rec, con) == {t \in D : ~(rec[t] = s /\ extra[t]) /\ (synced[t] \/ con[t] # {})}
\* Records after space s declares D: its old records dropped, D recorded for s (taken from any other space)
Redeclared(s, D, rec) == [t \in Tables |-> IF t \in D THEN s ELSE IF rec[t] = s THEN None ELSE rec[t]]

\* Private space opens for user u (None: owner omitted) with declaration D, local-only tables L, and retired tables R: upgrade (drop
\* retired tables a space recorded, redeclare, wiping returning tables), then claim
OpenPrivate(u, D, L, R) ==
    /\ phase = "closed" /\ sessions < MaxSessions /\ retired \subseteq R /\ (D \cup L) \cap R = {}
    /\ LET \* Only tables a space recorded: the others left sync earlier and may hold local-only writes since
           gone == {t \in R : record[t] # None}
           back == Returning(P, D, record, content)
           \* A table turning local-only leaves the space recording it; rows a shared space pulled for its owner go first
           foreign == {t \in L : record[t] \in Shared}
           rec1 == [t \in Tables |-> IF t \in L \cup gone THEN None ELSE Redeclared(P, D, record)[t]]
           wiped1 == [t \in Tables |-> IF t \in back \cup foreign THEN {} ELSE content[t]]
           switch == u # None /\ privOwner \notin {None, u}
           who == IF u = None THEN privOwner ELSE u
           orphans == {t \in Tables : extra[t] /\ rec1[t] = None /\ t \notin L}
           cleared == IF switch THEN D \cup L \cup orphans ELSE {}
           kept == ~switch /\ back = {} /\ cookie[P]
           \* Unknown rows of tables declared for the first time land on open (a switch wipes them afterwards)
           restored == {t \in D \ back : unknown[P] /\ ~synced[t]}
       IN /\ record' = rec1
          /\ content' = [t \in Tables |->
                IF t \in cleared \cup gone THEN {} ELSE IF t \in restored THEN wiped1[t] \cup {<<P, who>>} ELSE wiped1[t]]
          /\ cookie' = [cookie EXCEPT ![P] = kept]
          /\ unknown' = [unknown EXCEPT ![P] = ~switch /\ @]
          /\ privOwner' = who
          /\ synced' = [t \in Tables |-> (synced[t] /\ t \notin gone) \/ t \in D]
          /\ extra' = [t \in Tables |-> (extra[t] /\ t \notin gone) \/ t \in D]
    /\ decl' = [decl EXCEPT ![P] = D] /\ local' = L /\ retired' = R
    /\ left' = left \cup {t \in Tables \ (D \cup L) : ~extra[t] /\ \E tag \in content[t] : tag[1] = Local}
    /\ phase' = "open" /\ sessions' = sessions + 1
    /\ UNCHANGED owner

Taken == decl[P] \cup local \cup UNION {decl[x] : x \in Shared}

\* Shared space s opens for user o (None: owner omitted; independent of the private owner) declaring D: owner switch reset first, then (if the open succeeds) redeclare, wiping
\* returning tables
OpenShared(s, D, o, fails) ==
    /\ phase = "open" /\ decl[s] = {} /\ D # {} /\ D \cap (Taken \cup retired) = {}
    /\ LET switch == o # None /\ owner[s] \notin {None, o}
           reset == IF switch THEN D \cup {t \in Tables : record[t] = s} ELSE {}
           rec0 == [t \in Tables |-> IF t \in reset THEN None ELSE record[t]]
           con0 == [t \in Tables |-> IF t \in reset THEN {} ELSE content[t]]
           back == Returning(s, D, rec0, con0)
           unknown0 == ~switch /\ unknown[s]
       IN /\ unknown' = [unknown EXCEPT ![s] = unknown0]
          /\ IF fails
             THEN /\ record' = rec0 /\ content' = con0
                  /\ cookie' = [cookie EXCEPT ![s] = IF switch THEN FALSE ELSE cookie[s]]
                  /\ UNCHANGED <<synced, extra, decl>>
             ELSE LET kept == ~switch /\ back = {} /\ cookie[s]
                      \* Tables the space no longer declares: its rows would outlive the owner switches that reach them
                      dropped == {t \in Tables : rec0[t] = s /\ t \notin D}
                      restored == {t \in D \ back : unknown0 /\ ~synced[t]}
                  IN /\ record' = Redeclared(s, D, rec0)
                     /\ content' = [t \in Tables |->
                           IF t \in back \cup dropped THEN {} ELSE IF t \in restored THEN con0[t] \cup {Tag(s)} ELSE con0[t]]
                     /\ cookie' = [cookie EXCEPT ![s] = kept]
                  /\ synced' = [t \in Tables |-> synced[t] \/ t \in D]
                  /\ extra' = [t \in Tables |-> extra[t] \/ t \in D]
                  /\ decl' = [decl EXCEPT ![s] = D]
    /\ owner' = IF o = None THEN owner ELSE [owner EXCEPT ![s] = o]
    /\ UNCHANGED <<privOwner, local, phase, retired, left, sessions>>

\* Space s pulls: a full pull (no cookie) replaces its tables with its rows; an incremental pull only adds its rows
Pull(s) ==
    /\ phase = "open" /\ decl[s] # {}
    /\ content' = [t \in Tables |-> IF t \in decl[s] THEN (IF cookie[s] THEN content[t] \cup {Tag(s)} ELSE {Tag(s)}) ELSE content[t]]
    /\ cookie' = [cookie EXCEPT ![s] = TRUE] /\ unknown' = [unknown EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<privOwner, owner, record, synced, extra, decl, local, phase, retired, left, sessions>>

LocalWrite(t) ==
    /\ phase = "open" /\ t \in local
    /\ content' = [content EXCEPT ![t] = @ \cup {<<Local, privOwner>>}]
    /\ UNCHANGED <<privOwner, owner, record, synced, extra, cookie, unknown, decl, local, phase, retired, left, sessions>>

Close ==
    /\ phase = "open"
    /\ phase' = "closed" /\ decl' = [s \in Spaces |-> {}] /\ local' = {}
    /\ UNCHANGED <<privOwner, owner, record, synced, extra, content, cookie, unknown, retired, left, sessions>>

\* The app drops a table while the database is closed (renaming it away is the same for its name); declaring it recreates it
\* empty, without _extra
ExternalDrop(t) ==
    /\ phase = "closed"
    /\ content' = [content EXCEPT ![t] = {}] /\ extra' = [extra EXCEPT ![t] = FALSE]
    /\ UNCHANGED <<privOwner, owner, record, synced, cookie, unknown, decl, local, phase, retired, left, sessions>>

Next ==
    \/ \E u \in Users \cup {None}, D, L, R \in SUBSET Tables : D \cap L = {} /\ OpenPrivate(u, D, L, R)
    \/ \E s \in Shared, D \in SUBSET Tables, o \in Users \cup {None}, fails \in BOOLEAN : OpenShared(s, D, o, fails)
    \/ \E s \in Spaces : Pull(s)
    \/ \E t \in Tables : LocalWrite(t)
    \/ \E t \in Tables : ExternalDrop(t)
    \/ Close

Spec == Init /\ [][Next]_vars

\* ---------------------------------------------------------------- Properties
\* Rows belong to the current owner of where they came from: the private space to the signed-in owner, a shared space's rows to the
\* user it is opened for, and local-only writes to the signed-in owner while the table is local-only (a table removed from local-only
\* use without being synced is indistinguishable from the app's own tables, so it is left alone, even if it becomes local-only again).
\* Rows written before any owner was recorded belong to whoever is recorded first.
Mine(tag, o) == tag[2] \in {None, o}
NoLeak ==
    \A t \in Tables : \A tag \in content[t] :
        CASE tag[1] = P -> Mine(tag, privOwner)
          [] tag[1] = Local -> t \in local \ left => Mine(tag, privOwner)
          [] OTHER -> Mine(tag, owner[tag[1]])
\* An open space with a cookie holds exactly its own rows in every table it declares: nothing foreign, nothing missing
Exact ==
    \A s \in Spaces : \A t \in decl[s] : cookie[s] => content[t] # {} /\ \A tag \in content[t] : tag[1] = s /\ Mine(tag, OwnerOf(s))
\* Local-only writes are lost only to an owner switch, to a space declaring their table (which wipes it first), or to the app
\* dropping it (the one step that stays closed), even after the table leaves local-only use and is retired
Kept(t) == {tag \in content[t] : tag[1] = Local} \subseteq content'[t]
NoSwitch == privOwner \in {None, privOwner'} /\ \A s \in Shared : owner[s] \in {None, owner'[s]}
LocalKept == [][NoSwitch /\ phase' = "open" => \A t \in Tables \ UNION {decl'[s] : s \in Spaces} : Kept(t)]_vars
================================================================================
