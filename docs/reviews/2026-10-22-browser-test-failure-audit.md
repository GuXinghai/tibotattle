---
title: Browser test failure attribution and focused repair
date: 2026-10-22
type: review
status: implemented
---

# 浏览器十项失败的归因与定向修复

范围：逐项核查上次[主账本修复记录](./2026-10-22-ledger-normalization-fixes.md)
保留的十项浏览器失败，只修复已证实问题。保留全部无关未提交改动，
不改产品渲染、负载卡片预览、真实数据或运行包，不提交、打包、重启
或安装；没有调用真实接口。

验收边界：先复现十项，再用只读子进程对照当前/HEAD源码文本及
LF/CRLF换行。该对照仅覆盖测试读取的文本，不冒充整仓HEAD测试或
原生运行验收。确认原因后只改测试读取与已过时的导航契约，保留
原有行为断言，并用换行对照和负向注入确认没有放宽断言。

结论：这十项中没有确认产品运行逻辑回归。九项是源码抽取断言依赖
LF，另一项是HEAD已有的导航期望过时。只修改了
`apps/web/test/lib.test.mjs`及本次核查文档；产品源码保持原字节。
这不撤销主账本真实历史及原生运行包尚未验收的边界。

## 归因方法与界限

环境为Windows、Node.js `22.21.1`，HEAD
`94cc26f3a63fc12b726fd47da8a83b44ba27e425`及原有脏工作树。核查开始时
`app.js`、`index.html`与`lib.test.mjs`均为CRLF，`styles.css`为LF。
仓库`.gitattributes`规定`eol=lf`，HEAD相关blob亦为LF；没有修改Git
配置、重写产品文件换行或切换工作树。

在独立Node测试子进程中，用`--import`临时覆盖`fs.promises.readFile`，
只替换测试读取的`app.js`、`index.html`、`styles.css`与
`src/local-companion-data.js`文本。HEAD文本通过只读`git show HEAD:<path>`
取得；所有导入模块仍来自当前工作树，故这是源码文本反事实对照，
不是完整HEAD checkout的测试。没有写回任何被替换文本。

| 修复前的对照 | 选中十项的结果 |
| --- | --- |
| 当前原始文本 | 0通过、10失败 |
| 当前文本统一LF | 9通过、1导航失败 |
| HEAD文本LF | 9通过、1导航失败 |
| HEAD文本统一CRLF | 0通过、同样10项失败 |

因此，九项失败的触发条件不依赖本轮计量逻辑，HEAD的原有测试抽取
方式也不能承受CRLF。没有本轮开始前的字节快照，不能断言哪一次编辑
写入了CRLF。导航中的桌面X入口则明确存在于HEAD；最后相关提交
`a65bd7ed`已包含它，四入口总数断言没有同步。

## 逐项结果

| 原失败用例 | 直接失败点 | 已确认原因 |
| --- | --- | --- |
| native dashboard readiness follows both first-render outcomes | readiness marker的结束边界找不到 | 字面LF边界遇到CRLF；函数存在 |
| native dashboard readiness does not wait on secondary companion reads | dashboard loader结束边界找不到 | 同上；主结果与可选读取顺序断言未被执行 |
| timeline keeps time, uncertainty, and primary navigation explicit | 全部导航被断言为四项 | HEAD已有第五个默认隐藏的desktop-only X入口 |
| the weekly headline is a stable all-data median and says so on screen | plan-label helper结束注释找不到 | 字面LF边界遇到CRLF |
| the historical allowance headline and history use one selected plan without changing current pace | 同一个plan-label helper抽取失败 | 同上 |
| live timeline couples speed-priced usage to the matching allowance capacity | liveTimelinePoints源码正则不匹配 | 结束函数/空行边界依赖LF |
| self-resolving degraded notes are classed informational and keep the quiet style | informational matcher正则不匹配 | 声明与正则间的换行依赖LF |
| the exact-windows table pages ten rows at a time and states the shown range | inspection-table renderer结束注释找不到 | 字面LF边界遇到CRLF |
| exact comparisons explain quality without mistaking agreement, missing estimates, or unknown states | 同一个inspection renderer抽取失败 | 同上 |
| LOWESS is drawn exactly from the filtered allowance history | 同一个plan-label helper抽取失败 | 同上 |

## 最小修复

测试文件的文本读取边界将CRLF转换为LF，二进制读取保留原值。原有
行为、顺序、价格容量配对、分页、未知状态和LOWESS断言全部保留；
没有把产品代码重排成测试要求的形状。

导航断言分别要求四个通用入口按原顺序出现，以及恰好一个桌面专用
入口`x`，并验证它带有`hidden`。任意额外入口、X丢失desktop-only属性
或提前可见均不能通过。已有的X capability运行逻辑用例也单独验证。

## 验证

- 修复前整个`apps/web/test/lib.test.mjs`：192项，182通过、10失败。
- `node --test --test-reporter=tap apps/web/test/lib.test.mjs`：修复后
  192/192通过，0失败、0跳过。选中原十项分别在LF及CRLF文本覆盖下
  均为10/10通过。
- `node --test --test-reporter=spec --test-name-pattern="X navigation is available only through the desktop capability" apps/web/test/navigation.test.mjs`：选中1/1通过。
- 四个独立子进程负向注入：移除readiness函数名、增加未知导航、
  移除X的hidden、移除X的desktop-only属性；各自目标用例均以
  `ERR_ASSERTION`失败，确认未通过放宽断言获得通过。
- 核查前后SHA-256比较确认`app.js`、`index.html`、`styles.css`完全
  相同；这些文件内已有的未提交改动均保留。
- 仅在内存中撤销本次三处测试编辑后，所得字节与开工时测试文件的
  SHA-256完全相同，确认旧的未提交测试改动没有被覆盖。

`pnpm run docs:check`与`pnpm run test:preflight`通过；后者包含20项文档/
指引治理用例及工作树空白检查。没有执行全量浏览器套件、真实
数据渲染或Electron/安装包验收，也没有重算历史费用。此前十项失败
记录保留为当时证据，由本文补充解释。
