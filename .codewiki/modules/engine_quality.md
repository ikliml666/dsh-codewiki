---
title: engine_quality
type: module
source_files:
  - lib/engine/quality-gate.js
  - test-engine-quality-gate.mjs
  - lib/engine/output.js
  - lib/article-contract.js
  - lib/engine/mapping.js
  - lib/update-record.js
  - lib/engine/contract.js
  - lib/engine/native-run.js
  - lib/engine/apply-plan.js
tags: [engine, quality-gate, native-output, baseline, article-contract, native-run]
---

## Overview

`lib/engine/quality-gate.js` is the engine pipeline's **stage 3: adoption gate (quality gate)**. It sits after `output.js` (stage 2, which only judges "is the artifact self-consistent") and before the docs tree is written into `.codewiki/` and `CodeWiki.md`. It composes three checks into one machine-readable verdict (`gateNativeOutput`, `lib/engine/quality-gate.js:390`):

1. **Artifact self-consistency** — reuses `output.js`'s `validateOutput` (`lib/engine/quality-gate.js:400`), without rewriting any judgment.
2. **Target-format contract** — renders the mapped result into a real wiki article (synthesized frontmatter + FSoft original body) and runs `article-contract.js`'s `inspectArticle` (`lib/engine/quality-gate.js:347`) — frontmatter unique closing / fences / dead links / source_files evidence / type-and-location match.
3. **Baseline advanceability** — the commit the artifact corresponds to must be the **committed** HEAD, and the `.codewiki/_meta.yaml` baseline itself must be committed; uncommitted working-tree content must not be treated as a committed baseline.

### The three-way problem split (the core reason this module exists)

The 0.14.0 lesson was "1 success + 19 failures still reported as done". But shoving everything into one `blockers` array is equally harmful: the engine would be blamed for things that aren't its fault, or the wiki's stale state would be treated as a product defect — both send ops looking for causes in the wrong place. So the classification is machine-readable (`lib/engine/quality-gate.js:45-72`):

- **defect (product defect)** — a problem with this engine artifact itself (missing entry / missing page / empty body / dead link / `source_files` pointing to a non-existent file / broken frontmatter / unclosed fence / artifact commit not being HEAD). Handling: must not count as full success. Corresponding to `GATE_DEFECT_KINDS` (`lib/engine/quality-gate.js:45-59`).
- **degradation (capability downgrade)** — the artifact is usable but evidence is insufficient (whole-repository mode with empty `module_tree` → pages have no attribution and `source_files`; some pages can't be mapped into the wiki). Handling: may be committed, but **incremental ownership is untrustworthy, so the baseline must not advance**. Note the difference from defect: the page is real, the content is real, it just can't be attributed.
- **stale (wiki state stale)** — not the artifact's fault (existing wiki baseline behind HEAD, baseline only in working tree uncommitted). Handling: report truthfully; only "baseline not committed" blocks advancement (solidifying uncommitted state as a committed baseline is an irreversible bookkeeping error).

The terminal state remains strict: **only when all three are empty is it `done`** (`lib/engine/quality-gate.js:533-536`). The classification changes the "who fixes, what to fix" orientation, not the gate threshold — loosening is the most dangerous direction in the migration.

## Key Components

All public APIs are exposed both as named exports and via `export default` (`lib/engine/quality-gate.js:626-639`). Below, every public constant, function, and internal helper is listed with real line numbers.

### Constants (public exports)

- `GATE_VERSION` (`lib/engine/quality-gate.js:42`) — adoption gate schema version, fixed at `1`, written into `GateReport.version`.
- `GATE_DEFECT_KINDS` (`lib/engine/quality-gate.js:45-59`) — `Object.freeze` array of product-defect categories, stable and machine-readable; new entries may only be appended. The 13 values: `missing-docs-dir`, `missing-metadata`, `missing-module-tree`, `bad-json`, `entry-missing`, `empty-body`, `article-missing`, `unmapped-page`, `source-missing`, `dead-link`, `article-contract`, `commit-mismatch`, `uncommitted-input`.
- `GATE_DEGRADATION_KINDS` (`lib/engine/quality-gate.js:61-66`) — capability-downgrade category table. Values: `empty-module-tree`, `no-source-evidence`, `missing-section`, `empty-section-optional`.
- `GATE_STALE_KINDS` (`lib/engine/quality-gate.js:68-72`) — wiki-state-stale category table. Values: `baseline-behind-head`, `baseline-uncommitted`, `baseline-absent`.
- `NATIVE_REQUIRED_SECTIONS` (`lib/engine/quality-gate.js:86`) — frozen `[]`, the section whitelist passed to `inspectArticle` for the native channel. Reason: FSoft bodies are decided by the upstream prompt (e.g. `## Introduction and Purpose`); the plan hard-constrains "don't change technical content", so judging it with the agentic channel's `Overview`/`Key Components` would turn every line into an unrepairable warning and degrade the gate into noise. "At least one non-empty H2" is judged separately by `checkRendered`.

### Internal sets and helpers

- `DEFECT_SET` / `DEGRADATION_SET` / `STALE_SET` (`lib/engine/quality-gate.js:74-76`) — `Set`s built from the three category tables, used by `gateNativeOutput` to assert "any written kind must be registered"; unregistered kinds throw (`406`, `410`).
- `posix` (`78`) — normalizes backslashes to `/` and tolerates `null`/`undefined`.
- `git(repoRoot, args, { timeout = 15000 })` (`90-102`) — read-only git helper wrapping `execFileSync('git', ...)`; on failure (including 15s timeout) returns `null` rather than throwing, so "git command failed" becomes a reportable state instead of a crash. `maxBuffer` 8 MiB.
- `parseMetaCommit(text)` (`104-107`) — regex-extracts the value of the `last_compiled_commit:` line from `_meta.yaml` text, stripping optional surrounding quotes.
- `SHA_RE` (`109`) — 40-hex SHA validation regex.
- `WIKI_PATHS` (`156`) — `['.codewiki/', 'CodeWiki.md']`; used by `uncommittedSourceChanges` to exclude the wiki's own artifacts from "uncommitted source changes".
- `oneLine(s)` (`248-250`) — collapses multiline text to a single space and trims; used by `titleOf`.
- `YAML_UNSAFE_HEAD` (`264`) / `YAML_RESERVED` (`266`) / `YAML_NUMBER` (`267`) — regex and reserved-word set used by `yamlScalar` to decide "is the bare value unsafe" (see `yamlScalar`).

### Public functions

- **`readCommittedBaseline({ repoRoot, relPath = WIKI_META_REL })`** (`117-151`, `WIKI_META_REL` from `lib/engine/mapping.js:32`) — reads the **committed** compile baseline, not the working-tree file. Returns an object with fields:
  - `ok: boolean` — whether a valid committed baseline was obtained;
  - `source: string` — `'git-head' | 'worktree-only' | 'absent'`;
  - `commit: string|null` — the `last_compiled_commit` from `_meta.yaml` at `HEAD`;
  - `worktreeCommit: string|null` — the working-tree file's commit (for dirty comparison);
  - `dirty: boolean` — whether the working-tree value differs from the `HEAD` value;
  - `reason: string` — human-readable reason.
  Key logic: reads committed content via `git('show', 'HEAD:' + rel)` (`126`); the working-tree file is only used by `fs.readFileSync` for comparison. If `HEAD` has none but the working-tree file exists (`140`), `source='worktree-only'`, `ok=false`, `dirty=true` — this is the "baseline not committed" verdict and the **only** stale condition that blocks advancement.

- **`uncommittedSourceChanges({ repoRoot })`** (`158-174`) — uses `git status --porcelain --untracked-files=all` (`161`) to list **non-wiki** uncommitted changes. Returns `{ ok, paths, reason }`; `paths` are already filtered by `WIKI_PATHS` to exclude `.codewiki/` and `CodeWiki.md` themselves. This is the basis for deciding "does the artifact reflect content that is in some commit".

- **`assessBaseline({ repoRoot, artifactCommit = null, baseline = null, requireCommittedInput = true })`** (`188-244`) — judges "can this artifact's baseline be advanced". Returns `{ ok, headCommit, artifactCommit, defects, stale, writable }`.
  - If `requireCommittedInput=false` (`196`), pass immediately (`ok=true, writable=true`);
  - Otherwise compare `artifactCommit` (artifact's `metadata.generation_info.commit_id`) with `git rev-parse HEAD` (`192`): missing commit / not a 40-hex sha / mismatch with HEAD → `defect: commit-mismatch`;
  - Via `uncommittedSourceChanges` check whether the working tree is dirty → `defect: uncommitted-input` (`215`);
  - Baseline staleness is only reported, not blamed on the engine (`227`): `baseline-absent` / `baseline-uncommitted` / `baseline-behind-head`;
  - **Only `baseline-uncommitted` blocks advancement** (solidifying uncommitted state as digested is irreversible), see `blockingStale` filter (`241`); `ok = defects.length===0 && blockingStale.length===0` (`242`).

- **`yamlScalar(value)`** (`269-288`) — safe YAML scalar serialization. Only adds double quotes when **genuinely unsafe**, and uses `JSON.stringify` to get a valid YAML double-quoted scalar (YAML 1.2 is a superset of JSON). Unsafe conditions (`plainUnsafe`, `273`) include: leading/trailing whitespace, control characters, newline/carriage-return, backslash (Windows paths), `: ` / trailing `:`, ` #` / leading `#`, `YAML_UNSAFE_HEAD` leading character, `YAML_RESERVED` reserved words (true/false/yes/no/…), `YAML_NUMBER` numeric shape. All dangerous values are pinned in `test-engine-quality-gate.mjs:338` to "write into frontmatter, then `parseFrontmatter` reads back the original string and JSON is valid".

- **`titleOf(bodyText, fallback)`** (`291-297`) — extracts the H1 text from the first `# title` line (`293`) as the frontmatter `title`; falls back to `fallback` (usually the module name) if none.

- **`renderArticle({ article, body })`** (`316-340`) — renders one mapped article into the **complete text** of a wiki article — synthesized frontmatter + FSoft original body. Three hard constraints (pinned in `test-engine-quality-gate.mjs:314`):
  1. **Body unchanged to the character** (doesn't delete H1, rewrite titles, rewrite links, or add sections) (`318` only strips BOM);
  2. **frontmatter only fills evidenced fields**: `source_files` comes verbatim from the mapping (`321`), and an empty list is written explicitly as `source_files: []` (`328`) to distinguish "declared empty" from "not declared"; `type` comes from the mapping (`320`); always writes `tags: []` (`331`), `generated_by: fsoft-native` (`332`);
  3. **Traceable**: `fsoft_page` records which source file in the FSoft original tree the body came from (`333`).
  The closing `---` is followed by **no blank line** (`338`) to guarantee "the article in the wiki = the article the engine produced" is byte-for-byte comparable.

- **`checkRendered({ content, article, cwd, fsoftPage })`** (`346-373`) — per-article post-render check. First runs `inspectArticle` (`347`, `requiredSections: NATIVE_REQUIRED_SECTIONS`, `allowEmptySourceFiles: true`, `fsImpl: null`, `readableSources: null`, `allowedLinks: null`), then adds two native-channel-specific judgments: after stripping **its own synthesized** frontmatter, compute `bodyLength` (from `output.js:127`); if `===0` add an `empty-body` error (`368`) — because `inspectArticle`'s empty-body looks at `body.trim()`, and an H1 present makes it non-empty, which would let empty-shell pages pass; this catches them with the header-stripped body. Returns `{ issues, fsoftPage }`.

- **`gateNativeOutput({ docsDir, repoRoot, componentFiles, overviewName, baseline, requireCommittedInput, includeContent })`** (`390-568`) — main entry. A pure composition pipeline returning a `GateReport` (JSON-serializable). Internal steps:
  1. Call `validateOutput` (`400`) to get `collected`/`mapped`/`problems`;
  2. Route `validation.problems` by kind (`418`): `empty-module-tree` → degradation (`420`); `article-missing`/`unmapped-page`/registered defect → defect (`424`, `428`, `432`); unregistered kind → report as `article-contract` defect (`436`) to force the layer above to add a mapping;
  3. Entry check (`440`): no overview → whole batch not committable (`entry.ok=false`); unreadable / empty body / unclosed fence → `entry-missing`/`empty-body`/`article-contract` (e.g. `449`, `454`, `459`);
  4. Per-article render + contract (`467`): read body → `renderArticle` → `checkRendered`; error-level issue → `article-contract` defect (`487`), warning-level → degradation (`492`); empty `source_files` → `no-source-evidence` degradation (`497`); each article records `articles[]` and (when no defects) `rendered[]` (`502`, `514`);
  5. Baseline (`518`): take `collected.json.metadata.generation_info.commit_id` as `artifactCommit`, call `assessBaseline` (`519`);
  6. Terminal synthesis (`526`): `writable = entry && entry.ok`; `blocking` merges defects + degradations + `baseline-uncommitted` stale (`527`); `outcome = !writable ? 'failed' : blocking.length ? 'partial' : 'done'` (`533`).
  Return fields (source `538-567`): `version`, `ok`, `outcome`, `writable`, `canAdvanceBaseline`, `entry`, `articles`, `rendered`, `defects`, `degradations`, `stale`, `blockers`, `counts` (pages/articles/writable/skipped/unmapped/defects/degradations/stale), `baseline` (`headCommit`/`artifactCommit`/`source`).

- **`toContractBlockers(report)`** (`589-596`) — converts `GateReport.blockers` into `contract.js`'s `BLOCKER_KINDS` (`lib/engine/contract.js`). Anything that can't be one-to-one mapped defaults to `'quality-gate'` (`591`), and the original kind is preserved in `detail` (`592`). Mapping table `TO_CONTRACT_KIND` (`572-587`).

- **`toQualityIssues(report)`** (`610-624`) — converts the gate verdict into `update-record.js`'s `qualityIssues` (one of `judgeOutcome`'s inputs). Logic (`612`): `degradations` + `defects` are fully converted to `{name, issue}`; among `stale`, **only `baseline-uncommitted` is treated as blocking** (`621`), because mixing in others (e.g. baseline behind HEAD) would make every incremental run land in `partial`. This is the key wiring that prevents "a writeable page with empty `source_files` being silently counted as success by `judgeOutcome` and advancing the baseline" (test `test-engine-quality-gate.mjs:211` specifically verifies this blind spot).

### Default export

- `default` (`626-639`) — exports all the above symbols at once: `GATE_VERSION`, `GATE_DEFECT_KINDS`, `GATE_DEGRADATION_KINDS`, `GATE_STALE_KINDS`, `gateNativeOutput`, `renderArticle`, `titleOf`, `readCommittedBaseline`, `uncommittedSourceChanges`, `assessBaseline`, `toContractBlockers`, `toQualityIssues`.

## Architecture

`gateNativeOutput` is a pure composer: it does not re-parse the docs itself, instead reusing `output.js`'s `validateOutput`, then layering on three checks — rendering, contract, baseline — and finally routing the three problem classes into a terminal state. Components ≥3 and the main entry is a clear composition pipeline, so a UTF-8 box diagram follows (arrows denote "call / data flow"):

```text
  docs/ (FSoft output)          repoRoot (git + .codewiki)
        │                            │
        ▼                            │
 ┌───────────────┐                  │
 │ output.js      │  validateOutput │
 │ validateOutput │─────────────────┘  (read docs + map + self-consistency)
 │   :400         │
 └──────┬────────┘
        │ { validation: { collected, mapped, problems } }
        ▼
 ┌──────────────────────────────────────────────┐
 │ quality-gate.js: gateNativeOutput (:390)      │
 │  1) problems route defect/degradation (:418)  │
 │  2) entry read + empty-body/fence check (:440)│
 │  3) per-article renderArticle(:477)→checkRendered(:478)
 │  4) empty source_files → no-source-evidence (:497)
 │  5) assessBaseline(:519) ← readCommittedBase- │
 │     line(:117)                                │
 │  6) terminal synthesis outcome (:533)         │
 └──┬─────────┬───────────────┬───────────────┘
    │         │               │
    ▼         ▼               ▼
 ┌────────┐ ┌──────────┐ ┌──────────────────────┐
 │render- │ │ inspect- │ │ assessBaseline+      │
 │Article │ │ Article  │ │ readCommittedBaseline│
 │ :316   │ │ article- │ │ :188 (git HEAD base)│
 │ (body  │ │ contract │ │ uncommittedSource-   │
 │ intact)│ │ .js:347  │ │ Changes :158         │
 └────────┘ └──────────┘ └──────────────────────┘
    │
    ▼  GateReport { outcome, defects, degradations, stale, blockers, rendered }
 ┌──────────────────────────────────────────────┐
 │ native-run.js: runNativeJob (:506)            │
 │  toContractBlockers(:642) → terminal blockers │
 │  report → apply-plan.js: applyNativeOutput    │
 │  toQualityIssues(report) → judgeOutcome       │
 └──────────────────────────────────────────────┘
```

Key points (line numbers are the source-code prefixes):

- `gateNativeOutput` reuses `validateOutput` (`lib/engine/quality-gate.js:400`), which internally already calls `mapFsoftOutput` (`lib/engine/output.js:164` → `lib/engine/mapping.js:115`) and carries out `collected.json.metadata.generation_info.commit_id` for baseline judgment (`lib/engine/output.js:271-274`).
- `checkRendered` deliberately sets `allowedLinks` / `readableSources` / `fsImpl` to `null` (`lib/engine/quality-gate.js:351-355`) because dead links, source existence, and source evidence were already judged once in the `output.js` stage; judging again would only double-report the same defect.
- The native channel passes `requiredSections: []` (`NATIVE_REQUIRED_SECTIONS`, `:356`); section names are decided by the upstream prompt and must not be judged with the agentic channel's `Overview`/`Key Components`, or the gate degrades into noise (`lib/engine/quality-gate.js:80-85`, `lib/article-contract.js:217-224`).

## Data Flow

The data flow of one native artifact from input to `GateReport`:

1. **Entry collection**: `gateNativeOutput` (`390`) receives `docsDir`, `repoRoot`, `componentFiles`, `overviewName`, `baseline`, `requireCommittedInput`, `includeContent`. It first calls `validateOutput` (`400`), which internally does `buildWritePlan` (`lib/engine/output.js:162`) → `collectOutput` (`lib/engine/output.js:91`) + `mapFsoftOutput` (`lib/engine/mapping.js:115`), producing `{ collected, mapped, problems }`.

2. **Problem routing**: iterate `validation.problems` (`418`). `empty-module-tree` is downgraded to degradation (`420`, evidence missing rather than artifact broken); `article-missing`/`unmapped-page`/registered defect are upgraded to defect; unregistered kind is uniformly reported as `article-contract` defect (`436`) to force the layer above to add a mapping. Every written kind must be in the corresponding set (`406`, `410`), otherwise it throws.

3. **Entry validation**: take the overview page from `mapped.entry` (`440`); unreadable / empty body / unclosed fence respectively push `entry-missing`/`empty-body`/`article-contract` and set `entry.ok=false` (`449`, `454`, `459`).

4. **Per-article render + contract**: for each of `mapped.articles` (`467`): read the original body → `renderArticle` (`477`) synthesizes frontmatter+body → `checkRendered` (`478`). `inspectArticle`'s error-level issue becomes an `article-contract` defect (`487`), warning-level becomes a degradation (`492`); empty `source_files` pushes `no-source-evidence` (`497`). Defect-free pages enter `rendered[]` (`514`), and each page records `action: 'write' | 'skip'` in `articles[]` (`510`). Note: pages with defects **never** enter `rendered` (test `test-engine-quality-gate.mjs:147-156` confirms — otherwise the upstream would bypass `skip` and write the whole page).

5. **Baseline judgment**: take `collected.json.metadata.generation_info.commit_id` as `artifactCommit` (`518`), call `assessBaseline` (`519`). The latter compares HEAD, validates commit shape and `uncommitted-input`, then combines with `readCommittedBaseline` (`117`) reporting baseline staleness, producing `{ ok, defects, stale }` (`242`'s `ok` is only blocked by `baseline-uncommitted`).

6. **Terminal synthesis**: `writable = Boolean(entry && entry.ok)` (`526`); `blocking` is defects + degradations + `baseline-uncommitted` stale (`527`); `outcome` is three-state (`533`). The final `GateReport` (`538`) contains all details and `counts`.

7. **Downstream wiring**: `toContractBlockers` (`589`) maps blockers into `contract.js`'s `BLOCKER_KINDS` for the index-layer commit gate; `toQualityIssues` (`610`) maps the verdict into `update-record.js`'s `qualityIssues`, fed to `judgeOutcome` to prevent "a page with empty `source_files` being silently counted as success and advancing the baseline".

Consumption by stage 4: `GateReport` is consumed by `native-run.js:runNativeJob` at `lib/engine/native-run.js:506` (stage 4), whose `blockers` are merged into the terminal state via `toContractBlockers` (`lib/engine/native-run.js:642`), then handed to `apply-plan.js:applyNativeOutput` (`lib/engine/native-run.js:637`) to be written. If stage 4 goes through the `judgeOutcome` path (e.g. test `lib/update-record.js:37`), it must explicitly use `toQualityIssues(report)` (`lib/engine/quality-gate.js:610`) to feed in `qualityIssues`, otherwise an empty `source_files` page would be judged done and advance the baseline (`test-engine-quality-gate.mjs:211-224`).

## Connections

This module sits at the "adoption gate" layer of the engine pipeline and is strongly coupled to the following modules:

- [[engine_output]] (stage 2, `lib/engine/output.js`): `gateNativeOutput` directly reuses `validateOutput` (`lib/engine/output.js:184`) and `bodyLength` (`lib/engine/output.js:127`), and does not rewrite any "artifact self-consistency" judgment; the division of labor is described in `lib/engine/output.js:14`.
- [[engine_mapping]] (`lib/engine/mapping.js`): this module `import`s `WIKI_ENTRY` (`30`) and `WIKI_META_REL` (`32`), and consumes the `entry`/`articles`/`unmapped` produced by `mapFsoftOutput` (`115`). `WIKI_META_REL` is the path `readCommittedBaseline` reads the committed baseline from.
- [[article_contract]] (`lib/article-contract.js`): reuses `inspectArticle` (`213`), `fencesBalanced` (`161`), `parseFrontmatter` (`77`) for the post-render format gate; the native channel turns off the agentic-channel-specific judgments via `requiredSections=[]` + `allowEmptySourceFiles=true`.
- [[engine_contract]] (`lib/engine/contract.js`): `toContractBlockers` (`589`) maps the gate's blockers to `BLOCKER_KINDS`, ensuring the upper-layer commit gate can recognize them. The strict terminal invariant (`engineResult`: done must not carry blockers) is enforced by `native-run.js:settle` (`lib/engine/native-run.js:160`).
- [[update_record]] (`lib/update-record.js`): `toQualityIssues` (`610`) maps the gate verdict into `judgeOutcome`'s (`lib/update-record.js:37`) `qualityIssues`, the key wiring so "the two judgment paths aren't one strict and one loose" (see `lib/engine/quality-gate.js:599` comment).
- [[engine_native_run]] (`lib/engine/native-run.js`): stage 4 orchestration `runNativeJob` calls `gateNativeOutput` at `lib/engine/native-run.js:49`, `toContractBlockers` at `:642`, hands `report` to the applier, and synthesizes the terminal state by taking the weakest of engine/gate/apply outcomes (`RANK`, `lib/engine/native-run.js:73`).
- [[engine_apply_plan]] (`lib/engine/apply-plan.js`): stage 3 applier `applyNativeOutput` consumes `report.writable`/`report.rendered`/`report.outcome`, enforces write-set closure (`APPLY_WRITE_ROOTS`, `lib/engine/apply-plan.js:46`) and "index/baseline failure => rollback"; a `gate-partial` report is still written but must not be washed into `done`.
- Test side: `test-engine-quality-gate.mjs` (this module's dedicated test) imports both `lib/update-record.js`'s `judgeOutcome` and `lib/engine/contract.js`'s `BLOCKER_KINDS` to verify wiring correctness.

## Known Issues

- No known disabled code paths: every exported function is live. `assessBaseline`'s `requireCommittedInput=false` short-circuit (`lib/engine/quality-gate.js:188-190`) is intentional (used by tests and by callers that have already guaranteed a clean HEAD), not a disabled feature.
- The gate's strictness depends on `toQualityIssues` being fed into `judgeOutcome`. If a future caller builds the terminal state only from per-article write results without `qualityIssues`, an empty-`source_files` page would again be silently counted as success and advance the baseline — this blind spot is permanently guarded by `test-engine-quality-gate.mjs:211-224`.

