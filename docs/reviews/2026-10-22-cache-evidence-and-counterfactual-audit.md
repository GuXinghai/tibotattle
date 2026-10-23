---
title: Cache evidence and counterfactual accounting audit
date: 2026-10-22
type: review
status: implemented
---

# 缓存证据与反事实计价核查

范围：在现有未提交改动之上核查单次用量、去重、相邻顺序、可复用前缀
基准与缓存差价。仅只读真实内容无关事实，不把真实会话或用量样本写入
仓库或测试；不提交、打包、重启、安装，不修改负载卡片预览。

验收计划：

1. 核验官方前缀/断点、诊断估计、写入计费、保留期和Codex用量语义。
2. 追踪本地现代response事实与旧累计增量、去重、分叉及字节顺序；以
   一致只读快照检查真实内容无关事实覆盖，区分请求与无法分解的增量。
3. 将实际API等价费用、不可验证的前缀损失和相邻计数条件估计明确分开；
   历史证据不能证明C*时返回未知，禁止升级为真实损失、下界或账单。
4. 最小修正计算、归一化、显示和文档中的已确认问题；只用合成边界做
   定向验证，保留缺失、顺序不明、压缩、取消及资源边界。
5. 汇报源码、真实只读分析和运行包的各自证据；未知部分不造数。

## 官方来源

- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Codex token accounting](https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md)
- [Codex credit pricing](https://learn.chatgpt.com/docs/pricing)

诊断的miss数量也是估计，不等于账单中的可避免成本。五分钟是本地
分析邻近窗口，不是缓存TTL；半数门槛是严重度分类，不是价格规则。

## 结论与证据边界

相邻记录的缓存读取量不包含token身份或前缀等价证据。即便模型、设置、
输入长度和两次读取计数都已知，仍可对应不同前缀、路由或缓存状态。
因此旧算法不能识别本次原本可命中的C*；输出数值既不是实际可避免损失，
也不是已证明的损失下界。删除半数门槛只能改变情景的采样范围。

官方diagnostics的`cache_missed_tokens`也是估计，文档要求用usage字段
衡量实际读取和计费。不能假定Codex本地日志具有这项API诊断，更不能
事后发送真实会话来补造证据。此次没有调用任何推理、诊断或账户实验API。

实际用量的API等价核算保持原有独立账本；缓存分析现在明确分为：

- 观测：读取计数、边界、正向计数变化及其观测单位。
- 可验证损失：前缀未验证，token与金额均为null，不填零。
- 条件情景：以先前读取计数为假设基准的输入重定价；假设不等于C*。

`complete`及`coveredSubtotal`只描述边界、价格和被纳入的子集。
价格算得精确不能把前缀证据升级为已验证。

## 当前条件情景的精确定义

令本次普通输入为U、缓存读取为C、缓存写入为W，总输入T=U+C+W；
先前观测的读取计数为B。现有资格规则仍要求完整非负输入证据、可用
设置、非负间隔、无压缩干扰及T不小于B。B不是已确认的可复用前缀。

被重定价的条件数量为`D=min(max(B-C,0),U+W)`。D>0即进入情景，
不再要求C不超过B的一半。半数边界只用于图表的两组计数。
在上述资格条件内，`U+W=T-C>=B-C`，所以实际上
`D=max(B-C,0)`；min只是防御上限，并不进一步收紧有效样本。
普通输入优先分配`qU=min(U,D)`，余量`qW=D-qU`来自缓存写入：

`(U,C,W) -> (U-qU,C+D,W-qW)`。

这是固定的分配假设，不是从日志识别出的缓存失效位置。输入守恒，输出
完全不变，两边使用本次模型、事件日期及不变的总输入上下文T计价。
当qW大于0时，把写入视为本可读取是额外的反事实假设；差额取决于
写入类别和寿命。正式定价器只能保证所选假设的算术，不能证明该替换。
差价由同一正式定价器计算两次，再以纳美元精确相减。没有跨模型重建
“如果仍用前个模型”的请求；未知写入价格、缺失或矛盾输出继续未定价。

速度依次使用请求观测、覆盖该时刻的已声明设置，最后才是明确的
Standard/Fast假设情景。两边使用相同情景。未解析速度的两种结果不是
概率置信区间，更不能通过当前配置倒填历史。

GPT-6.1 Sol官方当前短上下文Standard费率为普通输入2美元/百万、
缓存读取0.10美元/百万。若另有证据确认C*，40,000个原本可读、实际
按普通输入处理的token差价为0.076美元。30分钟及12小时写入使用
不同总费率，不能在普通输入费之外再叠加；缺少写入量/生命周期时不能
擅自套用。Codex信用计费没有单独写入费，API-key使用另遵循API价格；
这不授权将本地API等价金额当作订阅账单或额度内部公式。

## 用量单位、去重与顺序

现代`token_usage_record.usage`提供逐response向量，同一turn内允许多个
response；turn累计量用于链校验，不再次作为新增费用。response身份
用于重复副本、冲突与外线程分叉处理，原始身份不进入此次报告。

旧`token_count`可来自last向量或累计快照差分。差分可能跨越多个缺失
response，last-only也缺少逐response身份；故不能把每个旧事件当作
一个请求。此次不改变其主账本增量或去重策略。

存量索引已有response标记，此次在精确/物化两种候选读取中同时传播
当前和前驱标记。只有两端都为严格值1的比较记为`responsePairs`；
其余记为`unresolvedIncrementPairs`。两者之和必须等于纳入的下降数量。
这描述观测单位，不是C*或因果证据。

同一来源内使用原始字节顺序配对，而不是按可能回退或相同的时钟排序。
负时间间隔不进入估算；多来源会话无法证明跨来源顺序时仍整组暂缓，
每个受影响会话只提供一个顺序覆盖缺口，不能当作一个遗漏请求。

## 实现及兼容性

`src/cache-switch-impact.js`对所有合格正向下降计价，保留半数分类；
每个summary增加闭合的`estimateEvidence`和`observationUnits`。
证据schema版本1的方法名为`adjacent_cache_read_decrease`，前缀状态
固定`unverified`，`verifiedLossTokens`与`verifiedPremiumUsd`固定null。
`src/local-companion-data.js`保留该信息，并关闭从此启发式情景换算
额度损失百分比，理由为`reusable_prefix_unverified`。

浏览器保持旧半数快照的可读性，但标为
`adjacent_cache_read_decrease_legacy_half_threshold`，不将旧金额伪装成
已经按新范围重算。新连续性计数满足`cacheReadDrops`等于半数以下组
加半数以上但较前次减少的组；旧方法仍保留原有不变量。近期详情也按
方法区分，不能一边纳入金额、一边继续过滤小幅下降。

归一化严格拒绝未知方法、伪造verified金额/token（包括0）、额外字段、
字符串单位计数及分区不守恒。总量、分桶和模型方法必须一致；模型证据
有误时保留有效总量，明确模型不可用。矩阵绘图不重算分桶或统计量。

三语言界面明确“条件差价情景”和前缀未知；读取量的50%比例不再被
表述成前缀内容复用。语言镜像通过既有生成器生成。没有修改数据库
schema、原始会话、价格注册表、主用量账本、负载卡片或预览。

## 真实只读核对

通过既有owner-only入口，以`readOnly:true`打开当前本地派生索引，
再启用`PRAGMA query_only=ON`，在一个事务中限定已提交游标读取。
仅计算匿名数值和白名单诊断聚合，不读取源路径、原始身份或会话内容。
读取已有声明速度账本，不读取密钥、不观察或重写当前Codex设置。

新旧门槛比较使用同一候选集合、时钟和速度账本；旧门槛只排除介于
前次一半与全部之间的正向下降，因此比较的是门槛对条件金额的影响。
不是将两个不同时间的后台快照相减。核查发现后台发布代数会前进，
并另行验证了发表代数与读取事务代数一致的一次对比。

真实金额、数量及观测单位分布仅在本地交互中报告，未写入测试fixture
或仓库。历史存量不含可复用前缀或cache-miss诊断列；不能给出经过证明
的非零损失总额。没有刷新、迁移、重建、改写或清理真实状态。

## 未确认风险与剩余门

旧/现代重叠消除仍有向量匹配分支；旧首个total-only观测在provider与
index入口的选择也不同。静态差异与合成探针不足以证明真实多计/少计，
此次保留并标明观测单位未知，不凭猜测重写历史账本或去重策略。
后续独立的[主账本核查](./2026-10-22-main-ledger-accuracy-audit.md)
已复现重叠消除、冲突副本及速度归属的合成缺陷；真实历史受影响量
仍未知。原有缓存情景测试通过不能升级为主账本准确性验收通过。

本报告对应的历史条件情景快照冻结，不作为经验证的当前统计。它同时
受两项独立限制：可复用前缀未知，底层历史用量与价格归属尚未重新验收。
后续[归一化修复](./2026-10-22-ledger-normalization-fixes.md)通过合成回归，
也不能消除这两项限制；真实索引与运行包仍未更新。

没有获取或保存完整请求前缀、缓存键/断点、缓存资格及驱逐状态。
读取会话正文也不能可靠补回服务端隐藏上下文或路由状态，因此没有
扩大私有内容访问。将来引入诊断必须另行审核闭合、内容无关的证据
契约、可用性和估计性质；不能把诊断默认升级为真实可避免损失。

源码验证不代表运行包或原生窗口验收。本次没有提交、打包、安装或
重启，已运行应用仍可使用其原资源；不会为了验收越过用户边界。

## 定向验证

基于工作树HEAD `94cc26f3a63fc12b726fd47da8a83b44ba27e425`，
Windows、Node.js `22.21.1`，保留原有未提交改动。全部用例使用合成
数据或静态契约，不使用真实私有记录作fixture。

- 核心、索引配对、现代response用量、托盘摘要及跨来源顺序：
  `node --test --test-concurrency=1 test/cache-switch-impact.test.js test/local-index-pairing.test.js test/codex-response-usage.test.js test/local-tray-cache-summary.test.js test/local-index-cache-drop-links.test.js`，73/73通过。
- 浏览器金额归一化与矩阵：
  `node --test --test-reporter=dot apps/web/test/cache-switch-impact.test.mjs apps/web/test/cache-reuse-matrix.test.mjs`，52/52通过。
- 托盘自定义、弹窗及本地化文案：
  `node --test --test-reporter=dot apps/web/test/electron-tray-customization.test.mjs apps/web/test/electron-tray-popup.test.mjs apps/web/test/localization-copy.test.mjs`，55/55通过；不是原生窗口验收。
- `pnpm run architecture:check`通过；浏览器i18n镜像检查、i18n基础
  定向用例及API参考契约通过。
- `pnpm run docs:check`与`pnpm run test:preflight`通过。

未运行全量测试、打包或安装版验证，未触发真实索引刷新或重新计价。
