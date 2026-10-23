---
title: Ledger normalization fixes and synthetic acceptance
date: 2026-10-22
type: review
status: implemented
---

# 用量归一化修复与合成验收

范围：修复[主账本核查](./2026-10-22-main-ledger-accuracy-audit.md)已确认
的重叠消除、身份冲突及速度归属问题。保留既有未提交改动，不触碰
负载卡片预览；真实数据仅只读。本阶段不重建真实索引，不提交、打包、
重启、安装或修改运行包，冻结历史缓存情景金额，不作发布验收声明。

状态：源码修复与必要合成验收已完成，主账本发布验收继续冻结。真实
历史尚未重算或重新验收；扩展浏览器文件仍有失败。本文不把修复效果
折算成真实金额，也不改变缓存可复用前缀未知的结论。

## 共同计量契约

1. 现代响应由线程/响应身份标识；raw是单次向量，turn/thread累计
   不能再次相加。相同身份的冲突显式失败，不能按来源先后择值。
2. 无法确认的旧/现代重叠失败并保留最后有效源事务。完整现代轮次
   按向量出现次数一对一匹配；未知前缀不能凭相同向量抹去旧增量。
3. 请求配置按来源记录顺序生效；同时间戳保留ordinal先后。请求
   已捕获的速度不被运行中的后续设置覆盖；缺失/矛盾保留未知。
4. 首个只有累计量的快照仅建立基线，未归属前缀保留覆盖缺口，
   不按当前请求时间/模型计价；后续可验证累计差分仍可计量。
5. 同步更新解析、检查点与派生计算缓存版本，不伪造数据库版本，
   不 relabel 旧结果；验证合成旧缓存失效、源回滚、增量/冷启动、
   来源顺序与故障路径。Windows受保护存储失败独立归因。
6. 仅跑必要的定向验证与文档/架构检查；合成与隔离结果不代表
   真实历史重建、运行包、原生窗口或账单验收。

共享响应reconciler由provider扫描、索引提取和checkpoint入口复用。
旧累计量、最新增量和独立响应raw向量保持不同语义；不能将累计快照
当作额外请求，也不能以相同token数量推断请求身份。依据为
[Codex Token Accounting](https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md)
及本地三个入口的合成对照；不是对真实账单的独立验证。

## 已实现的修复

- 完整现代轮次使用token向量多重集匹配，每个现代响应最多消除一个
  旧增量。未知前缀、缺少独立增量或多余旧记录明确报
  `codex_response_usage_legacy_conflict`，失败不替换已提交的源事实或游标。
- 同线程/响应身份的物理副本只有在计量与归属证据一致时才去重；
  数量、日期、模型、速度或组件可用性冲突报
  `codex_response_usage_identity_conflict`，不能按文件读取顺序择值。
  内存扫描和checkpoint采用内容无关的不透明证据摘要；checkpoint
  冲突会阻止继续使用该工作区。索引写入器在事务边界复核已存组件与
  归属；同源的版本化归属修复仍允许，响应数量不可改写。
  身份检查先于期间过滤；不能用冲突日期落到窗口外来绕过去重证据。
- 现代请求独立捕获速度，明确的未知不能回退到后来设置。新请求的
  已捕获速度不受运行中切换影响；切换后复用旧上下文则保持未知。
  同时间戳按原始ordinal阻止后写设置倒填；先遇到的未来设置不能使
  算法回退到更早速度。compactor的替代上下文单独不能证明先前速度。
- 无继承基线时，首个正累计快照且无latest增量只建立基线，不归入
  当前请求时间或价格。后续差分仍保留；用
  `cumulativePrefixUnattributed`及独立覆盖状态表达历史缺口。
  索引→计算缓存→快照→浏览器保留partial/null，仍可显示实际观测小计。
  已完成索引但有前缀缺口时不再声称等待刷新就能扩展这段历史。

### 保守冲突边界

混合来源中的首个total-only记录不能仅凭位置跳过。分页文件可能
通过`history_base`继承累计基线，首个物理记录也可能是有意义的增量；
重叠预扫描又从物理源起点读取，不能把append游标的累计量当成源起点
基线。缺乏该区分的记录继续显式冲突，不擅自消除或双计。这是明确
保留的可用性限制，需独立的带基线分页回归后才能放宽。

普通model reroute归属等尚未确认策略未扩改。真实历史受影响范围、
费用变化方向和修复后金额均未知。

## 版本、恢复与安全

| 边界 | 新版本 | 处理 |
| --- | --- | --- |
| Provider scanner | `codex-log-scan-v12` | 兼容元组同步，不将旧扫描结果标成新语义 |
| 索引提取 | `local-index-rollout-typed-v3+unified-rollout-typed-v22` | present来源在将来授权刷新时重解析；不存在的来源保留原始provenance |
| Checkpoint scanner | `codex-export-checkpoint-scan-v0.8` | 旧版无副本证据的检查点不能继续恢复 |
| 派生计算缓存 | `local-replay-safe-accounting-v0.24` | 旧缓存失效重算，不relabel |

物理SQLite `user_version`仍为8，没有为语义修复伪造迁移版本。旧parser
标签仍按已审查历史provenance读取，未来标签拒绝。只增加闭合诊断
词汇并通过canonical generator更新本地旧draft镜像；没有放宽上传
schema或执行导出、上传、R7重生成。

先前容量用例的失败独立定位为测试目录缺少Windows owner-only DACL，
不是token算法失败。该纯账本容量用例现在注入已有存储port，真正执行
64窗口上限断言；生产受保护存储与ACL检查未改变。
进程终止测试的Windows worker路径改用`fileURLToPath`，修复测试启动
路径后实际执行终止与恢复，不能把此前未启动worker算作恢复通过。

## 定向验证

环境：Windows x64、Node.js `22.21.1`，基于HEAD
`94cc26f3a63fc12b726fd47da8a83b44ba27e425`上的未提交工作树。
全部fixture为合成、最小且内容无关；临时SQLite及故障测试不使用真实
日志、索引副本或用户配置。

- `node --test --test-reporter=spec --test-concurrency=1 test/codex-ledger-parity.test.js test/codex-response-usage.test.js test/codex-response-model-recovery.test.js test/export-checkpoint-equivalence.test.js`：68/68通过。
  覆盖多对一反例、完整向量数量守恒、同源/跨源冲突及反向枚举、等价
  ISO时间、捕获速度、未知前缀、重放、源替换、游标回滚及checkpoint
  批次恢复；纯入口对照12项包含在这68项中，不重复累计。
- `node --test --test-reporter=spec --test-name-pattern="unverified prefix through the public history coverage|legacy cumulative prefixes" test/local-companion-data.test.js`：选中2/2通过，真实公共流水线使用合成索引及generation绑定缓存，校验浏览器覆盖归一化与无误导的刷新提示。
- `node --test --test-reporter=spec --test-name-pattern="history coverage only becomes complete" apps/web/test/lib.test.mjs`：选中1/1通过，包括非法前缀计数保持未知。
- 最后复核新增窗口外冲突反例：checkpoint在修复前漏报，修复后两个
  来源顺序均拒绝。`node --test --test-reporter=spec --test-concurrency=1 test/export-checkpoint-equivalence.test.js test/export-checkpoint-workspace.test.js test/export-checkpoint-process-death.test.js`：最终25/25通过；
  `node --test --test-reporter=spec test/codex-ledger-parity.test.js`：最终12/12通过。
- `node --test --test-reporter=dot --test-concurrency=1 test/export-checkpoint-equivalence.test.js test/export-checkpoint-workspace.test.js test/export-checkpoint-process-death.test.js test/export-contract.test.js test/export-paginated-reset.test.js test/codex-speed-baseline-ledger.test.js`：通过，包括实际子进程终止恢复、旧checkpoint版本拒绝和容量断言；与上组部分重叠，不相加宣称总测试数。
- 索引迁移、parser兼容族与旧计算缓存拒绝的定向用例通过。
  `pnpm run telemetry:check`、`pnpm run telemetry:browser:check`、
  `pnpm run telemetry:upload-schemas:check`和`pnpm run architecture:check`
  通过；不代表全套surface验收。
- `node --test --test-reporter=spec test/api-surface-reference.test.js`：1/1通过。
  `pnpm run docs:check`通过；`pnpm run test:preflight`通过，包含20项文档
  治理/agent指引用例、根目录策略及工作树空白检查。

### 未通过的扩展浏览器门

扩展执行`node --test --test-reporter=dot apps/web/test/lib.test.mjs`退出1，
有10项失败：native首次渲染ready两项、主导航项数一项、周窗口与历史
plan选择两项、live timeline容量一项、降级说明一项、exact windows
渲染与质量两项、LOWESS plan筛选一项。失败落在页面源码匹配、导航及
渲染期望；本阶段没有改动这些渲染实现，也未为通过测试修改负载预览。
没有可用的干净基线对照，因此不宣称这些失败已经证明为既有缺陷。
新增覆盖状态定向通过不替代这个未通过的文件门。

后续[浏览器逐项核查](./2026-10-22-browser-test-failure-audit.md)确认九项
由CRLF与测试抽取的LF假设冲突触发，一项为HEAD已有的导航期望过时。
该后续仅修复测试边界与契约，产品渲染未改；上面的十项失败仍是此前
那次运行的证据，不改写成当时已经通过。

## 剩余验收边界

未执行全量测试、真实私有索引副本重放、真实历史重建、原生运行包或
安装版验证。源级合成迁移及事务故障通过，不代替真实副本的版本、
游标、缓存失效、数量和归属差异核查。真实索引的后续迁移仍需独立
授权与隔离副本验收；不能因本次修复自动触发。

历史缓存条件情景继续冻结：一方面可复用前缀未知，另一方面底层历史
用量账本尚未重新验收。未来即使重算金额相近，也不构成可验证缓存
损失或提供方账单。源码、当前应用、历史统计与发布验收四者保持分离。
