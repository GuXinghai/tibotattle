---
title: 本地刷新职责与发布架构建议
date: 2026-10-21
type: plan
status: phase-one-implemented
---

# 状态、范围与结论

阶段 1A–1C 已在工作区实施；阶段 2 仍是有条件的建议，未启用额度并发。
[实现与验证边界](../reviews/2026-10-21-local-refresh-unification-implementation.md)
记录本次实施，以下现状调查保留为设计依据，不代表修改后的调用路径。原调查依据为
`94cc26f3a63fc12b726fd47da8a83b44ba27e425` 上的当前工作区，包含未提交的
[计算与缓存优化](./2026-10-21-refresh-calculation-cache-optimization.md)。
原设计调查未启动、操控或打包应用，未读取真实凭证，未运行产品测试或私有数据实验。
用户正在验收的新包不能由本次源码分析代替验证。

推荐沿用现有 companion controller、scheduler、data store 三个职责边界：
companion 统一决定本地刷新何时运行、当前做什么及何时发布；Electron 负责生命周期、
设置传递和连接恢复；网页与托盘观察同一份状态。保留额度读取和索引/计算两种工作能力，
避免把轻操作强制变成全历史计算，也不把所有后台工作塞入新全局协调器。

**第一阶段保持单个执行流水线，修正入口语义、重复调度、局部发布和 UI 观测。**
耗时计算期间独立执行额度刷新是后续有条件的增强，需要先验证数据库和发布边界；
不能通过多加一个定时器就宣称额度不会受重算影响。X 动态的调度和会话保持独立。

# 当前源码路径与需要更正的说法

以下行号指本次调查时工作区，后续实现可能移动。代码是实现证据，注释与旧文档需与其核对。

```text
companion 启动快照成功
  └─ overview scheduler：本轮完成后等待用户间隔，默认 300 秒
       └─ controller.start(overview)

网页普通刷新 / Electron 启动 fresh 分支 / Electron automatic quick 事件
  └─ requestRefresh(detailed=false)
       └─ LocalCompanionClient.refresh() → POST /refresh/overview
            └─ overview scheduler.request() → controller.start(overview) 或加入现有工作

设置页详细刷新 / Electron 启动非 fresh 分支 / automatic detailed 事件
  └─ requestRefresh(detailed=true) → POST /refresh → controller.start(detailed)

保留的 POST /refresh/quick → controller.start(quick)

controller：当前只有一个 inFlight
  └─ quota-only collector：主动 app-server 查询 → collector SQLite 持久化
       └─ quick_result
            ├─ quick/detailed：await dataStore.reload(purpose=quick)
            └─ overview：不做此处 reload
       └─ overview/detailed：统一索引 → 有效缓存复用或 accounting rebuild
            └─ dataStore.reload(overview/full) → 最终状态

网页：自己的 requestRefresh 循环 + 两秒轮询 finishedAt
Electron：额外小时级业务调度 + renderer lease/watchdog
托盘：五秒读取 /desktop-status；观察快照/刷新回执，不主动查询额度
```

1. **当前界面的所谓 quick 并不等于额度轻刷新。**
   `apps/web/public/data-client.js:5925` 的 `refresh()` 实际调用 `/refresh/overview`；
   `apps/web/public/app.js:9421` 选择这个入口，但 `:9428` 仍把 Electron lease 标为 quick。
   `:9889` 的 automatic quick 事件也走这条路径。因此不能说普通手动、启动 fresh 分支或
   小时节流外的 quick 事件只查额度。它们现在都可能更新索引并计算。
   测试桩也有漂移：`apps/web/test/refresh-policy.test.mjs:146` 把该方法记作 `/refresh/quick`，
   单测绿不能证明真实客户端路由语义相同。
2. **两个业务调度仍并存。** `apps/local/server.js:1190` 在初始快照完成后启动 scheduler；
   `apps/local/overview-refresh-scheduler.js:24` 按完成后间隔计时，`:60` 请求 overview。
   `apps/electron/desktop-runtime.js:950` 设置 `overviewRefreshOwnedByCompanion: true`，
   但 `apps/electron/desktop-controller.js:748` 只将 shell 间隔抬到至少 3600 秒，并未关闭它。
   `:675` 至 `:704` 仍按持久预约选择 quick/detailed 并向 renderer 发命令。
   此小时约束只限制名为 detailed 的自动尝试，不能限制 overview 内的重计算。
3. **额度通常是主动查询，须说明条件。** `src/local-companion-refresh.js:858` 传入
   `staleAfterMs:0`、`refreshStale:true`、`skipRolloutIngestion:true`。
   `src/passive-collector.js:1856` 的分支在未取消且当前时钟严格晚于已有观测时查询；
   `:1873` 启动 app-server，`:1515` 对账户前后夹取并调用 `readRateLimits` 和可选
   `readAccountUsage`。它不是扫描 rollout 才发现额度，也不是所有调用必有新观测。
   同毫秒、未来时间、取消、连接失败、无有效记录都可不产生新观测。
   非 detailed 且已经成功读取过额度时可省略 reset credit 详情（runner `:865`）。
4. **overview 先读取额度，却不提前发布 dashboard。** runner `:898` 发出 quick_result，
   controller `:1779` 明确排除 overview 的 quick reload；`:1849` 到最后才 reload。
   detailed/quick 的早发布也必须等 reload 成功，不能把 collector commit 当作 UI 已更新。
5. **状态互斥不等于需求合并。** controller `:1664` 对任何在途任务返回 false；
   server `:1631` 对 overview 加入返回 200，详细和 quick 在 `:1612`、`:1648` 返回 409。
   没有通用的能力升级或待处理请求队列。overview 遇到 quick 可能只加入较弱工作。
   detailed 路由通知 scheduler.observe，quick 路由目前没有同样调用。
6. **自动运行与图标状态不是同一来源。** app `:666` 用本页面 `localRefreshInProgress`
   决定按钮；`:559` 才设置 `is-refreshing`。`:10544` 的后台轮询只按 `finishedAt` 加载结果，
   不把 companion 的 running 投影为相同进度状态。该结构能解释状态不一致的风险，但没有
   本次真实 UI 复现，不能断言它就是用户那次卡住的唯一原因。
   `apps/web/public/styles.css:6172` 才定义旋转，`:6174` 尊重 reduced-motion 而停止动画。
7. **启动/隐藏窗口并非统一由间隔控制。** app `:9779` 有一次 Electron 启动刷新；
   `:9807` 用索引生成时间小于一小时及 workload 可用判断 detailed 或默认入口，默认实际是
   overview。`:9843` 的 returning-user 路径是一次延迟加载后的刷新，不是 visibilitychange
   恢复处理。desktop controller `:477` 只要求主窗口存活、ready，关闭到托盘也符合条件。
   已查看的刷新入口没有独立的 OS resume/前台恢复采集触发；不要把常规定时器恢复当成它。
8. **托盘轮询是观察，不是另一额度采集器。**
   `apps/electron/desktop-status-monitor.js:17` 至 `:20` 定义固定路由、五秒观察周期和超时。
   `src/desktop-shell-status.js:429` 在 running 时返回 analyzing，使用现有 display evidence；
   当前 controller 在运行期间 result 为 null，notification evidence 通常要到最终回执才出现。
   长计算可能令开始时取得的通知证据在完成前过期，不能延长通知新鲜度来掩盖它。

# 推荐的职责与状态合同

## 一个业务调度权，保留清楚的轻重能力

- `apps/local/overview-refresh-scheduler.js` 是本地业务周期的唯一所有者；继续使用完成后计时。
  Electron 只把已持久化设置传入 companion，报告传递失败与已应用值；不再跑第二个小时维护周期。
  独立浏览器使用 companion 的默认或有效配置，不另有页面计时采集。
- `src/local-companion-refresh.js` 仍是执行、取消和运行回执所有者。内部能力明确为
  `quota` 与 `usage`：前者查询/持久化额度，后者依次索引、复用或计算、发布。
  初期可保留旧路由兼容映射，先在公共请求与回执中明确实际能力，别靠 quick 字样猜工作量。
- 默认自动周期和普通手动都请求额度加 usage，保持当前 overview 的产品新鲜度；
  usage 是否重算仍由已有 calculation revision、generation、时效与缓存证明决定。
  不新增“每小时才准计算”或另一个缓存层。详细入口的区别仅保留经证实必要的能力，
  如 reset detail 要求和显式恢复/继续语义；不要赋予“绕过所有有效缓存”的隐含含义。
- 轻能力保留给额度单独检查及将来被证明需要的重算期间观测。它不用重新跑 usage，
  也不替代 usage 的周期性更新。优先使用户正常操作清楚，不急于统一所有内部函数名字。
- Electron lease 是桥接连接健康，不再是业务运行的真相。优先让现有 watchdog 查询和恢复
  companion 连接；心跳失效不能授权另起重算，更不能替代 companion 的取消确认。
  旧 lease 迁移期间保留幂等结算/迟到回复清理，只逐步去掉其重新启动业务周期的职责。

该变更与当前已接受的
[Electron 刷新韧性决定](../decisions/2026-09-21-electron-refresh-resilience.md)
中“shell 拥有自动节奏”不一致。实施时需更新该决定及公开说明，明确保留的恢复保证；
不能悄悄让新代码与维护文档冲突。旧持久预约文件可以停止使用并保留，勿顺手删除用户状态。

## 一个运行回执，组件结果分开表达

扩展现有 refresh 状态，不增加另一套全局状态机。建议最少包含：稳定 run ID、请求原因、
请求/实际能力、running/cancelling/终态、当前阶段、额度阶段结果、usage 阶段结果、
已发布版本/时刻、下一自动时间。组件结果允许 skipped/reused/available/deferred/failed，
并带闭合原因码；整个运行只有要求的工作都到终态后才 settled。

额度发布、usage 发布与全轮完成是三个不同事件。先成功发布额度后 usage 失败，结果应为
“额度已更新；用量计算失败，仍显示上次结果”，不能返回全成功或抹掉有效额度。
失败观测保留上次值及其原始时间，另记录本次尝试失败时间。新查询得到相同数值可以是
新观测，但必须有实际有效 provider 回执；仅重读缓存不能刷新 observedAt。

# 额度与耗时计算：先发布解耦，再决定并发

## 当前不能直接并发的原因

`LocalCompanionDataStore.reload`（`src/local-companion-data.js:3672`）没有内部串行队列
或发布版本比较：await builder 后整体 clone 并替换 snapshot（`:3688`、`:3698`），
然后等待可选持久化。现有单任务流程提供了大部分顺序保证。额外启动一次 quick reload
可能让旧的 full candidate 晚到覆盖新额度；反向也可能退回 usage 视图。

quick reload 也不只是几字段赋值。server `:1003` 仅将统一索引投影改为 deferred；
snapshot builder `:2277` 仍读 accounting cache，`:2371` 读 collector 投影和其他派生材料，
再构造 snapshot。collector 投影虽已 off-main（`:2248`），最终候选验证、对象组装、
structuredClone、retention 合并和可选持久化仍有成本；不得称其常数时间或无阻塞。

数据库不是同一种锁策略：统一索引使用 WAL（`src/local-index-store.js:438`），
accounting scanner 和 calibration corpus 在只读事务中跨 await 保持一致快照
（`src/local-index-accounting-cache.js:448`、`src/local-index-calibration.js:91`）。
额度和 accounting cache 持久化则落入 collector store，它使用 DELETE journal、FULL 同步
（`src/local-collector-state.js:214`），短写事务为 BEGIN IMMEDIATE（`:658`），
数据库连接可等待锁五秒（`:499`）。collector 的逻辑锁从 `passive-collector.js:1802`
持有到 finally release（`:2215`）；并不是整个 usage 重算期间一直持有额度采集锁。
但共享 collector 数据库的长读、缓存写、完整性校验仍须实测，不能从 WAL 推断所有路径无争用。

CPU 已有可复用的让出机制：accounting scanner `local-index-accounting-cache.js:179`
按批 setImmediate；calibration `local-index-calibration.js:100` 使用 cooperativeYield。
继续用这些机制并检查遗漏的同步 SQL、排序、finalize、JSON/clone 阶段。
Promise/async 本身不保证事件循环响应；同步 SQLite busy wait 也会影响控制面。

## 第一阶段可实施的改动

先让 overview 与 detailed 都在额度持久化成功后走统一的早发布边界，仍保持单任务顺序。
UI 必须订阅这一发布版本，而不只是等 finishedAt。可以先复用现有 quick reload 获得
正确性，但要计时并明确它仍是较宽快照构造；不能据此承诺长计算中的周期额度更新。

然后在现有 data store 内抽出窄额度投影/发布方法，复用 provider 规范化、账户夹取和
collector 读取入口。只替换闭合额度字段、来源、新鲜度、独立额度错误和托盘显示证据；
不重建 timeline/calibration，也不把新额度值塞进旧计算的输入声明。
持久额度证据仍由 collector store 负责，快照只是展示投影，不产生新 ledger。

发布时捕获并验证运行代号、账户连续性、额度发布序列及取消状态。full candidate 完成后，
在 data store 的短同步发布区合并“当前最新且账户匹配的额度组件”，再一次性替换 usage
及其完整 generation metadata。重结果不得覆盖更晚的额度；若账户已切换，旧作用域结果
只能留在隔离历史，不能冒充当前账户。账户未知保持未知，不根据上一次身份倒推。
这里是有限字段合并与版本栅栏，不能扩成任意组件缓存框架。

## 第二阶段的条件性额度并发

只有第一阶段证明仍存在“重算超过用户间隔，额度因此长期陈旧”，且窄发布已独立，才启用：
现有 scheduler 按同一配置计算额度到期；现有 controller 内至多一个额度任务、一个重任务。
重任务存在时自动到期只补额度，usage 合并而不排队重跑。重任务自身开头的额度阶段与补读
共享一个 single-flight，不产生双 app-server 查询。两者可分别取消/结算，UI 仍有明确关联。

不要先引入 worker、常驻进程或新调度服务。先用合成大数据测查询到达、额度持久化、
额度发布、事件循环延迟和锁等待，复用已有 off-main 与 cooperative yield。
仅当明确的同步阶段无法合理分片并持续阻塞时，才将那个已识别的阶段移入现有 worker
边界或受控 worker；必须保留固定输入、取消终止、内存界限与结果栅栏。worker 不能解决
长事务锁或发布顺序问题。并发测试未通过时继续单任务与真实等待状态，不发布“已独立”。

# 各类触发与合并规则

| 触发 | 推荐语义 | 在途处理 |
|---|---|---|
| 启动 | 先展示本地 last-good；一次检查实际索引/额度状态，缺少或陈旧时请求同一刷新入口；判断迁入 companion，renderer 只报告 ready | 启动与周期/手动合并；每次 companion 生命周期最多一次初始化意图，不因页面重载重复 |
| 周期自动 | 默认 300 秒，usage 全轮结束后计时；有效缓存则复用，失败进入有界退避 | 加入可满足能力的现有任务，不累计每个错过的 tick |
| 普通手动 | 请求额度和 usage，展示“加入当前刷新”或“开始刷新”的真实回执 | 同能力直接加入；仅额度任务在途时用一个 pending usage 标记，额度结束后继续一次 |
| 详细/恢复 | 仅增加明确需要的详情或继续能力，保留已有恢复/覆盖判定 | 能力尚未执行则补充要求；已过阶段则最多一个合并后的后续需求，不能无限升级重启 |
| 前台恢复/OS resume | 立即读取状态并重绘年龄；到期且自动启用时最多提交一次请求；无需恢复即不采集 | 与周期到期合并，不补睡眠期间的每轮历史任务 |
| 间隔变更 | 持久设置成功后传递给 companion；显示 configured/applied 差异；重算下一 deadline | 不取消在途工作，不重启它；变更 revision 防止旧回执覆盖新配置 |
| 账户/相关输入变化 | 下一次 provider 夹取确认身份变化；相关输入按已有 revision/缓存证明失效 | 旧账户迟到结果不得发布到新账户；不以“设置改了”强行全局清缓存 |

“加入”只承诺观察同一任务及其能力，不承诺所有证据都采于本次按钮点击之后。
请求回执必须返回实际 run ID、能力和加入/待处理标志；客户端不能根据自己请求的 mode
推断实际工作。只保留一个有界后续需求集合，按能力并集折叠；不建立通用消息队列。
用户取消清除本次显式后续需求，下一周期至少等待正常间隔，不能立刻自动接着跑。

`-1` 当前停止 companion 周期和 shell 周期，但不阻止手动，也不阻止 app 的一次启动刷新。
建议最小迁移保持该行为并把设置明确命名为“周期自动刷新：关闭”；前台/恢复不得绕过关闭。
启动仍检查一次应在设置说明中写明。若产品希望“关闭所有自动采集”，则同时禁止启动采集，
只读本地缓存，保留手动和用户明确触发的首次设置操作；这是应确认的一个产品选择。
无论哪种定义，都不停止年龄展示、状态轮询、现有任务安全收尾或独立 X 刷新。

# UI、托盘与时间表达

统一将 companion 运行状态作为 busy、阶段、按钮和完成摘要的来源；本地 POST pending
只表示“正在提交”。自动、手动、另一窗口启动的同一运行都旋转；有 reduced-motion
时保持静态忙碌图标、文字及 aria-busy，不能拿动画作为唯一证明。

简洁主状态为：等待/运行/正在取消/已完成/部分完成/失败；运行阶段可写“读取额度”、
“索引本地记录”、“计算用量”、“发布结果”。额度成功后重算继续时显示
“额度已更新，正在计算用量”。重计算期间保留可读旧图表和其时效标签，避免全页 loading。
重试、缓存复用和退避必须分别表达，不伪造进度百分比或预计剩余时间。

时间明确分开：provider observedAt（额度年龄）、quotaPublishedAt（显示何时接收）、
index publishedAt/coverage（索引范围）、accounting evaluatedAt（计算依据时间，复用不改写）、
run finishedAt（本轮何时结束）。默认界面仅突出额度年龄和用量更新/计算状态，其余放详情。
年龄按当前时钟更新；休眠回来立即重算；未来观测或倒退时钟显示异常/未知，不钳成“刚刚”。
相同额度观测不会因为刷新完成而重置年龄；读到较晚的有效观测时年龄下降是合理变化，
但必须与真实新回执一致。

托盘与通知分别使用闭合的额度证据，不再让 usage 的总失败覆盖已验证的新额度状态。
通知资格仍遵守已有 app-server-only、账户连续性、去重和五分钟有效窗口；局部发布不是
通知政策放宽，更不能把日志快照或旧缓存提升为通知证据。显示与通知可不同步且有各自依据。

# 故障与生命周期边界

- provider 超时/离线/限流：额度失败不阻止本地索引计算；保留旧观测时间，记录本次失败；
  只使用已验证的 retry-after 或有界退避，手动不突破服务端冷却。不假设已支持某个限流码，
  新码需闭合 schema 与负例测试。额度成功、usage 失败同样不得互相抹除。
- 超时与取消：继承现有 AbortSignal、从开始计的总截止、取消 settlement 和持久写前检查。
  `local-companion-refresh.js:1711` 的普通超时只 abort 并先标失败，仍等 runner 结算，
  `:1743` 的强制脱离是取消 settlement；不要把二者说成同一机制。仍在退出的旧 writer
  不能因 UI 恢复就得到第二个 writer；迟到进度、builder、worker 回复都要检查运行代号。
- 自动失败：保留现有 accounting 内存预算退避；刷新调度错误/额度失败分别有界退避。
  恢复成功后回正常间隔；不使用无限紧重试。保留已有按签名限流的无内容诊断。
- 休眠/时钟调整：每次醒来按实际 deadline 重新判断；只请求一次逾期工作。
  duration 使用单调时钟，证据时间使用墙钟，未来时间不能自动视作新鲜。
- 退出：先停业务 scheduler，再阻止新请求并取消工作、关闭 owned workers/companion，
  保留已提交数据和 last-good；不得杀无关进程。重启读取 durable 事实，不回放过期的内存 pending。
- 账户切换/凭证不可用：前后账户夹取和现有秘密存储不变；不新增凭证读取渠道。
  不同作用域不能合并运行结果或沿用通知连续性；未知身份保持未归属。
- 权限与离线：状态观察不获得 mutation 权限；所有用户请求继续经过既有 loopback/capability
  校验。自动工作只沿现有允许的本地分析生命周期执行；迁移启动判断时不得借 renderer ready
  绕过 onboarding/会话检查。联网额度不可用时，本地历史仍可分析。

# 分阶段最小迁移与验证

| 阶段 | 文件归属与变化 | 验收边界 |
|---|---|---|
| 1A 入口与观察 | `apps/web/public/data-client.js`、`app.js`，`src/local-companion-refresh.js`、`apps/local/server.js`；回执实际能力、自动运行可见、局部发布版本 | 真实客户端→路由→controller 串联测试；自动与手动阶段/旋转一致；quick_result 不能误报完成 |
| 1B 单调度 | local scheduler/controller 继续拥有周期；Electron controller/runtime 停止小时业务 timer，保留桥接恢复；同步更新决定与设置说明 | 多个 renderer/启动/手动/设置竞态只有一个业务周期；关闭到托盘继续；-1 和传播失败可解释 |
| 1C 顺序早发布 | runner/controller 为 overview 提供同一额度早发布；data store 提供有限额度组件更新并保留 last-good usage | 额度成功后重算继续仍busy；usage失败额度不回退；账户/取消/旧candidate覆盖负例 |
| 2 条件性并发 | 仅在测量证实需要时，扩展同一 scheduler/controller 的额度 single-flight 与窄发布；改已识别阻塞点 | 长计算期间查询、持久化、发布均有界响应；无双writer、无陈旧覆盖、无过量请求 |

1A–1C 可按小补丁实施，先保留串行执行；“去掉小时 timer”必须与真实请求能力、启动语义和
健康检查调整同批落地，不能让旧 UI 根据没有 timer 判故障。缓存优化文件与计算合同保持原样，
除非新发布边界确实需要最小适配；不再设计计算缓存、rollup 或 schema migration。

先选现有定向测试扩充：`test/local-companion-refresh.test.js`、
`test/local-companion-data.test.js`、`test/desktop-shell-status.test.js`、
`apps/local/overview-refresh-scheduler.test.mjs`、`apps/local/server.test.mjs`、
`apps/web/test/refresh-policy.test.mjs`、
`apps/web/test/app-refresh-notice.test.mjs`、`apps/electron/test/desktop-refresh-integration.test.mjs`。
修复桩与真实客户端路由不一致的问题，并加一个实际 loopback 串联测试；不要只断言函数调用次数。

有意义的场景包括：自动运行被页面中途观察；弱请求在途时强请求；重复强请求；局部发布后失败；
新额度先发布、旧 full 后完成；账户改变；取消发生在 builder await 中；超时后迟到进度；
设置传播与 timer 触发竞态；-1、休眠超期、时间倒退；关闭到托盘、renderer 替换与恢复；
有效缓存复用时 evaluatedAt 不刷新。延续已有冷启动/长计算取消与恢复用例，不弱化超时。

条件性并发实验必须用合成或已授权保护副本，分别测 provider 调用、collector 锁等待、
commit、投影、发布、HTTP控制面和事件循环延迟。使用实际 SQLite 争用负例，检查 DELETE
数据库读写、WAL 长读和缓存写；单凭 mock 定时器不能证明不会堵塞。任何数字目标先记录为
待定验收预算，不从旧缓存微基准推导新端到端性能承诺。

按影响运行 owning local/UI/Electron 测试和 architecture gate；文档修改运行 docs:check、
test:preflight。不要求全量测试、重新打包或用户应用操作来完成本设计。实施后的真实 Windows
Electron 打包验收另行安排，观察额度早更新、图标、托盘、长计算、前后台和退出；浏览器通过
不算 Electron 或安装版证据。签名、安装、发布与 updater 不在此方案的当前授权范围。

# 仍需产品或运行证据决定的事项

1. `-1` 是仅停止周期刷新（推荐先保持当前行为并写清启动例外），还是连启动采集一起关闭。
2. 额度在长重算期间是否仍需遵守用户间隔；建议有需求时启用第二阶段，而不是先承担并发成本。
3. 当前新包真实控制面延迟、quick reload 成本、锁等待、动画是否卡顿及缓存命中率均未在本次
   验证。若顺序早发布加已有缓存已足够，阶段 2 可以不做。
4. accepted 刷新韧性决定、当前 Electron 健康文案及 API schema 的准确修改范围，应在实现前
   再对照维护文档和 owning tests；本方案不通过删除 watchdog 来换取表面简化。
