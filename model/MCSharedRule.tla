---- MODULE MCSharedRule ----
EXTENDS MCShared
\* Two tables with 1 row each; rules match MCShared and can change independently
MCTableOf2 == k1 :> 1 @@ k2 :> 2
MCRules2 == [t \in {1, 2} |-> MCRules[1]]
====
