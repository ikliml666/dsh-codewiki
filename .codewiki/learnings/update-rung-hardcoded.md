---
title: 增量档位写死导致上游五档全部不可达
type: learning
source_files:
  - index.js
  - lib/engine/native-run.js
  - lib/engine/python/entry.py
tags: [native-engine, incremental, config]
---

## Overview

原生通道把「增量怎么做」整条交给 FSoft updater，插件侧只透传一个写死的 rung=3。结果上游五个档位（0/1/2/3/3b）与十几个阈值（tau_nb / tau_grow / tau_full / tau_tree）在设置页里一个都碰不到：怀疑增量判错、想退回全量、想放宽 growth 门槛，都只能改源码。

## 根因

三处断点叠在一起：Config 没有对应字段 → liveConfig 不透出 → startNativeRun 的 deps 不传 updateOptions。entry.py 那边因此始终拿不到 payload.updateOptions，上游 _update_options() 只好用默认 rung=3。

## 关键语义

rung=0 不是「最弱的增量」，而是「放弃增量」：上游 doc_generator 的 _update_options() 见到 rung 为 "0" 直接返回 None，整条 _run_incremental_update 分支被跳过，本轮按全量重写。所以插件侧必须在决议阶段就把它翻译成 RESOLUTION.FULL，而不是等引擎返回后再回头解释。

## 验证方式

test-engine-native-incremental.mjs 用例 18 断言 rung=0 时 resolution 为 full、动作里 update 出现次数为 0、blockers 不含 incremental-fallback；test-config.mjs 覆盖空配置不下发任何键、阈值越界不写入、非法档位在提交时报错。

