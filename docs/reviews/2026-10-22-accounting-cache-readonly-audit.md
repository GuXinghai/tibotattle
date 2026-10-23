---
title: Accounting result cache read-only audit
date: 2026-10-22
type: review
status: investigated
---

# 核算结果缓存只读调查

范围：当前工作区的索引刷新、核算结果复用、投影和工作负载结果缓存。
基线提交：`94cc26f3a63fc12b726fd47da8a83b44ba27e425`，含既有未提交改动。
本记录是调查时点证据，不是发布或安装版运行证明。

调查计划：

1. 核对缓存键、作用域、读写链和失效边界。
2. 分别核验索引变化、核算证明、投影及工作负载调用方。
3. 仅对必要结论使用合成数据定向验证，区分确认问题和未确认风险。
4. 汇报触发条件、影响、源码位置和最小修复建议；不修改实现或测试。

验收边界：保留现有工作区改动；不操作真实数据、不运行全量测试、
不打包、重启或安装应用。真实安装版状态未知。

## 结果与证据边界

发现五项可定位的问题，均建议在修复授权后分别处理。没有证据证明当前
安装版已经出现这些问题，也没有确认普通缓存命中会重复计价。
这里的缓存指应用计算结果；输入中的缓存读写 token 仍是价格计算的组成，
不与结果复用命中率混用。未发现调查必须进入 X 内容缓存的直接依赖。

环境为 Windows x64、Node.js 22.21.1。调查使用当前未提交源码；验证仅使用
内存替身或临时合成数据库。没有读取真实用户会话、修改生产代码或测试。

## 读写链与失效条件

| 层 | 键和范围 | 命中、失效与读写 |
| --- | --- | --- |
| 索引事实 | 每个源的身份、文件状态、parser 版本；提交代次及 calculation_revision | 追加/重扫在事务中提交事实和游标；事实、账号维度、套餐配额、谱系和重要来源状态变动推进计算版本。等价事实重扫可以只推进发布代次。源消失保留事实并标 absent |
| 核算进程内证明 | 单个 runner；数据库 dev/ino/birthtime、calculation_revision、与用量区间相交的速度窗口、已知 origin 的 autoReview 值 | 两次证明一致才 remember；命中仍须版本校验、零 fallback、weeklyApiIntervals available、原计算时钟不超过 30 分钟且不在未来。不同发布代次可重组元数据并落盘，同代次只返回克隆 |
| 核算落盘结果 | collector SQLite 的 accounting_cache 单个结果 | 完整 schema、价格注册表版本/观察时间、价格时期、来源模式/上下文与请求的 generation 共同校验；原子替换。不是跨重启恢复进程内证明。错误结果不覆盖 last-good |
| 共享索引投影 | 进程内一份完成结果与 pending map；indexFile、速度窗口、includeWorkUsage、exactWindow、codexHome、secretFile、发布指纹 | 时间成员有效期内返回克隆；exactWindow 要求相同 nowMs。并发同构建共享，最后订阅者取消时中止；失败不存入完成缓存。重启清空 |
| 工作分解服务 | 活跃快照的 period、scope、时间锚点、exactWindow、expectedGeneration；完成回退按 period 与 scope | 5 分钟 idle、最多两份；失败用标注 retained 的 last-good，另有重启恢复快照。这是 work-usage，不是 overview workload |
| 工作负载状态 | 当前 snapshot/previousWorkload 与独立 owner-only 持久状态 | readLocalIndexWorkload 每次读取事实和重算；保存的是 comparison baseline 与 capacityHistory，不是一个完整结果 memo。仅在 fresh 且 available/partial 时写回，但历史保留有下述问题 |

主要源码入口：[复用证明](../../src/local-index-accounting-reuse.js)、
[核算扫描](../../src/local-index-accounting-cache.js)、
[落盘核算](../../src/replay-safe-accounting-cache.js)、
[刷新编排](../../src/local-companion-refresh.js)、
[共享投影](../../apps/local/server.js)、
[工作负载](../../src/local-index-workload.js)。

## 确认问题

### 1. 延后重算的旧结果下一轮可能被标成已复用（P2）

- 触发：一次重算超出内存预算；退避期内下次 collector 报告零新增。即使
  原结果已超龄、速度声明或 origin 证明已失效，退避仍绕过证明和年龄门。
- 位置：`src/local-companion-refresh.js:1033-1064`，尤其 1062 根据
  rolloutRecordsWritten 单独选择 reused；1124-1126 设置 30 分钟退避。
- 最小证据：内存合成 runner，固定同代次、两小时前的旧结果；首次返回
  deferred，推进一分钟后返回 reused；重算次数始终为 1，第二轮没有
  accountingRebuildDeferred。读年龄限制依次为 1800000、null、null。
- 影响：延后状态被成功复用状态覆盖；“本轮没有新增记录”不能证明旧结果
  尚在年龄范围内，也不能证明数据库之外的计算输入没有变化。未证明金额
  一定错误，已证明状态不诚实。
- 最小建议：退避期间只有重新满足正常年龄与计算证明的结果才能标 reused；
  其余保持 deferred 和原计算时间。不要用 collector 新增数量代替证明。

### 2. 新代次后的预算失败无法通过现有路径读出保留的旧结果（P2）

- 触发：索引从 G1 推进到 G2，G2 核算超预算，磁盘还保留 G1。
- 位置：`src/replay-safe-accounting-cache.js:4383-4404` 无指定代次确认
  retained；`src/local-companion-refresh.js:1136-1155` 随后却按 G2 读取；
  `src/replay-safe-accounting-cache.js:5498-5513` 拒绝 G1。退避期的
  1045 行仍要求 G2；快照读取 2334-2341 行也要求当前代次。
- 证据：现有定向用例分别通过“代次不匹配拒绝”及“预算失败保留旧缓存”。
  源码串联确认 retained=true 不等于调用方能服务它。未运行真实 UI。
- 影响：所承诺的“保留且展示有标签的旧估计”路径在真实索引推进后失效，
  核算变 unavailable，可能转入其他数据源展示；并非旧 SQLite 行被删除。
  现有 runner 预算测试用恒定 generation 的注入 reader，不能覆盖此组合。
- 最小建议：保留严格的当前代次校验，另设明确 stale/deferred 旧结果通道，
  带原代次、计算时间和缺口说明。不能简单取消 generation 检查。

### 3. 源重新被发现后，skip 路径不恢复 present（P2）

- 触发：源曾因发现范围变窄或暂时不可见被标 absent；恢复发现时文件身份、
  大小和时间戳未变。不是“删除后重新创建”的所有情况。
- 位置：`src/local-index-source-digest.js:265-288` 分类不读 presence；
  `src/local-index-refresh.js:1107-1118` 标 absent，1223-1231、1244-1246
  直接跳过；恢复 present 位于 `src/local-index-store.js:1307-1310`，
  该路径未执行。`src/local-index-report.js:823-826` 统计只认 present。
- 隔离证据：真实 refresh 和发现链，1 个合成源、5 个事件。正常刷新为
  present/事件5/计算版本48；将 endAt 缩到源之外为 absent/事件5/版本49；
  恢复无结束限制后发现1、skip1，仍 absent/事件5/版本49。
- 影响：覆盖范围和 indexed source 统计持续错误，后续复用可延续错误元数据。
  事件仍为5，没有证据表明这条路径丢失或重复计算 token。
- 最小建议：将“重新发现”作为独立元数据事务恢复 presence 并推进代次/
  计算版本；无需为恢复状态强制重解析相同事实。

### 4. 切换套餐会抹掉其他套餐的派生容量历史（P2）

- 触发：已有套餐 A 的 capacityHistory，切到 B 后完成一次 fresh 负载计算。
- 位置：`src/local-index-workload.js:273-283` 先只保留当前套餐，并按显示
  窗口裁历史；313 行将裁剪结果返回，113-115 的 workloadState 直接保存；
  `src/local-companion-data.js:2922-2923` 写回持久状态。
- 隔离证据：临时合成库与状态，prolite 历史1条 → pro available/0条 →
  再回 prolite 仍0条。没有修改真实状态。
- 影响：丢失的是容量估计版本及当时 availableAtMs，不是原始用量或配额。
  未来可以算出新估计，但现有链没有恢复原“当时可用时间”的路径。
  相同写回也使显示窗口成为派生历史保留策略。
- 最小建议：展示筛选与持久历史保留分开，按套餐保留历史；裁剪需有独立
  明确的保留契约，不能让本次展示范围隐式删除累计证据。

### 5. 共享 workUsage 投影缺少外部元数据失效条件（P2）

- 触发：本地索引代次不变，但 Codex thread origin/父子关系或项目元数据
  更新，且投影时间成员仍有效。
- 位置：`apps/local/server.js:145-155` 键和命中条件只覆盖索引和选项；
  `src/local-index-companion-source.js:221-245` 与
  `src/local-index-report.js:891-916` 只证明索引时间成员；实际
  `src/local-index-work-usage.js:392-435` 读取外部关系并生成 autoReviewThreads
  和 threadFamilies，107-110 行还读取仓库来源。
- 隔离证据：给生产缓存组件注入固定指纹与有效期，外部 origin 从 unknown
  变为 auto_review；相邻两次读取只构建一次，缓存仍 unknown，直接读取则
  为 auto_review。外部真实 Codex 数据库变化尚未运行验证。
- 调用边界：server 986 行主读取 includeWorkUsage=true，未强制 exactWindow；
  1042 行 workUsage 查询由 query.exactWindow 决定。即使 exactWindow=true，
  同一查询截止时间的再次读取仍可能命中。不是全部请求都会跨时刻复用。
- 影响：项目/线程归属及审核分类可沿用旧值。未证明核算总金额受此投影错误
  影响；核算进程内证明已另外检查 origin，不能混为同一漏洞。
  主要消费面为工作分解接口；`src/application/work-usage.js:205-206,263,277`
  仅显式 endAt 请求启用 exactWindow，291-300 行允许并采用缓存原时刻。
- 最小建议：为外部元数据增加可验证版本，或分离索引数值缓存与需重读的
  外部分类。单纯数据库时间成员证明不能证明整个 workUsage 不变。

## 尚未确认的风险

- 多写者：单个控制器会合并/串行请求，源事实事务保证提交原子性；但
  refreshLocalIndex 本体未见每索引跨进程全扫描锁。并发调用能否从旧 catalog
  开始后互相覆盖、是否所有入口都有外部保护，尚未完成竞争实验。
- 数据库同路径替换：核算复用证明含文件身份；共享投影的 generation 指纹
  基于代次、schema/parser 与覆盖计数，不含文件身份。另一库若同代次和计数
  可能撞投影身份。未做真实替换验证，不能宣称已发生错误复用。
- 取消时的工作负载写回：builder 中的状态写入早于 DataStore 最终发布 fence。
  未复现旧候选写入后被取消/新候选覆盖的竞态，需要隔离调度验证。
- schema/parser 升级：索引有版本拒绝和迁移门，parser 纳入代次，核算 schema
  与价格版本校验存在；本次未运行迁移矩阵或安装版升级验证。
- 账号切换：账号维度与配额事实改变会推进计算版本；独立的实时账号归属
  和前台发布门仍需专门验证。本次不把未找到漏洞当作账号全链通过。

## 已确认的冗余与保守失效

- `src/local-companion-data.js:2289-2298,2334-2341` 对可用/超龄核算结果
  读取两次。第二次代次绑定有正确性目的，但每次实际读取和验证完整缓存；
  “cheap probe”不是仅查元数据。可以考虑复用已读不可变结果再验证来源，
  但必须保留并发 fence；本次没有测量耗时，不能给出收益数字。
- origin 不完整、超过 25000 sessions、进程重启会让复用证明失败；这是
  当前有意的保守门，不应直接删门来优化。定向用例确认过期克隆被释放、
  同代次命中不重复落盘、元数据重组保留原评估时间。
- 工作负载不是命中完整结果缓存后跳过全部计算：每次仍扫描指定证据范围。
  这本身不是缺陷，没有以猜测性重构作为修复建议。

## 验证记录

- 现有 `test/local-index-accounting-reuse.test.js`：1/1 通过，覆盖进程内
  证明、元数据代次变更、过期、origin/速度变更、取消及计算版本变化。
- 现有核算测试定向选择3项：代次失配拒绝、旧价格表拒绝、内存预算失败
  保留旧缓存，3/3 通过。没有执行完整测试文件集合或全量测试。
- 索引语义版本与中断回滚定向用例1项通过；这不等于全部迁移矩阵通过。
- 合成实验：runner 退避误标、真实发现链的 absent 恢复、容量历史套餐切换、
  共享投影外部输入变化。分别按上文界定证据，不当作真实运行证明。
- 文档治理检查通过；preflight 的根目录、diff whitespace、文档与指导规范
  检查通过（20/20 测试）。这是文档门，不是产品全量验证。
- 修复需要另行授权；本次只新增本报告，没有修改实现、测试或预览文件。
