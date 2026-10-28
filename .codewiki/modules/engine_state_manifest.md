---
title: engine_state_manifest
type: module
source_files:
  - lib/engine/native-state.js
  - lib/engine/mapping.js
  - lib/engine/manifest.js
  - lib/engine/contract.js
  - lib/engine/native-run.js
  - lib/engine/apply-plan.js
  - test-engine-manifest.mjs
  - test-engine-native-incremental.mjs
tags: [engine, native-state, manifest, lock, mapping, incremental]
---

## Overview

The `engine_state_manifest` module groups the three pieces that let the FSoft
native engine behave as a **managed, versioned, resumable** writer inside this
repo — instead of a one-shot, side-effectful tool:

- **Native managed state** (`lib/engine/native-state.js`) — the cross-round
  persistence substrate that makes FSoft's component-level incremental
  (`rung 3`) actually work on round 2+. It hydrates the previous round's
  graph/module-tree/metadata/articles into the engine's temp `docsDir`, and
  captures the current round's equivalents back into a git-managed
  `.codewiki/_native-state/` directory so they form a single commit with the
  articles.
- **Manifest / lock handling** (`lib/engine/manifest.js`) — a read-only doctor
  that fingerprints the engine environment (version + Python version), compares
  it against a persisted `.codewiki/engine-lock.json`, and reports drift /
  unhealthy deps without ever modifying the environment.
- **FSoft → CodeWiki mapping** (`lib/engine/mapping.js`) — the single, narrow
  format-translation boundary that turns a FSoft docs tree (overview.md +
  module pages + module_tree.json + metadata.json + update_record.json) into
  cw's write-set description (CodeWiki.md entry + `.codewiki/modules/*.md`
  articles + `.codewiki/_meta.yaml` meta + `.codewiki/temp/update-record.json`).

Why these belong together: incremental, resumable compilation needs three
facts to be **checked, not trusted** at the deserialization boundary — *what
state did the last round leave?*, *is the engine environment still the same?*,
and *does the produced tree map cleanly onto our article model?*. The first is
answered by `native-state.js`, the second by `manifest.js`, and the third by
`mapping.js`. Both `native-state.js` and `manifest.js` lean on primitives from
`contract.js` (`ENGINE_CONTRACT_VERSION`, outcome enumerations) and are wired
together by the orchestrator in `native-run.js`, with the write-set actually
committed by `apply-plan.js`.

## Key Components

## Architecture

## Data Flow

## Connections

## Known Issues
