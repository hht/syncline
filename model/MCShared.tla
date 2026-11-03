---- MODULE MCShared ----
EXTENDS Shared, TLC
CONSTANTS k1, k2, b1, b2
MCKeyOrder == <<k1, k2>>
MCBucketOrder == <<b1, b2>>
\* One table: rule set 1 maps c=1 to b1, c=2 to b2, c=3 to both buckets; rule set 2 (after deploy) maps 1->b2, 2->b1, 3->b1
MCTableOf == k1 :> 1 @@ k2 :> 1
MCRules == 1 :> << (1 :> {b1} @@ 2 :> {b2} @@ 3 :> {b1, b2}), (1 :> {b2} @@ 2 :> {b1} @@ 3 :> {b1}) >>
MCSubs == {{b1}, {b2}, {b1, b2}}
\* Version 0: k1 only in b1, k2 in both buckets
MCData0 == k1 :> [w |-> 100, c |-> 1] @@ k2 :> [w |-> 101, c |-> 3]
====
