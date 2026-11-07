---
title: Job Store（作业持久化与跨实例协调层）
description: JobStore（实现于 lib/job-store.js）是 JobService 的持久化 / 跨进程协调层。它从原来 index.js 里的 createJobService 中抽出、独立成可单测的纯函数与小类集合，承担的核心场景是：同一台机器上可能有多个宿主窗口（多个 JobService…
---

# Job Store（作业持久化与跨实例协调层）

!!! info "Generated documentation"
    This page was written by CodeWiki from the source code at commit [`695bf7d0`](https://github.com/ikliml666/dsh-codewiki/commit/695bf7d0681fd06c15e63a731761d443a069a9e3) on 2026-11-07 with `doubao-seed-2.1-lite`. Check the code before relying on details.

## 简介

`Job_Store`（实现于 `lib/job-store.js`）是 JobService 的**持久化 / 跨进程协调层**。它从原来 `index.js` 里的 `createJobService` 中抽出、独立成可单测的纯函数与小类集合，承担的核心场景是：**同一台机器上可能有多个宿主窗口（多个 JobService 进程）同时运行，却共享同一份磁盘上的 `jobs.json`**。此前作业状态与 tick 的业务推进缠在一起，任何一条语义都只能靠「起两个真宿主」来验证；拆出本层后，磁盘读写、现场合并与执行器重放裁决都可以在没有真实宿主的条件下测试。

本模块只保留三件事，且全部做成纯函数 / 小类：

1. **磁盘层**：原子读写、损坏检测、跨进程 tick 锁；读写失败一律显式抛出，绝不静默吞掉。
2. **现场合并**：多实例 job 列表合并、同仓幂等查找、所有权判定与心跳节流。
3. **原生通道重放**：可序列化的执行配置快照，以及「宿主重启后该重跑还是该显式失败」的裁决。

## 模块在系统中的位置

```mermaid
flowchart TB
    subgraph "调用方：业务编排"
        Orch["Job_Orchestration<br/>index.js：createJobService / tick / runPool"]
    end

    subgraph "Job_Store（本层，纯函数 / 小类）"
        Disk["磁盘层<br/>createJobsStore：load / save / 原子写 / tick 锁"]
        Merge["现场合并<br/>findActiveJob / mergeJobLists / reassignSession"]
        Own["所有权与心跳<br/>classifyOwnership / planForeignJob / heartbeat / adoptOrphan"]
        Replay["原生通道重放<br/>snapshotNativeRun / planNativeReplay"]
        Ser["序列化闸门<br/>serializeJobs：拒函数值 / 拒凭证"]
    end

    subgraph "磁盘现场"
        J[("jobs.json<br/>（跨进程共享）")]
        Lock[("jobs.json.lock<br/>跨进程 tick 锁")]
        Corrupt[("jobs.json.corrupt<br/>+ .corrupt-时间戳")]
        Tmp[(".jobs.json.tmp-pid-rand<br/>原子写临时文件")]
    end

    Orch -->|"tick 前取锁 / 提交前幂等闸门"| Disk
    Orch -->|"保存 jobs / 合并磁盘现场"| Merge
    Orch -->|"别的实例拥有的非终态任务怎么办"| Own
    Orch -->|"宿主重启后要不要重跑原生编译"| Replay
    Disk --> Ser
    Disk --> J
    Disk --> Lock
    Disk --> Corrupt
    Disk --> Tmp
```

上游业务编排（作业提交、tick 推进、取消）见 [Job Orchestration（编译任务编排服务）](Job_Orchestration.md)；原生编译通道本身（Python 引擎子进程、临时工作区）见 [Engine_Native_Run（原生编译裁决编排层）](Engine_Native_Run.md) 与 [工作区快照（Engine_Workspace_Snapshot）](Engine_Workspace_Snapshot.md)。

## 核心概念

### 磁盘现场与 schema

- `JOBS_SCHEMA = 2`：写入 `jobs.json` 的顶层结构为 `{ schema, savedAt, jobs }`，其中 `jobs` 数组只保留最近 `maxKept`（默认 30）条，避免文件无限增长。
- 同一仓库只允许有**一条活动任务**：`findActiveJob` 在多条历史活动记录里返回 `createdAt` 最新的那条（旧版幂等只看内存，会让同仓挂多条）。

### 硬不变量（防重复执行的四道闸）

```mermaid
flowchart LR
    A["不变量 A<br/>只允许「写临时文件 + fsync + rename」替换<br/>不存在半写状态"]
    B["不变量 B<br/>读不出 = ok / missing / corrupt / unreadable 四态区分<br/>幂等判定只在 ok #124; missing 成立（fail-closed）"]
    C["不变量 C<br/>函数值与敏感凭证一律拒绝入 jobs.json<br/>执行器由新宿主按当前配置重建"]
    D["不变量 D<br/>取消是终态<br/>任何重放裁决先看 cancelRequested，绝不复活血"]
```

| 不变量 | 针对的旧事故 | 实现位置 |
| --- | --- | --- |
| A | 直接 `writeFileSync` 覆盖，写一半崩溃得到截断 JSON，被读成「没有任务」→ 同仓重复提交、两个引擎同时写同一仓库 | `writeAtomic`（临时文件必须与目标同目录、先 fsync 后 rename） |
| B | `loadJobs` 的 catch 把损坏文件当成「没有活动任务」 | `load` 返回四态、`loadForIdempotency` 增加 `safe` 布尔闸门 |
| C | `JSON.stringify` 对函数值静默丢弃，`llm` 等执行器字段悄悄消失 | `serializeJobs`  replacer 主动抛 `JobsStoreError` |
| D | 重放时可能把已取消任务又跑起来 | `planNativeReplay` 最先检查 `cancelRequested` |

### 错误类型

`JobsStoreError extends Error`，携带 `code`（如 `job-serialize-function`、`job-secret-field`、`jobs-write`、`jobs-rename`、`jobs-lock`）、`path` 与 `detail`，供上层把「为什么不能安全提交」显式报错给用户。

## 关键组件与函数

### 1. 路径身份

- `normKey(p)`：去尾分隔符 + `path.normalize`；在 win32 上折叠大小写。本模块自带一份而不反向依赖 `index.js` 的同名实现，保持层次独立。`findActiveJob` 等幂等查找都以它生成 cwd 的身份 key。

### 2. 序列化闸门（`serializeJobs`）

```mermaid
flowchart LR
    P["payload 调用方传入的 job 列表"] --> R["JSON.stringify replacer"]
    R --> F{"value 是函数？"}
    R --> K{"键名命中 SECRET_KEY_RE#59; api-key #124; secret #124; passw #124; authorization #124; private-key #124; token 结尾"}
    F -->|"是"| E1["抛 job-serialize-function"]
    K -->|"命中"| E2["抛 job-secret-field"]
    F -->|"否"| Out["正常序列化"]
    K -->|"否"| Out
```

- 「放宽到键名包含」是因为真实事故里出现的是 `CODEWIKI_API_KEY` 这类环境变量名，而不是干净的 `apiKey`。
- 不收 `maxTokens` / `outputTokens` 这类计数字段：它们不含凭证，且面板要展示。
- 函数值被拦下来是因为「少一个执行器字段也没人知道」——执行期依赖（`llm` 等）应由新宿主按当前配置重建，不进快照。

### 3. 磁盘层（`createJobsStore`）

构造参数：`file`（`jobs.json` 路径，必填）、`maxKept`（默认 30）、`instanceTag`（默认 `'svc'`）。派生出三个配套文件：

| 派生文件 | 用途 |
| --- | --- |
| `${file}.lock` | 跨进程 tick 锁，内容为 `pid#124;instanceTag#124;时间戳` 的 token |
| `${file}.corrupt` | 「上一版是坏的」事实标记（JSON：quarantinedAt / detail / at） |
| `${file}.corrupt-<时间戳>` | 损坏主文件被改名保留的证据原件 |

#### 读取四态

```mermaid
flowchart TD
    S["load 读 jobs.json"] --> E{"ENOENT?"}
    E -->|"是"| M{"存在 corrupt 标记？"}
    M -->|"是"| C1["state = corrupt<br/>上次已隔离，fail-closed"]
    M -->|"否"| Ok1["state = missing<br/>全新机器，可以当空"]
    E -->|"否（其他）"| R["state = unreadable<br/>权限 / I/O 问题"]
    E -->|"读到内容"| P{"JSON.parse + jobs 是数组？"}
    P -->|"否"| Q["quarantine：主文件改名保留 + 写 corrupt 标记<br/>state = corrupt"]
    P -->|"是"| Ok2["state = ok"]
```

- `loadForIdempotency()` 在 `load` 结果上追加 `safe = state === 'ok' #124;#124; state === 'missing'`，这是调用方发起提交前必须接的一步：**只有能断言「这个仓库当前没有活动任务」时才允许提交**；corrupt / unreadable 时调用方要报错给用户（报什么错属于 JobService，本层不替它决定）。
- corrupt 标记的意义：损坏文件被改名后原路径 ENOENT 会被误判成「现场干净」，幂等判定从这一刻起 fail-open（同仓重复执行）。改名必须留下「上一版是坏的」这条事实，直到一次成功写入证明现场恢复正常（`clearCorruptMarker`）。

#### 原子写

```mermaid
flowchart LR
    T1["序列化 + 截断到 maxKept"] --> T2["同目录创建 .tmp-pid-rand<br/>（跨卷 rename 会退化成复制，失去原子性）"]
    T2 --> T3["写入 + fsync<br/>（顺序反了断电后可能是长度对、内容空洞）"]
    T3 --> T4["rename 替换目标<br/>Windows 占用窗口退避重试 10/30/60/100ms"]
    T4 --> T5["成功后清除 corrupt 标记<br/>现场已恢复"]
```

- 写盘路径全程同步 API：`save` 是同步接口，tick 的 `finally` 也要能同步落盘；退避睡眠用 `Atomics.wait`（`sleepSync`）而非忙等。
- rename 仍失败时抛 `jobs-rename`，让调用方决策；残留临时文件不会被当成 jobs 读，无害。

#### 跨进程 tick 锁

```mermaid
flowchart TD
    A["acquireTickLock staleMs 默认 60000"] --> W{"flag: 'wx' 创建 .lock"}
    W -->|"成功"| Ok["返回 token"]
    W -->|"EEXIST"| St["stat 取 mtimeMs"]
    St -->|"age <= staleMs"| Y["锁是活的：本轮让路，返回 null"]
    St -->|"超时"| Del["强删崩溃进程留下的锁<br/>再 wx 抢一次"]
    Del -->|"抢到"| Ok
    Del -->|"被别人先抢"| Y
    R["releaseTickLock token"] --> C{"读出锁内容 == token?"}
    C -->|"否（已被别的实例接管）"| N["不删，返回 false"]
    C -->|"是"| Un["unlink 释放"]
```

- 锁内容带 `instanceTag`、释放时校验归属：旧实现无条件 `unlink`，两实例交错时会把对方的锁删掉，于是两边同时推进同一 job。
- 存活判定只用文件系统真实时钟（mtime）；拿调用方合成的 `now` 去减会造成两个时钟混用，负年龄被读成「活的」，崩溃锁永远等不到接管。

### 4. 终态与阶段常量

- `TERMINAL_STAGES = ['done', 'partial', 'failed', 'cancelled']`，`isTerminalStage(stage)` 判断任务是否已完结。
- `NO_EXECUTOR_STAGES = ['queued', 'submitting']`：「没有执行器可丢」的阶段。超时只意味着没人替它推进，绝不意味着「原生引擎执行器丢失」——旧实现把排队任务也当孤儿接管，会把正常排队项写成「原实例停更 X 分钟，本实例接管推进」，并在原生通道上直接判失败。

### 5. 所有权判定与处置（跨实例协调的核心）

```mermaid
flowchart TD
    J["某个磁盘上的 job"] --> H{"owner 字段存在？"}
    H -->|"无（0.4.2 之前残留）"| LEG["LEGACY：任何实例可接手续查"]
    H -->|"== instanceId"| MIN["MINE：我的任务"]
    H -->|"其他实例"| L["lastSeenAt = max(heartbeatAt, updatedAt, createdAt)"]
    L --> F{"时间戳可解析？"}
    F -->|"否（手工编辑 / 旧格式）"| LEG
    F -->|"是"| O{"age <= orphanTakeoverMs?"}
    O -->|"是"| LIVE["LIVE_OTHER：对方还活着"]
    O -->|"否"| S{"stage 在 NO_EXECUTOR_STAGES?"}
    S -->|"是"| IDL["IDLE_NO_EXECUTOR：排队中断，无执行器"]
    S -->|"否"| ORP["ORPHAN：真孤儿（执行器丢了）"]
```

`planForeignJob(job, { instanceId, orphanTakeoverMs })` 在 tick 遇到「别的实例拥有的非终态任务」时给出处置动作：

| 情形 | ownership | action | 理由 |
| --- | --- | --- | --- |
| 我的 / 对方还活着 | MINE / LIVE_OTHER | `LEAVE` | 不干预 |
| `submitting` 阶段停更 | 任意非 mine | `VOID` | 提交未完成、没过凭证校验，没有可续状态 |
| `queued` 且 `job.auto === true` | 任意非 mine | `VOID` | 自动调度遗留的排队项，下一轮扫描会重新提交；作废后该仓库幂等记录释放 |
| 其余（用户手动提交的排队项） | 任意非 mine | `ADOPT` | 接管：排队项按 FIFO 继续排队；执行器类孤儿由 `adoptOrphan` 改挂本实例 |

- 直接作废自动排队项解决了旧实现的死锁：旧实现遇到这类任务 `continue`，宿主重启前的排队项永久卡在 `queued`——既占着闸门窗口，又让同仓幂等一直返回它，用户连重新提交都做不到。
- `lastSeenAt(job)` 取三个时间戳的 `max`（而非第一个存在的），因为 `mergeJobLists` 会用磁盘版本整体替换内存版本，两组时间戳可能不同步。
- `heartbeat(job, { instanceId, everyMs = HEARTBEAT_MS=30000 })`：只对「我的」任务生效，按 30s 节流（`jobs.json` 是整文件重写，每 tick 都写一遍没必要）；让长批次 / 等引擎的慢宿主不被别的实例误判成孤儿。
- `adoptOrphan` 接管时写入 `owner / ownerAdoptedAt / heartbeatAt / updatedAt`。

### 6. 现场合并（`mergeJobLists`）

```mermaid
flowchart LR
    A["mine：内存现场"] --> M{"按 id 建索引"}
    D["disk：磁盘现场"] --> M
    M --> N{"磁盘上的 id 内存里没有？"}
    N -->|"是"| Add["并入，changed = true"]
    N -->|"否"| G{"该 id 在 dirtyIds？<br/>或磁盘 updatedAt <= 内存"}
    G -->|"脏（本实例刚改过）"| Keep["保留内存版本"]
    G -->|"磁盘更新"| Rep["磁盘覆盖内存"]
    Rep --> Sort["按 createdAt 升序输出"]
```

- 磁盘覆盖内存的条件只有两条：本实例没改过它（`dirtyIds`），**且**磁盘版本更新。否则慢 tick 会用过期快照把对方刚写的 `note` / `batchRef` 洗掉。

### 7. 会话归属（`reassignSession`）

同一仓库被另一个会话再次提交时，完成唤醒必须发到**新的**会话（旧会话可能早已关闭，steer 会石沉大海）。`reassignSession(job, sessionId)` 追加一条 `{ from, to, at }` 到 `sessionOwnerHistory`（最多保留最近 10 条），让面板能解释「唤醒去了谁」。

### 8. 原生通道重放

#### 快照（`snapshotNativeRun`）

只收「下次还能原样再下发的执行配置」：`channel.python / entry / timeoutMs / scope`、`scope`、`kind`、`language`、`moduleConcurrency`、`rawTreeRoot`、`docsDir`、`attempt`、`capturedAt`，带 `version = NATIVE_SNAPSHOT_VERSION`。

明确**不收**的：`llm` 服务、bridge（随机端口 + 占位 key）、`onProgress/onLog` 回调、任何 provider 凭证——它们属于「当前宿主」，重启后必须由新宿主重建；持久化只会留下过期指针（桥端口已死）或泄密面。

#### 重放裁决（`planNativeReplay`）

```mermaid
flowchart TD
    A["planNativeReplay(job)"] --> T{"终态？"}
    T -->|"是"| No1["replayable = false<br/>原因：已是终态"]
    A --> C{"cancelRequested？"}
    C -->|"是"| No2["replayable = false<br/>cancelled：取消是终态，不复活"]
    A --> N{"nativeChannel 缺 python / entry？"}
    N -->|"是（旧 job 可能只有 nativeStarted）"| No3["replayable = false<br/>无法续跑，请重新提交编译"]
    A --> E{"attempt >= maxAttempts<br/>默认 3"}
    E -->|"是"| No4["replayable = false<br/>exhausted：连续中断到顶，停止重跑"]
    A --> Y["replayable = true<br/>attempt + 1<br/>resumeDocsDir：上次临时目录还在就续用，只补缺失状态不覆盖"]
```

- 设计动机：旧行为「`nativeStarted === true` 且内存里没有执行器 → 直接 `failed`」把「执行器丢了」误当成「这轮编译不可续」。原生通道的全部输入本来就在 job 上，重启后完全可重放；代价是重跑一次编译，收益是用户不必手工重新提交，而 `failed` 是纯损失（跑了一半的仓库被标成没有成果）。
- 三条刹车：取消（绝不复活血）、尝试次数到顶（宿主崩溃循环时不能无限烧全量编译）、终态。
- `resumeDocsDir`：宿主强杀不会执行 `startNativeRun` 的 `finally`，临时目录里保留了引擎已提交的叶子终态；重放时只补水缺失状态，不覆盖它（Python 适配器按签名决定能否续用）。临时工作区本身见 [工作区快照（Engine_Workspace_Snapshot）](Engine_Workspace_Snapshot.md)。

## 跨进程协作总览

```mermaid
sequenceDiagram
    participant A as 宿主实例 A（窗口 1）
    participant B as 宿主实例 B（窗口 2）
    participant F as jobs.json（磁盘共享现场）
    participant L as jobs.json.lock（tick 锁）

    A->>L: acquireTickLock（wx 创建）
    B->>L: acquireTickLock（EEXIST，age <= 60s → 让路）
    A->>F: load（state = ok）→ loadForIdempotency.safe = true
    A->>A: findActiveJob(cwd)：无活动任务 → 允许提交
    A->>F: save：tmp + fsync + rename 原子替换
    A->>L: releaseTickLock（校验 token 归属）
    Note over B: 下一轮 tick：A 的锁已释放
    B->>L: acquireTickLock 成功
    B->>F: load → 看到 A 提交的 job（owner = A）
    B->>B: classifyOwnership：LIVE_OTHER → planForeignJob → LEAVE
    Note over A: 假设 A 进程崩溃
    B->>B: 超时后再判：ORPHAN / IDLE_NO_EXECUTOR → ADOPT 或 VOID
    B->>F: save：adoptOrphan / 作废，现场收敛
```

## 与其他模块的关系

| 方向 | 模块 | 关系 |
| --- | --- | --- |
| 上游（本层的调用方） | [Job Orchestration（编译任务编排服务）](Job_Orchestration.md) | `createJobService` 的 tick 循环在提交前走 `loadForIdempotency`、每 tick 前取锁、保存时整文件落盘；取消语义（`cancelRequested`）由上游写入 |
| 上游（原生通道消费方） | [Engine_Native_Run（原生编译裁决编排层）](Engine_Native_Run.md) / [Engine_Native_State（原生引擎跨轮受管状态）](Engine_Native_State.md) | 启动子进程前写 `nativeChannel` 快照、重启后按 `planNativeReplay` 裁决重跑或续用 docsDir |
| 上游（临时工作区） | [工作区快照（Engine_Workspace_Snapshot）](Engine_Workspace_Snapshot.md) | `resumeDocsDir` 引用的临时目录生命周期由其管理 |
| 横向（日志） | [Job_Logs](Job_Logs.md) | 与 `jobs.json` 并列的日志文件清理（`removeLog`），不在本层范围内 |
| 横向（更新记录） | [Update_Record（编译更新记录）](Update_Record.md) | 更新/阶段记录的持久化与终态判定，与本层 `TERMINAL_STAGES` 语义对齐 |
| 配置来源 | [Cordis_Patch_Config（插件装配配置）](Cordis_Patch_Config.md) | 插件 `codewiki` 配置（并发、超时、原生引擎开关）决定 job 快照里要写哪些执行参数 |

## 工程要点速查

- **全部同步 API**：`load` / `save` / 锁的获取释放都是同步的（落盘路径不能 await）。
- **失败显式化**：任何 I/O、序列化、rename 失败都抛 `JobsStoreError`，code 见上表，方便面板与用户文案对号入座。
- **只收最近 30 条**：`save` 前 `slice(-maxKept)`，终态历史不留在活跃现场里。
- **测试性**：本层刻意不反向依赖 `index.js`（路径 key 自带一份 `normKey`），所有函数纯化，跨进程语义可用单测模拟两实例。

??? abstract "Documented components (1)"
    - [`normKey`](https://github.com/ikliml666/dsh-codewiki/blob/695bf7d0681fd06c15e63a731761d443a069a9e3/lib%5Cjob-store.js) — `lib\job-store.js`

