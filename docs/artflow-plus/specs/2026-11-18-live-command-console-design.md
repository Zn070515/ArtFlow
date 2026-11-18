# Live 现场指挥台设计

- **Status**: proposed
- **Date**: 2026-11-18
- **Scope**: `/live/$activityId` 顶部新增 `LiveCommandBar`；纯前端投影现有 `LiveState`；不改命令、事件、表、后端读模型
- **相关**: [GOAL](../../../GOAL.md)、[live-service](../../../plus/packages/runtime/src/live-service.ts)、[Live 前端视觉](../frontend-design-direction.md)

## 0. 生命周期修正（设计前审阅）

1. **`LiveState.session` 只包含运行中的 judging 会话**（`findRunningSessionByScope`）。闭幕后为 `null`，没有“已关闭”字段；指挥条只能显示 **运行中 / 未启动**，不能声称“已关闭”。
2. **无会话时 mode 默认 `formal` 只是读模型默认值**，不是用户选择的模式；指挥条在无会话时不显示“正式”，只显示“未启动”。
3. **`readyToScore` 不能只看 session + performance**：还要求轮次为 `scoring`、面板 `current`、表演 `open`、席位达到 `minimumJudges`。
4. **“当前”只能是 `open` 表演**；没有 open 时不能把最近 locked 表演当作当前，应显示“待开始/等待锁定/等待解析”。
5. **HOLD/未解析排名会阻塞下一轮**：当前轮 locked 但 `ranking.status === "hold"` 或尚未 resolved 时，下一轮不应被当作“下一”；应显示“先处理 HOLD/解析排名”。
6. **下一轮可能尚未 prepare**（`round === null`）：显示“准备第 N 轮”，不能假装有表演。
7. **活动 closed/archived 时命令不可执行**：指挥条只读，不能提供“去启动/去开始”；全部轮次 resolved 时显示“全部轮次已完成/待发布赛果”，不把“启动会话”当主操作。

## 1. 目标与非目标

### 目标

- 组织者在现场一眼看到：会话、当前轮次/表演、下一位、评委席位、评分进度、HOLD/异常。
- 只做状态与跳转；命令仍由现有会话/轮次/异常/平局面板执行。
- 纯投影：用 `LiveState` 的 session、rounds、panel、seats、performances、ranking、participantNames。
- 权限不足时只读；无会话、未准备、已结束、HOLD 都有明确状态。

### 非目标

- 不做现场大屏/TV、倒计时、自动推进。
- 不在指挥条复制 start/close/advance/lock/score 命令。
- 不新增异常/修正计数接口；异常卡已有数据，指挥条只链接。
- 不扩展 `LiveState` 增加 closed session；第一版接受“未启动”语义。
- 不改右侧面板与轮次表布局。

## 2. 数据与阶段

### 2.1 `deriveLiveCommand(state, options)`

```ts
type LiveSessionState = "none" | "running";
type LivePhase =
  | "inactive"       // 活动 closed/archived
  | "no_session"     // 无运行会话，轮次未完成
  | "awaiting_start" // 焦点轮次 prepared/scoring，但无 open，有 not_opened
  | "scoring"        // 焦点轮次有 open 表演
  | "round_scored"   // 焦点轮次全部 locked，轮次仍 scoring
  | "round_hold"     // 焦点轮次 ranking hold，或 locked 未解析
  | "round_resolved" // 焦点轮次 resolved，有下一轮
  | "completed";     // 所有轮次 resolved

interface LiveCommandView {
  session: LiveSessionState;
  mode: "test" | "rehearsal" | "formal" | null; // 仅 running 时
  phase: LivePhase;
  focusRoundKey: string | null;
  focusRoundIndex: number | null;
  current: {
    performanceId: string;
    sequence: number;
    participantId: string;
    scoreCount: number;
    expectedJudges: number;
  } | null;
  next: {
    kind: "performance" | "round" | "blocked";
    roundKey: string;
    roundIndex: number;
    sequence?: number;
    participantId?: string;
    label: string;
  } | null;
  rounds: {
    key: string;
    index: number;
    state: "none" | "prepared" | "scoring" | "locked" | "resolved";
    lockedPerformances: number;
    totalPerformances: number;
    hold: boolean;
  }[];
  seats: { assigned: number; expected: number; minimum: number };
  readyToScore: boolean;
  activityStatus: "draft" | "active" | "closed" | "archived";
}
```

推导规则：

- `session = state.session === null ? "none" : "running"`；`mode = state.session?.mode ?? null`。
- **焦点轮次**：按 config 顺序第一个 `round.state !== "resolved"` 的轮次；全部 resolved 则 `completed`。
- 焦点轮次 `round === null` → 有运行会话时 `awaiting_start`（“准备第 N 轮”），无会话时 `no_session`。
- 焦点轮次 `prepared/scoring`：
  - 有 `open` 表演 → `scoring`，current=该表演；next=同轮下一个 `not_opened`，否则下一轮/本轮结束。
  - 无 open 且有 `not_opened` → `awaiting_start`，current=null；next=最小的 `not_opened`。
  - 无 open 且无 `not_opened` → `round_scored`；next=null（“去锁定回合”）。
- 焦点轮次 `locked`：
  - `ranking.status === "hold"` 或 ranking 为空 → `round_hold`；next=`{kind:"blocked", label:"先处理 HOLD/解析排名"}`。
  - 否则 `round_resolved`（等待 `resolveRound`/进入下一轮）；next=下一轮。
- 焦点轮次 `resolved` → 取下一个未 resolved 轮次。
- 下一轮未 prepare → next=`{kind:"round", label:"准备第 N 轮"}`；下一轮已有表演 → `performance`。
- `seats` 取焦点轮次 panel 的 seats（assigned 数）与 `config.judgeCount`、`config.minimumJudges`。
- `readyToScore = session === "running" && focusRound.state === "scoring" && panel !== null && panel.current && current !== null && seats.assigned >= seats.minimum`。
- `activityStatus` closed/archived → `phase = "inactive"`，所有动作只读。
- 所有 resolved → `completed`；next=null；活动仍 active 时主操作是“查看/发布赛果”，不是启动会话。
- 当前/下一的参与者用 `state.participantNames` 显示；缺失回退 participantId。

### 2.2 不制造的状态

- 不把 locked 表演当“当前”。
- 不把 next 跨过 hold/未解析的轮次。
- 不把未 prepare 的下一轮显示成有表演。
- 不把无会话显示成“已关闭”或某个 mode。
- 不把 closed/archived 活动显示成可启动。

## 3. 指挥条 UI

### 3.1 布局

```text
[活动状态 / 会话：运行中 · rehearsal]
当前：第 2 轮 · 第 3 位 · 张三        评分 3/5    席位 5/5（最低 2）
下一：第 4 位 · 李四
[轮次 chip：1 已解析 | 2 评分中 | 3 未准备 | 4 未准备]
[HOLD：并列待处理] [异常与修正] [评委入口]
```

- 桌面：一条横向卡片，三列（会话/当前/下一）+ 轮次 chips + 告警。
- <900px：纵向堆叠；390px 无横向滚动。
- 只读用户：状态与轮次 chips 可见；动作锚点按权限隐藏。
- 空状态：`no_session` 显示“未启动评分会话”；`completed` 显示“全部轮次已完成”。

### 3.2 动作

| 阶段 | 主锚点 | 目标 |
| --- | --- | --- |
| no_session，活动 active，可管理会话 | 去启动会话 | `#live-session` |
| awaiting_start，可管理设置 | 去开始/准备 | `#round-$key` |
| scoring | 去评分/查看席位 | `#round-$key` / `#live-session` |
| round_scored | 去锁定回合 | `#round-$key` |
| round_hold | 去处理 HOLD | `#live-tie`；无权限时只显示说明 |
| round_resolved | 去下一轮 | `#round-$next` |
| completed | 查看/发布赛果 | `#live-result` |
| inactive | 无动作 | — |

- 锚点只滚动到面板；按钮仍在面板里，避免复制命令、mode 选择和确认弹窗。
- 指挥条不自行修改任何状态。

### 3.3 权限

- `canManageSession`：显示“去启动会话/评委入口”；
- `canManageSetup`：显示“去开始/去锁定/去准备”；
- `canManageCompetition`（异常/平局面板已渲染）：显示“去处理 HOLD/异常”；
- 结果权限：显示“查看/发布赛果”；
- 不满足时不渲染对应锚点，只显示状态。

## 4. 锚点

- 会话卡 `id="live-session"`；平局推进 `id="live-tie"`；异常/修正 `id="live-exception"`；赛果 `id="live-result"`；
- 每轮用 `<div id={`round-${key}`}>` 包裹 `LiveRoundPanel` 及其附属卡；
- `scroll-margin-top` 防顶栏遮挡；
- 锚点目标不存在时（权限/未渲染），浏览器停在页面顶部；指挥条不伪造面板。

## 5. Test architecture

### 5.1 契约与能力

- 不新增 capability、命令、事件、路由、表、topic。
- 指挥条是 `LiveState` 的只读投影；不进入 `executeCommand` authority 路径。

### 5.2 消费者、读模型、路由、事件、topic

- 复用 `GET /api/activities/:id/live`；不新增 route。
- `/live/$activityId` 页面行为变化；`/live` 列表、Studio/Ops 不受影响。
- 不新增 read model 或实时 topic。

### 5.3 生命周期边界、终态与 mode 隔离

- session 只分 none/running；无 closed 语义；无会话不显示 mode。
- 当前只取 open；locked 表演不是当前。
- 焦点轮次 locked + hold/未解析时 next 被阻塞。
- 下一轮未 prepare 只显示“准备第 N 轮”。
- closed/archived 活动只读；draft 活动在无 release 时页面本来就是错误态。
- 全部 resolved → completed；主操作是赛果，不是启动会话。
- `readyToScore` 同时要求 scoring 轮次、current panel、open 表演、最低席位；test/rehearsal/formal 共用同一状态机。

### 5.4 适配器

- 不新增 adapter；组件测试用 `LiveState` fixture；E2E 用真实后端。

### 5.5 故障注入与恢复状态

| 故障 | 注入方式 | 断言 |
| --- | --- | --- |
| 无会话 | `session: null` | 显示“未启动”；不显示 mode/当前/评分；可启动时锚点 |
| 焦点轮次未 prepare | `round: null` | 显示“准备第 N 轮”，不显示表演 |
| 全部表演 locked | performances locked | `round_scored`；“去锁定回合”；无 current |
| ranking hold | ranking status hold | `round_hold`；next 为 blocked；不指向下一轮 |
| 下一轮 resolved 前置 | 上一轮 resolved | next 指向下一轮/未准备 |
| 活动 closed | activity.status closed | inactive；无启动/开始锚点 |
| 活动 archived | archived | inactive；只读 |
| 全部 resolved | 所有 round resolved | completed；赛果锚点 |
| 席位不足 | seats assigned < minimum | `readyToScore=false`；显示最低席位 |
| 权限不足 | 无 canManageSession/Setup | 只显示状态；不渲染对应锚点 |
| 实时失效 | realtime fallback | 5 秒轮询刷新指挥条与面板 |

### 5.6 现有测试为什么不够

- `LiveRoundPanel`/`LiveSessionPanel` 测试覆盖各自命令，不覆盖跨面板的当前/下一/阶段；
- 现有 E2E 通过面板操作，但看不到“当前/下一/HOLD/评委就绪”的单一视图；
- a11y 只审计 `/live` 列表，不覆盖详情指挥条；
- mobile 只覆盖既有 live 详情，不覆盖新指挥条的触控/溢出。

### 5.7 防膨胀 / anti-bloat

- 一个纯函数 `deriveLiveCommand` + 一个 `LiveCommandBar`；不新建页面、不复制命令组件。
- 测试：derive 纯函数 + 组件测试；E2E 扩展 `live-judge.spec.ts`；a11y 增加 live 详情；mobile 既有 live 详情覆盖。
- 不引入图表库、状态库、计时器或大屏模式。

### 5.8 聚焦门禁

```powershell
Set-Location plus
pnpm run check
pnpm --filter @artflow-plus/web test -- deriveLiveCommand LiveCommandBar
$env:ARTFLOW_PLUS_DATABASE_URL = "postgresql://artflow:artflow_dev@127.0.0.1:5433/artflow_plus"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
pnpm --filter @artflow-plus/web test:e2e -- live-judge.spec.ts a11y.spec.ts mobile.spec.ts
pnpm run test
pnpm run build:prod
pnpm --filter @artflow-plus/contract-tools graph:check
```

仓库级：

```powershell
uv run pytest tests/gates -q
uv run python tests/golden/validate_fixtures.py
pwsh -NoProfile -File scripts/check_docs.ps1
```

## 6. 实施顺序

1. `deriveLiveCommand` + 纯函数测试；
2. `LiveCommandBar` + 组件测试；
3. `liveActivity.tsx` 接入、锚点/轮次包裹、权限 props；
4. 样式、a11y、mobile、`live-judge` E2E；
5. 全量门禁、合并、CI。

## 7. 风险

- **无 closed session**：指挥条无法显示“已关闭”；接受“未启动”，未来需要时再扩展 LiveState。
- **锚点不等于命令**：用户仍需在面板点击真实按钮；指挥条不提供一键执行。
- **跨面板状态**：指挥条与面板同一 `LiveState` 快照；面板操作后 `refresh()` 一起更新。
- **HOLD 语义**：ranking hold 只覆盖并列；评分修正/异常由异常卡处理，指挥条只链接。
