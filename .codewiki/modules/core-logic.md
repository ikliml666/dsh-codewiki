m00207–m00207 modules/core-logic.md rewrite
TASK AS OF THIS BLOCK: Rewrite `modules/core-logic.md` based on current `index.js`.

### Summary of Changes

**1. Overview & Architecture**
- Updated to reflect the "Service-Oriented Batch Pipeline" (zero sub-agents).
- **Architecture Diagram**: Updated to show `DeepSeek Harness` ↔ `core-logic (Job Service)` ↔ `Alibaba Bailian (Batch Chat / Realtime Fallback)`, with `Rust CLI cw` as a local dependency.

**2. Key Components (Exact Line Numbers)**
- **Config Schema** (`L29-L58`): Defines `enabled`, `binaryPath`, `batchModel`, `batchApiKey`, `batchThinkingBudget`, `batchMinTokens`, `maxConcurrency`, `articleLanguage`, `excludePaths`, `autoUpdate`, `autoUpdateMin`, `workspaceOnly`, `updateReminder`.
- **liveConfig()** (`L74-L103`): Normalizes config, enforces hard cap for concurrency (8), and handles defaults.
- **cw CLI Wrapper**:
  - `resolveBinary()` (`L109-L133`): Resolves `cw` binary path (PATH → plugin bin).
  - `runCw()` (`L135-L166`): Spawns `cw` process with timeout/signal support.
  - `parseStatus()` (`L169-L182`): Parses `cw status` output into `missing/uncompiled/clean/stale`.
  - `ensureWikiEntry()` (`L195-L232`): Auto-generates `CodeWiki.md` if missing.
  - `isExcluded()` (`L235-L245`): Checks exclusion list against cwd.
- **Token Estimation & Realtime Fallback**:
  - `estimateTokens()` (`L252-L260`): CJK=1 token, ASCII=3.5 chars/token.
  - `bailianChat()` (`L263-L276`): Synchronous chat/completions call for fallback or small tasks.
  - `applyTaskResult()` (`L279-L291`): Writes article to disk or returns content in memory (`keepInMemory`).
  - `runRealtimeTasks()` (`L294-L318`): Concurrent pool for realtime tasks.
- **Batch Inference**:
  - `collectSources()` (`L328-L352`): Inlines source files into markdown, respecting `BATCH_TOKEN_BUDGET` (28k) and `BATCH_TOKEN_HARD_LIMIT` (200k).
  - `prepareArticleTasks()` (`L532-L553`): Prepares tasks for batch submission, handling oversized sources.
  - `resolveBatchApiKey()` (`L506-L530`): Resolves API key from config or host credentials service.
- **Prompt Templates**:
  - `articleFormatSection()` (`L534-L557`): Strict Markdown format constraints.
  - `batchPlannerPrompt()` (`L560-L582`): JSON module grouping plan.
  - `localPlan()` (`L585-L596`): Fallback plan by top-level directory.
  - `packArticles()` (`L599-L618`): Packs articles for crosscut, truncating headers if over budget.
  - `crosscutIntro()` (`L621-L633`): Generic crosscut intro.
  - `batchArchitecturePrompt()` (`L636-L642`): `_architecture.md` prompt.
  - `batchPatternsPrompt()` (`L645-L651`): `_patterns.md` prompt.
  - `batchConceptPrompt()` (`L654-L662`): Concept article prompt.
  - `batchObservePrompt()` (`L665-L682`): Module observation prompt (for split crosscut).
  - `batchProofreadPrompt()` (`L685-L707`): Proofreading prompt.
- **Job Service (`createJobService`)** (`L712-L950`):
  - Constants: `JOBS_FILE`, `REPOS_FILE`, `ORPHAN_TAKEOVER_MS` (5 min), `SCAN_SKIP_DIRS`, `SCAN_SKIP_EXT`, `BATCH_TOKEN_BUDGET` (28k), `BATCH_TOKEN_HARD_LIMIT` (200k).
  - `scanRepoFiles()` (`L445-L470`): Recursive file scanner with blacklist/size limits.
  - `acquireTickLock()` / `releaseTickLock()` (`L483-L496`): File-based lock for multi-instance safety.
  - `loadJobs()` / `saveJobs()` (`L473-L480`): Persistence (last 30 jobs).
  - `mergeFromDisk()` / `flush()` (`L745-L762`): State reconciliation.
  - `tick()` (`L835-L883`): Main loop, pushes jobs forward.
  - `submit()` (`L786-L833`): Submits new job, handles idempotency/orphan resume.
  - `cancel()` (`L835-L844`): Cancels job.
  - Stage Handlers: `tickPlan`, `tickArticles`, `tickCrosscut`, `tickCompose`, `tickReview`, `tickIndex`.
    - `tickPlan`: Scans repo, submits plan task, parses JSON.
    - `tickArticles`: Submits article tasks (batch/realtime), writes to disk.
    - `tickCrosscut`: Submits crosscut tasks (arch/patterns/concepts), supports split-compose.
    - `tickReview`: Local check + batch proofreading.
    - `tickIndex`: Runs `cw index`/`meta update`, generates entry.
- **Tool Definitions**:
  - `cwToolDefinition()` (`L710-L760`): Wraps `cw` CLI.
  - `generateToolDefinition()` (`L953-L1033`): `codewiki_generate` tool (status check + submit).
  - `progressToolDefinition()` (`L1036-L1063`): `codewiki_progress` tool (read-only status).
- **Web Server**:
  - `installWebServer()` (`L1036-L1153`): Registers `/api/codewiki/jobs`, `/repos`, `/control` (loopback only).
- **Plugin Entry**:
  - `apply()` (`L1163-L1225`): Initializes service, registers tools, starts auto-update scheduler.
  - `reminderText()` (`L1156-L1162`): Wiki maintenance reminder.
  - `installUpdateReminder()` (`L1165-L1196`): Injects reminder into system prompt.
  - `autoScan()` (`L1206-L1225`): Auto-update scheduler (60s heartbeat).

**3. Data Flow**
- Updated to detail the full pipeline: Trigger → Status Check → Job Submission → Plan → Articles → Crosscut (with split-compose logic) → Review → Index.
- Clarified persistence mechanisms (`JOBS_FILE`, `REPOS_FILE`) and cancellation flow.

**4. Connections & Known Issues**
- Added backlinks to `tools`, `web-server`, `auto-update`.
- Updated known issues to reflect current implementation details (token estimation, file locking, credential resolution, orphan takeover).