---- MODULE MCFanout ----
EXTENDS Fanout
CONSTANTS b1, b2, s1, s2
MCBuckets == {b1, b2}
MCShards == {s1, s2}
MCSub == {b1}
MCResSub == {b2}
====
