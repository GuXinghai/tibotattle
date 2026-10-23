---
title: Accounting result cache fixes
date: 2026-10-22
type: review
status: implemented
---

# 核算结果缓存修复

范围：修复[只读调查确认的五项问题](./2026-10-22-accounting-cache-readonly-audit.md)。
基于 `94cc26f3a63fc12b726fd47da8a83b44ba27e425` 的既有未提交工作区；
仅证明本次源码与合成定向验证，不证明运行中或安装版应用。

用户已授权修复，保留既有改动、不触碰负载卡片预览、仅使用合成数据，
不提交、打包、重启或安装。调查中的未确认风险不在本次修复范围。

## 计划与验收

1. 退避结果须满足正常计算证明和年龄条件才可标已复用。
2. 保留严格的当前代次读取，旧代次仅通过有来源和时间的 stale 通道返回。
3. 重新发现的相同源恢复 present，事实不重放，代次及计算版本可观察。
4. 当前套餐/显示窗口只筛选计算输入，不裁剪持久容量历史。
5. 含外部工作归属元数据的投影不按数据库单一证明复用已完成结果。
6. 补充合成回归，核对取消、last-good、边界和现有正常复用的相关用例；
   只跑定向测试及必要架构/文档门。

## 实现与验证

1. `src/local-companion-refresh.js` 保留正常年龄、计算证明及周区间条件。
   退避期不再因 collector 零新增就将超龄或未证明的结果改标 reused。
2. `readReplaySafeAccountingCache` 新增默认关闭的
   `includeStaleGeneration`。开启后仍保持 unavailable/current cache null；
   只将当前 schema、价格及来源验证通过、零 fallback 且有非未来时钟证明
   的旧代次放入独立 staleCache。runner 标 deferred，并报告原代次且
   generationMatched=false。快照仅通过 staleServe 返回旧成本标量，保留
   原代次、指纹、计算时间和覆盖区间；旧套餐容量及校准输入保持不可用。
   浏览器 DTO 归一化保留来源，缺少指纹则拒绝该旧结果。
3. `src/local-index-refresh.js` 将重新发现与事实重解析分离；通过 writer 的
   条件式 markPresent 在事务内恢复 presence。触发器推进计算版本，只有
   实际改变时发布代次。取消及相同源重复刷新不制造新发布或重放事实。
4. `src/local-index-workload.js` 返回完整合法容量历史用于持久化；只将
   当前套餐/显示窗口所需片段传给计算。切回套餐不移动原 availableAtMs。
   沿用原4096条状态上限，新增版本超限时明确失败并保留 last-good，
   不隐式裁旧证据。持久状态 schema 不变。
5. `apps/local/server.js` 不再缓存已完成且 includeWorkUsage=true 的投影，
   因数据库指纹不能证明外部项目、父子关系及审核分类不变。相同键/时刻
   仍共享在途构建，各订阅取消独立；纯 companion 缓存继续保留。
   工作分解服务的新 initial query 会构建新快照；显式 snapshotId 继续
   保持原有分页冻结语义，无需修改该服务。

权衡：当前生产主快照也请求 workUsage，因此包含它的完整投影会重读。
这避免旧外部分类继续命中，没有新增昂贵或不完整的外部指纹机制。
没有优化调查记录中的重复读取，也没有改并发写者、同路径数据库替换、
取消写回等未确认风险。

## 合成验证

Windows x64、Node.js 22.21.1；以下均使用临时合成状态或内存替身。
新增10项回归，覆盖退避误标、真实旧代次reader/runner/snapshot全链、
来源恢复、套餐与时间窗历史保留、容量上限、外部元数据更新及并发取消。

| 定向验证 | 结果 |
| --- | --- |
| 刷新、reader、来源恢复、容量历史与共享投影的明确名称筛选；包括现有取消及临时 loopback 路由用例 | 29/30 通过；下述单项版本断言失配 |
| `test/replay-safe-accounting-stale-serve.test.js`，当前及旧语义 stale 合约、价格拒绝、原子替换、浏览器 DTO | 7/7 通过 |
| `pnpm run architecture:check` | 通过，607 production files、2411 imports、0 approved debt edges |
| `pnpm run test:preflight` | 通过，文档治理、root layout、whitespace、指导规范20/20 |

唯一未通过项是 `test/local-index-workload.test.js:33` 的既有
`overview-workload-v5` 断言，而当前并行工作区的 quota-analysis 已返回
`overview-workload-v6`。同批容量历史新增回归全部通过。该版本断言及
负载算法/卡片预览均保留，未为取得绿色而放宽断言或修改并行工作。
因此不能声称本次全部选中用例通过，也未执行全量产品门。

## 改动与剩余边界

- 实现：核算 reader、runner、快照 stale 消费与必要 DTO 归一化，索引
  presence 恢复，容量历史保留和共享投影完成缓存条件。
- 测试：六份对应测试文件追加合成回归，保留既有测试及工作区改动。
- 文档：更新维护中的本地索引契约及用户刷新说明，原只读调查保留为
  修复前证据。
- 未读取或改写真实数据库、设置、会话及输入记录；未操作运行中应用，
  未提交、打包、重启或安装，未触碰负载卡片预览文件。
- 未作真实 UI、安装版或发布验证；本报告不提供这些证据。
