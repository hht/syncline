---- MODULE MCShared ----
EXTENDS Shared, TLC
CONSTANTS k1, k2, b1, b2
MCKeyOrder == <<k1, k2>>
MCBucketOrder == <<b1, b2>>
\* 一张表：第 1 套规则 c=1 在 b1、c=2 在 b2、c=3 两个桶都在；第 2 套（部署后）1→b2、2→b1、3→b1
MCTableOf == k1 :> 1 @@ k2 :> 1
MCRules == 1 :> << (1 :> {b1} @@ 2 :> {b2} @@ 3 :> {b1, b2}), (1 :> {b2} @@ 2 :> {b1} @@ 3 :> {b1}) >>
MCSubs == {{b1}, {b2}, {b1, b2}}
\* 第 0 版：k1 只在 b1，k2 两个桶都在
MCData0 == k1 :> [w |-> 100, c |-> 1] @@ k2 :> [w |-> 101, c |-> 3]
====
