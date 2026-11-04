------------------------------- MODULE Schedule -------------------------------
(***************************************************************************)
(* Schedule model for Syncline Durable Objects: tasks (background          *)
(* maintenance steps, exports, deliveries, integrator callbacks) share one *)
(* alarm through a schedule table. Time is abstracted into classes: an     *)
(* entry is due now, after a lease (15 minutes), or after a pause (a day); *)
(* ticks move later classes to due.                                        *)
(*                                                                         *)
(* An alarm leases its batch before any task runs (the lease commits, so a *)
(* reset keeps it) and counts a started run in resets. A task that         *)
(* finishes clears resets and deletes its entry if it still holds the      *)
(* lease. Crashers reset the object every time they run; an external reset *)
(* (deployment, another request exceeding the CPU limit) can cut any run.  *)
(* If due entries include one with resets > 0 (a run that never finished), *)
(* the alarm runs only one of them, alone; one reaching ResetLimit instead *)
(* moves a day later, backing off, and gets one more run per day.          *)
(*                                                                         *)
(* Writers schedule with By (replaces a lease, keeps backoff, only moves   *)
(* earlier), Ensure (like By but keeps a lease: work found pending on      *)
(* start), and At (replaces the entry: deliveries, bounded rounds that     *)
(* never reset the object, also replaced on every restart). Integrators    *)
(* may Cancel their tasks.                                                 *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    Tasks,
    Crashers,       \* Tasks that reset the object every time they run
    Replaced,       \* Tasks rescheduled with At (never crashers)
    ResetLimit,     \* Unfinished runs in a row before a task pauses a day
    MaxFaults,      \* External resets
    MaxRequests     \* Scheduling calls

ASSUME Crashers \subseteq Tasks /\ Replaced \subseteq Tasks \ Crashers

Due == "due"
Lease == "lease"
Day == "day"

VARIABLES
    present,    \* Entry exists in the schedule table
    at,         \* Time class of the entry
    leased,     \* Entry holds the lease of a run
    backoff,    \* Entry is backing off (By and Ensure keep its time)
    resets,     \* Runs started in a row without finishing
    alarm,      \* An alarm invocation is in progress
    running,    \* Tasks of the current alarm still running (memory, lost on reset)
    wanted,     \* Ghost: a scheduling call not yet served by a run that started after it
    started,    \* Ghost: tasks whose current run started after their last scheduling call
    crashes,    \* Ghost: runs of each crasher since the last day tick
    faults, requests

vars == <<present, at, leased, backoff, resets, alarm, running, wanted, started, crashes, faults, requests>>

Init ==
    /\ present = [t \in Tasks |-> FALSE] /\ at = [t \in Tasks |-> Due] /\ leased = [t \in Tasks |-> FALSE]
    /\ backoff = [t \in Tasks |-> FALSE] /\ resets = [t \in Tasks |-> 0]
    /\ alarm = FALSE /\ running = {} /\ wanted = [t \in Tasks |-> FALSE] /\ started = {}
    /\ crashes = [t \in Tasks |-> 0] /\ faults = 0 /\ requests = 0

Earlier(a, b) == a = Due /\ b # Due

\* By (release = TRUE; also for deliveries, after a server write) and Ensure (release = FALSE, only on object start, so never during an
\* alarm, and never for deliveries): insert if missing; release a lease (By only); otherwise move earlier unless backing off
Schedule(t, when, release) ==
    /\ requests < MaxRequests
    /\ release \/ (~alarm /\ t \notin Replaced)
    /\ requests' = requests + 1
    /\ wanted' = [wanted EXCEPT ![t] = TRUE] /\ started' = started \ {t}
    /\ IF ~present[t]
       THEN /\ present' = [present EXCEPT ![t] = TRUE] /\ at' = [at EXCEPT ![t] = when]
            /\ UNCHANGED <<leased, backoff, resets>>
       ELSE IF leased[t] /\ release
       THEN /\ at' = [at EXCEPT ![t] = when] /\ leased' = [leased EXCEPT ![t] = FALSE] /\ backoff' = [backoff EXCEPT ![t] = FALSE]
            /\ UNCHANGED <<present, resets>>
       ELSE IF ~leased[t] /\ ~backoff[t] /\ Earlier(when, at[t])
       THEN /\ at' = [at EXCEPT ![t] = when] /\ UNCHANGED <<present, leased, backoff, resets>>
       ELSE UNCHANGED <<present, at, leased, backoff, resets>>
    /\ UNCHANGED <<alarm, running, crashes, faults>>

\* At: replaces the entry outright (clearing lease, backoff, and resets)
Replace(t, when) ==
    /\ requests < MaxRequests /\ t \in Replaced
    /\ requests' = requests + 1
    /\ wanted' = [wanted EXCEPT ![t] = TRUE] /\ started' = started \ {t}
    /\ present' = [present EXCEPT ![t] = TRUE] /\ at' = [at EXCEPT ![t] = when]
    /\ leased' = [leased EXCEPT ![t] = FALSE] /\ backoff' = [backoff EXCEPT ![t] = FALSE] /\ resets' = [resets EXCEPT ![t] = 0]
    /\ UNCHANGED <<alarm, running, crashes, faults>>

\* Integrator unschedule of a task it scheduled (not crashers: unscheduling then scheduling deliberately restarts the count)
Cancel(t) ==
    /\ requests < MaxRequests /\ present[t] /\ t \notin Crashers \cup Replaced
    /\ requests' = requests + 1
    /\ present' = [present EXCEPT ![t] = FALSE] /\ leased' = [leased EXCEPT ![t] = FALSE]
    /\ backoff' = [backoff EXCEPT ![t] = FALSE] /\ resets' = [resets EXCEPT ![t] = 0]
    /\ wanted' = [wanted EXCEPT ![t] = FALSE]
    /\ UNCHANGED <<at, alarm, running, started, crashes, faults>>

DueNow == {t \in Tasks : present[t] /\ at[t] = Due}

Start(batch) ==
    /\ leased' = [t \in Tasks |-> IF t \in batch THEN TRUE ELSE leased[t]]
    /\ at' = [t \in Tasks |-> IF t \in batch THEN Lease ELSE at[t]]
    /\ resets' = [t \in Tasks |-> IF t \in batch THEN resets[t] + 1 ELSE resets[t]]
    /\ crashes' = [t \in Tasks |-> IF t \in batch \cap Crashers THEN crashes[t] + 1 ELSE crashes[t]]
    /\ started' = started \cup batch
    /\ alarm' = TRUE /\ running' = batch

\* Alarm fires: a suspect (resets > 0) with the fewest resets runs alone, or pauses a day once it reached ResetLimit (so tasks cut off
\* alongside a crasher run before it); otherwise the whole due batch runs
Fire ==
    /\ ~alarm /\ DueNow # {}
    /\ LET suspects == {t \in DueNow : resets[t] > 0}
       IN IF suspects = {}
          THEN Start(DueNow) /\ UNCHANGED <<present, backoff>>
          ELSE \E s \in {x \in suspects : \A y \in suspects : resets[x] <= resets[y]} :
                 IF resets[s] >= ResetLimit
                 THEN /\ at' = [at EXCEPT ![s] = Day] /\ backoff' = [backoff EXCEPT ![s] = TRUE]
                      /\ leased' = [leased EXCEPT ![s] = FALSE] /\ resets' = [resets EXCEPT ![s] = ResetLimit - 1]
                      /\ UNCHANGED <<present, alarm, running, started, crashes>>
                 ELSE Start({s}) /\ UNCHANGED <<present, backoff>>
    /\ UNCHANGED <<wanted, faults, requests>>

\* A task that is not a crasher finishes: clears resets; deletes its entry if it still holds the lease (served), else stays rescheduled
Finish(t) ==
    /\ t \in running \ Crashers
    /\ running' = running \ {t}
    /\ alarm' = (running' # {})
    /\ resets' = [resets EXCEPT ![t] = 0]
    /\ IF leased[t]
       THEN /\ present' = [present EXCEPT ![t] = FALSE] /\ leased' = [leased EXCEPT ![t] = FALSE] /\ backoff' = [backoff EXCEPT ![t] = FALSE]
            /\ wanted' = [wanted EXCEPT ![t] = IF t \in started THEN FALSE ELSE wanted[t]]
       ELSE UNCHANGED <<present, leased, backoff, wanted>>
    /\ UNCHANGED <<at, started, crashes, faults, requests>>

\* The object resets mid-alarm: a crasher's run, or an external reset; runs in memory are lost, committed leases and resets stay, except
\* that the restart replaces delivery entries with At (keeping their time), so a reset that cut a delivery never counts toward a pause
Reset ==
    /\ alarm
    /\ (running \cap Crashers # {} \/ faults < MaxFaults)
    /\ faults' = IF running \cap Crashers # {} THEN faults ELSE faults + 1
    /\ alarm' = FALSE /\ running' = {}
    /\ leased' = [t \in Tasks |-> leased[t] /\ t \notin Replaced]
    /\ backoff' = [t \in Tasks |-> backoff[t] /\ t \notin Replaced]
    /\ resets' = [t \in Tasks |-> IF t \in Replaced THEN 0 ELSE resets[t]]
    /\ UNCHANGED <<present, at, wanted, started, crashes, requests>>

\* Time passes only while nothing is due and no alarm runs: alarms fire at their time, and an alarm ends within a lease
Idle == ~alarm /\ DueNow = {}

\* A lease ends (15 minutes pass)
LeaseTick ==
    /\ Idle /\ \E t \in Tasks : present[t] /\ at[t] = Lease
    /\ at' = [t \in Tasks |-> IF at[t] = Lease THEN Due ELSE at[t]]
    /\ UNCHANGED <<present, leased, backoff, resets, alarm, running, wanted, started, crashes, faults, requests>>

\* A day passes: paused entries come due and crasher run counts restart
DayTick ==
    /\ Idle /\ \E t \in Tasks : present[t] /\ at[t] = Day
    /\ at' = [t \in Tasks |-> IF at[t] \in {Lease, Day} THEN Due ELSE at[t]]
    /\ crashes' = [t \in Tasks |-> 0]
    /\ UNCHANGED <<present, leased, backoff, resets, alarm, running, wanted, started, faults, requests>>

Next ==
    \/ \E t \in Tasks, when \in {Due, Lease}, release \in BOOLEAN : Schedule(t, when, release)
    \/ \E t \in Tasks, when \in {Due, Lease} : Replace(t, when)
    \/ \E t \in Tasks : Cancel(t) \/ Finish(t)
    \/ Fire \/ Reset \/ LeaseTick \/ DayTick

Spec == Init /\ [][Next]_vars
            /\ WF_vars(Fire) /\ WF_vars(LeaseTick) /\ WF_vars(DayTick)
            /\ \A t \in Tasks \ Crashers : WF_vars(Finish(t))
            /\ WF_vars(Reset /\ running \cap Crashers # {})

\* ---------------------------------------------------------------- Properties
TypeOK ==
    /\ \A t \in Tasks : resets[t] \in Nat /\ at[t] \in {Due, Lease, Day}
    /\ running \subseteq Tasks /\ (alarm <=> running # {})
\* A scheduling call is never lost: an entry stays until a run started after the call finishes
Kept == \A t \in Tasks : wanted[t] => present[t]
\* A crasher resets the object at most ResetLimit times between day ticks, instead of every lease
Bounded == \A t \in Crashers : crashes[t] <= ResetLimit
\* Deliveries never reset the object, so resets that cut them never pause them
Exempt == \A t \in Replaced : ~backoff[t]
\* Every scheduling call of a task that finishes is eventually served, whatever crashers are due alongside it
Served == \A t \in Tasks \ Crashers : wanted[t] ~> ~wanted[t]
================================================================================
