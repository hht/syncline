---- MODULE MCSharedRule ----
EXTENDS MCShared
\* 两张表各 1 行，规则都与 MCShared 的一样，各自可以改
MCTableOf2 == k1 :> 1 @@ k2 :> 2
MCRules2 == [t \in {1, 2} |-> MCRules[1]]
====
