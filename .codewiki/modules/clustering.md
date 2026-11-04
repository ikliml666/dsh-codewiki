---
title: clustering
type: module
source_files:
  - lib/cluster.js
  - test-cluster.mjs
  - index.js
  - lib/update-planner.js
tags: [clustering, module-planning, ast, prompt-engineering, llmdriven]
---

## Overview

`lib/cluster.js` is the LLM-driven module clustering engine of the CodeWiki pipeline. It corresponds to the upstream FSoft-AI4Code/CodeWiki `cluster_modules.py` plus the `CLUSTER_REPO_PROMPT` / `CLUSTER_MODULE_PROMPT` / `SUPER_GROUP_PROMPT` three-stage pipeline. Its job is to take a flat list of extracted source components (each identified as `path#name`, per the `lib/symbols.js` convention) and organize them into a module tree whose leaves become individual wiki articles.

The module is a set of **pure functions** plus one async orchestrator `clusterComponents`. There is no filesystem I/O and no network access in `cluster.js` itself — the caller injects an `llmCall` callback of shape `async (prompt) => string` (`lib/cluster.js:20`). This makes the whole pipeline testable by injecting a fake completer (see `test-cluster.mjs`).

The upstream pipeline is three stages (`lib/cluster.js:5-14`):
1. **Top-level clustering** — `clusterPrompt` asks the LLM to split all leaf components into "leaf modules".
2. **Recursive subdivision (drill-down)** — any module that exceeds a component-count threshold is drilled into sub-modules via `subClusterPrompt`.
3. **Super-grouping** — if too many top-level modules remain, `superGroupPrompt` regroups them into "architecture subsystems".

Key differences from upstream (`lib/cluster.js:10-15`):
- Upstream uses Python dicts with recursive descent and persists `module_tree.json`; here it is pure functions with explicit depth (`maxDepth`).
- Upstream decides drill-down from the nested structure of the LLM reply; here it uses an explicit threshold (`splitThreshold`) on component count / subdirectory presence to cut the number of requests on large repos.
- Component ids use the `path#name` form (`lib/cluster.js:15`).

The contract of the main entry (`lib/cluster.js:17-20`):

```
clusterComponents({ components, tree?, llmCall, ... }) ->
  { modules: [{ name, summary, files, components, children?, parent? }], concepts: [], stats }
```

`llmCall` may be omitted. When it is, the module falls back to a local directory heuristic (`heuristicCluster`) so the pipeline still runs with zero network calls (`lib/cluster.js:219`).

In the bigger pipeline (`index.js`), clustering is consumed by `semanticPlan` (`index.js:1412`), which extracts the AST graph via `extractRepoGraph` (`lib/symbols.js`), builds import edges via `resolveImportEdges`, then calls `clusterComponents` (`index.js:1459`) and converts the result to a plan via `toPlanModules` (`index.js:1471`). This `plan` later feeds `lib/update-planner.js` (`buildModuleMap`, `planUpdate`) for incremental planning.

## Key Components

All exports live in `lib/cluster.js`. The module imports only `path` (`lib/cluster.js:22`).

### `formatComponents(components)` — lib/cluster.js:28
Pure function that renders the component list for the LLM prompt, **grouped by file** (not a flat id list) to save tokens and let the model see file-level ownership (`lib/cluster.js:24-26`). Returns a string: one `# <file>` header line per file (with an `(artifact: config)` tag when applicable), then one `\t<id>\t<kind>\t<name>(<params>)` line per component (`lib/cluster.js:35-45`). Only name + type + a one-line signature is emitted — not the function body, because clustering cares about structural relationships (`lib/cluster.js:40-42`).

Supporting private pieces:
- `ARTIFACT_RE` (`lib/cluster.js:48`) — regex matching config/build files (`package.json`, `tsconfig*.json`, `Cargo.toml`, `*.ya?ml`, `*.toml`, `*.json`, `Dockerfile*`, `Makefile`, etc.).
- `artifactTag(file)` (`lib/cluster.js:49`) — returns `' (artifact: config)'` when `ARTIFACT_RE` matches, else `''`.

### `clusterPrompt(componentText, totalComponents)` — lib/cluster.js:57
Builds the **top-level** clustering prompt (mirrors upstream `CLUSTER_REPO_PROMPT`). Wraps `componentText` in `<POTENTIAL_CORE_COMPONENTS>` tags and instructs the model to return a single JSON object `{ "modules": [ { name, path, summary, components } ] }` (`lib/cluster.js:57-81`). Emphasizes: every component must appear exactly once and not be dropped (`lib/cluster.js:69`); artifact files go to a dedicated build/config module (`lib/cluster.js:70`); module names are short snake_case English, reflecting responsibility not directory name (`lib/cluster.js:72`); `path` is the primary POSIX-relative directory (`lib/cluster.js:73`); no markdown fence allowed (`lib/cluster.js:75`).

### `subClusterPrompt(moduleName, componentText, totalComponents)` — lib/cluster.js:84
Builds the **drill-down** prompt for one already-clustered (large) module (mirrors `CLUSTER_MODULE_PROMPT`). Takes `moduleName` to address the model (`模块「big」` syntax, tested at `test-cluster.mjs:58`), and asks for sub-modules of the same JSON shape (`lib/cluster.js:84-103`). Allows returning a single sub-module with the original name when the module is genuinely indivisible (`lib/cluster.js:3`).

### `superGroupPrompt(modules)` — lib/cluster.js:106
Builds the **super-grouping** prompt (mirrors `SUPER_GROUP_PROMPT`). Renders a `<MODULES>` listing (`- <name> (path: <path>, <n> 组件): <summary>`) (`lib/cluster.js:107-112`) and asks for `{ "subsystems": [ { name, modules:[names] } ] }` — higher-level architecture subsystems, fewer than the module count, named by architecture role (`lib/cluster.js:106-129`).

### `parseJsonLoose(text)` — lib/cluster.js:135
Resilient JSON extractor. Strips markdown fences (` ```json ... ``` `) (`lib/cluster.js:139-140`), tries a direct `JSON.parse`, then falls back to the span between the first `{` and last `}` (`lib/cluster.js:143-148`), then tries again after removing trailing commas (`lib/cluster.js:150`). Returns `null` if nothing parses (`lib/cluster.js:152`). Tests at `test-cluster.mjs:65-82`.

### `parseClusterResponse(text, validIds, warnings = [])` — lib/cluster.js:156
Parses the LLM reply into module objects, with **id validation and deduplication** (`lib/cluster.js:156-195`). Steps:
- parse via `parseJsonLoose`; if null → push warning `'聚类回复不是合法 JSON'` and return null (`lib/cluster.js:157-160`).
- accept either an array directly, or `obj.modules ?? obj.groups` (`lib/cluster.js:162`). Missing array → warning `'聚类回复缺少 modules 数组'`, null (`lib/cluster.js:163-165`).
- for each module: normalize name via `normalizeModuleName`; filter components to `validIds`; drop unknown ids (warning `'聚类返回了不存在的组件 id：...'`, `lib/cluster.js:198`) and duplicate assignments (warning `'组件被重复分配（已丢弃后出现的）：...'`, `lib/cluster.js:177`); set `path` (falling back to `guessPath`), `summary` (`lib/cluster.js:171-187`).
- drop any module with no name or no kept components (`lib/cluster.js:181`).
- compute `missing = validIds not seen` and return `{ modules, missing }` (`lib/cluster.js:193-194`). If no modules remain → warning + null (`lib/cluster.js:189-192`).

### `normalizeModuleName(name)` — lib/cluster.js:198
Sanitizes a module name into a filename-friendly form: trim, whitespace → `_`, strip characters outside `[\w\u4e00-\u9fff-]`, collapse repeats, strip leading/trailing `_`, lowercase, and fall back to `'module'` when empty (`lib/cluster.js:198-206`). Preserves CJK characters (so multiple Chinese directories don't all collapse to `module`). Tests at `test-cluster.mjs:113-118`.

### `guessPath(ids)` — lib/cluster.js:208 (private)
From the first component id's file path, returns `path.posix.dirname(file)` or `''` if the file is at repo root (`lib/cluster.js:208-212`).

### `heuristicCluster(components)` — lib/cluster.js:219
Local directory heuristic used when there is no LLM and also to backfill missed components. Groups by top-level directory (`depth=1`); if that yields a single group (the common `src/` layout) it descends one level (`depth=2`) to avoid collapsing the whole repo into one module (`lib/cluster.js:219-244`). Each group becomes `{ name: normalizeModuleName(key), path, summary, components: ids }`; `root` key maps to path `''` (`lib/cluster.js:238-243`). Tests at `test-cluster.mjs:121-128`.

### `fillMissing(modules, components, missingIds)` — lib/cluster.js:247
Re-attaches components the LLM omitted: for each missing id, attach it to a module whose `path` is a prefix of the component's directory (`lib/cluster.js:247-268`). Leftovers that match no module get a new `'misc'` module (`lib/cluster.js:259-266`). Returns the same `modules` array (mutated). Tests at `test-cluster.mjs:130-144`.

### `moduleFiles(componentIds, byId)` — lib/cluster.js:274
Returns the sorted, de-duplicated list of source files for a set of component ids (used to populate article `source_files`) (`lib/cluster.js:274-281`). Tests at `test-cluster.mjs:146-150`.

### Constants — lib/cluster.js:287
- `DEFAULT_MAX_DEPTH = 2` — total tree depth ceiling (`lib/cluster.js:287`).
- `DEFAULT_SPLIT_THRESHOLD = 60` — components per module above which drill-down is attempted (`lib/cluster.js:288`).
- `DEFAULT_TOP_FANOUT = 14` — top-level module count above which super-grouping runs (`lib/cluster.js:289`).

### `clusterComponents(opts)` — lib/cluster.js:291
The async orchestrator and the module's public entry. Signature inputs (`lib/cluster.js:291-297`): `opts.components`, `opts.llmCall` (optional), `opts.maxDepth`, `opts.splitThreshold`, `opts.topFanout`, `opts.superGroup` (bool, opt-out). Returns (`lib/cluster.js:347`):

```
{ modules, tree, concepts: [], warnings, stats, byId }
```

Behavior:
- `stats = { requests, llm, levels, fallbacks }` initialized; `llm = !!llmCall` (`lib/cluster.js:295`).
- empty `components` → `{ modules: [], concepts: [], warnings: ['没有可聚类的组件'], stats }` (`lib/cluster.js:299-301`).
- `call(prompt)` increments `stats.requests` and coerces the LLM output to string (`lib/cluster.js:303-307`).
- **Stage 1** (`lib/cluster.js:310-325`): if `llmCall`, run `clusterPrompt` + `parseClusterResponse`, then `fillMissing` with the missing ids; on null/throw, increment `stats.fallbacks` and record a warning. If no `llmCall`, immediately set `stats.fallbacks += 1`. If top-level parsing still failed, fall back to `heuristicCluster`. `stats.levels = 1`.
- **Stage 2 — drill-down** (`lib/cluster.js:327-344`): only when `llmCall && maxDepth > 1`. For each top module whose `components.length >= splitThreshold`, call `subdivide`; if it returns >1 kids, keep the parent as a container node with `{ ...m, children: kids }` (the parent itself does not become an article — see finalize below); otherwise keep as-is.
- **Stage 3 — super-grouping** (`lib/cluster.js:346-356`): if `llmCall && topModules.length > topFanout && opts.superGroup !== false`, run `superGroupPrompt` + `parseSuperGroups`; on throw, keep flat modules and record a warning.
- **Finalize** (`lib/cluster.js:358-388`): `finalize(m, parent)` adds `files` (via `moduleFiles`), `summary`, optional `parent`, and recursively `children`; a parent container gets `aggregateFiles` (union of children files) and does NOT produce its own article (`lib/cluster.js:369-373`). `collect` walks the tree and only leaf nodes (no `children`) go into `modules` — parent container nodes are navigation only (`lib/cluster.js:379-386`). `byId` is the `Map<id, component>` passed through for downstream use (`lib/cluster.js:388`).

### `subdivide(m, components, byId, call, warnings, stats, depth, maxDepth, splitThreshold)` — lib/cluster.js:396 (private)
Recursively drills one large module one level deeper. Calls `subClusterPrompt`, parses, `fillMissing`, and returns the kids. If it returns ≤1 kid (or the name is unchanged) it is treated as indivisible and returns `null` (`lib/cluster.js:403-404`). Updates `stats.levels = max(stats.levels, depth)` (`lib/cluster.js:247`). Continues recursing only while `depth < maxDepth` and a kid still exceeds `splitThreshold` (`lib/cluster.js:407-415`). The recursion terminations are: reached `maxDepth`, or kid below threshold, or ≤1 kid — guaranteeing no infinite recursion (`lib/cluster.js:408-414`). On any throw it records a warning, increments `stats.fallbacks`, and returns `null` (`lib/cluster.js:417-421`). This fixed the historical bug where `maxDepth` was only treated as a `> 1` boolean switch, making `maxDepth=2` and `maxDepth=3` behave identically (`lib/cluster.js:84-85`). Tests at `test-cluster.mjs:313-343`.

### `parseSuperGroups(text, modules, warnings = [])` — lib/cluster.js:425
Parses the super-group reply into a top-level list with subsystem children (`lib/cluster.js:425-456`). Accepts array / `obj.subsystems ?? obj.groups`. Each group becomes `{ name: normalizeModuleName, path: '', summary, components: [], children: [picked modules] }` — the subsystem parent is itself an article-less navigation container (`lib/cluster.js:444-451`). Modules referenced by no subsystem (or unknown, or already used) stay at the top level so nothing silently disappears (`lib/cluster.js:453-455`). Unknown module names produce a warning (`lib/cluster.js:438`). Tests at `test-cluster.mjs:389-402`.

### `toPlanModules(result)` — lib/cluster.js:460
Converts a `clusterComponents` result into the task-list shape consumed by the articles stage: `{ name, summary, files }`, adding `parent` when present (`lib/cluster.js:460-467`). Shape matches `job.plan.modules` in `index.js` (`{ name, summary, files }`). Tests at `test-cluster.mjs:405-414`.

### Result object fields (struct-like)
The returned `tree` / `modules` nodes carry these fields:
- `name` (string) — normalized module name.
- `path` (string) — primary directory (POSIX, relative).
- `summary` (string) — one-line responsibility; defaults to `${name} 模块` (`lib/cluster.js:364`).
- `files` (string[]) — de-duplicated source files (from `moduleFiles`).
- `components` (string[]) — component ids belonging to this node.
- `children` (optional) — sub-nodes (only on container parents).
- `parent` (optional) — parent module name (only on leaf articles).
- `aggregateFiles` (optional) — union of children files (only on container parents).

`stats` fields: `requests` (int), `llm` (bool), `levels` (int, max tree depth reached), `fallbacks` (int, count of LLM failures/degradations).

## Architecture

The module is a four-stage pure pipeline orchestrated by `clusterComponents` (`lib/cluster.js:291`). Components in `()/read_code` are functions in `lib/cluster.js`; the caller side (`semanticPlan` in `index.js`) is shown for context.

```text
 components[] (from lib/symbols.js extractRepoGraph)
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ clusterComponents(opts)            [lib/cluster.js:291]│
│                                                       │
│  Stage 1  clusterPrompt ─► llmCall ─► parseClusterResponse
│           (lib/cluster.js:57)            (lib/cluster.js:156)
│                       │                  │  validates ids, dedups
│                       │                  ▼
│                       │            fillMissing(missing)  [lib/cluster.js:247]
│                       │                  │
│           ┌───────────┴── fallback: no llmCall / parse null / throw
│           ▼                                        │
│  heuristicCluster(components)   [lib/cluster.js:219]│
│           │                                        │
│  topModules (depth 1)                             │
└───────────┬───────────────────────────────────────┘
            │ if llmCall && maxDepth>1 && module.size>=splitThreshold
            ▼
┌─────────────────────────────────────────────────────┐
│ Stage 2  subdivide(module)   [lib/cluster.js:396]    │
│          subClusterPrompt ─► llmCall ─► parseClusterResponse
│          recurses while depth<maxDepth && kid>=threshold
│          parent kept as container {children}          │
└───────────┬───────────────────────────────────────┘
            │ if llmCall && topModules.length>topFanout
            ▼
┌─────────────────────────────────────────────────────┐
│ Stage 3  superGroupPrompt ─► llmCall ─► parseSuperGroups
│          (lib/cluster.js:106)          (lib/cluster.js:425)
│          top-level modules regrouped into subsystems  │
└───────────┬───────────────────────────────────────┘
            ▼
 finalize(m,parent): adds files (moduleFiles), summary,
 children; container parents get aggregateFiles, NO article
            │
            ▼
 ┌──────────────┐        ┌──────────────┐
 │ tree[]       │        │ modules[]     │  (leaf nodes only → articles)
 │ (full tree)  │        │ (leaf nodes)  │
 └──────────────┘        └──────────────┘
            │                      │
            ▼                      ▼
   index.js semanticPlan   toPlanModules(result)  [lib/cluster.js:460]
            │                      │
            ▼                      ▼
   plan (tree, graph)      plan.modules (name,summary,files)
            │
            ▼
   lib/update-planner.js  buildModuleMap / planUpdate
```

Key architectural properties:
- **No article for container nodes.** Parent modules created by drill-down (`lib/cluster.js:359`) or super-grouping (`lib/cluster.js:372-379`) are navigation containers; `finalize` gives them `aggregateFiles` and `collect` deliberately excludes them from `modules` (`lib/cluster.js:379-386`). Tests assert the parent `big` does NOT become an article (`test-cluster.mjs:245`).
- **Backfill never loses a component.** After LLM clustering, `missing` ids (or LLM omission) are re-attached via `fillMissing` (`lib/cluster.js:315`, `lib/cluster.js:402`); the final `modules` always covers `components.length` ids (`test-cluster.mjs:157`, `test-cluster.mjs:133`).
- **Every failure degrades gracefully.** Missing `llmCall`, thrown request, or unparseable reply all increment `stats.fallbacks` and route to `heuristicCluster` (`lib/cluster.js:317-324`).

## Data Flow

The end-to-end data flow, from a raw repo through to article tasks, with the call sites in `index.js`:

1. `scanRepoFiles(cwd)` (`index.js:2215`) returns `{path,bytes}` for each source file under repo root (blacklist dirs `SCAN_SKIP_DIRS`, byte/extension caps).
2. `semanticPlan(files, {...})` (`index.js:1412`) reads file contents, calls `extractRepoGraph` (`lib/symbols.js`, imported at `index.js:16`) → `graph` (a `Map<id, component>` where each component has `id` like `path#name`, `name`, `kind`, `relativePath`, `parameters`, `dependsOn`). It also calls `resolveImportEdges` to build dependency edges.
3. `components = [...graph.values()]` (`index.js:1450`) is passed to `clusterComponents({ components, llmCall, signal })` (`index.js:1459`; `llmCall` wraps `llmChat`, `index.js:557`).
4. Inside `clusterComponents`, components are rendered to prompt text by `formatComponents` (`lib/cluster.js:28`) and sent through the three-stage pipeline described in Architecture. The output `tree`/`modules` are node objects carrying `files` (resolved by `moduleFiles`, `lib/cluster.js:274`) and `components` (id list).
5. `semanticPlan` wraps the result into a `plan` object (`index.js:1467`): `modules: toPlanModules(result)` (`index.js:1412`), `tree: result.tree`, and a slimmed `graph` (component metadata only — explicitly **without** `sourceCode`, `index.js:1474-1477`, because the JOBS_FILE would otherwise bloat by hundreds of KB). `plan.stats` merges `result.stats` with `durationMs` and `components.length` (`index.js:1488`).
6. `buildPlan(job, files)` (`index.js:3027`) chooses `localPlan` (`planMode==='dirs'`, `index.js:3030`) or `semanticPlan`; on `semanticPlan` fallback it degrades to `localPlan` (`index.js:1412`). The plan is stored on `job.plan`.
7. In `tickArticles` (`index.js:3176-3199`), `plan.modules` is mapped to article tasks — each becomes `modules/<slug>.md` with `sources: mod.files` and `mission` text (`index.js:3295-3305`). `slugify(mod.name)` (`index.js:1760`) produces the article filename.
8. Downstream, `lib/update-planner.js` uses the plan's module membership (`buildModuleMap`, `lib/update-planner.js:442`, which reads `plan.modules[].files`) and the persisted `tree`/`graph` to compute incremental `planUpdate` actions (`lib/update-planner.js:156`).

Component id convention: every component id is `${relativePath}#${name}` (`test-cluster.mjs:28`, `test-cluster.mjs:277`). `validIds` in `parseClusterResponse` is the full set of ids (`lib/cluster.js:156`); any id the LLM returns that is not in `validIds` is dropped with a warning (`lib/cluster.js:176`).

## Known Issues
