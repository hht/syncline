# 反向验证

[模型与检查](model.md)的细节：故意改坏下列任一处，括号里的配置都会报出违反，说明这些配置真能抓到这类错；最后列出改坏了也不报的几处，以及为什么正确性不靠它们。

## 私有空间（`Private.tla`）

- 去掉重复写的跳过（`MCPrivateValue`：P1）
- 应用前不撤回待上传（`MCPrivateValue`：P5）
- 撤回待上传时从最早的一条开始（`MCPrivateValue`：P5）
- 不删已确认的待上传（`MCPrivateValue`：P7）
- 不检查通知的 base（`MCPrivateValue`：P5）
- 增量漏掉游标之后的第一版（`MCPrivateValue`：P5）
- 拒收时不推进 lmid（`MCLivePrivateReject`：P9）
- 不跳号：序号比 lmid + 1 大的都当空洞（`MCPrivateJumpBackup`：P3）
- 整份落地时重编待上传的序号、也不跳号（`MCPrivateJumpBackup`：P11）
- 覆盖式跳号：是最早的待上传就把 lmid 设到它之前，可以往回拉（`MCPrivate`：P1）
- 时间点恢复之后旧连接上的推送照常处理（`MCPrivateJumpBackup`：P8r）
- 整份落地时丢掉待上传（`MCPrivateRestoreChunk`：P8k）
- 接着拉时不看 cursor 的 seen（`MCPrivateIncrChunk`：P5；只分 1 块的配置走不到：第一块与位置同一步算出，seen 就是水位）
- 设备从备份恢复后沿用旧的客户端编号（`MCLivePrivateBackup`：P3）
- 校验游标时忽略随机数（`MCPrivateRestore`：P8a）
- 游标在不在历史上不看日志下限（`MCPrivateTruncChunk`：P8a）
- 日志下限那一版只比版本、不比随机数（`MCPrivateTruncBackup`：P8a）
- 客户端表随日志截断，处理到第几条只从没截掉的提交算（`MCPrivateTruncChunk`：P1）
- 连上不发补齐通知（`MCLivePrivate`：P9）
- 连上时的补齐只给尾巴、不含扫描（`MCPrivatePromote`：P5）
- 当前连接上的通知接不上本机游标时不断开（`MCLivePrivateReject`：P9）
- 设备不检查通知是否来自当前连接（`MCLivePrivateRestore`：P9；模型的网络不保序，恢复关掉的旧连接上的通知可以在关闭之后才到，base 恰好等于恢复后的游标时会把设备带到回滚掉的历史上；实现里同一条连接按序送到，关了就收不到）
- 拉取还在路上时也能连接（`MCLivePrivateRestore`：P9；恢复前算的拉取结果在新连接连上之后才到，把游标带到回滚掉的历史上，连着的设备不会再拉；实现里拉完才连，上一次连接的拉取结果丢掉）
- 连接上的消息丢了不算断线（`MCLivePrivate`：P9）
- 后台写不记改到的键（`MCPrivateBackend`：P5）
- 后台写不记提交、直接改云端表（`MCPrivateBackend`：HistConsistent）
- 后台写不发通知（`MCLivePrivateBackend`：P9）
- 应用增量时不应用删除（`MCPrivateDelete`：P5）
- 本机删除不记撤回信息（`MCPrivateDelete`：P5）
- 用户要整份重下时丢掉待上传（`MCLivePrivateRefetch`：P5）
- 整份重下落地后不清掉要整份重拉的标记（`MCLivePrivateRefetch`：P9；一直不连，待上传推不上去）
- 存储出错的那条照样扣下、推进序号（`MCPrivateStorage`：P2）
- 存储出错的那条跳过、之后的照常处理（`MCPrivateStorage`：P3）
- 后台写删行不记键（`MCPrivateDeleteBackend`：P5）
- 离开同步后改它的写照常执行（`MCLivePrivateRetire`：P10；P2 用同一个 `Exec` 判断该不该执行，跟着一起改坏，报不出）
- 改已离开同步的表的写整批报错、不推进序号（`MCLivePrivateRetire`：P9）
- 存储出错、已有写提交时不给别的在线设备发提示（`MCLivePrivateStorage`：P9）
- 丢掉接不上的通知时不记下要追到的版本（`MCLivePrivateHintGap`：P9）
- 进入同步（含离开后回来）不写 since（`MCPrivatePromote`：P5）
- 时间点恢复回到进入之前，重启时不重新写 since（`MCPrivateRestorePromote`：P5）
- 尾巴不跳过扫描集里 since 及之前的项（`MCPrivateScopeTwice`：P5）
- 尾巴里的删掉不受跳过规则管（`MCPrivateScopeTwice`：P5）
- 追到最新时不开下一轮（`MCPrivateScopeEnter`：P5）
- 设备收到「删掉」不删（`MCLivePrivateRetire`：P10）
- 时间点恢复后不按现在的范围记删掉（`MCPrivateScopeRestore`：P10）
- 下发的已确认序号一个都不给（`MCLivePrivate`：P7）
- 设备要求重下的范围不进扫描集（`MCLivePrivateRange`：P5，坏行当作已恢复、却没收到云端的值）

## 共用空间（`Shared.tla`）

- 订阅去掉了桶时不整份重下（`MCShared`：S1）
- 尾巴只给改后在订阅里的行、不看改前（`MCShared`：S1）
- 回复的订阅与暂存的块不同也不丢暂存（`MCShared`：S1）
- 通知不比订阅（`MCShared`：S1）
- 整份开头不清空（`MCSharedRebuild`：S1）
- 每一轮扫一张表之前不清空这张表（`MCSharedRule`：S1）
- 末块不看 `seen` 就生效（`MCSharedChunk`：S1）
- 追到最新时不开下一轮（`MCSharedRule`：S1）
- 接着拉的请求可以在这一轮的水位之前算出，即缓存键不含水位（`MCSharedRule`：S1）
- 通知只比版本、不比代（`MCSharedRebuild`：S1）
- 通知不检查 base（`MCSharedRebuild`：S1）
- 有暂存的块时也应用通知（`MCSharedRebuild`：S1）
- 拉取在路上时也应用通知、拉取结果也不比对 cursor（`MCSharedRebuild`：S1）
- 设备不理提示（`MCLiveShared`：S2）
- 接不上的较新通知直接丢、不提目标版本（`MCLiveShared`：S2）
- 连上时只发空补齐、设备落后也不发提示（`MCLiveShared`：S2）
- 从连接上听到的订阅与落地的不同也不拉（`MCLiveShared`：S2）
- 落地的不是目标那一代就放下目标，不看这次请求带没带它作下限（`MCLiveSharedRebuild`：S2）
- 分片收到晚到的旧一代那一轮时只按版本接上、推跨代的通知（`MCSharedLate`：S1）
- 截日志后游标早于下限的照常给增量、不整份（`MCSharedTrunc`：S1）
- 截日志后拉到一半的计划带的各版早于下限也接着读（`MCSharedTrunc`：S1）
- 分片推的上一版早于日志下限也推通知（`MCSharedTrunc`：S1）
- 落地的不是目标那一代也不放下目标（`MCLiveSharedLate`：S2，设备揣着别代的目标一直拉）
- 分片收到晚到的旧一代那一轮时推了它的提示、却不推问到的最新一版（`MCLiveSharedLate`：S2，设备被带回旧一代落地后，分片以为推过最新的、不再推，设备停在旧一代）
- 补齐之前推来的与问到的不同代时，不再问、不推最新一版（`MCLiveSharedLate`：S2）
- 旧令牌连的连接不到期关掉（`Expire` 不公平，即分片不按到期关、接入方也不调 `reconnect()`；`MCLiveShared`：S2，连接一直按原来的订阅推）
- 拉取落地的订阅与这条连接上听到的不同时只作废听到的、不换连接（`MCLiveShared.big`：S2；订阅变回原来的，连接上不再来消息，设备停在中间那份订阅上）

## 扇出（`Fanout.tla`）

- 投递丢了进度照样前进（`MCFanout`：S2）
- 补齐时问到的最新一版写进分片知道的版本（`MCFanout`：S2，常驻设备收不到被吞掉的那一轮）
- 收到提示后拉取不带下限（`MCFanout`：`NoWastedPull`）
- 不带键的版本（规则变更、换代）不按「太多」处理（`MCFanout`：`Covers`）
- 问不到最新一版时发接在设备游标上的空补齐（`MCFanout`：`Covers`）
- 共用空间对象重启后各分片的确认取最新一版、不退回落库的那一版（`MCFanout`：S2）

## 改坏了也不报的几处

正确性不靠它们：
- 有暂存的块时也应用接在游标上的通知：`MCPrivateRestoreChunk` 完整穷举、`MCPrivateIncrChunk` 随机游走照样通过。块里是读时的当前值、位置都要在当前历史上，游标被通知推前之后接着拉，落地的结果照样对；实现照旧在拉取中途冻结通知，简单。
- 按范围重下不要求没有待上传：`MCPrivateRange` 完整穷举照样通过。重下给的是最新一版的值，落地时照常撤回、叠上、重放；「没有待上传」是校验和比对的前提（有待上传时本机表不等于任何一版），模型里发出重下之后照样可以写。
- 共用空间的尾巴不跳过扫描集里 since 及之前的项：`MCSharedRule` 照样通过。共用空间没有删掉整张表的项，尾巴给的都是现在的值，多给几项只多读；私有空间的跳过管着删掉（`MCPrivateScopeTwice`）。
- 共用空间收到提示后第一个请求不带目标作下限（等落地后的下一个请求才带）、下限不在云端现在这一代的请求也走缓存：`MCLiveSharedRebuild` 都照样通过。两处只让设备少拿几次旧缓存、少拉几次；放下另一代的目标只看「这次请求带着它、回来的不是它那一代」，与什么时候带上无关。
