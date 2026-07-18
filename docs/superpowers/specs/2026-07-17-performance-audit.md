# Rabbitholes 全链路性能审计 — 2026-07-17

> **Status: 2026-07-19 implementation complete — worktree only，不要 commit**（惯例同 specs/plans）
>
> 方法:55 个 subagent 工作流(8 个维度 finder × 对抗性验证 per finding × 完整性批评),全部结论基于 dev 分支当前 working tree 的实际代码,每条都经独立验证者尝试反驳后存活。
> 已排除 2026-06 已落地的优化(streaming block split、Shiki 限流、dirty-delta 持久化、lazy tree loading、useSmooth listener skip)。原稿所称的 pane 冬眠不在当前 dev tree 中，因此不再作为既有优化排除。

**结果:44 个维度 finding(high 6 / medium 21 / low 17),2 条驳回,8 个审计盲区。去重后至多 36 个独立根因；#1/#19/#33、#4/#21/#43、#5/#9/#40、#7/#25/#39 分别属于同一根因族。**

## 2026-07-18 实施契约

本次实施只包含能够用自动化测试证明“用户可见行为不变”的优化。涉及滚动模型、查找覆盖、后台 turn 即时性或编辑器首帧体验的架构项，先进入量测/设计 gate，不以性能名义直接改变体验。

### Success Criteria

- Composer 在输入后同一事件循环立即 Enter/点击发送时，不能丢最后字符、mention 或 quote；submit 后延迟写入不能复活已清空 draft。
- 前后端 transcript fingerprint 保持现有 wire value 完全一致；exact resume 不因优化静默降级。
- 流式 chunk 不再逐事件派生完整 content，但 checkpoint、done、error、cancel 与崩溃恢复仍持久化相同可见文本。
- Desktop 与 mobile 的消息内容、Markdown/HTML 安全、unread/count、Map 可见节点、焦点/选择语义保持一致。
- audit/auth SQLite durability 不改变；只允许 data.db 使用经测试的 WAL + synchronous=NORMAL。
- production build 中无数学内容时 KaTeX JS/CSS 不在启动依赖图；首次公式仍正常渲染。
- 所有 frontend unit、backend unit/integration、Playwright E2E、typecheck/build 通过，并记录 before/after bundle 与验证证据。

### 本 worktree 的 implementation-ready 范围

1. Composer：`set-composer-draft` 可进入 RAF 合并，但 submit 与 primary action mode 必须读取同步状态；补 desktop 同帧提交/queue/不复活测试，确认 mobile 既有 local-draft 路径不受影响。
2. Persistence/boot：同一 attempt 启动 advisory capabilities probe 但不 await，meta 保持唯一 readiness gate；删除 dead `messageNodeIds`；bulk edge/context lookup 使用按需 Map。
3. Fingerprint：共享、逐段 FNV fold，缓存 finalized content 字符串；不修改 wire algorithm。
4. Streaming/backend：chunk defer content + checkpoint 惰性物化；只节流进行中的 tool updates；静态热 SQL statement cache；data.db NORMAL；stub-only TTL/LRU。
5. Render/chrome：KaTeX dynamic chunk、raw/sanitize 内容门控、completed-message useSmooth fast path、稳定 sidebar/Topbar selectors、O(N+E) Map visibility。

### 已确认的连接级阻塞与新增 Batch D

2026-07-18 使用真实 Chromium + 本机 HTTP/1.1 探针验证：前 6 个永久 fetch/SSE 连接建立后，第 7/8 个流以及随后发起的普通 `/ping` 在 1.5 秒观察窗内均保持 pending。结论不是“所有 pane 必须 multiplex”，而是 idle pane 不应永久占用连接。本 worktree 采用双系统：用户发起 turn 固定走该 turn 的临时 direct `/message` SSE；runtime self-turn 固定走 ChatProvider 生命周期内一条常驻 background SSE。两条路径按 turn origin 分流，不为 Multiwindow 增加额外协议复杂度。

### 2026-07-18 实施结果

- Background contract：关闭或 idle 的 pane 不再各自订阅；每个 ChatProvider 保持 1 条 `/chats/background/subscribe`，仅承载 runtime self-turn。用户 turn 使用临时 direct `/message` SSE；renderer reload 通过 `/stream?fromTurnId&fromSeq` 单飞恢复。
- Correctness contract：foreground/background watermark 分离；gap 是阻塞 barrier；跨 chat 先发送全部 gap control；cancel 绑定 turnId；spawn prompt 在 `beginTurn` 事务内原子消费；后台 spawn 只追加目标 tree pane，不抢焦点。
- Frontend：462 suites / 1272 tests；typecheck 通过。Backend：typecheck、关键 replay/context/outbox 定向测试与 74 个独立测试文件通过；`claudeSession.test.ts` 的独立 runner 在完成部分用例后未自动退出，未继续以重复长跑阻塞交付。Playwright：10 passed / 4 intentional skips。Root production build 与 bundle verifier 通过。
- Boot JS graph：1,711,974 B raw / 523,055 B gzip → 1,386,673 B raw / 425,432 B gzip（约 19%）。KaTeX JS 267,188 / 79,648、CSS 28,933 / 8,076，均不再由 boot HTML preload/link。
- `git diff --check` 通过。Repo 基线 lint 仍有 10 个 hook-order error，全部位于本 worktree 未修改且与 HEAD 相同的 `ToolCallGroup.tsx` / `UserInputBanner.tsx`，未混入本性能 tranche。

### 其余量测/设计 gate（本 worktree 不直接改变用户体验）

- M1/M2：增量 Markdown lexer 与 reveal span 动画窗口，必须先有 prefix-parity/property tests 与 paint profile。
- M4/M8/M9/M10：context 大拆分、Markdown/TipTap lazy、row memo 必须先有 render-count 与首帧/focus/IME 测试。
- L1/L3：virtualization 与 message eviction 必须联动 scroll restore、follow-pin、PaneFind、Global Search 设计。
- live-session purge：必须先提供 cancel-and-wait-terminal 生命周期原语；当前只实现可安全回载的 stub eviction，禁止裸 `dropSession`。

## 核心洞察

2026-06 的优化确实有效——审计验证那些路径已不是瓶颈。当前最大杠杆:

1. **打字路径** — `set-composer-draft` 未列入 HIGH_FREQ_ACTIONS,每个键击触发全站 structural selector 雪崩；修复虽小，但必须配合同步 draft/quote source-of-truth 与同帧提交回归测试(Q1)。
2. **流式 O(N²)** — `splitStreamingMarkdownBlocks` 每帧全文 re-lex + `applyTurnEvent` 每 chunk 全文 sentinel-strip(前后端各付一次)(M1+M3)。
3. **Boot bundle** — KaTeX / unified / TipTap 合计 ~400KB gzip 不该在首帧(Q3+M8+M9)。

## 执行路线图（按 ROI 排序）

> Q/M/L 编号与下方 Appendix 的 finding 编号无关；每行括号内 `→ #N` 指向对应 finding 详情。

### Tier 0 — Quick Wins（effort=S，impact≥medium）

| # | 问题 | 文件 | 修法 | 预期收益 |
|---|------|------|------|----------|
| **Q1** | `set-composer-draft` 每键一次 structural dispatch，全站 selector 空转（→ #1, #33） | `chatStore.tsx:156`, `TPane.tsx` | 加入 `HIGH_FREQ_ACTIONS`，同时用同步 draft ref 保证同帧 submit 读取最新内容（需补 structural + composer behavior tests） | 移除 structural fan-out；收益以测试/trace 为准 |
| **Q2** | inline 闭包 selector 每帧清空 structural 版本缓存（→ #2） | `ThreadRow.tsx:82` | useCallback 包裹 + module-level `EMPTY_EDGES` 常量 | sidebar 50+ 行渲染量减 5-10× |
| **Q3** | broad manualChunks 把 rehype-katex/KaTeX 拉进 boot graph（→ #29） | `vite.config.mts`, `viteChunks.ts` | 停止手工归并 unified/rehype 家族，保留 Rollup 的自然 dynamic-import boundary；用 artifact verifier 检查 boot HTML/static imports | 数学 JS/CSS 从启动依赖图延后到首次公式 |
| **Q4** | Boot 串行等待 advisory capabilities 后才请求 meta（→ #20） | `workspacePersistence.ts:1121` | 同一 attempt 立即启动 capability probe，但不 await；`fetchAllWorkspacesMeta()` 仍是唯一 readiness/retry gate | Web 首屏少等一个 advisory RTT，悬挂 probe 也不阻塞 hydration |
| **Q5** | rehype-raw + rehype-sanitize 无条件跑（→ #15） | `MarkdownContent.tsx:307` | `text.includes('<')` 门控 | 每条消息省 parse5 全序列化+重解析 |
| **Q6** | WorkspaceRow nodeStatuses 遍历全局 nodes（→ #35） | `WorkspaceRow.tsx:203` | 改遍历 `project.chatIds`，仅收集非 idle | 5×1000 nodes → 每 tick 5000→200 |
| **Q7** | messageNodeIds 死字段每 chunk clone Set（→ #23） | `workspacePersistence.ts:501` | 删除字段及 accumulate/merge 代码 | 流式每帧少一次 Set 分配 |
| **Q8** | data.db 在 WAL 下保持 FULL（→ #26） | `db.ts:37` | 仅 `initDb(data.db)` 使用 `PRAGMA synchronous = NORMAL`；audit/auth 保持 FULL | 低风险 hygiene；不宣称 macOS 可见收益 |
| **Q9** | Topbar trash/archived count 非当前页也算（→ #38） | `Topbar.tsx:237` | page 门控 + useCallback | 非 trash 页省 O(N)×2 |
| **Q10** | buildExplicitWorkspaceCommands edge 查找 O(E²)（→ #22） | `workspacePersistence.ts:452` | 预构建 `Map<serializedEdgeId, edge>` | 千 edge workspace 首同步 ~1M→~1K 次比较 |

### Tier 1 — High-Impact Medium Effort

| # | 问题 | 文件 | 修法 | 预期收益 |
|---|------|------|------|----------|
| **M1** | splitStreamingMarkdownBlocks 每帧全文 Lexer.lex，O(N²)/turn（→ #12） | `streamingMarkdownBlocks.ts:95` | 增量缓存 {prevText, prevBlocks}，只 re-lex 尾部（注意 htmlStack/double-dollar 合并守卫） | 流式渲染 CPU 减半+ |
| **M2** | reveal plugin 每帧给整个尾块逐字符包 span（→ #11） | `MarkdownContent.tsx:157` | 只 wrap `>= previousLength` 的新字符 + 每帧 span 上限 | DOM churn O(delta) |
| **M3** | applyTurnEvent 'chunk' 每 chunk 全文 answerContent()，前后端双付 O(L²)（→ #7, #25, #39） | `shared/src/turnProjection.ts:391` | 流式期间不算 content，done/error 时 finalize；checkpoint 惰性派生 | 最热路径省全文扫描×2 |
| **M4** | ChatProjectsContext 耦合 projects 与 focus/selection（→ #3） | `chatStore.tsx:2292` | 拆 structural / UI-focus 两个 context | focus 点击不再重渲全部 pane+行 |
| **M5** | transcript fingerprint 每 turn-end 全量重算（→ #4, #21, #43） | `transcriptFingerprint.ts`, `resumeStrategy.ts` | 共享逐段 FNV fold；WeakMap 缓存 `finalizeTurnContent` 输出字符串。禁止组合独立 per-message hash，禁止改变 wire value | 去除巨型 payload 与重复 finalize scans |
| **M6** | 每个 tool_call_update 绕过 throttle 做完整 SQLite 事务（→ #24） | `chatHub.ts:313` | toolCallUpdate 移出 STRUCTURAL_EVENTS（或仅 terminal 状态旁路） | codex 构建场景省数百次事务 |
| **M7** | 62 处 getDb().prepare() 每次重编译（→ #28） | `dbRepository.ts` | `Map<sql, StatementSync>` 缓存，closeDb 失效 | 每 checkpoint 省 6 次 prepare |
| **M8** | MarkdownContent 静态导入拖 unified 全家 352K 进 entry（→ #30） | `MessageBlock.tsx:7` | React.lazy MarkdownContent（MessageBlock/DigestPane/ArtifactPane 三处边界） | entry 减 ~110K gzip |
| **M9** | TipTap/ProseMirror 静态打入 897K entry chunk（→ #31） | `MentionEditor.tsx:9` | manualChunks 拆分或 React.lazy + textarea shim | entry 再减 ~80K gzip |
| **M10** | Sidebar 行无 React.memo + childrenOf Map O(edges)/行/render（→ #34, #37） | `WorkspaceTree.tsx` | 父级一次构建 adjacency Map 下传 + memo 行组件（注意行内自订阅 context 也要拆） | focus 切换全树渲→2 行 |
| **M11** | useSmooth 对已完成消息也全文 Intl.Segmenter（→ #14） | `useSmooth.ts:370` | `!streaming && 未曾 smoothing` 短路 | 千消息 pane 打开省 ~2M 次 segment + ~16MB boundaries |
| **M12** | sessionRegistry HistoryStubSession 永不 evict（→ #42） | `sessionRegistry.ts:64` | inactive stub 使用 30min TTL + 256-entry LRU；本次正在组装的深 ancestor chain 暂时保护，复制给 caller 后再恢复 cap；live-session 禁止 eviction | inactive resident stub entry 数受控且不遗留子进程；不宣称 transcript bytes 有硬上限 |
| **M13** | Map 页 visibleMapNodeIds O(N×E) + liveIds .filter() 身份级联 dagre 重排（→ #36 + gap#4） | `mapVisibility.ts:22` | 一次构建 parentOf + memoized root 解析；同时稳定 liveIds 数组身份（shallowArrayEqual） | Map 打开时 structural tick 不再全量重排 |

### Tier 2 — Architectural（effort=L）

| # | 问题 | 修法 | 说明 |
|---|------|------|------|
| **L1** | PaneMessageList 无 virtualization，pane mount 全量 markdown 管线（→ #13） | 窗口化:只渲最近 ~50 条 + IO sentinel 挂载更早消息 | **与 follow-pin（#16）、⌘F PaneFind、content-visibility 冲突,必须一起设计** |
| **L2** | Composer draft 每键全局 store 写（→ #19） | TPane-local state + 300ms debounce 持久化（mobile ChatScreen.tsx:68-95 已有先例） | Q1 止血、L2 治本;flush on blur/submit/unmount |
| **L3** | lazy tree bodies 永不 evict（→ #41） | LRU budget（~5 trees）+ `messages-unloaded` action | 与 L1 配合让内存封顶 |

### 建议执行顺序

```
第 0 批: RED tests + SSE 连接上限验证
第 1 批: Q1-safe → Q3 → M3 → Q5 → Q7 → Q4
第 2 批: Q2 → Q6 → Q9 → Q10 → M11 → M13
第 3 批: M5-wire-compatible → M6 → M7-limited → Q8-data-only → M12-stub-only
第 4 批: ChatProvider-level background SSE + foreground direct/replay recovery contract regression
设计 gate: M1 + M2 + M4 + M8 + M9 + M10 + L1 + L3
```


## 审计盲区（completeness critic 补充,未经对抗验证）

### 盲区 1: Network/connection dimension entirely uncovered: every open pane holds a permanent /subscribe SSE connection, colliding with the browser's ~6-connection-per-origin HTTP/1.1 cap
- 文件: `frontend/src/state/chatStore.tsx`

startObserver (chatStore.tsx:897-926) opens a persistent fetch-SSE via observeChatStream → subscribeChat (api.ts:639-652) for EVERY claimed pane, and the onTerminal comment says 'Never stop observing — owners need the subscribe channel for self-initiated turns'; it only closes on pane close. Owner panes ADDITIONALLY hold the /message SSE during a turn (the audit noted double-parse cost but not connection count). Electron/local direct-to-Express is HTTP/1.1 and was reproduced with real Chromium; the protocol seen by a deployed web browser depends on the hosting proxy and must be verified in that environment. Under an HTTP/1.1 origin Chrome caps roughly six concurrent connections: with the audit's own '20+ panes' scaling target, the 7th pane's subscribe stream, plus any createChat/lazy-message/persistence fetch, silently queues behind the long-lived streams — panes stop receiving events and flushes stall. No dimension audited connection pooling, waterfalls, or per-pane socket scaling.

### 盲区 2: No HTTP compression middleware and no cache headers on express.static — bundle-startup's gz numbers assume compression the server never applies
- 文件: `backend/src/server.ts`

grep confirms no 'compression' package anywhere in backend/src or backend/package.json, and static serving is bare `app.use(express.static(frontendBuild))` (server.ts:481) with no maxAge/immutable despite content-hashed filenames (e.g. Archived-CwO2IGlx.js). The bundle-startup dimension priced the boot path at '281K gz entry + 111K gz markdown-legacy' — but self-hosted (Electron file:// is fine, but the web topology serves via this Express instance) the wire cost is the RAW 897K entry chunk unless Railway's edge happens to compress, and hashed assets are conditionally revalidated (one RTT each) on every boot instead of served from cache. Two-line fix (compression middleware or precompressed .br + setHeaders immutable) with boot-path impact comparable to the manualChunks findings; nobody checked the serving layer.

### 盲区 3: FTS5 AFTER UPDATE trigger re-tokenizes the full assistant message on every checkpoint — hidden write amplification multiplying the confirmed tool_call_update finding
- 文件: `backend/src/services/db.ts`

db.ts:258-261 defines trigger messages_au: on ANY UPDATE of messages it does an FTS delete + full re-insert/re-tokenize of new.content. Every checkpoint and finalize runs writeAssistantSnapshot's `UPDATE messages SET content = ...` (dbRepository.ts:1080-1090), so the growing accumulated answer is re-tokenized into messages_fts on each checkpoint — O(answer length) FTS work per checkpoint, inside the same synchronous transaction. Combined with the confirmed 'tool_call_update bypasses the checkpoint throttle' finding, a chatty command stream pays full-answer FTS re-tokenization per stdout delta. The backend-runtime dimension audited the checkpoint transaction but never looked at the triggers attached to the table it writes. Fix option: exclude streaming checkpoints from FTS (e.g. only index at finalize via a rev/status guard in the trigger).

### 盲区 4: Map page: full dagre re-layout keyed on activeProject object identity — re-runs O(V·E) layout on every structural tick while the Map is open
- 文件: `frontend/src/components/terminal/pages/Map.tsx`

The layout useMemo (Map.tsx:202-312) lists `activeProject` (the whole project object) in its deps. Because ChatProjectsContext recreates project identity on every structural dispatch — including the confirmed per-keystroke composer-draft dispatch and per-turn touch-tree — dagre.layout(g) for every tree re-executes on each such tick while the Map page is open, plus the downstream fitZoom memo and full SVG re-render. The chrome-sidebar dimension audited mapVisibility.ts's O(N×E) pre-pass and per-chunk behavior but missed that the expensive dagre pass itself is invalidated by unrelated project mutations. Composing with the keystroke finding: typing in a composer while Map is open re-lays-out the entire forest per key press.

### 盲区 5: SSE fan-out re-serializes each event once per subscriber (encodeChatStreamEvent inside sub.send), and finalize adds a full-snapshot JSON.stringify just for a log field
- 文件: `backend/src/routes/michi.ts`

ChatHub.broadcast (chatHub.ts:328-336) calls sub.send(event) per subscriber, and each subscriber's send does its own encodeChatStreamEvent(ev) → JSON.stringify (michi.ts:1012-1021, 1073-1079). With the multi-window/observer architecture (owner + observer subscribe streams per pane, multiple windows), a single chunk is stringified N times on the event loop instead of encoded once and reused. Additionally finishWithDone logs `payloadBytes: Buffer.byteLength(JSON.stringify(terminalSnapshot))` (chatHub.ts:374-377) — an extra full-transcript stringify per turn purely for a log line. Low individually, but it is per-SSE-event backend CPU the backend-runtime dimension did not examine.

### 盲区 6: Backend half of the priorMessages finding is missing: 50mb express.json bodies re-parsed and re-materialized per send
- 文件: `backend/src/routes/michi.ts`

The confirmed state-render finding covers the FRONTEND building/shipping the full transcript per send, but nobody audited the receiving side: server.ts:361 sets `express.json({ limit: '50mb' })`, so every /message POST synchronously JSON.parses a body that grows with session length, then michi.ts:803 runs readTranscriptMessages(body.priorMessages, ...) re-materializing it — event-loop time proportional to transcript size per send, on the same process that is streaming other panes' SSE. Any fix that keeps priorMessages client-side must be evaluated against this backend cost too (e.g. send only a fingerprint and rehydrate from sqlite, which the resume-fingerprint machinery already half-supports).

### 盲区 7: CSS/paint dimension never audited: 17 backdrop-filter rules with known-fragile Electron vibrancy interaction
- 文件: `frontend/src/index.css`

grep counts 17 backdrop-filter usages in index.css. backdrop-filter forces compositor readback of everything beneath the element and is repainted whenever underlying content changes — i.e. continuously during token streaming if any translucent chrome (topbar, status line, drawers, palette) overlaps a streaming pane. Under Electron vibrancy (main.ts:472-477 shows the NSVisualEffectView window base) the sampled surface is the live window backing store, making this a per-frame GPU cost during streams. No dimension measured paint/composite cost, layer counts, or animation-driven repaint (the markdown reveal plugin's per-character CSS animations from the confirmed finding land inside these layers, compounding). At minimum a DevTools paint-profiling pass during a stream is missing from the audit.

### 盲区 8: Electron main-process dimension only got one finding; renderer<->main IPC, zoom/webPreferences, and backend fork stdio were never examined
- 文件: `electron/main.ts`

The bundle-startup dimension flagged serialized window creation, but nobody read the rest of electron/main.ts (~500 lines: vibrancy sync IPC at :32-36 — a SYNCHRONOUS ipcRenderer call blocks the renderer main thread; backend child stdio piping vs inherit affecting backpressure on backend logs; before-quit SIGTERM path). Sync IPC on the boot path and forked-backend stdout piping through the Electron main process are classic Electron perf traps and are one Read away from confirmation or dismissal — the audit should state it checked them.

## 跨发现冲突

Three cross-finding interactions the audit did not flag: (1) The markdown-dom "no render windowing" fix (virtualizing PaneMessageList) directly interacts with the markdown-dom follow-pin finding and the shipped content-visibility optimization — windowing changes every offsetTop/offsetHeight assumption the follow-pin at TPane.tsx relies on, and removes the DOM nodes content-visibility was preserving for find-in-pane (⌘F PaneFind searches rendered DOM). These must be fixed together, not independently. (2) The backend-runtime fixes "throttle tool_call_update checkpoints" + "PRAGMA synchronous=NORMAL" both widen the crash-loss window of the same durability mechanism; chatHub.ts:363-365 documents finalize as "the durability boundary" — applying both without revisiting recoverInterruptedTurns (dbRepository.ts:1255) semantics could lose more in-flight tool output on crash than either alone. (3) The composer-keystroke finding appears three times (state-render high, chrome-sidebar medium, persistence-hydration medium) as if independent; it is one root cause (draft dispatched through the structural reducer path) and a single fix (local draft state / HIGH_FREQ classification) resolves all three — the audit risks triple-counting impact.

## 各维度健康总结

### state-render

React state layer is architecturally strong: the four-context split (stable ChatNodeStoreContext external store + actions context + projects context + legacy full context), per-node useSyncExternalStore subscriptions (useChatNode), RAF-coalesced setNodes for HIGH_FREQ actions with a synchronously-updated nodesRef single writer, and the dedicated structural-version channel (useStructuralSelector) together ensure a streaming SSE chunk does NOT invalidate the provider subtree — chunk dispatches skip setProjects, keep all three context memos stable, and only wake the streaming node's subscribers once per frame. Reducers are consistently identity-preserving (early `return nodes` on no-ops), paneState prunes preserve references, and projectsValue deliberately reads nodesRef to avoid chunk-driven memo re-fires. The verified gaps are on the OTHER hot paths: (1) per-keystroke composer drafts are structural dispatches that bump the structure version and re-run every structural selector app-wide (O(nodes+edges×rows) per keystroke) — the top finding; (2) many useStructuralSelector call sites pass inline closures, blowing the version cache the hook's own docs warn about; (3) ChatProjectsContext couples `projects` with focus/selection/openPanes so every focus click or per-turn touch-tree re-renders all panes and sidebar rows (TPane's memo can't help against context); (4) turn-end work is O(full transcript) via computeTranscriptFingerprint; (5) per-chunk reducer work clones the full nodes Record + maps the full messages array (render is coalesced, reducer isn't); (6) every send rebuilds and uploads the whole transcript as priorMessages. Checked and found well-optimized (not findings): notifyChangedNodeSubscribers diff (O(2N) per commit, allocation-light), deletedIdsKey memo, openPaneBindingsKey gating the ownership effect off the hot nodes ref, the nodesRef non-backflow contract, and useNodesSelector's redux-style ref pattern.

### streaming-pipeline

Frontend SSE pipeline audit (streamMessage/subscribeChat parse loop, chatStreamRunner, observeChatStream, reducer chunk path, streamingProjection, queueFlush). Well-optimized areas confirmed: SSE parsing is lean (one shared TextDecoder with stream:true, incremental '\\n\\n' buffer splitting with no quadratic re-scan, exactly one JSON.parse per event in parseChatStreamEvent); React renders are RAF-coalesced via a single rafPending flag shared across all streaming panes (chatStore.tsx:836-843), so N concurrent streams still commit at most once per frame; the structural-version channel keeps sidebar/tree consumers from re-snapshotting per token; runProjectionCache (WeakMap keyed on last block) correctly skips re-stripping frozen runs; the stream probe (TextEncoder per chunk) is gated behind a localStorage flag; queueFlush.ts is trivial and cold. Remaining gaps are all per-SSE-event reducer-side CPU, not render-side: (1) the shared applyTurnEvent chunk case recomputes stripTurnMetadataSentinels over the full accumulated answer on every chunk and the frontend discards the result — the classic O(L²) the code's own comment warns about (backend chatHub pays it too); (2) each chunk triggers two dispatches (apply-seq + chunk), each shallow-copying the entire nodes record; (3) owner panes keep a parallel /subscribe stream that receives and JSON-parses every chunk a second time, with dedup only at dispatch (and an unguarded owner-side chunk dispatch that can double-append if the observer wins the race); (4) high-frequency reducer cases map the full message history per event, which hurts 1000+-message nodes. Backpressure is implicitly absent: the read loop dispatches synchronously per event, so a fast model translates directly into reducer CPU — fixes 1/2/4 shrink that per-event cost enough that explicit chunk coalescing before dispatch is likely unnecessary. No O(n²) string accumulation exists in the network buffer itself; live-tail projection is O(L) per animation frame (inherent to the shipped streaming-markdown design), not per chunk.

### markdown-dom

Markdown/DOM pipeline is in decent shape at the block level: the shipped stable-prefix split is correctly memoized (MarkdownBlock comparator keys on block.text/index, keys are stable prefix indices), frozen answer runs memo-hit via sameBlockRefs + the WeakMap runProjectionCache, message frames use content-visibility:auto (index.css:234-241), KaTeX and shiki are lazy-loaded, and useSmooth skips visibility listeners on completed messages. The remaining costs concentrate in two places: (1) the per-reveal-frame tick is much more expensive than 'throttled tail' suggests — each rAF-revealed grapheme re-runs marked Lexer.lex over the FULL answer text, then re-runs the whole remark/rehype-raw/sanitize pipeline on the tail block, then the reveal plugin explodes the entire tail block into one <span> per character with a CSS animation; and (2) large-session mounts have no render windowing — content-visibility skips layout/paint but React still runs react-markdown parsing plus Intl.Segmenter grapheme segmentation for every message on pane open. Secondary: unconditional rehype-raw (parse5 pass even with no HTML), O(N) child offset reads in the follow-pin per ResizeObserver fire, and per-chunk full-array reversals. Not reported (checked, fine): weaveRunToolBlocks per-frame slicing is O(L) string copies but cheap relative to markdown parse; countRender/probes are gated; proseVars/style props are referentially stable so memo comparators hold.

### persistence-hydration

Persistence/hydration dimension is largely healthy — the June 2026 v2 rework did its job. Verified well-optimized: (1) No full-state JSON.stringify per debounce tick — the legacy full-snapshot sync is gone; flushes build explicit per-entity commands from true dirty deltas (buildExplicitWorkspaceCommands), and node.upsert commands are deduped against a JSON projection cache so unchanged nodes send nothing. (2) Streaming does NOT write per chunk: streaming assistant messages are skipped by serializeMessageRowsForNode, the node projection is unchanged mid-stream so the 2s tick emits zero commands, and message bodies persist via the backend-authoritative turn path at done. (3) No localStorage/backend duplication: after backend hydration succeeds, clearDurableLocalStorageMirror removes the local mirror, and writeScopedLocalStorage / serializeWorkspaceForSync now have no live callers (dead-code candidates, ~150 lines). (4) Boot payload is meta-mode (structure + counts, no bodies) with per-tree lazy message loading (useLazyTreeMessages) — the 13MB whole-forest fetch is gone; the hydration barrier correctly distinguishes 'backend not up' from 'empty DB'. (5) Flushes run in requestIdleCallback behind a per-workspace single-flight queue with latest-task coalescing, and unload uses delta-scoped sendBeacon. Remaining gaps, ranked: an O(nodes×edges) synchronous projection-seeding pass at boot (findTreeIdForNode rebuilds the parent map per node) right at first paint; per-keystroke composer-draft dispatch through the global nodes record; three serial RTTs before hydrated=true (advisory capabilities probe awaited pointlessly); full-transcript fingerprint recompute at every turn end (linear in session size); O(E²) edge lookup on first-seed flushes; and a dead messageNodeIds set cloned per SSE chunk.

### backend-runtime

Backend runtime & data layer is largely well-architected: SQLite runs in WAL with busy_timeout and FK enforcement (db.ts:37-41); message chunks are NOT written to DB per SSE event — the ChatHub batches into a durable turn snapshot with a 1.5s checkpoint throttle plus a single finalize transaction (chatHub.ts:311-327), which is the right shape. The SSE write path is thin (direct res.write of a small `event:/data:` string per event, no buffering middleware, X-Accel-Buffering disabled); EventQueue is O(1) push/pull with a single waiter and unref'd heartbeat timers, and the known idle-buffering issue is mitigated by ClaudeSession's idle pump (heartbeats skipped, self-turns drained). Boot hydration uses the optimized ?meta=1 payload with a single grouped COUNT per workspace (dbRepository.ts:1374-1382) and per-tree lazy message loading. Ownership middleware is a hard no-op in desktop mode. ACP stdin/stdout uses simple newline-JSON with an indexOf loop — fine at chat-scale message rates. The real problems are concentrated in the streaming persistence hot path: (1) tool_call_update is classified as a 'structural' event that bypasses the checkpoint throttle, and the codex translator emits one per command-output stdout chunk — so a long-running command triggers a synchronous full-snapshot SQLite transaction per delta (event-loop blocking, WAL write amplification); (2) applyTurnEvent recomputes the sentinel-stripped content of the ENTIRE accumulated answer on every chunk (O(n²) per turn); (3) PRAGMA synchronous is never set, so WAL commits fsync at FULL on every checkpoint; (4) finalizeTurn re-reads and re-hashes the node's full message history for the resume fingerprint every turn; (5) all 62 repository statements are re-prepared per call with no statement cache. Fixing (1)+(3) is two small edits with the largest payoff.

### bundle-startup

Bundle/code-splitting health is largely good: all secondary pages are React.lazy in TerminalShell.tsx:17-27 (Map with dagre, Branches, Digest, Settings, ArtifactsDrawer, Workspaces, WorkspaceManage, Trash, Archived, Profile, CommandPalette), MobileShell and ExportPanel are lazy in App.tsx:4/24, shiki is exemplary (core+JS-regex engine in a dynamic markdown-code chunk, every language and theme individually dynamic-imported in shikiCodePlugin.ts:7-33/56-58 — only downside is the upstream 622K cpp grammar chunk, paid only on first C++ block), the vite config already has thoughtful manualChunks + a modulePreload filter, index.html pre-paints the saved theme before React mounts, fonts are self-hosted subset woff2, and backend boot correctly fires runtime warm() before app.listen without awaiting it (server.ts:228-235) with stale-while-revalidate model catalogs. The real problems are all one theme: the boot critical path carries ~515K gz of JS (entry 281K gz + markdown-legacy 111K gz + math 77K gz + react-vendor 45K gz) plus a render-blocking 28K KaTeX stylesheet. Three concrete causes: (1) the manualChunks `includes('node_modules/rehype')` pattern accidentally captures rehype-katex, converting the deliberately-lazy KaTeX path into a static boot dependency (S fix, biggest win per line changed); (2) MessageBlock statically imports MarkdownContent → react-markdown/unified, so the 111K gz markdown-legacy chunk is entry-blocking even on an empty Home page; (3) TipTap/ProseMirror is statically compiled into the 281K gz entry chunk via MentionEditor. Electron-side, window creation is fully serialized behind backend health, so packaged launches show nothing during backend boot.

### chrome-sidebar

Shell chrome audit (sidebar, topbar, tree, palette, Map). Well-optimized already: the structural channel is genuinely effective — HIGH_FREQ streaming actions (chunk/thought/heartbeat/tool-call) do not advance structureVersionRef, so sidebar/topbar structural selectors are NOT woken per SSE chunk (chatStore.tsx:826-841, 707-723); Topbar's per-pane title/status/kind/width selectors use shallowArrayEqual correctly (Topbar.tsx:104-121); projectsValue deliberately reads nodesRef so it doesn't re-fire per chunk (chatStore.tsx:2292-2303); CommandPalette debounces 200ms and uses server-side FTS instead of in-memory scans (CommandPalette.tsx:203-211); GlobalSearch.tsx is debounced+capped but appears to be dead code (no live import sites — candidate for deletion, not optimization); Map avoids per-chunk re-renders (structural selector for streamingIds, non-reactive nodesSnapshot) and its pan handler is a cheap scrollLeft/Top delta via ref; heavy pages are React.lazy'd. The real gaps: (1) composer keystrokes are structural dispatches — the single worst hot path, cascading O(threads×edges + nodes) selector work per keystroke; (2) the sidebar rebuilds edge-adjacency maps O(E) per row per render across treeHasUnread/buildTree/subtreeOpenState, amplified by inline-closure selectors that defeat useStructuralSelector's version cache (the hook's own docs warn about this, and most call sites in ThreadRow/WorkspaceRow/Topbar violate it); (3) rows are unmemoized so any focus/selection change re-renders the whole tree; (4) Map's visibility pre-pass is O(N×E) via repeated findTreeIdForNode. All findings verified against current working-tree code with file:line evidence; none overlap the June-2026 shipped optimizations.

### memory-longsession

Memory/GC audit of the current dev tree. Well-optimized areas confirmed and NOT reported: streamingProjection's runProjectionCache is a WeakMap keyed on block objects so entries die with their blocks (streamingProjection.ts:127-130 — no eviction needed); cloneBlocks preserves element identity so frozen runs stay memo-hit (assistantBlocks.ts:27-33); ChatHub turn logs are evicted 60s after turn end via scheduleEvict and subscriber sets are deleted when empty (chatHub.ts:74, 165-168, 469-474); EventQueue heartbeat timers are unref'd and cleared on dispose, and ClaudeSession.doSpawn disposes the old queue before creating a new one (eventQueue.ts:26, ClaudeSession.ts:673-679); terminal-component listeners/observers checked (TPane, TerminalShell, Dashboard) all have matching removeEventListener cleanups — the two 'unbalanced' TPane adds (pagehide :160, michi:sidebar-animating :204) are module-scope singletons, not per-mount leaks; TPane's scroll-position cache is LRU-capped at 200 entries (:65, :148); attachments store only {name, absPath} — no data URLs retained in state (chatTypes.ts:73-78) — and the one createObjectURL site revokes (exportWorkspace.ts:224-230); ChatHub.cancelledChats is cleaned in finally. The dominant remaining problems are (1) a per-chunk O(L) full-answer sentinel strip hidden inside the shared applyTurnEvent that runs on BOTH the frontend main thread and the backend event loop — the frontend adapter's comment shows the team believed this cost was already avoided; (2) per-chunk whole-nodes-record + whole-messages-array cloning in the reducer, whose cost compounds with (3) message bodies never being evicted once lazily loaded, so long multi-thread sessions grow resident heap monotonically; and (4) backend sessionRegistry stub sessions that pin full ancestor transcripts in Node heap forever with no eviction on chat delete. Two smaller items: full-transcript fingerprint rebuild at every turn end, and the paneOwnership claims Map never sweeping expired leases.

## 被驳回的发现（避免重复调查）

- **[streaming-pipeline] Owner panes keep a second live /subscribe SSE open during their own stream — every chunk is delivered, decoded and JSON-parsed twice** → ALREADY_MITIGATED
  - The claimed double-delivery mechanism does not occur in the current tree. The frontend does keep the /subscribe observer alive for owners (chatStore.tsx:945-953) and the hub does broadcast every stamped event to all subscribers (chatHub.ts:329-337), but the /subscribe route's subscriber explicitly drops every event server-side while an owner turn is active: michi.ts:1078 `if (chatHub.isOwnerTurnActive(chatId)) return;` with the comment "Suppress events while an owner turn (/message SSE) is active — those events already flow through the /message response. Only self-initiated turns (idle pump) pass through here." isOwnerTurnActive is backed by activeSessions, set in startTurn (chatHub.ts:136) before the first event and cleared only in runTurn's finally (chatHub.ts:457) after the terminal event, so the mask covers the entire turn including the replay-on-connect path (subscribe() replays log.events through the same send, chatHub.ts:156-165). Therefore during an owner-driven turn the observer socket carries zero chunk/thought/tool/done bytes — no 2× network, no 2× TextDecoder/JSON.parse in api.ts. The secondary duplicate-append race (owner onChunk dispatch ungated at chatStreamRunner.ts:153-156 vs observer applySeq dedup at observeChatStream.ts:49-57) cannot trigger either: the observer never receives seq-carrying events for owner turns, and self-initiated turns (startSelfTurn) have no concurrent /message stream, so each event has exactly one delivery path. The proposed fix ("backend skip broadcasting to the subscriber while an owner turn is active / client mask observer") is literally what already shipped, implemented at the route layer rather than in ChatHub.broadcast. Residual cost is 20 idle SSE connections receiving only periodic heartbeat frames (michi.ts:1090-1099) — negligible, and intentional so background/self-initiated turns wake panes. Note the reviewer was misled by reading only the hub's broadcast and the client dedup, missing the route-level gate.
- **[backend-runtime] Legacy full-snapshot bulk load still ships every message body of every workspace in one response** → ALREADY_MITIGATED
  - The cited mechanism is real: dbRepository.ts:1344 loadAllWorkspaces → loadFullWorkspace (1325-1342) selects every message body per workspace, and persistence.ts:55-58 serves the non-meta branch in one res.json. However, the performance-relevant trigger no longer exists. The only hydration path in the live frontend is workspacePersistence.ts:1139 `return await fetchAllWorkspacesMeta();` — the ?meta=1 lazy path (per-node counts + per-tree body fetches), explicitly introduced to replace the "whole-forest 13MB" boot payload (comment at workspacePersistence.ts:1136-1138). The non-meta client function fetchAllWorkspaces (api.ts:789) has zero production callers — every reference is a vi.fn() test mock. So GET /workspaces/all without meta=1 is a dead route branch nobody hits; the event-loop-blocking scenario ("legacy hydration path... still live") is not exercised by any shipped frontend. The remaining user, backup.ts:32 GET /backup/export, also has no frontend caller (grep found only the backend route definition) and is an on-demand, purpose-built full-snapshot export whose cost is inherent to being a backup — a rare explicit action, not a hot path. The June-2026 lazy-load work (useLazyTreeMessages + loadAllWorkspacesMeta + fetchTreeMessages) is precisely the mitigation for the claimed problem; what's left is code hygiene (an unused route branch and client fn), not a performance issue anyone pays.

---

# Appendix: 全部 44 条确认发现（完整细节）

> 本 Appendix 的 present-tense 机制、旧行号与 build artifact 均描述审计基线 `dev@2e711cc1`，用于保留 finding 证据；worktree 中已实施项的现状与验收以文首「2026-07-18 实施契约」及配套 implementation plan 为准。

## #1 [state-render] Every composer keystroke is a structural dispatch that re-runs every useStructuralSelector app-wide

- **位置**: `frontend/src/state/chatStore.tsx:829`
- **影响**: high | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every keystroke in any pane composer (the primary typing surface). Also fires on paste, mention edits, quote changes.

**机制**:

TPane's MentionEditor is store-controlled: each TipTap change calls setDraft -> setComposerDraft(nodeId, ...) -> dispatch({type:'set-composer-draft'}) (TPane.tsx:1954, 373-391). 'set-composer-draft' is NOT in HIGH_FREQ_ACTIONS (chatStore.tsx:156-159), so per keystroke: (a) structureVersionRef bumps (chatStore.tsx:829-831), (b) setNodes(next) runs synchronously (line 845) re-rendering the 2900-line ChatProvider body, and (c) on commit the structural channel notifies (lines 719-722) every useStructuralSelector consumer, whose version-keyed caches all miss and re-run their selector bodies: Topbar selectUnreadTotal O(nodes) (Topbar.tsx:86), WorkspaceRow nodeStatuses O(nodes) + treeHasUnread per tree (WorkspaceRow.tsx:203-238), every visible ThreadRow's treeHasUnread which rebuilds a childrenOf Map from ALL project edges (ThreadRow.tsx:82 -> sidebarSelectors.ts:230-237), and per open TPane the sameTreeNodes selector calling findTreeIdForNode per chatId — O(chatIds × edges) each (TPane.tsx:1169-1181, tree.ts:104-118). With 50 threads, 200+ edges and 5+ open panes this is hundreds of thousands of ops plus Map/array allocations per keystroke, on the main thread, while the user types.

**修复建议**:

Keep the draft component-local in TPane (uncontrolled TipTap) and persist to the store on a ~300ms debounce/blur, or add a dedicated draft channel: classify 'set-composer-draft' as high-frequency (it mutates no field any structural selector reads — verify against chatReducers.structural.test.ts) so it neither bumps structureVersion nor forces a synchronous provider render. The debounced-persist option also removes the full TPane re-render per keystroke.

**验证者笔记**:

Every link in the claimed mechanism is present in the current tree, unmitigated, and fires once per keystroke:

1. Per-keystroke dispatch, no debounce: MentionEditor.tsx:501-504 `onUpdate` calls `onChange(draft)` on every TipTap transaction (no throttle/debounce anywhere in the file). TPane.tsx:1954 wires `onChange={setDraft}`; setDraft (TPane.tsx:383-391) → persistComposerDraft (TPane.tsx:375) → setComposerDraft → `dispatch({type:'set-composer-draft'})` (chatStore.tsx:1938).

2. Not high-frequency: HIGH_FREQ_ACTIONS (chatStore.tsx:156-159) contains only chunk/thought/heartbeat/tool-call/tool-call-update/plan/subagent-list-update/subagent-tool-activity/apply-seq. So each keystroke takes the cold path: structureVersionRef bumps (chatStore.tsx:829-831) and `setNodes(next)` runs synchronously (chatStore.tsx:845) — a full ChatProvider render (the two ~65-entry context useMemos at 2578-2713 re-evaluate their dep arrays; values stay referentially stable so the subtree bail-out mostly holds, but the provider body itself runs).

3. Structural fan-out: the commit effect (chatStore.tsx:707-723) does an O(all nodes) reference diff (notifyChangedNodeSubscribers, 632-648), fires all store subscribers, and — because the version advanced — fires every structureSubscriber. useStructuralSelector's version-keyed cache (chatStore.tsx:2876-2889) misses (`last.version !== version`), so every consumer's selector body executes. React's useSyncExternalStore only forces a re-render when the snapshot changed, and the equalityFn returns the cached value here (composerDraft isn't a structural input), so consumers don't re-render — but the selector work + allocations all happen, exactly as claimed.

4. The expensive selectors are as cited: Topbar selectUnreadTotal iterates all nodes (Topbar.tsx:86, sidebarSelectors.ts:208-215) plus 5 more structural selectors in Topbar (104-118, 237); WorkspaceRow nodeStatuses builds a full Record over ALL nodes with an O(N) equality check (WorkspaceRow.tsx:203-215) plus workspaceHasUnread (216-218); each visible ThreadRow's treeHasUnread rebuilds a childrenOf Map from ALL project edges plus a subtree DFS (ThreadRow.tsx:82-83 → sidebarSelectors.ts:230-247) — note ThreadRow passes an inline (non-useCallback) selector, so its cache is additionally cleared every render per chatStore.tsx:2868-2871; each open TPane's sameTreeNodes calls findTreeIdForNode per chatId, and tree.ts:114-118 rebuilds a parentOf Map from all edges on EVERY call — O(chatIds × edges) Map construction per pane per keystroke (TPane.tsx:1169-1181), plus parentTitle and mergeSourceLabels selectors.

5. Additional confirmed per-keystroke cost the claim only implies: the edited node's reference flips, so useChatNode fires and the ~1.7k-line TPane re-renders fully every keystroke (PaneMessageList is memoized, but composer chrome/toolbars re-render). And because `setNodes(next)` on the cold path publishes the latest nodesRef synchronously, typing WHILE another pane is streaming flushes accumulated chunk state outside the RAF coalescing — every keystroke forces streaming panes to commit too, amplifying cost exactly when the app is busiest.

Mitigations checked and absent: no debounce in MentionEditor or TPane; 'set-composer-draft' is not in NODE_ACTIVITY_ACTIONS (chatReducers.ts:13-24) so at least no setProjects churn; the reducer's composerDraftEqual short-circuit (chatReducers.ts:1166-1174) only helps for no-op writes, never for real typing; persistence side is debounced (shipped optimization) so disk writes are fine — the cost is purely the render/selector path.

Impact: at the audit's stated target scale (50+ threads, 200+ edges, 5+ open panes) the arithmetic holds — sameTreeNodes alone is ~5 panes × ~100 chatIds × ~200-edge Map rebuilds ≈ 100k+ ops plus Map/array allocations, on top of the full TPane render and provider render, per keystroke on the main thread, synchronous with typing. At small scale it would be medium, but 'high' is fair for the scaling scenario this audit explicitly targets, and typing is the app's single hottest input path.

**补充证据 / fix 安全检查**:

Fix sanity check:

Option B (classify 'set-composer-draft' as HIGH_FREQ) is safe and cheap: the reducer (chatReducers.ts:1166-1174) touches only `composerDraft`, which is NOT in STRUCTURAL_FIELDS (chatReducers.structural.test.ts:16-20 lists status/kind/title/deletedAt/pinnedAt/markedReadAt/seenMessageIds/paneWidth/digest/lastAssistantAt/viewedAt/deletionGroupId), so the structural invariant test would pass after adding a SAMPLE_ACTIONS entry (required — the coverage assertion at test line 77-81 fails otherwise). RAF-coalesced setNodes means the draft echoes back to MentionEditor one frame late, but MentionEditor's lastSyncedRef guard (MentionEditor.tsx:502-503, 517-523) already absorbs its own echo, so no feedback loop or caret jump. nodesRef stays the single synchronous writer (dispatch still updates it before RAF), so onSubmit reading `draft.value` via useChatNode one frame stale is the only behavioral delta — worst case the submitted text lags the very last keystroke by one frame if the user hits Enter within ~16ms of typing; TPane.tsx:1555 reads `draft.value` from the store-derived prop, worth flushing synchronously on submit. This option removes the structural fan-out and the synchronous provider render but keeps one RAF-coalesced TPane re-render per frame of typing.

Option A (component-local draft + debounced persist) removes the TPane re-render too and has precedent in-repo: mobile ChatScreen already does exactly this (ChatScreen.tsx:68-95: local draftLocal state, sync-in on node change, write-back guarded). Constraints to respect: composerDraft is persisted (workspacePersistence.ts:300) and restored (chatHydration.ts:417, 676), so flush on blur/submit/unmount is needed to avoid losing the tail on crash; the multi-window 'observing' hint (TPane.tsx:1967) and the queued-message restore path (TPane.tsx:1930 external setComposerDraft) require the editor's external re-sync effect to keep working — it does, since MentionEditor re-syncs whenever incoming props differ from lastSyncedRef. Wire-stability (mentionDoc serialization) is orthogonal to where the draft state lives. Neither fix touches stream terminal safety or per-tree pane maps.

Not part of the claim but observed: ThreadRow.tsx:82-83 passes an inline selector (no useCallback), which nukes useStructuralSelector's version cache every ThreadRow render (chatStore.tsx:2868-2871) — worth fixing alongside.

---

## #2 [state-render] Inline (non-memoized) selectors passed to useStructuralSelector blow the version cache every render

- **位置**: `frontend/src/components/terminal/ThreadRow.tsx:82`
- **影响**: medium | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every render of Sidebar rows / Topbar — i.e. every pane focus change, selection toggle, tree activity touch (per assistant turn), workspace switch. Scales with thread count (50+ rows) and edge count.

**机制**:

useStructuralSelector's docstring requires a stable selector identity; when it changes, `lastRef.current = null` (chatStore.tsx:2868-2871) and the selector body re-runs even when the structure version is unchanged. Many hot consumers pass fresh closures every render: ThreadRow.tsx:82 (`(nodes) => treeHasUnread(tree, projectEdges, nodes, focusedNodeId)` — and `projectEdges` itself is `projects.find(...)?.edges ?? []`, a new `[]` each render, ThreadRow.tsx:81), WorkspaceRow.tsx:203/216/220 (O(all-nodes) Record build + Object.entries alloc), Topbar.tsx:86-118 (selectUnreadTotal O(nodes) + 4 openPanes maps), Map.tsx:105, Home.tsx:25, Settings.tsx:42/50, Workspaces.tsx:227. These components also consume ChatProjectsContext, which changes identity on every focus/selection/pane change and on every per-turn touch-tree — so each such render pays the full O(nodes)/O(edges) selector cost per sidebar row, exactly the work the structural cache was built to skip.

**修复建议**:

Wrap each selector in useCallback keyed on its real inputs (as TPane.tsx:1159-1213 and Dashboard.tsx:46-57 already do), and hoist the `projectEdges` fallback to a module-level EMPTY_EDGES constant. For per-row treeHasUnread, consider computing unread tree ids once in the parent (one O(edges) pass) and passing a boolean prop to each ThreadRow.

**验证者笔记**:

Mechanism verified end-to-end in the current tree. (1) The cache-blow exists exactly as claimed: chatStore.tsx:2868-2871 `if (selectorRef.current !== selector) { lastRef.current = null; }` with the comment "Per-render closures break the version cache; blow away cached result", and the @remarks (2852-2855) explicitly require useCallback for inline lambdas. Since useSyncExternalStore invokes getSnapshot on every render, a per-render closure means the selector body re-runs on every render of the consuming component even when getStructureVersion() is unchanged — precisely the case the structural cache exists to skip. (2) The cited hot consumers all pass fresh closures: ThreadRow.tsx:82-84 inline `(nodes) => treeHasUnread(tree, projectEdges, nodes, focusedNodeId)` where projectEdges (line 81) is `projects.find(...)?.edges ?? []` (new `[]` fallback each render); WorkspaceRow.tsx:203-215 inline selector that builds an O(all-nodes) Record via Object.entries plus an inline O(N) equality fn (both refs churn per render), plus wsUnread (216-218) and unreadTreeIds (220-232); Topbar.tsx:86-88 inline selectUnreadTotal (O(all nodes), sidebarSelectors.ts:208-215) and four inline openPanes.map selectors (104-121). Map.tsx:105, Home.tsx:25, Workspaces.tsx:227 also inline. None of these components are React.memo'd. (3) The trigger cadence is honest: ThreadRow/WorkspaceRow/Topbar consume useChatProjects(); projectsValue (chatStore.tsx:2292-2343) re-memoizes on openPanes/focusedPane/focusedNodeId/selection/treeSelection — i.e. every focus change and selection toggle (these are plain useState, no structure-version bump, so the version cache WOULD have short-circuited if selector identity were stable) — and on every per-turn touch-tree (dispatch at chatStore.tsx:848-860 calls setProjects for every NODE_ACTIVITY_ACTION: user-send/done/error/set-title/set-follow-ups etc., chatReducers.ts:13-24). Each such flip re-renders all N ThreadRows, each rebuilding a childrenOf Map over ALL project edges plus a Set-based DFS (sidebarSelectors.ts:229-247), and each WorkspaceRow rebuilding an O(all-nodes) Record. With the audit's stated scale (50+ threads, 1000+ nodes/edges) that is ~50 redundant O(E) walks + a few O(N) map builds per focus/selection/turn interaction. (4) Not per-SSE-chunk: chunk/tool-call are HIGH_FREQ (chatStore.tsx:156-159), don't touch projects or the structure version, and the claim correctly does not assert per-chunk cost. Contrast with TPane.tsx:1159-1213 and Dashboard.tsx:46-57 which wrap the same hook's selectors in useCallback — confirming this is a known, followed convention that these sidebar/topbar call sites violate. Impact "medium" is fair for the stated large-session scaling target: per-interaction/per-turn milliseconds of pure allocation+walk waste on the always-mounted sidebar, not a per-chunk hot loop.

**补充证据 / fix 安全检查**:

Fix sanity check: (a) The useCallback fix works but deps must be chosen carefully — keying ThreadRow's selector on the `tree` object is nearly useless because touch-tree replaces the Tree object every turn ({ ...t, lastActiveAt }, chatReducers.ts:87-90); key on tree.id/tree.rootNodeId instead (treeHasUnread only reads tree.rootNodeId). Note reduceProject('touch-tree') preserves p.edges by reference, so a hoisted module-level EMPTY_EDGES plus `project.edges` is a stable dep across turns. (b) `focusedNodeId` is a genuine input to treeHasUnread/selectUnreadTotal, so a useCallback keyed on it still re-runs all rows' selectors on every focus change — the parent-level fix (one O(E) pass in WorkspaceRow computing unread tree ids, passing a boolean prop; this shape already exists as `unreadTreeIds` at WorkspaceRow.tsx:220-232 but only when forceExpand) is strictly better: one childrenOf Map build instead of N. (c) One residual cost the fix does NOT remove: 'set-composer-draft' is not in HIGH_FREQ_ACTIONS, so every composer keystroke bumps structureVersion and legitimately re-runs every structural selector once (cache miss by version, not by identity) — that per-keystroke O(nodes+E·threads) selector sweep is a separate version-granularity issue, not attributable to this finding. (d) Invariant risk: none — these are read-only render-phase selectors; the fix touches neither nodesRef single-writer, composer wire-format, per-tree pane maps, nor stream terminal safety. Only caution: don't move focusedNodeId into a ref inside the selector to dodge re-runs — that would return stale unread state on focus change since the structural version doesn't bump on focus.

---

## #3 [state-render] ChatProjectsContext couples the projects forest with hot ephemeral focus/selection state, fanning out to every pane and sidebar row

- **位置**: `frontend/src/state/chatStore.tsx:2292`
- **影响**: medium | **工作量**: L | **验证**: CONFIRMED
- **触发**: Every pane focus/click, every selection toggle, every turn start/end (user-send/done/set-title/set-follow-ups all touch-tree), search-highlight set/clear. Cost scales with open pane count (20+ panes) and sidebar row count.

**机制**:

projectsValue (chatStore.tsx:2292-2342) bundles `projects`, `activeProject`, `order`, `edges` together with `focusedPane`, `focusedNodeId`, `openPanes`, `selection`, `treeSelection`, `searchHighlightTerm`, `canNavBack/Forward`. Any change to ANY of these rebuilds the memo and re-renders every useChatProjects consumer: each open TPane (~1.7k-line component; its React.memo comparator at TPane.tsx:2083-2086 only guards props, context bypasses it), every ThreadRow/WorkspaceRow, Topbar, Dashboard, Sidebar, MobileShell. Concretely: clicking a pane changes focusedPane + focusedNodeId (which also dispatches node-viewed and may setProjects activate-tree, chatStore.tsx:482-496) → all 20 open panes re-render; every assistant turn start/end runs the NODE_ACTIVITY touch-tree setProjects (chatStore.tsx:848-861) flipping `projects` identity → same full fan-out, which then combines with finding 2's blown selector caches.

**修复建议**:

Split into (a) a structural projects context (projects/activeProject/order/edges/hydrated) and (b) a UI-focus context (focusedPane, focusedNodeId, openPanes, selection, treeSelection, searchHighlightTerm) — or move focus/selection into the external-store channel with per-key subscriptions so a focus flip only re-renders the two panes whose focus state changed. Also consider debouncing/absorbing touch-tree (lastActiveAt) writes so projects identity doesn't flip twice per turn.

**验证者笔记**:

Every element of the claimed mechanism is present in the current tree. (1) projectsValue at chatStore.tsx:2292-2342 does bundle structural state (projects, activeProject, order, edges, hydrated) with hot ephemeral state (openPanes, focusedPane, focusedNodeId, viewMode, selection, treeSelection, searchHighlightTerm, unreadFilterOn, canNavBack/Forward) in a single useMemo whose dep array includes all of them, published through one ChatProjectsContext.Provider (chatStore.tsx:2717). (2) Consumers use plain useContext (useChatProjects, chatStore.tsx:2738-2741) — no selector layer — so any identity flip re-renders every consumer: TPane (TPane.tsx:334-340), ThreadRow (:77), WorkspaceRow (:193), Topbar (:65), Dashboard (:43), WorkspaceTree (:70), TerminalShell (:88). (3) The React.memo comparator on TPane (TPane.tsx:2083-2086) only guards nodeId/contentMaxWidth props and is bypassed by the context subscription, exactly as claimed. (4) The touch-tree fan-out is real: NODE_ACTIVITY_ACTIONS (chatReducers.ts:13-24) covers user-send/done/error/set-title/set-follow-ups/agent-spawn/image-block/permission-request; dispatch (chatStore.tsx:848-861) runs setProjects with reduceProject touch-tree, which unconditionally rebuilds the project object ({ ...p, trees: trees.map(...) }, chatReducers.ts:87-90). So a typical turn flips projects identity ~3-4 times (user-send, set-title, set-follow-ups, done), each time re-rendering all open panes and all sidebar rows. (5) The claimed selector-cache interaction is confirmed: TPane's sameTreeNodes selector (TPane.tsx:1169-1181) closes over activeProject; when activeProject identity flips, useStructuralSelector nulls its version cache (chatStore.tsx:2868-2872) and re-runs an O(chatIds x tree-walk) computation per pane. (6) setFocusedNodeId's conditional activate-tree setProjects is at chatStore.tsx:482-496 as cited. The impact estimate is honest: the reviewer correctly scoped it to focus clicks, selection toggles, and turn boundaries (chunk is NOT in NODE_ACTIVITY_ACTIONS, and the memo comment at 2297-2299 shows streaming chunks deliberately bypass this context via nodesRef). The damage is also correctly bounded to 'medium' because the June-2026 optimizations hold the inner cost down: PaneMessageList's memo comparator (PaneMessageList.tsx:198-215) compares node/prefs/callback identity, so the heavy message list skips these fan-outs — what re-renders 20x is the TPane shell (composer chrome, header, dozens of hooks and structural selectors) plus every ThreadRow/WorkspaceRow. Medium is a fair rating for 20+ panes / 50+ threads on per-click and 3-4x-per-turn frequency.

**补充证据 / fix 安全检查**:

Fix sanity check: splitting ChatProjectsContext into a structural context and a UI-focus context is compatible with the documented invariants — it touches neither the nodesRef single-writer channel (nodes flow through ChatNodeStoreContext/useSyncExternalStore, chatStore.tsx:2857-2892, entirely separate), nor composer wire-stability (composer drafts flow through useChatActions.setComposerDraft, a different context), nor the per-tree pane maps (openPanes/focusedPane storage stays keyed by `${workspaceId}::${treeId}`; only the read-side context changes), nor stream terminal safety (done/error dispatch path untouched). Two caveats for the proposed fix: (a) a plain two-context split does NOT fix the focus-flip pane fan-out by itself, because TPane legitimately reads focusedPane (isFocused, TPane.tsx:947) — all 20 panes would still re-render on the focus context; only the per-key subscription variant (like the existing useChatNode/subscribeStructure pattern) fixes that, and the codebase already has the infrastructure (ChatNodeStoreContext external-store channel) to model it on. The split alone DOES fix the touch-tree/turn-boundary fan-out reaching focus-only consumers and vice versa. (b) Debouncing touch-tree (lastActiveAt) is safe for rendering but must keep the value flushed before workspacePersistence's dirty-delta write and before archive-fallback ordering reads (lastActiveAt picks the successor tree when archiving the active tree per AGENTS.md) — a trailing-edge debounce that still lands within the 2s persistence window is fine. Also worth noting: `agentStatus` and `availableModes` sit in the same memo but change only at boot/reload — they are not part of the hot-path problem; and the ChatContext `value` memo (chatStore.tsx:2344+) has the same coupling for its own consumers, so a fix should address both providers.

---

## #4 [state-render] 'done' reducer recomputes the transcript fingerprint over the entire message history on every turn end

- **位置**: `frontend/src/state/chatReducers.ts:555`
- **影响**: medium | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every assistant turn completion ('done' action) on every node; also fires on aborted streams (onAborted dispatches synthetic done, chatStreamRunner.ts:282). Cost grows linearly with session length — worst at exactly the long-session scale where turns are frequent.

**机制**:

The `done` case calls computeTranscriptFingerprint(msgs) which, for EVERY message in the node, runs assistantPersistenceContent → finalizeTurnContent (a full-string scan of the message's raw block text) and concatenates all content into one payload string before FNV-hashing it (transcriptFingerprint.ts:6-13). This is O(total transcript characters) of string building + scanning on the main thread, inside a reducer, at the exact moment the UI is also doing turn-end work (metadata extraction at chatReducers.ts:514-524 does another full scan of the final message, plus follow-up/title parsing). For a 1000-message node with a multi-MB transcript this is tens of MB of transient string allocation per turn.

**修复建议**:

Make the fingerprint incremental: cache a per-message content hash (messages before the current turn are immutable) and chain-hash `prevFingerprint + newUserMsg + newAssistantMsg` instead of rescanning history; or stream the FNV hash per message without building the concatenated payload string (hash the separator bytes directly), and store per-node running hash updated only for the two new messages.

**验证者笔记**:

Mechanism verified exactly as claimed. chatReducers.ts:555 (`resumeFingerprint: computeTranscriptFingerprint(msgs)`) runs inside the 'done' reducer case over the node's FULL message array. transcriptFingerprint.ts:6-13 loops every message; for each assistant message it calls assistantPersistenceContent (assistantBlocks.ts:92-94) → finalizeTurnContent (shared/src/turnProjection.ts:156-170), which per message does: titleMatch, followUpsMatch (regex matchAll over the whole raw text plus a follow-up-slot backscan), stripTurnMetadataSentinels (char-by-char scan of the entire string, turnProjection.ts:180-222), a global regex replace, a blank-line-collapse replace, and trim — 4-6 full passes and several intermediate string copies per assistant message. It then string-concatenates ALL content into one payload (`payload += ...`) and FNV-hashes it char-by-char. No caching or memoization exists anywhere in transcriptFingerprint.ts, assistantBlocks.ts, or turnProjection.ts (grep confirmed). Trigger verified: dispatched at every turn end (chatStreamRunner.ts:276), on aborted streams (chatStreamRunner.ts:282), and on observer-stream completion for background nodes (observeChatStream.ts:142). The turn-end pile-up claim is also real: the same 'done' case runs assistantMetadata → extractTurnMetadata (another multi-regex scan of the final message, chatReducers.ts:514-524), and turn end coincides with persistence work. This is synchronous main-thread work inside a React reducer dispatch, O(total transcript chars) × several passes — at the audit's stated 1000+-message / multi-MB scale that is plausibly tens of ms of jank plus transcript-sized (multi-MB) transient allocation per turn, exactly when the pane re-renders the completed message. Impact 'medium' is honest: it is per-turn-end, not per-chunk or per-keystroke, negligible for small nodes, but grows linearly and fires on every turn including cancels. Not mitigated by any June-2026 optimization: streamingProjection/memoization covers rendering, not this reducer computation; lazy tree loading only spares background nodes whose messages aren't loaded — the actively-streamed node always has full history in memory. None of the shipped optimizations touch this path.

**补充证据 / fix 安全检查**:

Key excerpts: chatReducers.ts:555 `resumeFingerprint: computeTranscriptFingerprint(msgs)`; transcriptFingerprint.ts:8-12 `for (const m of messages) { const content = m.role === 'assistant' ? assistantPersistenceContent(m) : m.text ?? ''; payload += ... } return fnv1a32(payload)`; turnProjection.ts:166-169 finalizeTurnContent ends with `stripTurnMetadataSentinels(answer).replace(INLINE_BRANCH_OVERVIEW_RE_G,'').replace(/\n[ \t]*\n[ \t]*\n+/g,'\n\n').trim()`. Fix sanity check: (a) The frontend fingerprint MUST stay byte-identical to the backend's computeTranscriptFingerprint (backend/src/services/resumeStrategy.ts:125-131) — michi.ts:804-807 compares storedFingerprint (sent by frontend) against a server-computed currentFingerprint, and any mismatch degrades resume to 'compatible' (resumeStrategy.ts:113-115, reason 'transcript_changed'), silently losing native resume. FNV-1a is stream-composable, so carrying the running 32-bit hash state per message (instead of building the payload string) yields the IDENTICAL value — that half of the fix is safe and eliminates the big concat allocation. (b) Per-message content-hash caching is the part that needs care: it must be invalidated when messages are replaced wholesale (lazy-load hydration flips messagesLoaded and swaps the array, chatHydration.ts:342/567; 'realign-assistant-id' renames ids at chatReducers.ts:585+ but doesn't change content/role so it's hash-neutral). Caching keyed on message object identity (WeakMap on the immutable message refs) would be robust since streaming replaces the tail message object on every event. Note the dominant cost is likely finalizeTurnContent's multi-pass scans per assistant message, not the FNV loop itself, so per-message caching is the higher-value half. (c) No conflict with documented invariants: the fix stays inside the reducer (nodesRef single-writer untouched), doesn't touch composer wire format, per-tree pane maps, or stream terminal safety (done/error still terminal; fingerprint is a field on the same 'done' state update). One caveat: a WeakMap cache module-level beside the reducer keeps the reducer observably pure (same input → same output) since the cached value is content-deterministic.

---

## #5 [state-render] Per-SSE-chunk reducer clones the whole nodes Record and maps the node's full messages array

- **位置**: `frontend/src/state/chatReducers.ts:423`
- **影响**: low | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every SSE chunk/thought/tool event on every active stream; worst with long transcripts (1000+ messages) plus many concurrent streams.

**机制**:

reduceNodes runs synchronously for every dispatched chunk/thought/tool-call event (RAF coalescing only batches React renders, not reducer work — chatStore.tsx:826-843). The 'chunk' case does `n.messages.map(...)` over ALL messages just to replace the tail streaming message, then `{ ...nodes, [id]: {...} }` which copies every property of the whole nodes Record (all nodes across all workspaces/trees, since hydration registers every node even when bodies are lazy). For a 1000-message node in a 2000-node store at ~100 chunks/s, that is ~300k element copies + two fresh arrays/objects per second per stream — multiplied by parallel streams (fanout / spawn_branches can run 5-20 at once). Same pattern in 'thought', 'tool-call', 'tool-call-update', 'plan', 'image-block' (chatReducers.ts:431-506).

**修复建议**:

Fast path for streaming appends: the target is virtually always the last message — check `msgs[msgs.length-1].id === assistantId` and do a slice()+tail-replace (or find the index once and copy with splice) instead of a predicate map over all messages. The Record spread is harder to avoid with plain objects; if profiling shows it matters at 2000+ nodes, coalesce reducer work per RAF too (buffer chunk text per assistantId and apply once per frame), which also cuts projectAssistantStreamEvent snapshot allocations by ~10x.

**验证者笔记**:

Mechanism verified at every cited location. chatReducers.ts:420-428 'chunk' does `n.messages.map(...)` over the node's entire messages array plus `{ ...nodes, [id]: {...n} }` full-Record + full-node spreads; the same pattern repeats verbatim in 'thought' (433-438), 'plan' (443-448), 'tool-call' (453-468), 'image-block' (473-486), 'tool-call-update' (491-506), and 'block-reset' (405-418). chatStore.tsx:826-827 runs reduceNodes synchronously on every dispatch; the RAF path (836-843) only coalesces setNodes React renders, exactly as the claim states — reducer work is NOT batched. chatStreamRunner.ts:156 (and observeChatStream.ts:77 for observer streams) dispatch one 'chunk' action per SSE frame with no upstream coalescing (api.ts SSE loop dispatches each parsed frame immediately). Hydration registers a placeholder node for every row even in lazy meta mode (chatHydration.ts:553-567), so the Record spread scales with total node count across all workspaces, not just loaded ones. Not mitigated: 'chunk' correctly excluded from NODE_ACTIVITY_ACTIONS (no per-chunk projects map), and projectAssistantStreamEvent already avoids O(L²) content recompute (assistantBlocks.ts:130-136 comment), but the outer O(messages)+O(nodes) per-chunk shallow-copy churn has no fast path. The 'low' impact claim is honest: the work is shallow copies/identity checks (~tens of µs per chunk at 1000 msgs + 2000 nodes), reaching low tens of ms/s of main-thread time only under extreme fanout — real allocation/GC churn but not user-visible in typical sessions, since the June-2026 optimizations already removed the expensive render-side costs.

**补充证据 / fix 安全检查**:

Fix sanity-check: (a) The tail fast-path is safe and correct — the streaming assistant message is appended last at turn start (chatReducers.ts:383 `messages: [...n.messages, ...newMessages]`), and realign-assistant-id retargets before chunks arrive, so `msgs[msgs.length-1].id === assistantId` will hit in practice with a full-map fallback for safety. It stays inside reduceNodes, preserving the nodesRef single-writer invariant (chatStore.tsx:826-827). It does not touch composer wire format or per-tree pane maps. However it only removes the O(messages) map; the O(nodes) Record spread remains. (b) The per-RAF reducer-coalescing part of the fix is riskier: buffered chunk text must be flushed before the 'done'/'error' dispatch because 'done' (chatReducers.ts:508-524) extracts title/follow-ups metadata from the assistant's accumulated blocks via assistantMetadata — deferring chunks past 'done' would lose metadata and violate the stream-terminal-safety invariant (node must leave 'streaming' with complete state). 'apply-seq' is dispatched separately by trackSeq (chatStreamRunner.ts:130-135) so resume-cursor tracking survives chunk buffering, but ordering with interleaved tool-call/thought events (which switch the active block section in assistantBlocks) must be preserved — a per-frame buffer keyed only by assistantId that reorders text relative to tool-call dispatches would corrupt block-run structure. A safe version buffers the full ordered action queue per frame, not just text. Also note observeChatStream.ts:77 is a second chunk dispatch site that any fix must cover.

---

## #6 [state-render] startStream rebuilds and ships the full transcript (priorMessages) on every single send

- **位置**: `frontend/src/state/chatStore.tsx:1092`
- **影响**: low | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every message send on every node; cost linear in transcript size, so long-lived sessions pay the most exactly when send latency matters.

**机制**:

Before every send, startStream maps every user/assistant message through visibleMessageText — which for assistant messages joins all answer blocks and runs the sentinel-stripping scan (assistantBlocks.ts:81-107) — building a full plain-text copy of the transcript, then passes it as `priorMessages` in the ensureSession POST (chatStore.tsx:1187). CPU is O(total transcript chars) and the JSON body grows with session length (a 1000-message, 1MB transcript = ~1MB serialized per send), even for the overwhelmingly common case where the session is already live and the backend ignores the resume payload.

**修复建议**:

Gate the transcript build on actually needing a resume: skip when `boundSessionsRef.current.has(n.chatId)` (session already bound this backend process), or make ensureSession two-phase — send the resumeFingerprint first and only upload priorMessages when the backend replies that it cannot resume exactly. Also cache visibleMessageText per message id (messages are immutable once done).

**验证者笔记**:

Mechanism verified in the current tree. chatStore.tsx:1092-1097 unconditionally builds the full transcript on every startStream call: `const priorMessagesForResume = n.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, text: visibleMessageText(m) }))`. For assistant messages visibleMessageText (assistantBlocks.ts:105-107) → assistantAnswerVisibleText (line 88-90) → assistantAnswerRawText joins every answer block (line 81-86) and stripSentinelsStreamingSafe (assistantParsing.ts:371+) does a full character-scan with cut-region bookkeeping. It is then always shipped: chatStore.tsx:1187 `priorMessages: priorMessagesForResume`, and api.ts:289 `if (opts.priorMessages) body.priorMessages = opts.priorMessages` — an array (even empty) is always truthy, so the entire plain-text transcript is JSON.stringified and POSTed to /nodes/:id/ensure-session on every send. No mitigation exists: boundSessionsRef (chatStore.tsx:596, populated at 1213) is never consulted before building the transcript, and there is no per-message memoization of visibleMessageText. CPU is O(total transcript chars) on the main thread per send, and the request body grows linearly with session length (server accepts up to 50mb, server.ts:361). One framing correction that does not change the verdict: the backend does NOT ignore the payload on live sessions — michi.ts:803-804 fingerprints it (computeTranscriptFingerprint, another full scan) and that fingerprint comparison is precisely what lets chooseResumeStrategy return 'live' (resumeStrategy.ts:113-117). So the cost is real (paid on both client and server per send) but the payload is currently load-bearing for the resume contract. Impact claim 'low' is honest: trigger is per user send (not per-chunk/per-keystroke), so this is a few ms of jank plus O(transcript) upload per send — worst for exactly the long-lived sessions where send latency matters, but bounded by user action frequency.

**补充证据 / fix 安全检查**:

Fix sanity check: (1) Caching visibleMessageText per immutable message object (WeakMap) is safe — pure derivation, touches none of the documented invariants (nodesRef single-writer, composer wire-stability, per-tree pane maps, stream terminal safety). (2) The 'skip when boundSessionsRef.has(chatId)' gate is riskier than claimed: omitting priorMessages makes readTranscriptMessages fall back to the server DB (michi.ts:94-99, listMessages(nodeId)), which by construction always matches the stored resume_fingerprint (dbRepository.ts:1126-1135 refreshResumeFingerprint computes it from the same DB rows) — so the transcript_changed → compatible-resume divergence check (resumeStrategy.ts:113-114) would degenerate to always-pass, masking genuine frontend/DB transcript divergence (e.g. locally-aborted partial text kept in the UI). The two-phase variant (send resumeFingerprint first — already sent at chatStore.tsx:1196 — and upload priorMessages only when the backend cannot resume exactly) is the semantically safe version; frontend would need to compute the fingerprint client-side with the same fnv1a32 scheme (resumeStrategy.ts:125-131) or accept one extra roundtrip on mismatch. Note the compat-resume context itself is already truncated to 28k chars server-side (resumeStrategy.ts:34-36, 143), so only the fingerprint check consumes the full uploaded transcript in the common case — reinforcing that the full-body upload is mostly fingerprint fuel.

---

## #7 [streaming-pipeline] applyTurnEvent recomputes full-answer stripped `content` on every chunk — result discarded by frontend (O(L²) per turn)

- **位置**: `shared/src/turnProjection.ts:391`
- **影响**: medium | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every SSE chunk event of every streaming turn, on the main thread, before the reducer returns; multiplied by concurrently streaming panes.

**机制**:

Every 'chunk' reducer action calls projectAssistantStreamEvent → applyTurnEvent. Its chunk case runs `content: answerContent(blocks)` (turnProjection.ts:387-393), where answerContent (ts:365-369) joins ALL answer blocks' rawText into one string AND runs stripTurnMetadataSentinels — a char-by-char scan — over the entire accumulated answer. The frontend adapter then throws the result away: assistantBlocks.ts:148-154 returns only {blocks, toolCalls, plan, streaming}, never reading `.content`. The comment at assistantBlocks.ts:130-135 explicitly warns that computing content per chunk 'would run ... full-string scan on every chunk (O(L²)) just to throw it away' — yet the shared chunk case does exactly that. For a 30KB reply arriving in ~1000 chunks this is ~15M chars of join+scan and ~15MB of transient string allocation on the main thread, per streaming pane. The backend pays the identical cost in chatHub.append (backend/src/agents/chatHub.ts:305) per event, where mid-turn content is also unused (checkpoints are interval-gated and could derive content at checkpoint time).

**修复建议**:

Make the chunk case in applyTurnEvent stop eagerly recomputing content: either keep `content` stale during streaming and derive it lazily at done/error (both terminal cases already recompute via finalizeTurnContent at turnProjection.ts:462/475), or add an opts flag `{ deferContent: true }` used by both the frontend adapter and chatHub, with chatHub deriving content in maybeCheckpoint only when a checkpoint actually fires.

**验证者笔记**:

The mechanism is fully confirmed in the current tree. shared/src/turnProjection.ts:387-393 chunk case does `content: answerContent(blocks)`; answerContent (ts:365-369) joins ALL answer blocks' rawText and runs stripTurnMetadataSentinels (ts:180-222), a char-by-char scan over the entire accumulated answer — O(accumulated length) per chunk, O(L²) per turn. The frontend adapter provably discards it: assistantBlocks.ts:148-154 returns only {blocks, toolCalls, plan, streaming}; the comment at 130-135 explicitly warns against exactly this cost, and nothing frontend-side reads assistant `.content` mid-stream (visibleMessageText derives from blocks). No batching exists between SSE and reducer: chatStreamRunner.ts:156 dispatches one 'chunk' action per SSE event, and chatReducers.ts:420-428 calls projectAssistantStreamEvent per action. Backend pays the same in chatHub.append (chatHub.ts:305) per event, while content is only consumed at interval-gated checkpoints (maybeCheckpoint, ts:311-327 gated by checkpointIntervalMs) and terminal finalize recomputes via finalizeTurnContent anyway (turnProjection.ts:462/475). No memo, cache, or June-2026 optimization mitigates this — those optimizations moved the renderer to O(tail) per chunk but left this O(L) scan in the reducer.

Why OVERSTATED rather than CONFIRMED-high: the arithmetic is right (~15M chars for a 30KB/1000-chunk turn) but the wall-clock translation is modest. stripTurnMetadataSentinels' hot loop for non-'[' chars is a compare+increment (hundreds of M chars/sec), so a 30KB turn costs roughly 50-100ms cumulative main-thread time spread over the multi-second stream — sub-millisecond per chunk even at the tail, well under frame budget even ×3 concurrent panes. It becomes user-noticeable only for very long turns (100KB+) where it grows to ~0.5-1s cumulative plus real GC pressure (~2 full-length string allocations per chunk). Real, worth fixing, hottest-path waste that undercuts the shipped O(tail) rendering work — but a fair rating is medium, not high.

**补充证据 / fix 安全检查**:

Fix sanity check: the proposed fix is sound. Both terminal cases already recompute content from rawAnswerContent via finalizeTurnContent (turnProjection.ts:455/462 and 468/475), so the streaming-time `content` is never load-bearing at the done/error boundary — stream-terminal-safety is untouched. The only mid-turn consumer is backend checkpointing (chatHub.ts:316 persistence.checkpoint(log.snapshot)), which the fix covers by deriving content when a checkpoint actually fires (interval-gated at ts:313, so ~1 derivation per checkpointIntervalMs instead of per event); skipping this would persist stale/empty content into crash-recovery snapshots, so the maybeCheckpoint derivation is required, not optional. No interaction with nodesRef single-writer (pure reducer computation inside reduceNodes), composer wire-stability (mentionDoc untouched), or per-tree pane maps. One test to update: frontend/src/state/turnProjectionParity.test.ts:44 replays applyTurnEvent snapshots and may assert on mid-stream content if a deferContent flag changes chunk-case output. Also note frontend adapter passes content:'' as placeholder input (assistantBlocks.ts:136) — already consistent with a defer flag.

---

## #8 [streaming-pipeline] Two reducer dispatches per SSE chunk (apply-seq + chunk), each cloning the whole nodes map

- **位置**: `frontend/src/state/chatStreamRunner.ts:153`
- **影响**: low | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every chunk/thought/tool event on the owner streaming path; frequency = SSE event rate × streaming panes.

**机制**:

The backend stamps a seq on every event (backend/src/agents/chatHub.ts:287-296), so runChatStream.onChunk always calls trackSeq → dispatch({type:'apply-seq'}) (chatStreamRunner.ts:130-135, 153-156) and then dispatch({type:'chunk'}). Each dispatch runs reduceNodes synchronously and returns `{ ...nodes, [nodeId]: {...} }` — a full shallow copy of the nodes record (chatReducers.ts:393-400 and :428) plus the HIGH_FREQ set checks in chatStore dispatch (chatStore.tsx:826-846). With 50+ threads / several hundred nodes hydrated, that is 2 × O(#nodes) object spreads plus 2 reducer invocations per network chunk. The same doubling applies to thought/tool_call/tool_call_update events.

**修复建议**:

Fold seq/turnId into the 'chunk'/'thought'/'tool-call' actions (add optional turnId/seq fields) and update lastAppliedTurnId/lastAppliedSeq inside the same reducer case, eliminating the separate apply-seq dispatch on the hot path (keep apply-seq for the observer path or fold there too).

**验证者笔记**:

The mechanism is 100% real in the current tree: backend stamps seq on every event (chatHub.ts:287-296), chatStreamEvents.ts:71 forwards it, and chatStreamRunner.ts onChunk/onThought/onToolCall/onToolCallUpdate each call trackSeq → dispatch('apply-seq') (:130-135) before the payload dispatch, so the owner streaming path really does two synchronous reduceNodes invocations per SSE event, and the apply-seq case (chatReducers.ts:387-401) never short-circuits on the owner path because seq is strictly increasing — it always allocates a fresh nodes-record spread plus a node spread. However, the "medium" impact is overstated. Both 'chunk' and 'apply-seq' are in HIGH_FREQ_ACTIONS (chatStore.tsx:157-159), so React renders are RAF-coalesced — the extra dispatch adds zero renders and zero setProjects/persistence work (neither action is in NODE_ACTIVITY_ACTIONS, chatReducers.ts:13-24). The expensive per-chunk work (n.messages.map + projectAssistantStreamEvent projection, O(#messages)) runs only once, in the 'chunk' case; the marginal apply-seq dispatch is just a switch, one node object spread, one shallow spread of the nodes record, and two Set lookups. Even at 500 hydrated nodes and 50 events/sec that is on the order of tens of microseconds of extra main-thread work per second plus modest GC allocation churn — nowhere near a 2× doubling of the chunk path cost. Real inefficiency, worth folding, but low impact.

**补充证据 / fix 安全检查**:

Confirmed code refs: backend/src/agents/chatHub.ts:287-296 `stamp()` adds `{turnId, seq, assistantId}` to every event's data; frontend/src/services/chatStreamEvents.ts:71 passes seq to onChunk; frontend/src/state/chatStreamRunner.ts:130-135 `trackSeq` → `dispatch({type:'apply-seq',...})`, :153-156 onChunk = trackSeq + dispatch('chunk'), same pattern at :177-179 (thought), :182-185/:199-202 (tool-call/update), :233-235 (branch-overview); frontend/src/state/chatReducers.ts:387-401 apply-seq spreads nodes+node (guard `seq <= prev` never fires on owner path since seq is monotonic), :420-428 chunk spreads nodes+node AND maps all node messages; frontend/src/state/chatStore.tsx:826-846 dispatch runs reduceNodes synchronously, but :157-159 HIGH_FREQ_ACTIONS contains both types → RAF-coalesced setNodes (no extra render) and neither is in NODE_ACTIVITY_ACTIONS (chatReducers.ts:13-24) so no per-chunk setProjects. Fix sanity-check: folding seq/turnId into the chunk/thought/tool-call actions is viable and safe for the documented invariants — nodesRef stays single-writer (writes still only in dispatch), composer wire-stability and per-tree pane maps are untouched, and stream terminal safety is unaffected (done/error paths don't use trackSeq). One correctness subtlety: the owner's startObserver (chatStore.tsx:890-900) dedupes the observer stream by live-reading lastAppliedSeq/lastAppliedTurnId from nodesRef via getter-refs, and observeChatStream.ts:55 dispatches its own apply-seq — the folded reducer cases must replicate apply-seq's monotonic turn/seq bookkeeping in the same pass so the observer's getter-refs still see up-to-date values; keep the standalone 'apply-seq' action for the observer path (or fold there identically). Tests to update: chatReducers.structural.test.ts:73, chatReducers.observer.test.ts:86-93.

---

## #9 [streaming-pipeline] Per-chunk reducer maps the node's entire messages array — O(history length) per SSE event

- **位置**: `frontend/src/state/chatReducers.ts:423`
- **影响**: low | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every chunk/thought/tool SSE event on nodes with long message histories; cost grows linearly with per-node message count.

**机制**:

The 'chunk' (and thought/plan/tool-call/tool-call-update/image-block) reducer cases run `n.messages.map(m => m.id === action.assistantId ? project(...) : m)` — allocating a fresh array of the full message history and doing an id comparison per element, on every SSE event. The streaming assistant message is virtually always the LAST element. For a long-lived node with 500–1000+ messages (lazy tree loading installs full bodies for the active tree), each chunk allocates a 1000-slot array and runs 1000 comparisons before touching the one message that changed; ×2 with the apply-seq spread, × event rate, × concurrent panes.

**修复建议**:

Replace the map with a tail-first update: check `n.messages[n.messages.length - 1].id === action.assistantId` and do `msgs = n.messages.slice(); msgs[last] = projected` (falling back to the map only when the streaming message is not last). Same one-liner applies to all six high-frequency cases.

**验证者笔记**:

The mechanism is real and unmitigated: chatReducers.ts:423-427 ('chunk') and the sibling cases at :433/:443/:453/:473/:491 all run n.messages.map() with a per-element id comparison, and the reducer runs synchronously on EVERY dispatch (chatStore.tsx:826 `reduceNodes(nodesRef.current, a)`) — the RAF coalescing at chatStore.tsx:836-843 only batches React renders (setNodes), not reducer executions, and the SSE loop in api.ts:547-605 dispatches one action per parsed frame with no coalescing. The streaming assistant message is indeed appended last (chatReducers.ts:304-317), so the map's N-1 identity iterations are pure waste, and messages-loaded (chatReducers.ts:604-611) does install full histories. However, the impact estimate is inflated. First, a factual overreach: the 'apply-seq' companion dispatch (chatReducers.ts:387-401) does NOT map the messages array — it only spreads the nodes record — so the '×2' multiplier applies to the O(#nodes) spread, not the O(#messages) map. Second, and decisive for impact: the skipped-element work is a single string compare plus identity return (~2-10µs and one array allocation per event even at 1000 messages), while the per-event cost that actually dominates is the matching-message path — projectAssistantStreamEvent (assistantBlocks.ts:113-155) constructs a DurableTurnSnapshot, runs applyTurnEvent, and shallow-clones the blocks array — plus the O(#nodes) `{...nodes}` record spread each dispatch pays anyway. Fixing the map leaves those terms untouched, so the realistic savings even at 20 streaming panes × 100 events/s × 1000-message nodes is low-single-digit milliseconds per second of main-thread time plus modest GC pressure. Real, hot-path, trivially fixable — but 'low', not 'medium'. Additionally, Michi's branching model (conversations fork into child nodes rather than growing one node) makes 1000-message single nodes an edge case rather than the norm.

**补充证据 / fix 安全检查**:

Fix sanity-check: the proposed tail-first update (check n.messages[len-1].id === action.assistantId, slice + index-assign, fall back to map otherwise) is safe. It is a pure change inside reduceNodes producing an identical output array; the nodesRef single-writer invariant is untouched because dispatch (chatStore.tsx:819-846) still performs the single `nodesRef.current = next` assignment and the reducer stays pure. It has no contact with composer wire-stability (mentionDoc), per-tree pane maps, or stream terminal safety (the 'done'/'error' cases can keep the map or receive the same transform — 'done' also extracts metadata from the matching message via assistantMetadata at :514-524, which works identically under tail-first). The map fallback covers the rare non-tail cases ('realign-assistant-id' retargeting at :585-602, observer turns at :321-336). Key code refs: chatReducers.ts:423 `const msgs = n.messages.map((m) => m.id === action.assistantId ? projectAssistantStreamEvent(...) : m)`; chatStore.tsx:826-827 `const next = reduceNodes(nodesRef.current, a); nodesRef.current = next;` (per-dispatch, unbatched); chatStore.tsx:156-159 HIGH_FREQ_ACTIONS includes chunk/thought/plan/tool-call/tool-call-update/apply-seq (render-batched only); chatStreamRunner.ts:153-156 per-chunk double dispatch (apply-seq via trackSeq + chunk); apply-seq case chatReducers.ts:387-401 contains no messages.map (claim's ×2 map multiplier is wrong; it is an O(#nodes) spread). Dominant per-event cost is assistantBlocks.ts:113-155 (snapshot build + applyTurnEvent + cloneBlocks at :31-33), which the proposed fix does not reduce.

---

## #10 [streaming-pipeline] Stream watchdog re-arms a timer (clearTimeout + setTimeout) on every network read

- **位置**: `frontend/src/services/api.ts:550`
- **影响**: low | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every network read of every active /message stream; proportional to chunk rate × streaming panes.

**机制**:

streamMessage's silence watchdog calls armWatchdog() after every reader.read() resolution (api.ts:550), and armWatchdog does clearTimeout + setTimeout with a 30s deadline (api.ts:511-518). During a fast model stream this is timer create/destroy churn at the network-read rate (can be hundreds/sec when chunks are small), all for a timeout that only needs ~1s resolution.

**修复建议**:

Record `lastByteAt = Date.now()` per read and use a single repeating 5s interval that aborts when `Date.now() - lastByteAt > STREAM_SILENCE_TIMEOUT_MS` — one timer per stream instead of one per read.

**验证者笔记**:

The claimed mechanism is present verbatim in the current tree: api.ts:511-518 defines armWatchdog as clearTimeout + setTimeout(30s), api.ts:546 arms it before the read loop, and api.ts:550 re-arms it on every reader.read() resolution with no throttle, timestamp check, or batching anywhere nearby. None of the shipped June-2026 optimizations touch this path (they are all downstream of the reducer). The impact estimate of "low" is honest and should not be inflated: the re-arm happens per network read (not per SSE frame — one read can carry several frames), realistically tens to low-hundreds of times/sec across all streaming panes, and each clearTimeout+setTimeout pair costs microseconds — negligible next to the decoder.decode/string-slice/JSON.parse/dispatch work on the same loop iteration. It is a real, confirmed micro-inefficiency at the very bottom of "low": timer alloc/free churn, never user-perceptible on its own. Since the mechanism is exactly as described and the claimed impact (low) matches reality, verdict is CONFIRMED rather than OVERSTATED.

**补充证据 / fix 安全检查**:

Code confirmation: frontend/src/services/api.ts:487 `const STREAM_SILENCE_TIMEOUT_MS = 30_000;`; :511-518 `const armWatchdog = () => { clearWatchdog(); watchdog = setTimeout(() => { watchdogTimedOut = true; controller.abort(); settleError('stream stalled — no data received'); }, STREAM_SILENCE_TIMEOUT_MS); };`; :546 `armWatchdog();` before the loop; :550 `armWatchdog(); // bytes arrived (incl. heartbeats) — reset the silence timer` inside `while (true) { const { value, done } = await reader.read(); ... }`. Note the sibling `subscribeChat` (api.ts:639-668+) has NO watchdog at all, so only `streamMessage` streams pay this.

Fix sanity check: the lastByteAt + 5s interval approach is sound and would reduce to one timer per stream. To stay safe it must (a) clear the interval in every path that currently calls clearWatchdog — settleError (:502), settleAborted (:508), terminal-frame seen (:601-603), finally (:620), and the returned cancel fn (:625); (b) preserve the watchdogTimedOut flag + controller.abort() on timeout (:513-516) so the AbortError branch (:611-615) still distinguishes "stall" (settleError) from user/navigation abort (settleAborted) — this is the documented stream-terminal-safety invariant and survives the fix intact. Precision degrades from exact 30s to 30-35s, acceptable for a safety net. The fix does not touch chatStore/nodesRef (single-writer unaffected), the composer/mentionDoc wire format, or per-tree pane maps — all outside api.ts. Background-tab timer throttling affects setTimeout and setInterval equally, so no behavioral regression there.

---

## #11 [markdown-dom] Streaming reveal plugin wraps the entire tail block one <span> per character, rebuilt every reveal frame

- **位置**: `frontend/src/components/MarkdownContent.tsx:157`
- **影响**: high | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every reveal frame (rAF, up to 60/s) of every streaming answer, for the duration of the tail block. Worst with long paragraphs/lists that don't hit a block boundary for a while, and multiplies across concurrently streaming panes.

**机制**:

When revealTailChars > 0 (the live tail block during streaming), createStreamingRevealPlugin's transformChildren loops `for (const char of Array.from(value))` over EVERY text node in the block and emits one hast <span class="stream-token-reveal"> element per non-whitespace character — including all already-visible chars (they just get `--stream-token-reveal-duration:0ms`, MarkdownContent.tsx:169-178). Each such span carries a CSS animation (index.css:887-888). On top of that, every transform runs renderedText(tree) (full hast walk, :142) and every commit runs domRevealText(rootRef.current) (full DOM walk, :364-366). So a 4KB tail paragraph becomes ~4,000 span elements that React must create/reconcile, at up to 60Hz because useSmooth's flushDisplayed changes smoothText every rAF tick, which changes the tail block's text and busts MarkdownBlock's memo.

**修复建议**:

Only per-char-wrap the actual new suffix: split each text node at the previousLength cursor and emit the stable prefix as a single text node (or one span), wrapping only characters with start >= previousLength. Additionally cap the number of animated spans per frame (e.g. 256) and fall back to a single fading span for larger deltas. This keeps the fade effect while making per-frame DOM churn O(delta) instead of O(tail-block length).

**验证者笔记**:

Every element of the claimed mechanism is present in the current tree and unmitigated.

1. Per-char span wrapping of the ENTIRE tail block, not just the reveal window: frontend/src/components/MarkdownContent.tsx:146-195. `transformChildren` runs `for (const char of Array.from(value))` over every text node and pushes `{ tagName: 'span', properties: { className: ['stream-token-reveal'], ...(alreadyVisible ? { style: '--stream-token-reveal-duration:0ms' } : { 'data-stream-token-new': true }) } }` per non-whitespace char (:169-177). `alreadyVisible` chars (everything before `previousLength`) still get a span — the plugin never uses the `revealTailChars` value (STREAM_REVEAL_TAIL_CHARS = 1, streamingProjection.ts:39) to bound the wrap; `revealEnabled = revealTailChars > 0` is only an on/off gate (MarkdownContent.tsx:294). Only whitespace and code/pre/katex subtrees are skipped (:68, :161, :184-188), so a long paragraph or a long bullet list (one marked lexer token = one block, streamingMarkdownBlocks.ts:95-137) yields O(block-length) spans per render.

2. Extra full walks per render/commit: `renderedText(tree)` runs on every transform (MarkdownContent.tsx:142) and `domRevealText(rootRef.current)` runs on every commit while revealEnabled (:364-366) — both O(tail-block).

3. Frequency is genuinely per reveal frame: useSmooth's `tick` calls `flushDisplayed()` → `setDisplayed` once per rAF while backlog exists (useSmooth.ts:516-618), so `smoothText` changes up to 60Hz. That changes the last text segment (streamingProjection.ts:317-327), `splitStreamingMarkdownBlocks(text)` re-runs, the tail block's `block.text` changes, which busts MarkdownBlock's memo (StreamingMarkdownContent.tsx:38-51 compares `block.text`) and MarkdownContent's memo (:409-421 compares `text`). So the whole remark/rehype pipeline plus the per-char span plugin re-runs on the tail block every frame. Only the tail block pays (revealTailCharsForBlock gates non-tail blocks, streamingMarkdownBlocks.ts:148-157) — exactly as the claim states.

4. Not mitigated: the June-2026 block split confines the cost to the tail block but nothing caps span count; `prefers-reduced-motion` (index.css:906-910) disables the CSS animation but the spans are still created and reconciled; each span carries `animation: t-stream-token-reveal ...` (index.css:887-889). No feature flag disables per-char reveal — `streamingMarkdownBlocksEnabled` only chooses block-split vs monolithic rendering; the monolithic fallback path (MessageBlock.tsx:402-408, 421-429) is WORSE (per-char spans over the entire segment).

Impact "high" is fair: this is the dominant remaining per-frame cost on the streaming hot path that the shipped optimizations deliberately isolated everything else around. Typical prose paragraphs → hundreds of spans/frame (medium-ish), but long lists/paragraphs are a single block and grow unbounded — thousands of VDOM elements created and diffed at up to 60Hz, multiplied across concurrently streaming panes. The claim itself correctly scopes the worst case to long blocks.

**补充证据 / fix 安全检查**:

Fix sanity check: the direction (O(delta) instead of O(tail-block)) is right and touches only the rendering layer — no risk to nodesRef single-writer, composer wire-stability, per-tree pane maps, or stream terminal safety (those live in chatStore/mentionDoc/SSE plumbing, untouched). BUT the fix as literally specified is visually wrong: `previousLength` is the common prefix with the PREVIOUS COMMIT's DOM text (MarkdownContent.tsx:143, :364-366), i.e. chars revealed one frame (~16ms) ago. Emitting those as plain text nodes would tear down their <span> mid-fade (the animation is 300ms, index.css:888) — each character would snap from ~0.3 opacity to 1 after a single frame, destroying the fade effect. A correct fix must keep per-char spans for a trailing time window (chars revealed within the last ~300ms / animation duration, or a fixed last-N-chars window like 64-256 chars) and collapse everything older into plain text nodes; the older 0ms-duration spans exist purely to keep DOM structure index-stable so React doesn't recreate (and restart) still-animating spans, so the collapse boundary must itself be stable across frames (e.g. quantized to word/whitespace boundaries) to avoid churn at the seam. The proposed per-frame span cap (fall back to one fading span for big deltas) is sound. Also worth pairing: skip span creation entirely under prefers-reduced-motion (currently only the CSS animation is disabled, spans are still built), and note the non-block fallback path in MessageBlock.tsx:402-408 applies revealTailChars to the whole segment text — any fix should land in the shared plugin in MarkdownContent.tsx so both paths benefit.

---

## #12 [markdown-dom] splitStreamingMarkdownBlocks re-lexes the full answer text with marked on every reveal frame (O(N) per rAF tick, O(N²) per turn)

- **位置**: `frontend/src/lib/streamingMarkdownBlocks.ts:95`
- **影响**: high | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every reveal frame of every streaming answer whose text segment renders through StreamingMarkdownContent (the default path, streamingMarkdownBlocksFlag). Cost grows linearly with total answer length as the turn progresses.

**机制**:

StreamingMarkdownContent recomputes blocks via `useMemo(() => splitStreamingMarkdownBlocks(text), [text])` (StreamingMarkdownContent.tsx:58), and text changes on every useSmooth grapheme flush (per rAF frame while smoothing, useSmooth.ts:511-514/618). splitStreamingMarkdownBlocks runs `Lexer.lex(markdown, { gfm: true })` over the ENTIRE accumulated answer plus the html-stack/double-dollar merge pass — so a 50KB answer is fully GFM-lexed ~60 times/second even though everything before the last block boundary is guaranteed stable (text grows monotonically). Only the react-markdown render of stable blocks is memoized; the split itself is not incremental. Cumulative cost over a stream is quadratic in answer length.

**修复建议**:

Make the split incremental: cache { prevText, prevBlocks } (module-level or ref). When text.startsWith(prevText), keep all blocks except the last one or two (last block can still merge via htmlStack/double-dollar rules), and re-lex only text.slice(secondToLastBlock.start). Fall back to full lex when the prefix check fails. This turns the per-frame cost from O(answer) to O(tail block).

**验证者笔记**:

Every element of the claimed mechanism checks out in the current tree, and no mitigation covers the split itself.

1. Mechanism present: frontend/src/lib/streamingMarkdownBlocks.ts:95 — `const tokens = Lexer.lex(markdown, { gfm: true });` inside `splitStreamingMarkdownBlocks(markdown)`, which always lexes the FULL input string, plus the O(N) footnote regexes (lines 91-93), the html open/close tag counting, and `countDoubleDollars` merge pass over each token. There is no cache, no prefix-reuse, no throttle anywhere in this file.

2. Call path per frame: StreamingMarkdownContent.tsx:58 — `const blocks = useMemo(() => splitStreamingMarkdownBlocks(text), [text]);`. `text` is `seg.text` of the LAST text segment (MessageBlock.tsx:397-417; only the last text segment goes through StreamingMarkdownContent, earlier segments use plain MarkdownContent). For a pure-text answer (no mid-answer tool calls) the last segment is the entire smoothed answer (weaveRunToolBlocks / weaveToolCalls in streamingProjection.ts:228/289 — the trailing slice from cursor 0 when `resolved` is empty). `smoothText` changes on every useSmooth flush: `tick()` → `flushDisplayed()` → `setDisplayed` per rAF tick whenever ≥1 grapheme is revealed (useSmooth.ts, `tick`/`flushDisplayed`), i.e. up to display refresh rate while smoothing. So a full GFM lex of the whole accumulated answer runs on essentially every reveal frame — cumulative O(N²) over the turn, exactly as claimed.

3. Not mitigated by the June-2026 work: the shipped optimization memoizes the *render* of stable blocks (`MarkdownBlock` React.memo, StreamingMarkdownContent.tsx:38-51, keyed on block.text/start/end) and caches the sentinel projection (runProjectionCache WeakMap, streamingProjection.ts:127-146), but the *split* is keyed on the full `text` and recomputes from scratch each frame. `streamingMarkdownBlocksEnabled()` defaults to true (streamingMarkdownBlocksFlag.ts:18), so this is the default path. Cost only accrues while the message is smoothing (completed messages have stable `text`, so the useMemo never re-fires), and hibernated far-offscreen panes don't pay it — the trigger scoping in the claim is honest.

4. Impact honesty: marked's lexer is fast (~1-3ms for 50KB), so for typical 2-10KB answers this is sub-millisecond per frame — modest. But it grows linearly per frame with answer length, runs synchronously inside the rAF-driven render that the smoothing controller depends on, and multiplies across concurrently-streaming panes (spawn_branches fanout). For the long-answer / multi-pane scaling cases this audit targets, "high" is defensible; it is precisely the remaining O(N)-per-frame gap in the shipped block-split optimization.

**补充证据 / fix 安全检查**:

Fix sanity check: the proposed incremental cache ({prevText, prevBlocks} + re-lex from the second-to-last block when text.startsWith(prevText)) would work but needs more guards than stated: (a) the footnote fast-path (streamingMarkdownBlocks.ts:91-93) collapses the WHOLE doc into one block the moment a footnote ref appears — the incremental path must still run those two regexes on the full text and invalidate; (b) `htmlStack` state can span MANY blocks (lines 105-115 keep appending every subsequent token into the last block while the stack is non-empty), so the cache is only valid if the stack was empty at the cached boundary — the cached state must include htmlStack/previousTokenWasCode, or the cache must only be taken when the stable prefix ends with an empty stack and an even double-dollar count; (c) marked block boundaries are mostly prefix-stable but constructs like setext headings ("para\n===") and table delimiter rows retroactively merge into the immediately preceding token, so dropping the last 1-2 blocks (as proposed) is the right minimum. A simpler alternative with most of the win: throttle the split input (re-split at ~100-150ms cadence, render the throttled prefix blocks + raw tail via plain MarkdownContent), matching the already-shipped "throttled live tail" philosophy. Invariant check: the fix is confined to a pure lib function + one useMemo; it touches none of the documented invariants (nodesRef single-writer in chatStore, composer wire-stability in mentionDoc, per-tree pane maps, stream terminal safety) — all of those live in state/backend layers this file never imports.

---

## #13 [markdown-dom] No render windowing: pane mount runs the full react-markdown pipeline for every message; content-visibility only skips layout/paint

- **位置**: `frontend/src/components/terminal/PaneMessageList.tsx:87`
- **影响**: high | **工作量**: L | **验证**: CONFIRMED
- **触发**: Pane open / tree switch / boot hydration of large threads (1000+ messages). Also multiplies with 20+ open panes since each pane mounts its full list.

**机制**:

PaneMessageList renders `node.messages.map(...)` with no virtualization, so opening a pane (or restoring a session) mounts a MessageBlock per message. Each assistant message then runs the entire markdown pipeline in JS during React render — remark-parse + remark-gfm + remark-math + mdast→hast + rehype-raw + rehype-sanitize + autolink (MarkdownContent.tsx:302-312 via MarkdownRendererAdapter.tsx:19-25) — plus projectAnswerRun sentinel stripping and weaveRunToolBlocks. The `.terminal-message-frame { content-visibility: auto }` rule (index.css:234-236) skips layout/paint for offscreen frames but cannot skip React component rendering or unified parsing, which happens before the DOM exists. At ~1-3ms markdown parse per message, a 1000-message thread costs 1-3s of blocking main-thread work on pane open, repeated on every remount (pane close/reopen, hibernation wake, tree switch).

**修复建议**:

Window the list: render only the last ~50 messages eagerly and mount older ones on scroll (an IntersectionObserver-driven 'render older' sentinel keeps the existing anchor-based scroll restore working, since anchors are data-msg-id based). Alternatively render older messages' bodies as cheap pre-rendered plain text until they enter the viewport. Pairs with the existing lazy tree message loading which already bounds data, but not render cost.

**验证者笔记**:

Mechanism verified at every cited location in the current tree. PaneMessageList.tsx:87 unconditionally maps node.messages to MessageBlock with no windowing (no react-window/virtuoso/IO-based windowing anywhere in frontend/src). Each assistant message mount runs the full unified pipeline in JS render: MarkdownContent.tsx:302-312 builds [remarkMath, remarkCurrencyGuard] + [rehypeRaw, rehypeSanitize, rehypeAutolinkBareUrls] and MarkdownRendererAdapter.tsx:19-25 adds remarkGfm into ReactMarkdown — parse happens before any DOM exists, so index.css:234-236's content-visibility:auto (layout/paint skip only) cannot mitigate it. React.memo on MessageBlock/MarkdownContent guards re-renders, not the mount. useLazyTreeMessages bounds fetch, not render. Critically, the 'Dashboard pane hibernation' item from the already-shipped list is NOT present in this working tree (no hibernation/offscreen-unmount code found; Dashboard.tsx:384-417 mounts every openPanes entry as a full TPane), so there is no offscreen mitigation and remount cost recurs on pane close/reopen and tree switch (openPanes are per-tree, so switching trees remounts the whole restored layout). One nuance keeps this from being understated rather than overstated: a pane renders one node's messages, not the whole thread, so '1000 messages in one pane' is a tail case — but tree-switch restoring a 20-pane layout mounts the aggregate anyway, so the 1-3s blocking estimate is fair for the stated 1000-message/20-pane scaling scenario the audit targets. TPane.tsx:44-65 itself documents the secondary cost (72px estimate → real-height inflation churn fought by the scroll-restore loop).

**补充证据 / fix 安全检查**:

Corrections/nuances: (1) The 'hibernation wake' remount trigger named in the claim does not exist — grep for hibernat/dormant/park/offscreen-unmount across frontend/src returns nothing; the shipped-optimizations list is stale on that item for this tree, which actually strengthens the finding (no offscreen-pane mitigation at all). (2) node.messages is per-node, not per-thread; single-pane 1000-message mount is the tail case, but tree switch remounting a restored 20-pane layout reaches the same aggregate. Fix sanity: windowing the list (eager last ~50 + IntersectionObserver 'render older' sentinel) is render-layer only and does not touch nodesRef single-writer (chatStore dispatch path untouched), composer wire-stability (mentionDoc/draft untouched), per-tree pane maps (openPanes/focusedPane untouched), or stream terminal safety (done/error reducer flow untouched). Two real constraints: TPane's mount-time scroll restore is data-msg-id anchor-based with a localStorage cache (TPane.tsx:44-70, SCROLL_CACHE_LS_KEY 'michi:paneScrollAnchors') — the initial window must include the saved anchorId or restore breaks, so seed the window from the anchor, not just the tail; and PaneFind computes matches from state (PaneFind.tsx:76-93) so counts stay correct, but jump-to-match scrolls to message DOM nodes that must be mounted — match navigation needs to force-expand the window. The streaming tail path is unaffected: isStreamingTail frames opt out of content-visibility (index.css:239-241) and would naturally be inside the eager window.

---

## #14 [markdown-dom] useSmooth grapheme-segments every completed message with Intl.Segmenter on mount

- **位置**: `frontend/src/hooks/useSmooth.ts:370`
- **影响**: medium | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every assistant MessageBlock mount: pane open, pane remount after hibernation, tree switch. 1000 messages × ~2KB ≈ 2M graphemes segmented via Intl.Segmenter per pane open, plus ~16MB of retained boundary arrays.

**机制**:

useAnswerRunStream/useVisibleStream unconditionally call useSmooth for every assistant message (streamingProjection.ts:310, :344), and useSmooth's first render runs `segmentGraphemesIncremental({source:'',...}, source)` which falls through to a full `segmentGraphemes(source)` — an Intl.Segmenter grapheme walk over the entire message text producing a boundaries array with one number per grapheme (useSmooth.ts:183-203, :224-226). For a message that mounts already complete (streaming=false, displayed initialized to full source), this segmentation output is never used to animate anything; it is pure wasted CPU and memory (a Number[] the length of the text per message, held for the component's lifetime via segCacheRef).

**修复建议**:

Short-circuit: if !streaming and the hook has never been in a smoothing state (a ref flag), return { displayed: source, isSmoothing: false } without computing boundaries (defer segmentation to the first render where streaming===true or displayed !== source). This is safe because completed-mount messages initialize displayed=source and never animate.

**验证者笔记**:

Mechanism verified in the current tree. useSmooth.ts:369-373 runs `useMemo(() => segmentGraphemesIncremental(segCacheRef.current, source), [source])` on first render with segCacheRef initialized to {source:'', boundaries:[]}; segmentGraphemesIncremental (useSmooth.ts:224-226) hits `prev.source.length === 0` and falls through to a full segmentGraphemes(source) — an Intl.Segmenter grapheme walk producing one Number per grapheme (useSmooth.ts:183-196). For a message that mounts complete (streaming=false), displayed is initialized to source (line 377) and cursorRef to sourceBoundaries.length (line 381), so isSmoothing is false, no animation frame is ever scheduled, and the boundaries array is never consumed — pure wasted CPU plus a retained Number[] via segCacheRef/boundariesRef for the component's lifetime. Callers are unconditional: streamingProjection.ts:310 (useAnswerRunStream) and :344 (useVisibleStream), invoked from MessageBlock.tsx:501 (per answer run — multi-run messages segment each run) and :571, plus MobileMessage.tsx:42. PaneMessageList.tsx:87 maps ALL node.messages with no virtualization, so every assistant message pays on pane open, and the shipped pane-hibernation optimization makes remounts re-pay the full cost. Not mitigated: the June-2026 useSmooth change (useSmooth.ts:702-742, commit 5eeb4e0f) only skips visibility/focus listeners on completed messages, explicitly per its comment; AnswerRunView's React.memo prevents re-renders but not mount cost. Benchmarked with Node's Intl.Segmenter: 1000 × ~2KB messages = ~485ms ASCII / ~593ms CJK of main-thread work and ~4M retained boundary numbers (tens of MB heap) — consistent with the claim's estimates. Trigger framing (pane open / hibernation remount / tree switch, not per-chunk or per-keystroke) is accurate, so "medium" is a fair rating: real, on a hot large-session path, but a one-time-per-mount cost rather than continuous.

**补充证据 / fix 安全检查**:

Fix sanity-check: the proposed short-circuit would genuinely help (it eliminates the entire segmentation + retention cost for completed-mount messages, the overwhelmingly common case in large sessions), but it must be implemented as skipping the WORK inside the hook, not skipping hooks (Rules of Hooks). Care points: (1) several refs are initialized from sourceBoundaries at mount — cursorRef/sourceCountRef (useSmooth.ts:381-383) and boundariesRef (:380) — a deferred-segmentation path must reconstruct these lazily before first use; (2) boundariesRef is read by snapToSource (:482-493), displayedGraphemeCount remap in the source effect (:790-793), and the isSmoothing computation (:878), so a lazy sentinel needs a guard or on-demand compute in those paths; (3) the source-change effect (:745-876) already handles the "text appended after mount" case via segmentGraphemesIncremental's fallback, so deferring first segmentation to the first source change is safe — a completed message whose source later grows (rare, e.g. retry/rebind) would just pay the full segmentation then. Simpler alternative: gate the useMemo body on `streaming || displayedRef.current !== source` and return an empty array otherwise, computing lazily inside tick/snapToSource. No interaction with the documented invariants: nodesRef single-writer, composer wire-stability, per-tree pane maps, and stream terminal safety are all upstream of this render-layer hook; the fix changes neither dispatch order nor SSE handling. Benchmark evidence: node Intl.Segmenter, 1000×2070-char ASCII strings = 484.9ms, 1000×2000-char CJK = 593.2ms, 4.02M retained boundary elements ≈ 51MB heapUsed in the test process.

---

## #15 [markdown-dom] rehype-raw runs unconditionally on every markdown render, even for text with no HTML

- **位置**: `frontend/src/components/MarkdownContent.tsx:307`
- **影响**: medium | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every MarkdownContent render: per message on pane mount, per rAF frame on the streaming tail block.

**机制**:

The rehype plugin chain is always `[rehypeRaw, [rehypeSanitize, sanitizeSchema], ...]`. rehype-raw serializes the hast tree and re-parses it through parse5 (hast-util-raw) — one of the most expensive steps in the unified pipeline — and rehype-sanitize then re-walks the result. This runs for every message on mount (finding #3) AND for the live tail block on every reveal frame (finding #2's tick), yet the vast majority of agent output contains no raw HTML at all. The only HTML producers are highlightMentions' mention-chip spans (user messages) and occasional model-emitted tags.

**修复建议**:

Gate the raw/sanitize pair on content: `const mayContainHtml = text.includes('<');` and build plugins with rehypeRaw+rehypeSanitize only when true (sanitize is only needed to launder raw HTML; react-markdown output without rehype-raw is already safe). Keep the pair always-on for user messages that went through highlightMentions, or check for '<' after the mention transform.

**验证者笔记**:

Mechanism verified in current tree. MarkdownContent.tsx:307 unconditionally builds `[rehypeRaw, [rehypeSanitize, sanitizeSchema]]` inside a useMemo keyed only on [rehypeKatex, revealPlugin] (line 312) — no content gating. MarkdownRendererAdapter.tsx:21 feeds this straight into react-markdown 9.1.0, whose unified pipeline runs synchronously on every render; react-markdown passes allowDangerousHtml:true to remark-rehype (node_modules/react-markdown/lib/index.js:112), so hast-util-raw's parse5 re-parse genuinely executes each time. Trigger claim survives the batching check: MarkdownContent's React.memo (lines 409-422) and the shipped MarkdownBlock memo (StreamingMarkdownContent.tsx:38-51) confine streaming re-renders to the live tail block, but that block's text changes every useSmooth rAF frame (useSmooth.ts:332-335), so raw+sanitize re-run per reveal frame on the tail and once per message on mount — exactly as claimed. Not mitigated: the katex plugin IS content-gated via hasMath(text) (lines 266-275), proving the pattern exists, but raw/sanitize never got it. First-party HTML sources check out: mention-chip spans at terminal/MessageBlock.tsx:332 (user messages only, via highlightMentions at lines 886-898) and the schema's `br` allowance (line 45). Impact 'medium' is honest: the whole remark/rehype pipeline still re-runs per tail frame regardless, so raw+sanitize is a partial (est. 20-40%) but real and removable slice of hot-path per-frame cost, multiplied across concurrent streaming panes and every message render on pane mount.

**补充证据 / fix 安全检查**:

Fix sanity check: the proposed `text.includes('<')` gate is sound and safe. (1) Verified react-markdown/lib/index.js:355-360 — without rehypeRaw, `raw` hast nodes are replaced with plain text nodes, so output is already XSS-safe without sanitize; dropping both when no '<' exists changes nothing semantically (raw HTML can't occur without a '<'). (2) All first-party HTML self-activates the gate: mention-chip spans (MessageBlock.tsx:332) contain '<span', model-emitted '<br>' contains '<'. (3) rehypeKatex deliberately runs AFTER sanitize (comment at MarkdownContent.tsx:304-306) so math output is never sanitized anyway — gating raw/sanitize does not affect math, autolink, or the reveal plugin, which all run later. (4) None of the documented invariants are touched: nodesRef single-writer (state layer), composer wire-stability (mentionDoc), per-tree pane maps, and stream terminal safety are all outside this pure render-layer change. Implementation caveats: the rehypePlugins useMemo at line 303 must add the mayContainHtml boolean to its dep array; a mid-stream false→true flip changes plugin array identity and forces one full ReactMarkdown re-render that frame (negligible). False positives (e.g. '<' inside code fences or 'a < b' prose) merely keep the old behavior — correctness unaffected, only the optimization foregone for that message.

---

## #16 [markdown-dom] Follow-pin reads offsetTop/offsetHeight of every message frame on each ResizeObserver fire during streaming

- **位置**: `frontend/src/components/terminal/TPane.tsx:1297`
- **影响**: low | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every content growth frame of a streaming pane (≈ every reveal frame), scaling with message count in the pane. Also refires on pane width changes and composer growth.

**机制**:

pinFollow computes the tail anchor by iterating ALL children of the scroll container's inner element and reading `c.offsetTop + c.offsetHeight` for each (TPane.tsx ~1297-1303: `for (const c of Array.from(inner.children)) { ... const b = c.offsetTop + c.offsetHeight; ... }`). A ResizeObserver on the container and its firstElementChild (TPane.tsx:1383-1390) fires this synchronously on every content-height change — which during streaming is essentially every reveal frame, since the growing tail changes the inner height each rAF tick. With 1000 message frames that is ~1000 forced geometry reads × 60/s, plus an Array.from allocation per fire. It also queries `el.querySelector('[data-msg-id=...]')` (a subtree scan) per fire for the latest-user anchor.

**修复建议**:

Children are laid out top-to-bottom, so iterate from `inner.lastElementChild` backwards and take the first non-aria-hidden child's bottom (O(1) in practice). Cache the latest-user message element lookup across fires (invalidate on lastMsg.id change). Replace the `[...messages].reverse().find` scans with reverse for-loops (no array copy) — they run per SSE chunk.

**验证者笔记**:

The mechanism exists exactly as cited, but the quantification ("~1000 forced geometry reads × 60/s") does not survive inspection of the actual trigger paths and guards.

CONFIRMED parts:
- TPane.tsx:1295-1303 does iterate ALL children of the inner content div (`for (const c of Array.from(inner.children) as HTMLElement[]) { ... const b = c.offsetTop + c.offsetHeight; ... }`), and PaneMessageList renders one `terminal-message-frame` div per message directly into that div (PaneMessageList.tsx:87-122), so the scan is O(messages).
- The ResizeObserver at TPane.tsx:1383-1390 observes both `el` and `el.firstElementChild` and calls `pin()` → `pinFnRef.current?.()` synchronously on each fire; a second trigger path at :1335-1338 schedules `requestAnimationFrame(pinFollow)` on every effect re-run, whose deps include `lastBlockSig` (per streaming commit).
- The `el.querySelector('[data-msg-id="..."]')` subtree scan at :1288 runs per pinFollow, and the latest user message is near the END of document order, so the selector scans nearly the whole message subtree before matching — plausibly the dominant per-fire cost at 1000 messages.
- The secondary O(N) copies are real: TPane.tsx:1253-1254 `[...n.messages].reverse().find((mm) => mm.role === 'user')` per effect run, and PaneMessageList.tsx:61-64 `[...node.messages].reverse().find(...)` per node identity change.

OVERSTATED parts (why impact drops below medium):
1. "Forced geometry reads" is wrong for the primary path. ResizeObserver callbacks fire AFTER layout, before paint — the code even documents this at TPane.tsx:1360-1365. At that point layout is clean, so `offsetTop`/`offsetHeight` are cheap property reads, not forced reflows. Within one pinFollow, all reads precede the single `el.scrollTop` write (:1321-1323), and scrollTop writes don't dirty layout, so there is no read-write thrash. The rAF path (:1337) can force at most one layout per streaming commit — layout the browser was about to do anyway.
2. "Every reveal frame ≈ 60/s" is wrong. The RO observes the container (fixed size) and the inner div; the inner's height changes only when revealed text wraps a new line or a new block lands — not on every character-reveal rAF tick. Realistic fire rate is line-wrap rate + streaming-commit rate (SSE dispatch, already throttled by the shipped streamingProjection), i.e. typically well under 60/s combined.
3. Strong guards limit who pays: pinFollow bails immediately unless `followRef.current` is true (:1285, cleared when the user scrolls up, :1798-1799), and `pinFnRef.current` is null unless the node is streaming / generating follow-ups (:1330-1334) — so only the one actively-followed streaming pane pays anything; idle panes and 20-pane layouts pay only the `setViewportH(el.clientHeight)` setState (which React bails on unchanged values).
4. Scale math at the audit's 1000-message target: per fire ≈ Array.from(1000) + 1000 getAttribute + 2000 clean-layout property reads + one late-match querySelector — roughly 0.3-1ms. At a realistic 10-30 fires/s that is ~1-3% of one core during active streaming of one giant pane, imperceptible at typical 20-100-message panes. The `[...messages].reverse()` copies are microseconds even at 1000 messages.

So: real, hot-path-adjacent, cheap to fix, but the honest impact is LOW (borderline medium only in the extreme single-pane-with-1000-messages streaming case), not the medium claimed on the basis of a 60Hz forced-reflow storm that doesn't exist.

**补充证据 / fix 安全检查**:

Fix sanity check: the proposed fix is sound and safe. (a) The inner div's children are normal block flow (message frames + MergeSourcesNotice + follow-ups/StreamActivityIndicator, PaneMessageList.tsx:84-122), so walking backwards from `inner.lastElementChild` to the first non-`aria-hidden` child yields the max bottom in O(1) for practical purposes — the aria-hidden skip already handles the tail spacer, per the comment at TPane.tsx:1290-1294. (b) Caching the `[data-msg-id]` element keyed on `latestUser.id` is safe: frames are keyed by `m.id` (PaneMessageList.tsx:117-119) so the DOM node is stable across streaming commits; invalidate on id change and pane remount. Note the separate mount-restore path at TPane.tsx:839 also uses querySelector but runs only on mount, and savePaneScroll (:788) does an O(N) `querySelectorAll('[data-msg-id]')` but only on debounced scroll (250ms, :800-806) — neither is per-chunk. (c) No documented invariant is touched: the fix is confined to DOM reads inside TPane's scroll-follow logic — no reducer/nodesRef writes (single-writer preserved), no composer wire-format code, no per-tree pane-map keys, no stream terminal (done/error) handling. One edge to preserve: the current loop's max-of-all-bottoms semantics would differ from last-child-bottom only if an earlier sibling extended below the last one (e.g. negative margins) — not the case in this layout, but worth a comment. Content-visibility note: frames use `content-visibility:auto` with `contain-intrinsic-size: auto 72px` (index.css:234-237), so offsetHeight reads on offscreen frames return cheap estimates — another reason the current scan is not as expensive as "1000 forced geometry reads" suggests.

---

## #17 [markdown-dom] Live answer run re-strips sentinels over the whole run text on every SSE chunk (O(L) per chunk, O(L²) per turn)

- **位置**: `frontend/src/state/streamingProjection.ts:305`
- **影响**: low | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every SSE chunk of a streaming answer; cost grows linearly with accumulated answer length. A 100KB answer delivered in ~2000 chunks scans ~100-200MB of characters total, on the main thread interleaved with reducer dispatch.

**机制**:

useAnswerRunStream memoizes `projectAnswerRun(blocks, incomingCarry)` on [blocks, incomingCarry], but the live run's blocks array gets a new identity on every chunk (appendAnswerBlockText replaces the tail block, assistantBlocks.ts:190-200), so stripSentinelsStreamingSafe re-scans the ENTIRE accumulated run text (carry + all answer rawText) per chunk. Unlike frozen runs (which hit the runProjectionCache WeakMap via splitAssistantRuns, streamingProjection.ts:127-146), the hot growing run pays a full-length scan per chunk — cumulative O(L²) character work over a turn. splitAssistantRuns in BlockAssistantBody additionally calls getRunProjection for carry propagation per chunk (cache miss for the live run, so the scan effectively happens twice per chunk when the live run is an answer run).

**修复建议**:

Make sentinel stripping incremental for the append case: stripSentinelsStreamingSafe already returns pendingRawTail; cache { prevRaw, prevVisible, pendingRawTail } per message/run and, when the new raw startsWith prevRaw, re-scan only pendingRawTail + appended delta and append to prevVisible (the remapOffset function needs the same prefix-reuse treatment or can be rebuilt lazily). Alternatively route useAnswerRunStream through getRunProjection keyed on (lastBlock, rawText length) to at least deduplicate the double scan per chunk.

**验证者笔记**:

Mechanism verified end-to-end in the current tree. (1) Per-chunk full re-scan: chatStreamRunner.ts:155-156 dispatches every SSE chunk straight to the reducer with no coalescing ("runner is now a thin pipe... goes straight to the reducer"); the `chunk` reducer path calls appendAnswerBlockText (assistantBlocks.ts:190-200) which does `blocks[blocks.length-1] = { ...last, rawText: last.rawText + text }` — new tail-block identity every chunk, and cloneBlocks (assistantBlocks.ts:31-33) is a plain `.slice()` so only the tail changes. (2) The hook has no cache: streamingProjection.ts:305-308 is `useMemo(() => projectAnswerRun(blocks, incomingCarry), [blocks, incomingCarry])` — it calls projectAnswerRun directly, NOT getRunProjection, and the live run's blocks array is rebuilt by splitAssistantRuns (MessageBlock.tsx:597, memoized only on m.blocks which changes per chunk), so the memo misses every chunk. projectAnswerRun (streamingProjection.ts:105-120) does answerRunRawText join (O(L) concat) + stripSentinelsStreamingSafe(carryRaw + rawText) — a char-by-char walk over the entire accumulated run (assistantParsing.ts:371-433). (3) The double scan is also real: splitAssistantRuns:90 calls getRunProjection for carry propagation; for the live run the last block changed identity so the WeakMap (streamingProjection.ts:127-146) misses and projectAnswerRun runs a second time. Ironically getRunProjection.set() populates the cache with exactly the (lastBlock, carry) key useAnswerRunStream would need — routing the hook through getRunProjection would immediately dedupe the second scan for free. The runProjectionCache comment itself acknowledges "only the actively-growing run's last block changes identity per frame" — i.e., the live run paying the O(L) re-scan per frame is known and unmitigated. None of the June-2026 optimizations cover this: the markdown block split / throttled tail sits downstream of the projection; AnswerRunView's React.memo (MessageBlock.tsx:513-521) uses sameBlockRefs which correctly fails for the changed tail block, so the recompute happens every chunk-render. Impact estimate is honest: stripSentinelsStreamingSafe's fast path (skip non-'[' chars) runs at ~100-300M chars/sec, so even the 2×~100MB cumulative scan for a 100KB answer amortizes to roughly ~1ms per frame near turn-end, spread across the turn on the main thread. Real, measurable on very long answers, but "low" is the right severity — confirming at the claimed impact.

**补充证据 / fix 安全检查**:

Fix sanity check: the cheap variant (route useAnswerRunStream through getRunProjection) is safe and effective — splitAssistantRuns at MessageBlock.tsx:597 runs first in the same render and populates runProjectionCache with the identical (lastBlock, incomingCarry) key, so the hook's scan becomes a cache hit, halving per-chunk work with zero invariant risk (pure derivation layer; nodesRef single-writer, composer wire-stability, per-tree pane maps, and stream terminal safety are all untouched). The full incremental variant needs one correction the claim missed: prefix-reuse on `newRaw.startsWith(prevRaw)` is NOT sufficient alone, because a completed-sentinel cut absorbs trailing whitespace greedily (assistantParsing.ts:396-398 `while (end < raw.length && /\s/.test(raw[end])) end++`) — if the previous raw ended exactly at a sentinel `]` (or mid-whitespace after it), the appended delta must extend that last cut rather than be scanned as fresh text, otherwise incremental visibleText diverges from a from-scratch computation (monotonicity holds but whitespace after a stripped sentinel would leak into visibleText). The incremental cache therefore must carry {prevRaw, cuts[], lastCutExtendsToEnd: boolean} and resume the whitespace-absorption loop, not just pendingRawTail. remapOffset can be rebuilt from the persisted cuts array cheaply (binary search), so that part of the fix is sound. Note also useVisibleStream (streamingProjection.ts:336-341, legacy non-block path) has the same per-chunk full-scan shape via stripSentinelsStreamingSafe(assistantAnswerRawText(m)) memoized on [hasBlocks, m] — any fix should cover both entry points.

---

## #18 [persistence-hydration] Post-hydration projection seeding is O(N×E) sync on main thread: findTreeIdForNode rebuilds the parent map per node, plus one JSON.stringify per node

- **位置**: `frontend/src/state/workspacePersistence.ts:912`
- **影响**: medium | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every boot (once, right after hydration completes, before the user can interact smoothly); also every 2s flush per dirty node, and full-workspace seeds. At 50 threads / 1000+ nodes with a comparable edge count this is millions of map inserts + thousands of stringify calls in one synchronous effect.

**机制**:

On the first render after hydration, the dirty-tracking effect seeds nodeCommandProjectionRef by looping EVERY project × EVERY chatId, calling serializeNodeRow(project, nodes, nodeId) and JSON.stringify(nodeCommandPatch(...)) for each (workspacePersistence.ts:912-921). serializeNodeRow (line 275) calls findTreeIdForNode(nid, project), and findTreeIdForNode (tree.ts:104-133) rebuilds a child→parent Map over ALL of the project's edges on every single call, then walks to a root. So seeding costs O(nodes × edges) map construction per project plus N stringify calls that serialize digest/composer_draft/trim_snapshot blobs — all synchronously inside a React effect right after hydrated flips true, i.e. exactly at first interactive paint. The same per-node O(E) cost recurs in buildExplicitWorkspaceCommands (line 442) on every flush of a dirty node, and is worst on a brand-new/first-seed project where every node is dirty.

**修复建议**:

Hoist the parent-map/tree-resolution out of the per-node call: build one `nodeId → treeId` resolver per project (single O(E+N) pass) and pass it into serializeNodeRow (or add a memoized `buildTreeIdResolver(project)` keyed on project reference). Additionally, defer the boot seeding to requestIdleCallback — it only needs to complete before the first flush tick (2s later), not before first paint.

**验证者笔记**:

The mechanism is real and verified at every cited line: the first post-hydration effect run (workspacePersistence.ts:906-923) synchronously seeds nodeCommandProjectionRef by looping every project × chatIds (912-921), calling serializeNodeRow per node; serializeNodeRow:275 calls findTreeIdForNode, and tree.ts:114-118 rebuilds the child→parent Map over ALL project edges on EVERY call (plus O(trees) find per walk step). No memoization exists. buildExplicitWorkspaceCommands:442 repeats the per-node O(E) cost on flush. However the impact is overstated on three counts: (1) the seeding runs in a useEffect AFTER first paint (post-commit), so it does not block first paint — it blocks the frame after hydration commit, once per boot; (2) the per-node JSON.stringify is cheap — nodeCommandPatch excludes messages (the heavy data); digest/composer_draft/trim_snapshot are typically null/small, so the dominant cost is the Map rebuilds (~1M inserts at 1000 nodes/1000 edges ≈ tens of ms one-time), and hydration fetch/install likely dwarfs it at that scale; (3) the claimed recurring "every 2s flush" cost is already mitigated — the flush is wrapped in requestIdleCallback (line 1048) and typically touches only 1-2 dirty nodes, so the O(E)-per-dirty-node cost is negligible; the "every node dirty" worst case only occurs on rare whole-project-add events. The quadratic growth is genuine and would become high at multi-thousand-node workspaces, but at the audit's stated scale (50 threads / 1000+ nodes) this is a one-time ~30-100ms post-paint block: medium, not high.

**补充证据 / fix 安全检查**:

Verified code: workspacePersistence.ts:912-921 (sync seed loop inside justHydratedRef first-run branch of useEffect at 906); workspacePersistence.ts:275 `tree_id: findTreeIdForNode(nid, project)`; tree.ts:114-118 `const parentOf = new Map<string, string>(); for (const e of project.edges) {...}` rebuilt per call, plus `project.trees.find(...)` per walk step at tree.ts:124; workspacePersistence.ts:441-450 per-dirty-node serializeNodeRow in buildExplicitWorkspaceCommands; workspacePersistence.ts:1048 `window.requestIdleCallback(flush, { timeout: 2000 })` already idle-defers the periodic flush (mitigates the recurring claim). nodeCommandPatch (400-422) contains no messages — serializeMessageRowsForNode is NOT called in the seed path, so the stringify cost claim is inflated. findTreeIdForNode has 10+ other unmemoized call sites (chatStore.tsx:66,492,856,1481,1550,1633; useLazyTreeMessages.ts:58; WorkspaceTree.tsx:340,503) — a shared memoized resolver would help beyond this finding. Fix sanity: hoisting a per-project nodeId→treeId resolver is safe (serializeNodeRow is pure; no interaction with nodesRef single-writer, composer wire format, per-tree pane maps, or stream terminal safety). Caveat on the "defer seeding to requestIdleCallback" half of the fix: prevProjectsRef/prevNodesRef assignments (910-911) must remain synchronous or the dirty-diff breaks; deferring only the projection loop is safe — worst case a flush/beforeunload beacon before the idle seed emits redundant idempotent node.upsert/node.patch commands (extra writes, no corruption).

---

## #19 [persistence-hydration] Composer draft is persisted through the global nodes reducer on every keystroke: full nodes-map spread + provider re-render + dirty-delta accumulation per key press

- **位置**: `frontend/src/components/terminal/TPane.tsx:1954`
- **影响**: medium | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every keystroke in any pane composer; the 2s network write fires continuously during active typing. Cost scales with total loaded node count (1000+ nodes → thousands of key copies + a full ChatProvider context re-render per keystroke).

**机制**:

MentionEditor's onChange={setDraft} (TPane.tsx:1954) → persistComposerDraft → setComposerDraft → dispatch('set-composer-draft') with no debounce (TPane.tsx:373-390, chatStore.tsx:1936-1938). The reducer returns `{ ...nodes, [nodeId]: updated }` (chatReducers.ts:1170-1174) — an O(total-nodes) object spread over the entire cross-workspace nodes record — and the new map identity re-triggers the persistence dirty-tracking effect (workspacePersistence.ts:962-977), which scans every project's chatIds with ref-compares and then runs accumulateWorkspaceDirtyDelta, cloning all 8 delta Sets (lines 558-568) per keystroke. Every 2s while typing, the flush also serializes the node row (incl. digest/trim/follow_ups JSON) and POSTs a node.upsert + node.patch command batch because composer_draft is in the projection (line 417).

**修复建议**:

Keep the live draft in TPane-local state and debounce the store dispatch (e.g. 300-500ms trailing, flushed on blur/unmount/submit). This cuts per-keystroke work to a local setState and reduces the 2s command batches to one per pause instead of one per tick while typing.

**验证者笔记**:

Every hop of the claimed mechanism exists in the current tree with no mitigation. (1) MentionEditor.tsx:501-504 fires onChange synchronously per TipTap transaction (per keystroke); TPane.tsx:1954 wires it straight to setDraft, which calls persistComposerDraft → setComposerDraft → dispatch('set-composer-draft') (TPane.tsx:373-390, chatStore.tsx:1936-1941) with zero debounce at any layer. (2) 'set-composer-draft' is NOT in HIGH_FREQ_ACTIONS (chatStore.tsx:156-159), so dispatch (chatStore.tsx:819-846) takes the synchronous path: structureVersionRef bumps AND setNodes(next) runs immediately — a full ChatProvider render per keystroke, not RAF-coalesced. (3) The reducer does the O(total-nodes) spread exactly as cited: chatReducers.ts:1174 `return { ...nodes, [action.nodeId]: updated }`; the composerDraftEqual guard (line 1170) only suppresses no-op writes, never typing. (4) The persistence dirty effect (workspacePersistence.ts:962-977) fires on every nodes-ref flip, ref-scans chatIds, and accumulateWorkspaceDirtyDelta clones all 8 delta Sets (lines 558-568) per keystroke. (5) composer_draft is in nodeCommandPatch (line 417); the JSON projection (line 445-446) changes as text grows, so a node.upsert + node.patch batch is enqueued on each 2s flush tick (lines 990, 1053) during continuous typing. The impact estimate is fair for the stated trigger: the per-keystroke cost is several O(loaded-node-count) passes plus a provider render, felt at the 1000+ node scale, and the 2s network write during typing is real. The claim is even slightly UNDERstated in one respect (see extraEvidence) and slightly narrower in another (messages are never re-serialized because the messages array ref is unchanged, workspacePersistence.ts:685 — the 2s batch is node-row only). Medium stands.

**补充证据 / fix 安全检查**:

Additional per-keystroke cost the claim missed: because 'set-composer-draft' bumps structureVersion (chatStore.tsx:829-831), every useStructuralSelector consumer app-wide re-executes its selector on each keystroke (chatStore.tsx:2876-2891 cache is keyed on version) — sidebar/WorkspaceTree tree-walk selectors included — and the notify bridge does a full two-pass Object.keys diff over the entire nodes map per commit (chatStore.tsx:707-713 → notifyChangedNodeSubscribers 632-645), plus the deletedIdsKey O(nodes) useMemo re-runs (chatStore.tsx:574-578). Fix sanity: the proposed local-state + trailing-debounce fix is sound and breaks no documented invariants — nodesRef single-writer is preserved (still dispatch-only), composer wire-stability is untouched (same value written later), per-tree pane maps and stream terminal safety are unrelated. MentionEditor's lastSyncedRef echo guard (MentionEditor.tsx:517-523) makes the delayed store write a no-op when it round-trips back through props. Two care points: the debounce must be flushed/cancelled on submit-clear and on external draft writes (onRestoreQueued sets the draft from outside at TPane.tsx:1930), or a trailing write can resurrect a cleared draft; and multi-window observer mode would see drafts up to the debounce interval late (cosmetic). An alternative of adding the action to HIGH_FREQ_ACTIONS is NOT viable: it mutates a persisted field, violating the structural invariant locked by chatReducers.structural.test.ts.

---

## #20 [persistence-hydration] Boot blocks first paint on three serial round-trips: capabilities probe → meta fetch → active-tree messages, all awaited before hydrated=true

- **位置**: `frontend/src/state/workspacePersistence.ts:1121`
- **影响**: medium | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every boot / page reload. Negligible on Electron localhost; on the Railway web deployment each RTT is real network latency, so 3 serial RTTs ≈ 300ms+ of blank shell at 100ms RTT.

**机制**:

awaitBackendSnapshot awaits fetchPersistenceCapabilities (line 1121) — explicitly advisory, its result only feeds a console.warn — and only then awaits fetchAllWorkspacesMeta (line 1139). After parsing, it awaits fetchTreeMessages for the active tree (line 1169) before calling setProjects/finishHydration (lines 1177-1182). TerminalShell renders nothing until hydrated (TerminalShell.tsx:413 `if (!hydrated)`), so the shell's first paint pays capabilities-RTT + meta-RTT + tree-messages-RTT serially, plus synchronous hydrateBackendWorkspaces parsing of every workspace in between.

**修复建议**:

Fire the advisory capabilities probe in the same attempt as the meta fetch, but do not await or join it: attach logging-only `.then/.catch`, while `fetchAllWorkspacesMeta()` remains the sole readiness/retry gate. `Promise.allSettled` is not equivalent because a slow or hung advisory probe would still block hydration. Optionally go further: finalize hydration after the meta fetch and let the existing lazy-load path (useLazyTreeMessages) install active-tree bodies, so the shell paints one RTT earlier with placeholder panes.

**验证者笔记**:

Mechanism verified line-for-line in the current tree. workspacePersistence.ts:1112-1147 `awaitBackendSnapshot` serially awaits fetchPersistenceCapabilities (line 1121) whose result only feeds a console.warn (line 1129, with a comment at 1116-1119 confirming it is advisory and non-gating), then awaits fetchAllWorkspacesMeta (line 1139). After synchronous hydrateBackendWorkspaces parsing (line 1156), it awaits fetchTreeMessages for the active tree (line 1169) before setProjects/installNodes/finishHydration('backend') at lines 1177-1182. TerminalShell.tsx:413 `if (!hydrated)` returns a splash-only div, so the shell's first real paint pays all three RTTs serially on every boot/reload. No existing mitigation: the June-2026 lazy-load path (useLazyTreeMessages.ts:70) is not used at boot — the eager tree load is a deliberate choice per the comment at lines 1161-1163. Impact estimate is honest: the claim correctly scopes it as negligible on Electron localhost and real (~300ms at 100ms RTT) on the Railway web deployment, and boot-only. Only caveat: of the 3 RTTs, only the capabilities probe is pure waste; meta is unavoidable and the tree eager-load is a documented UX tradeoff — but the claim itself states this, so medium is fair for a per-boot blank-shell delay on the web deployment.

**补充证据 / fix 安全检查**:

Fix sanity check: (1) Start both requests in the same attempt, but only await meta. A `.then/.catch`-only capability probe preserves the "readiness signal single-sourced" property even when that probe never settles; `Promise.allSettled([capabilities, meta])` does not. This does not touch nodesRef single-writer (installNodes at :1096-1099 remains the one write path), composer wire format, per-tree pane maps, or stream terminal safety. (2) The optional deeper fix (finalize hydration after meta, let useLazyTreeMessages install active-tree bodies) works mechanically (useLazyTreeMessages.ts:70 already fetches on demand) but contradicts the explicit design comment at workspacePersistence.ts:1161-1163 ("Eager-load the active workspace's active tree so first paint shows real messages, not placeholders") — it would reintroduce a placeholder flash on the active tree, so it is a product tradeoff, not a pure win. Also note startupMarkOnce('state_hydrate_start'/'state_hydrate_done') at :1101/:1104 gives ready-made instrumentation to measure the improvement.

---

## #21 [persistence-hydration] computeTranscriptFingerprint rescans the entire transcript (including per-message finalizeTurnContent full-string passes) at every turn end

- **位置**: `frontend/src/state/chatReducers.ts:555`
- **影响**: medium | **工作量**: M | **验证**: CONFIRMED
- **触发**: Once per completed turn per node. Cost grows linearly with session length: a 1000-message node with a multi-MB transcript pays a multi-MB string build + hash + N finalizeTurnContent scans on every single turn end, forever.

**机制**:

The `done` reducer computes `resumeFingerprint: computeTranscriptFingerprint(msgs)` over the node's FULL message history. transcriptFingerprint.ts:6-13 builds one giant payload string via `payload +=` across every message, calling assistantPersistenceContent per assistant message — which runs finalizeTurnContent's full-string sentinel scan on each one (assistantBlocks.ts:93 `finalizeTurnContent(assistantAnswerRawText(m))`) — then runs a charCodeAt FNV loop over the whole concatenation. Work is O(total transcript chars) on the main thread, inside the reducer, synchronously with the `done` dispatch that also does title/follow-up parsing.

**修复建议**:

Make the fingerprint incremental: since messages are append-only per turn, chain-hash — keep the previous fingerprint plus the last hashed index on the node, and fold only the new turn's messages into it (fnv over `prevHash + newMessages`). Alternatively hash each message once and cache per-message digests keyed by message identity. Either makes turn-end cost O(new turn) instead of O(whole transcript).

**验证者笔记**:

Mechanism verified in the current tree exactly as claimed. chatReducers.ts:555 computes `resumeFingerprint: computeTranscriptFingerprint(msgs)` over the node's FULL message array on every `done` action. transcriptFingerprint.ts:6-13 concatenates a payload across all messages and calls assistantPersistenceContent per assistant message; assistantBlocks.ts:92-94 routes that through finalizeTurnContent (shared/src/turnProjection.ts:156-170), which itself runs titleMatch + followUpsMatch (multiple regex/matchAll passes), a char-by-char stripTurnMetadataSentinels scan, and two global regex replaces over each assistant message's answer text — then fnv1a32 does a charCodeAt loop over the whole concatenation. No memoization, per-message digest cache, or incremental state exists anywhere; the only other resumeFingerprint write (chatReducers.ts:274) takes a precomputed value. None of the shipped June-2026 optimizations touch this path (they are render/persistence-side). Trigger is honestly stated: once per completed turn, O(total transcript answer chars), synchronous in the reducer on the main thread at the same dispatch that finalizes the turn. For the audit's explicit large-session target (1000+ messages) this is a real, ever-growing per-turn main-thread hitch (plausibly tens to ~100+ ms given the ~5-10 passes per assistant message), so medium is a fair rating. One softening nuance: assistantAnswerRawText (assistantBlocks.ts:81-86) hashes only 'answer' blocks — thinking text and tool outputs (often the bulk of agent transcripts) are excluded, so payloads are smaller than a naive "whole transcript" reading suggests; typical small nodes pay sub-millisecond cost. That nuance doesn't overturn the medium rating for the stated scaling scenario.

**补充证据 / fix 安全检查**:

Fix sanity check: the proposed fix needs one correction to be safe. The fingerprint value is not frontend-private — the backend independently recomputes the identical fingerprint (backend/src/services/resumeStrategy.ts:125-131, same `${role}\u0000${content}\u0000\u0000` + fnv1a32 format) and compares by exact string equality at resumeStrategy.ts:113 (`!input.storedFingerprint || input.storedFingerprint !== input.currentFingerprint`), feeding the resume-strategy decision in routes/michi.ts:804-825. So the naive "fnv over prevHash + newMessages" chain-hash would change the value and permanently force the diverged-transcript resume path. However, FNV-1a is natively resumable: caching the running 32-bit hash state plus last-hashed message index on the node and folding only new messages yields the IDENTICAL value as the full pass — backend needs no change. Content parity holds because persisted content is exactly assistantPersistenceContent output (messageForPersistence, assistantBlocks.ts:337-351). The cache must be invalidated on hydration/lazy message load and migrateAssistantToBlocks; realign-assistant-id is safe (ids are not hashed, only role+content). The alternative "hash each message, combine digests" variant also changes the value and breaks backend parity unless done as fnv-state chaining. No conflict with the documented invariants: fix touches neither nodesRef single-writer, composer wire-stability, per-tree pane maps, nor stream terminal safety (done still terminalizes status unconditionally).

---

## #22 [persistence-hydration] buildExplicitWorkspaceCommands looks up each dirty edge/context with Array.find, making first-seed of a large workspace O(E²)

- **位置**: `frontend/src/state/workspacePersistence.ts:452`
- **影响**: low | **工作量**: S | **验证**: CONFIRMED
- **触发**: First sync of a newly created/imported workspace, bulk structural edits (mass re-parenting, tree moves), and the unload flush when many edges are pending. A 1,000-edge workspace pays ~1M template-string constructions in one flush.

**机制**:

For every id in delta.edgeUpsertIds the builder does `project.edges.find((candidate) => serializedEdgeId(candidate) === edgeId)` — a linear scan that also constructs the serialized-id string for every candidate edge on every probe. Contexts use the same pattern (line 456). When a brand-new project is accumulated, accumulateWorkspaceDirtyDelta marks ALL edges dirty (lines 582-585), so the flush performs E scans × E string builds = O(E²) string allocations, inside the requestIdleCallback flush and again in the beforeunload sendBeacon path (line 1071).

**修复建议**:

Build one Map<serializedEdgeId, edge> (and Map<id, context>) per project at the top of buildExplicitWorkspaceCommands — a single O(E) pass — and look up ids from the map. ~5 lines.

**验证者笔记**:

The mechanism exists exactly as claimed in the current tree. frontend/src/state/workspacePersistence.ts:451-453: `for (const edgeId of delta.edgeUpsertIds) { const edge = project.edges.find((candidate) => serializedEdgeId(candidate) === edgeId); ... }` — a linear scan per dirty edge id, and serializedEdgeId (line 531-533) builds a template string `${kind}-${source}-${target}` on every probe, so E dirty edges over E project edges is O(E²) scans with O(E²) string allocations. Contexts use the same find pattern at 455-457 (and trees at 437-438, though tree counts are small). The new-project accumulate path at 582-585 does mark ALL edges dirty (`for (const e of cur.edges || []) d.edgeUpsertIds.add(serializedEdgeId(e))`), and this delta reaches buildExplicitWorkspaceCommands both in the interval flush (line 1025, inside requestIdleCallback with 2000ms timeout, line 1048-1049) and in the synchronous beforeunload sendBeacon path (line 1071). No mitigation exists at the call site — notably, accumulateWorkspaceDirtyDelta itself already builds Map indexes for the same edge diffing (lines 617-618), so the builder is the one un-indexed spot.

Impact calibration: the claim self-rates "low", which is honest and matches reality. Two softening facts: (1) hydration does NOT hit the prev===undefined path — the justHydratedRef guard (lines 908-923) seeds prevProjectsRef with the loaded projects, so existing large workspaces are never bulk-marked dirty on boot; the all-edges-dirty case only fires when a whole project object newly appears in state post-hydration (fresh createProject → ~0 edges → trivial; workspace import/undo-restore → real but rare). (2) The interval flush runs inside requestIdleCallback, so even the worst case (~1M template-string constructions for E=1000, realistically a few to tens of ms) is idle-time work, not jank on a hot path; only the beforeunload beacon path pays it synchronously, once, while the page is closing anyway. Steady-state per-edit cost is one O(E) scan per dirty edge — negligible. Since the claimed impact is already "low" and the mechanism, locations, and triggers are all accurate, this is CONFIRMED at the stated impact rather than OVERSTATED.

**补充证据 / fix 安全检查**:

Proposed fix sanity check: building `const edgeById = new Map(project.edges.map(e => [serializedEdgeId(e), e]))` (and a Map for contexts by id) at the top of buildExplicitWorkspaceCommands is a single O(E) pass and is exactly the pattern the same file already uses in accumulateWorkspaceDirtyDelta (workspacePersistence.ts:617-618: `new Map((prev.edges || []).map((e) => [serializedEdgeId(e), e]))`), so it is stylistically consistent and correct. buildExplicitWorkspaceCommands is a pure function over (project, nodes, delta, knownNodeProjections) — the fix touches none of the documented invariants: it does not write nodesRef (single-writer preserved), does not touch composer wire format, per-tree pane maps, or stream terminal safety. One caveat for the fixer: only build the Maps when the corresponding upsert set is non-empty (delta.edgeUpsertIds.size > 0), otherwise the common small-delta flush (1 node dirty, 0 edges) would pay an O(E) map build it previously avoided — a minor regression on the frequent path in large workspaces. Minor trigger nuance: "first sync of a newly created workspace" is effectively free (new workspaces have ~0 edges); the real triggers are workspace import/undo-restore and bulk structural edits that dirty many edges at once.

---

## #23 [persistence-hydration] WorkspaceDirtyDelta.messageNodeIds is accumulated, cloned, and merged on every dirty tick but never consumed by any command builder

- **位置**: `frontend/src/state/workspacePersistence.ts:501`
- **影响**: low | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every SSE chunk render (message array identity changes → line 686 fires) and every flush merge; pure overhead since nothing downstream reads it.

**机制**:

accumulateWorkspaceDirtyDelta populates messageNodeIds on every node-message change (line 686) and on new-project seed (line 580); every accumulation clones the set (line 560) and mergeWorkspaceDirtyDelta re-merges it (line 477). But buildExplicitWorkspaceCommands — the only consumer of deltas in both the 2s flush and the sendBeacon path — never reads messageNodeIds (messages persist via the authoritative turn path per the comment at line 502). During streaming, every chunk render adds the streaming node to this set and re-clones it, and because pendingCommandDeltaByProjectRef only clears when commands.length===0 checks pass, a set carrying message ids can keep a project's pending delta entry alive.

**修复建议**:

Delete the messageNodeIds field from WorkspaceDirtyDelta, its accumulation sites, and its merge entry (the v2 authoritative-turn path made it dead). Removes a per-chunk Set clone/add and simplifies the delta invariant.

**验证者笔记**:

The core mechanism is real in the current tree: WorkspaceDirtyDelta.messageNodeIds (workspacePersistence.ts:501) is written at :580 (new-project seed) and :686 (message-array identity change, i.e. every committed chunk render during streaming), cloned on every accumulation (:560), and merged on every flush (:477), yet buildExplicitWorkspaceCommands (:425-469) — the ONLY consumer of deltas in both the 2s interval flush (:1025) and the sendBeacon unload path (:1071) — never reads it. Grep over frontend+backend confirms zero production reads; the last consumer (buildWorkspaceSyncPayload's upserts.messages / messageReconcileNodeIds) was deleted in commit 9ec3c550, i.e. the field became dead at current HEAD. The claimed impact of "low" is honest: the accumulation effect runs per render anyway for the live nodeIds set, so the attributable cost is one extra small-Set clone+add per dirty tick — pure overhead, but tiny. One sub-claim is wrong and should be discounted: messageNodeIds cannot keep a project's pending delta entry alive, because it is always a subset of nodeIds (:680 precedes :686; :575 precedes :580) and never influences commands.length or the deletion logic at :1031-1032/:1040-1042. The proposed fix (delete the field, its accumulation sites, and its merge entry) is a safe dead-code removal that breaks none of the documented invariants (nodesRef single-writer, composer wire-stability, per-tree pane maps, stream terminal safety); it requires updating tests in lazyLoad.test.ts, dirtyDeltaAccumulate.test.ts, and workspaceCommands.test.ts, and removes the messagesLoaded placeholder guards at :580/:685 whose only purpose is feeding this set.

**补充证据 / fix 安全检查**:

frontend/src/state/workspacePersistence.ts:441-450 — command builder iterates delta.nodeIds only ("for (const nodeId of delta.nodeIds)"); no messageNodeIds anywhere in :425-469. :560 "messageNodeIds: new Set(existing.messageNodeIds)" cloned per accumulateWorkspaceDirtyDelta call; :477 merged per mergeWorkspaceDirtyDelta. Effect at :906-985 fires on [projects, nodes] each committed render, so streaming chunks do trigger accumulation — but nodeIds.add (:680) runs in the same branch, making the marginal cost of messageNodeIds one Set clone of a few entries. git show 9ec3c550 confirms the removed legacy buildWorkspaceSyncPayload was the last reader ("messageReconcileNodeIds: Array.from(messageNodeIds)"). Refuted sub-claim: pending-entry lifetime at :1031-1032 and :1040-1042 depends only on batch.commands.length, queue.hasPending, and dirtyProjectIdsRef — messageNodeIds ⊆ nodeIds and never affects any of these. Fix caveat: also delete the messagesLoaded guards (:580, :685) and update tests lazyLoad.test.ts:36-63, dirtyDeltaAccumulate.test.ts:256-305, workspaceCommands.test.ts:26; no documented invariant (nodesRef single-writer, wire-stability, per-tree pane maps, stream terminal safety) is touched. Benefit is mostly invariant simplification, not measurable perf.

---

## #24 [backend-runtime] Every tool_call_update forces a synchronous full-snapshot SQLite transaction (checkpoint throttle bypassed)

- **位置**: `backend/src/agents/chatHub.ts:313`
- **影响**: high | **工作量**: S | **验证**: OVERSTATED
- **触发**: Codex runtime emits a tool_call_update for EVERY commandOutputDelta / fileChangeOutputDelta / mcpToolCallProgress — i.e. per stdout chunk of a running command (codexEventTranslator.ts:294-326). A single `npm install` or build under codex produces hundreds-to-thousands of deltas, each one a full snapshot transaction + fsync. All concurrent streams stall while each transaction runs.

**机制**:

maybeCheckpoint() skips the 1.5s throttle for STRUCTURAL_EVENTS, which includes CHAT_STREAM_EVENTS.toolCallUpdate (chatHub.ts:77-85). Each checkpoint runs checkpointTurn() (dbRepository.ts:1199-1213): a BEGIN/COMMIT transaction that SELECTs the turn row, UPDATEs the assistant message with JSON.stringify of ALL accumulated blocks and toolCalls (writeAssistantSnapshot, dbRepository.ts:1085-1086), UPDATEs nodes, UPDATEs turns, then SELECTs the turn row again. node:sqlite DatabaseSync is fully synchronous, so each checkpoint blocks the Node event loop for every session, and each commit rewrites the entire snapshot into the WAL (write amplification O(turn_size) per update).

**修复建议**:

Remove toolCallUpdate from STRUCTURAL_EVENTS (or only bypass the throttle when status transitions to a terminal state like completed/failed, not for in_progress output deltas). In-progress deltas can safely ride the 1.5s throttle since the snapshot is rebuilt from the full event log anyway.

**验证者笔记**:

Mechanism fully confirmed in the current tree: STRUCTURAL_EVENTS includes toolCallUpdate (chatHub.ts:77-85) and maybeCheckpoint (chatHub.ts:311-316) bypasses the 1.5s throttle for it, running checkpointTurn (dbRepository.ts:1199-1213) — a synchronous node:sqlite transaction that re-stringifies ALL accumulated blocks+toolCalls (writeAssistantSnapshot, dbRepository.ts:1077-1094) plus node/turn UPDATEs, per event, on the shared event loop (DatabaseSync, WAL, no synchronous pragma relaxation — db.ts:36-41). The codex translator emits tool_call_update for every commandOutputDelta/fileChangeOutputDelta/mcpToolCallProgress (codexEventTranslator.ts:294-325) with zero coalescing anywhere in the path (CodexSession.ts:613-628 → EventQueue FIFO → chatHub.runTurn:441 appends each). The checkpointTurn seq guard (1204) never skips because lastAppliedSeq advances per event. So the per-delta full-snapshot-transaction claim is real. However 'critical' overstates practical impact: per-update tool detail is capped to a 200-char tail (translator appendOutput:219-224) and 16KB output only at completion, so snapshot size is dominated by answer/thinking blocks — large only late in long turns; each transaction is a few statements + one WAL fsync (sub-ms to low-ms); checkpoint failures are caught non-fatally (chatHub.ts:318-326). The realistic failure mode is cumulative event-loop stall (hundreds of ms to seconds over a verbose command, O(turn_size × delta_count) stringify + WAL write amplification) degrading all concurrent SSE streams — a solid high, not an outage-class critical.

**补充证据 / fix 安全检查**:

Fix sanity check: sound and safe. broadcast() runs BEFORE maybeCheckpoint (chatHub.ts:307-308), so checkpoints are crash-recovery persistence only — removing toolCallUpdate from the bypass (or better, bypassing only when the event's status is terminal completed/failed, which needs the event payload passed into maybeCheckpoint, minor refactor) changes no SSE/UI behavior. finalizeTurn (dbRepository.ts:1216+) writes the canonical snapshot at turn end regardless; in-progress deltas riding the 1.5s throttle lose at most 1.5s of a 200-char detail tail on crash. Documented invariants unaffected: nodesRef single-writer, composer wire-stability, and per-tree pane maps are frontend-only; stream terminal safety is preserved because done/error go through finishWithDone/finishWithError → finalize (chatHub.ts:355-397) plus route-level finalTerminalEvent (routes/chatStreamEvents.ts:125-134), none of which touch maybeCheckpoint. Key code refs: chatHub.ts:77-85 (STRUCTURAL_EVENTS with CHAT_STREAM_EVENTS.toolCallUpdate), chatHub.ts:313 (`if (!STRUCTURAL_EVENTS.has(eventName) && now - log.lastCheckpointAt < this.checkpointIntervalMs) return;`), dbRepository.ts:1085-1086 (`JSON.stringify(message.blocks)` / `JSON.stringify(message.toolCalls)`), codexEventTranslator.ts:310-325 (per-delta `kind:'tool_call_update'`), shared/src/turnProjection.ts:407 (tool_call_update advances snapshot seq so the checkpoint guard never dedupes), db.ts:36-41 (DatabaseSync + WAL + busy_timeout only). Note kiro/claude runtimes also emit tool_call_update but at far lower cadence; codex output deltas (and mcpToolCallProgress) are the high-frequency trigger.

---

## #25 [backend-runtime] O(n²) per-chunk content recomputation: full sentinel-strip scan of the entire accumulated answer on every SSE chunk

- **位置**: `shared/src/turnProjection.ts:391`
- **影响**: medium | **工作量**: M | **验证**: OVERSTATED
- **触发**: Every 'chunk' SSE event on every active turn, for all four runtimes. Cost grows quadratically with answer length; multiple concurrent streaming panes multiply it.

**机制**:

applyTurnEvent case 'chunk' calls answerContent(blocks) which joins ALL answer block rawText and runs stripTurnMetadataSentinels — a char-by-char scan with string rebuilding — over the entire accumulated answer text (turnProjection.ts:365-369, 180-222). ChatHub.append runs applyTurnEvent on every event (chatHub.ts:305), so a turn producing N chunks does N scans of growing length: O(total_answer_length²) work on the backend main thread. A 100KB answer arriving in ~2000 deltas performs ~100M character comparisons plus 2000 full-string reallocations.

**修复建议**:

Defer `content` materialization: keep only raw blocks during streaming and compute answerContent lazily at checkpoint/finalize time (checkpointTurn and finalizeTurn are the only consumers of content mid-turn). Alternatively cache the stripped prefix and only scan the appended delta plus a small sentinel-boundary window.

**验证者笔记**:

Mechanism fully CONFIRMED at every cited location: turnProjection.ts:387-393 'chunk' case computes answerContent(blocks) which re-joins all accumulated answer rawText and runs the char-by-char stripTurnMetadataSentinels scan (lines 180-222) on every chunk; chatHub.ts:305 applies it per event before the 1.5s checkpoint throttle (which limits DB writes only, not projection cost). No existing mitigation covers this — the June-2026 optimizations are all renderer-side. The cost is even broader than claimed: the frontend reducer path (assistantBlocks.ts:147 via chatReducers.ts:425) runs the same shared applyTurnEvent per chunk on the UI thread, and the comment at assistantBlocks.ts:130-135 discards the result but does not avoid computing it; chatStore.tsx:833 coalesces renders, not reducer runs. However, 'high' overstates felt impact: the claimed ~100M char comparisons for a 100KB/2000-delta answer amounts to roughly 0.3-1s of cumulative event-loop work spread over a turn lasting tens of seconds (~1% load) plus ~100MB cumulative GC garbage; per-chunk latency stays sub-millisecond even at 100KB. Typical answers (2-10KB) make it negligible. It is genuine quadratic waste on the hottest path that scales with concurrent streaming panes, so medium is fair — a real confirmed inefficiency, not a stall.

**补充证据 / fix 安全检查**:

Fix sanity: sound. Mid-turn, snapshot.assistantMessage.content has exactly one consumer — checkpointTurn → writeAssistantSnapshot (backend/src/services/dbRepository.ts:1199-1214, content column written at :1084). Terminal done/error paths already recompute via finalizeTurnContent(rawAnswer) (turnProjection.ts:462, 475), so deferring answerContent materialization to checkpoint time (≤ every 1.5s via TURN_CHECKPOINT_INTERVAL_MS, chatHub.ts:75) is safe — but it must be computed AT checkpoint, not skipped, or crash-recovery/resume would read stale/empty partial content. Caveats: (1) applyTurnEvent is shared with frontend (assistantBlocks.ts:147) and covered by turnProjectionParity.test.ts:44 — chunk-case changes must keep parity; fixing it in shared code also removes the hidden per-chunk UI-thread cost the frontend comment believes is already avoided. (2) The incremental-prefix variant must handle sentinels split across chunk boundaries (the holdStart partial-sentinel machinery at turnProjection.ts:209-212 exists for exactly this), so the boundary window must be at least the longest sentinel prefix. No documented invariant is at risk: nodesRef single-writer, composer wire-stability, per-tree pane maps, and stream terminal safety (done/error finalization path, chatHub.ts:355-397) are untouched by deferring content materialization.

---

## #26 [backend-runtime] PRAGMA synchronous never set — WAL commits fsync at FULL on every hot-path transaction

- **位置**: `backend/src/services/db.ts:37`
- **影响**: low | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every turn begin, every checkpoint (≥1 per 1.5s per active turn, plus every structural event), every finalize, every saveNode/saveMessage from the persistence routes.

**机制**:

initDb sets journal_mode=WAL, foreign_keys, busy_timeout, but not `synchronous`. SQLite default is FULL, which in WAL mode issues an fsync on every transaction commit. Combined with the per-tool_call_update checkpoints and 1.5s throttled checkpoints, every active turn performs an fsync every checkpoint plus 3+ transactions per turn (beginTurn/checkpoints/finalizeTurn), each blocking the event loop for the disk flush.

**修复建议**:

Add `PRAGMA synchronous = NORMAL` only to the primary `data.db` connection after enabling WAL. Keep `audit.db` and auth SQLite at FULL until their power-loss durability requirements are explicitly relaxed.

**验证者笔记**:

The mechanism is real but the "high" impact claim does not survive measurement on the actual deployment target.

CONFIRMED parts:
1. backend/src/services/db.ts:34-47 (initDb) sets only `PRAGMA journal_mode = WAL` (line 37), `PRAGMA foreign_keys = ON` (38), `PRAGMA busy_timeout = 5000` (41). getAuditDb (db.ts:71-82) is identical. `grep -rn synchronous backend/src` confirms no `PRAGMA synchronous` anywhere (also missing in backend/src/routes/admin.ts:18, which the claim didn't mention).
2. Default verified empirically on this machine's Node v22.22.2 `node:sqlite`: after `PRAGMA journal_mode = WAL`, `PRAGMA synchronous` returns 2 (FULL). So every commit does fsync the WAL.
3. Trigger frequency is as claimed: chatHub.ts:75 `TURN_CHECKPOINT_INTERVAL_MS = 1_500`, and chatHub.ts:77-85 + 313 show STRUCTURAL_EVENTS (plan, tool_call, tool_call_update, image, title, follow_ups, branch_overview) BYPASS the 1.5s throttle — every tool_call_update triggers a full checkpointTurn transaction (dbRepository.ts:1199-1214), plus beginTurn/finalizeTurn transactions per turn. DatabaseSync is synchronous, so commits do block the event loop.

OVERSTATED part — the actual cost:
I benchmarked BEGIN/INSERT/COMMIT loops on this machine (macOS/APFS, the primary desktop deployment): synchronous=FULL ≈ 0.06-0.09 ms per transaction vs NORMAL ≈ 0.015-0.03 ms. The fsync delta is ~50 microseconds per commit, because macOS fsync() does not force a hardware flush (SQLite only issues F_FULLFSYNC under PRAGMA fullfsync, which is off by default). At the observed checkpoint cadence (~1 per 1.5s per active turn, plus structural-event bursts of maybe dozens per turn), the total event-loop blocking attributable to the missing pragma is well under 1 ms per second even with several concurrent turns. The dominant cost of a checkpoint is writeAssistantSnapshot's UPDATE of the growing assistant content — which the proposed fix does not change. On a Linux server (Railway web deploy) fsync is real and could add ~0.5-2 ms per commit on typical volumes, but the checkpoint throttle bounds that to a handful of fsyncs/sec — a minor, not "high", event-loop cost. "Each blocking the event loop for the disk flush" is technically true but the flush is tens of microseconds on the desktop target, not a meaningful stall.

**补充证据 / fix 安全检查**:

Fix sanity check: adding `_db.exec('PRAGMA synchronous = NORMAL')` after the WAL pragma in initDb (db.ts:37) and getAuditDb (db.ts:74) — and admin.ts:18 — is correct, cheap, and the SQLite-documented recommended pairing with WAL (durability relaxed only across OS crash/power loss; app crashes remain fully durable since WAL frames are still written). It cannot affect any of the listed frontend invariants (nodesRef single-writer, composer wire-stability, per-tree pane maps, stream terminal safety) — those are all frontend/React or SSE-protocol concerns; a connection pragma changes only commit fsync behavior, not transaction semantics or event ordering. recoverInterruptedTurns (dbRepository.ts:1254+) already handles turns lost mid-flight, so losing the last <1.5s checkpoint on a power cut is within the design's existing recovery envelope. One caveat: audit.db exists for audit history — if audit durability across power loss is a hard requirement, keep that one at FULL; its write rate (per turn/permission, per db.ts:76-78 comment) is low enough that FULL costs nothing there. Benchmark data: FULL 0.091/0.060 ms per txn vs NORMAL 0.034/0.015 ms per txn (200-txn loops, node:sqlite v22.22.2, APFS). Worth doing as hygiene, but it will not produce a user-visible improvement on macOS.

---

## #27 [backend-runtime] finalizeTurn rescans and re-hashes the node's entire message history every turn

- **位置**: `backend/src/services/dbRepository.ts:1126`
- **影响**: medium | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every completed/cancelled/errored turn on every node; cost grows linearly with node history so long-lived nodes pay progressively more per turn.

**机制**:

refreshResumeFingerprint(nodeId), called inside the finalizeTurn transaction (dbRepository.ts:1232), runs listMessages(nodeId) — `SELECT * FROM messages WHERE node_id = ?` including full content and blocks/tool_calls JSON columns — then concatenates every message body into one payload string and FNV-hashes it (resumeStrategy.ts:125-131). Work per turn end is O(total transcript bytes): for a 1000-message node with megabytes of content, each turn end deserializes and hashes the entire history synchronously inside the durability transaction, extending the window during which the event loop and the DB write lock are held.

**修复建议**:

Make the fingerprint incremental: store the running FNV state (or hash-chain: newFp = fnv1a32(prevFp + role + content)) on the node row and fold in only the two new messages from the finalized turn. At minimum, SELECT only role+content columns instead of `*` (skips blocks/tool_calls JSON) and move the computation outside the transaction.

**验证者笔记**:

Mechanism exists exactly as claimed. backend/src/services/dbRepository.ts:1216-1232 — finalizeTurn wraps its body in runInTransaction and calls refreshResumeFingerprint(snapshot.nodeId) at line 1232. refreshResumeFingerprint (lines 1126-1135) calls listMessages(nodeId), which is `SELECT * FROM messages WHERE node_id = ? ORDER BY seq ASC` (line 1014) — all columns, including the blocks and tool_calls JSON text columns, are materialized even though only role+content are used. It then maps every user/assistant message into a TranscriptMessage and computeTranscriptFingerprint (resumeStrategy.ts:125-131) concatenates every content string into one payload and FNV-1a hashes it char-by-char (fnv1a32, lines 160-167). The DB is node:sqlite DatabaseSync (db.ts:36) and runInTransaction is a synchronous BEGIN/COMMIT (db.ts:91-102), so the entire O(total transcript bytes) read+hash runs on the Node event loop inside the durability transaction, delaying the terminal SSE frame ("Atomically materialize the canonical terminal snapshot before SSE success", line 1215) and blocking all other sessions' SSE processing while it runs.

Trigger frequency is honest: refreshResumeFingerprint is called ONLY from finalizeTurn — checkpointTurn (fires every 1.5s during streaming, chatHub.ts:75) does NOT recompute the fingerprint, and beginTurn does not either. So this is per turn-end (complete/cancel/error via chatHub.ts:49 finalize), not per chunk, exactly as the claim states. Cost grows linearly with node history since there is no incremental state; the only stored value is the final hash (nodes.resume_fingerprint, line 1133).

No mitigation exists: no message-count cap, no content-size cap on the SELECT, no caching, no column projection. None of the June-2026 shipped optimizations touch this backend path.

Impact "medium" is fair for the audit's stated large-session scaling scenario: for a long-lived node with 1000+ messages and multi-MB content (tool-heavy turns make blocks/tool_calls JSON large, all deserialized by SELECT *), each turn end costs tens of ms of synchronous event-loop time, and it compounds — the node pays more on every subsequent turn. For typical nodes (dozens of messages, <100KB) the cost is sub-millisecond, which is why this is medium, not high. One nuance: the "DB write lock held" framing is slightly weaker than stated — with a single synchronous DatabaseSync connection nothing can interleave anyway; the real cost is event-loop blocking, which delays SSE flushes for every concurrent session. That nuance doesn't change the impact tier.

**补充证据 / fix 安全检查**:

Key excerpts: dbRepository.ts:1232 `refreshResumeFingerprint(snapshot.nodeId);` inside `runInTransaction(() => {...})` started at 1220. dbRepository.ts:1126-1132 `const transcript = listMessages(nodeId).filter((m) => m.role === 'user' || m.role === 'assistant').map(...)`. dbRepository.ts:1014 `SELECT * FROM messages WHERE node_id = ? ORDER BY seq ASC`. resumeStrategy.ts:126-130 `let payload = ""; for (const m of messages) payload += role\0content\0\0; return fnv1a32(payload);`. db.ts:91-102 synchronous BEGIN/COMMIT on node:sqlite DatabaseSync.

Proposed-fix sanity check: (a) The cheap wins are safe and effective — SELECT only role,content (skips blocks/tool_calls JSON, often the bulk of row bytes for tool-heavy turns), and/or compute the hash after COMMIT but before the SSE terminal frame. If a crash lands between commit and a post-commit fingerprint write, the stored fingerprint goes stale and chooseResumeStrategy (resumeStrategy.ts:113-114) degrades to the "compatible" strategy (`transcript_changed`) — safe fallback, no corruption. (b) The incremental hash-chain (fold new turn messages into a stored running state) works because writeAssistantSnapshot finalizes assistant content before the fold, but it needs care: any other writer of message content or resume_fingerprint must be kept in sync — dbRepository.ts:1598 sets resume_fingerprint directly, routes/michi.ts:155 writes it on an import/sync path, and any future message-edit/delete feature would desync a chained hash and require full recompute. Changing the algorithm also invalidates all stored fingerprints once, causing a one-time "compatible" resume on every node — acceptable. (c) The four documented frontend invariants (nodesRef single-writer, composer wire-stability, per-tree pane maps) are untouched — this is backend-only. Stream terminal safety is actually helped, not risked, as long as finalizeTurn still completes (with fingerprint write) before the SSE done frame is emitted; the finalize→SSE ordering in chatHub is preserved by keeping the fingerprint UPDATE synchronous in the finalize call, just outside the BEGIN/COMMIT.

---

## #28 [backend-runtime] No prepared-statement reuse — 62 getDb().prepare() call sites re-prepare SQL on every invocation, including per-checkpoint hot paths

- **位置**: `backend/src/services/dbRepository.ts:1079`
- **影响**: low | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every DB access; hottest via checkpointTurn/beginTurn/finalizeTurn during streaming and via requireChatOwner/getNodeWorkspaceId on every cloud-mode API request.

**机制**:

Every repository function calls getDb().prepare(sql) inline; node:sqlite DatabaseSync.prepare compiles the SQL each call (no internal statement cache). checkpointTurn alone prepares ~6 statements per checkpoint (getTurnRow ×2, writeAssistantSnapshot, 1-4 UPDATEs in writeTurnNodeProjection, turns UPDATE); with per-tool_call_update checkpoints this is thousands of redundant sqlite3_prepare_v2 compilations per long turn, all on the event loop.

**修复建议**:

Add a small module-level memo keyed by SQL string (Map<string, StatementSync>) wrapping getDb().prepare, invalidated on closeDb(). StatementSync objects in node:sqlite are reusable across .run/.get/.all calls.

**验证者笔记**:

Mechanism fully confirmed: 62 inline getDb().prepare() sites in backend/src/services/dbRepository.ts, node:sqlite DatabaseSync (db.ts:1) compiles SQL on every .prepare() with no internal cache, and no statementCache exists. checkpointTurn (dbRepository.ts:1199-1213) really does ~6 prepares per checkpoint (getTurnRow ×2 at 1201/1211, writeAssistantSnapshot at 1079, 1-4 node UPDATEs at 1100/1107/1111/1114, turns UPDATE at 1208), and chatHub.ts:313 confirms tool_call_update/toolCall/plan/title are STRUCTURAL_EVENTS that bypass the 1.5s checkpoint throttle (TURN_CHECKPOINT_INTERVAL_MS=1_500, chatHub.ts:75), so per-tool_call_update checkpoints are accurate. The code even contains a false comment (dbRepository.ts:313-314 "cached by SQLite's prepared-statement cache") showing the author assumed caching that doesn't exist. However, the impact is overstated at medium: each prepare of these short statements is single-digit-to-tens of microseconds, so even "thousands per long turn" is tens of milliseconds spread over minutes, while the same checkpointTurn transaction rewrites the ENTIRE assistant message every checkpoint — content plus JSON.stringify of all blocks and toolCalls (dbRepository.ts:1084-1086), an O(turn-size) cost that grows with the turn and dominates the O(1) prepare overhead by 1-2 orders of magnitude. The per-cloud-request cost (requireChatOwner/getNodeWorkspaceId) is one extra prepare per HTTP request — negligible vs request handling. Real defect, valid cheap fix, but low measured impact.

**补充证据 / fix 安全检查**:

Fix sanity-check: a module-level Map&lt;string, StatementSync&gt; keyed by SQL, invalidated in closeDb() (only called at shutdown, backend/src/server.ts:524), is safe and would work — node:sqlite StatementSync is reusable across .run/.get/.all including named @param binding (saveTree/saveMessage use @-params), and sqlite3_prepare_v2 statements auto-recompile on schema change. It cannot break the documented invariants (nodesRef single-writer, composer wire-stability, per-tree pane maps, stream terminal safety) — those are all frontend/stream-protocol invariants; this is a backend DB-layer-only change. One implementation caveat: getDb() can reopen after closeDb(), so the cache must be keyed to or cleared with the db instance, exactly as the proposed fix says. But the higher-leverage optimization in the same code path is the per-checkpoint full-snapshot rewrite: writeAssistantSnapshot re-serializes all blocks/toolCalls JSON on every structural event (dbRepository.ts:1079-1093), which is the actual dominant event-loop cost during tool-heavy streaming turns; also checkpointTurn calls getTurnRow twice (1201 and 1211) where the second SELECT could be avoided entirely. Also note runTombstoneGc and isNodeTombstoned (dbRepository.ts:302-328) re-prepare on every saveMessage call — same pattern, same microsecond-scale cost.

---

## #29 [bundle-startup] manualChunks 'rehype' pattern swallows rehype-katex, dragging all of KaTeX (255K JS + 28K CSS) onto the boot critical path despite the code's lazy-import

- **位置**: `frontend/vite.config.mts:68`
- **影响**: high | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every cold start / page load (web, Electron renderer, mobile) — before first paint.

**机制**:

MarkdownContent.tsx intentionally lazy-loads math support (`import('rehype-katex')` / `import('katex/dist/katex.min.css')` at MarkdownContent.tsx:269-270, gated on hasMath()). But vite.config.mts:68 `id.includes('node_modules/rehype')` matches `node_modules/rehype-katex` and merges it into the `markdown-legacy` chunk — which is statically imported by the entry (react-markdown/unified are static imports). rehype-katex statically imports katex, so the `math` chunk becomes a static dependency too. Built output confirms it: entry chunk starts with `import"./math-BlKYfo5W.js"`, markdown-legacy imports `from"./math-BlKYfo5W.js"`, and build/index.html emits `<link rel="modulepreload" href="./assets/math-BlKYfo5W.js">` plus a render-blocking `<link rel="stylesheet" href="./assets/math-dIRGbAJA.css">` (28.3K). Result: 255K (77K gz) of KaTeX JS is parsed and 28K of KaTeX CSS blocks first paint on every cold load, even for users who never render a formula.

**修复建议**:

Do not rely on a one-line `rehype-katex -> undefined` carve-out: under the audited Vite 7 / Rollup 4 graph it still promoted math into the static boot graph, while an explicit math chunk introduced cycles. The verified fix is to stop broadly manual-grouping the unified/remark/rehype family and let Rollup preserve the existing dynamic imports for both `rehype-katex` and KaTeX CSS. Keep the remaining classifier testable in `viteChunks.ts`, then verify the built HTML, boot static imports, KaTeX engine signature and stylesheet links.

**验证者笔记**:

Every link in the claimed chain checks out in the current tree and a fresh build (frontend/build modified today). vite.config.mts:67 buckets any 'node_modules/rehype*' id into 'markdown-legacy' with no rehype-katex carve-out; MarkdownContent.tsx:269-270 dynamically imports rehype-katex/katex CSS (intent = lazy) but MarkdownContent itself statically imports rehype-raw/rehype-sanitize (lines 2-3) and is statically imported by MessageBlock.tsx:7 and others, putting markdown-legacy on the entry graph. rehype-katex's package.json depends on katex ^0.16.0, and the katex rule at vite.config.mts:43 names the 'math' chunk but cannot make it lazy once rehype-katex is merged into a static chunk. Built artifacts prove it: markdown-legacy-CKz-vuDw.js begins `import{k as Wr}from"./math-BlKYfo5W.js"`; entry index-ClcNLzNP.js contains side-effect `import"./math-BlKYfo5W.js"`; build/index.html emits `<link rel="modulepreload" href="./assets/math-BlKYfo5W.js">` (255.0K on disk) and a render-blocking `<link rel="stylesheet" href="./assets/math-dIRGbAJA.css">` (28.3K). No existing mitigation: the modulePreload.resolveDependencies filter (lines 34-38) only strips markdown-streamdown/markdown-code hints and wouldn't remove the static import anyway; none of the shipped June-2026 optimizations touch katex chunking. Impact "high" is fair for the web deployment (77K gz JS + 28K blocking CSS on every cold load before first paint); on Electron/localhost the cost reduces to parse/eval (~tens of ms per boot), so it skews medium there — but the claim states the trigger honestly for both.

**补充证据 / fix 安全检查**:

Fix sanity check (updated by implementation experiment): the isolated carve-out is insufficient in the current chunk graph, and explicit manual math grouping can create math↔markdown cycles. The safe result came from removing the broad unified/rehype manual bucket so the source-level dynamic import remains authoritative. The production verifier must inspect more than filenames: reject math/KaTeX modulepreloads and boot CSS links, walk the boot assets' static imports, and search them for the KaTeX engine signature. This is a build-config-only change with zero user-visible math semantics; formula rendering still needs a runtime regression test.

---

## #30 [bundle-startup] react-markdown/unified pipeline (markdown-legacy, 352K / 111K gz) is statically imported at boot; the StreamingMarkdownContent React.lazy split is defeated by MessageBlock's static MarkdownContent import

- **位置**: `frontend/src/components/terminal/MessageBlock.tsx:7`
- **影响**: medium | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every cold start — main-thread parse/compile before first interactive frame.

**机制**:

MessageBlock.tsx lazy-loads StreamingMarkdownContent (line 29) but statically imports MarkdownContent (line 7), which statically imports MarkdownRendererAdapter → react-markdown + remark-gfm (MarkdownRendererAdapter.tsx:1-3) plus rehype-raw/rehype-sanitize/remark-math (MarkdownContent.tsx:2-5). MessageBlock is statically reachable from entry (TPane → Dashboard → TerminalShell → App), so the entire unified/micromark/mdast/hast pipeline — bucketed as markdown-legacy — is a static dependency of the entry chunk: index.html modulepreloads it and entry execution blocks on it. That is 351.9K (110.9K gz) parsed on every cold start before the shell renders, even on the empty Home page with zero messages.

**修复建议**:

Make MarkdownContent itself React.lazy at its static consumer boundaries (MessageBlock, DigestPane, PaneMessageList, ArtifactPane, mobile MobileMessage) the same way StreamingMarkdownContent already is — a single `const MarkdownContent = React.lazy(() => import('../MarkdownContent'))` with a plain-text fallback, or hoist a shared lazy wrapper module. First message paint then triggers a warm fetch (chunk is small enough to also `import()`-prefetch after first idle). Combined with finding 1 this removes ~190K gz from the boot path.

**验证者笔记**:

Every element of the claim verified in the current tree. MessageBlock.tsx:7 statically imports MarkdownContent while lazy-loading StreamingMarkdownContent at line 29; MarkdownContent.tsx:2-7 statically pulls rehype-raw/rehype-sanitize/remark-math and MarkdownRendererAdapter, which statically imports react-markdown + remark-gfm (MarkdownRendererAdapter.tsx:1-3). Static reachability from entry confirmed: App.tsx:3 → TerminalShell.tsx:7 (Dashboard) → Dashboard.tsx:7 (TPane) → TPane.tsx:27 (PaneMessageList) → PaneMessageList.tsx:7 (MessageBlock); Dashboard.tsx:8-9 also statically import DigestPane/ArtifactPane which import MarkdownContent too. Build artifacts confirm: entry index-ClcNLzNP.js head contains from"./markdown-legacy-CKz-vuDw.js", index.html modulepreloads it (vite.config.mts:34-37 filters markdown-streamdown/markdown-code from modulepreload but not markdown-legacy — evidence the team intended markdown off the boot path), and gzip measures exactly 110,910 B (351.9K raw). None of the June-2026 optimizations mitigate this: the lazy split successfully keeps markdown-streamdown (40K) and markdown-code (129K shiki) out of boot, but markdown-legacy is defeated by the static import. Impact estimate is honest: every cold start, entry evaluation blocks on fetching+parsing 352K of unified/micromark/mdast/hast code even on the empty Home page — ~28% on top of the 897K entry chunk; medium is fair for the web deployment and a real parse-time win for Electron.

**补充证据 / fix 安全检查**:

Fix sanity: viable and low-risk. The actual boot-path offenders are only MessageBlock.tsx, DigestPane.tsx, and ArtifactPane.tsx — the other listed consumers are already behind existing lazy boundaries (ExportPanel behind App.tsx:24 lazy; pages/Branches + pages/Digest behind TerminalShell.tsx:18-19 lazy; MobileMessage/ContextsScreen behind App.tsx:4 lazy MobileShell), so a shared lazy wrapper at those three static consumers suffices. The fix is pure render-layer: it does not touch nodesRef single-writer, composer wire-stability (mentionDoc), per-tree openPanes/focusedPane maps, or stream terminal safety. Only UX risk is a one-time plain-text Suspense flash on first message paint, addressable via the proposed idle import() prefetch. Note MobileMessage.tsx:3 imports userTextToMarkdown from MessageBlock — a plain function export, unaffected by lazifying MarkdownContent inside MessageBlock. StreamingMarkdownContent.tsx:2 statically imports MarkdownContent, which is fine (already behind its own lazy boundary at MessageBlock.tsx:29). Bonus observation: the math/katex chunk (math-BlKYfo5W.js) is also modulepreloaded from index.html for the same structural reason — the same fix pattern could apply there.

---

## #31 [bundle-startup] TipTap + ProseMirror composer is statically bundled into the 897K (281K gz) entry chunk

- **位置**: `frontend/src/components/MentionEditor.tsx:9`
- **影响**: medium | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every cold start; cost is main-thread parse/compile of the entry chunk before first render.

**机制**:

MentionEditor statically imports @tiptap/react, @tiptap/starter-kit, @tiptap/extension-mention and @tiptap/pm (MentionEditor.tsx:9-13), and is itself statically imported by TPane.tsx:8, ComposerShell, ManageComposer, and pages/Home.tsx — all statically reachable from TerminalShell/App. The whole ProseMirror ecosystem (model/view/state/transform/commands/keymap + tiptap wrappers, roughly 150-250K min) therefore lands in the entry chunk, which is 896.9K raw / 280,946 B gzip. No manualChunks rule separates it (vite.config.mts only splits react-dom, katex, shiki, streamdown, remark/rehype), so it is parsed/compiled on the main thread before React can mount, on every cold start.

**修复建议**:

Either (a) React.lazy MentionEditor with a plain <textarea> placeholder that swaps in once loaded (composer contract is already {value, mentions} via mentionDoc.ts, so a read-only textarea shim during the ~1 frame load is viable), or (b) minimally, add a manualChunks rule for node_modules/@tiptap + node_modules/prosemirror-* so the editor becomes its own preloadable chunk that at least parallelizes fetch/parse and stops bloating the entry chunk cache-invalidation unit. Option (a) removes it from the critical path entirely.

**验证者笔记**:

Every element of the claim checks out in the current tree. MentionEditor.tsx:9-11 has value imports of @tiptap/react, @tiptap/starter-kit, and @tiptap/extension-mention (line 13's @tiptap/pm/state is type-only and erased, but the value imports pull the full prosemirror stack transitively). The static reachability chain is real: App.tsx:3 → TerminalShell.tsx:7 (static import of pages/Dashboard) → Dashboard.tsx:7 (TPane) → TPane.tsx:8 (MentionEditor), plus TerminalShell → Home.tsx:3 → ManageComposer.tsx:3 → MentionEditor. The codebase lazy-loads many other surfaces (TerminalShell.tsx:17-27 lazy Map/Settings/CommandPalette; App.tsx:4 lazy MobileShell) but never the composer, so no existing mitigation applies. Build output reproduces the claim exactly: index-ClcNLzNP.js is 896.9K raw / 280,946 B gzip; case-insensitive marker counts match (prosemirror 6 + ProseMirror 50 = 56; tiptap-insensitive 25), and prosemirror-view/prosemirror-model markers are present in the entry chunk. vite.config.mts:41-74 manualChunks covers only react-dom/katex/shiki/streamdown/remark-rehype — no tiptap/prosemirror rule. The size estimate is honest: minifying the actually-imported dists totals ~350KB (pm model 44.7K, view 97.1K, state 12K, transform 31.6K, commands 12.8K, @tiptap/core 99.7K, @tiptap/react 18.5K, mention+suggestion+starter-kit ~12K), so 150-250K post-tree-shaking is a fair range for main-thread parse/compile paid on every cold start before first render. Medium impact is appropriate for a boot-path-only cost.

**补充证据 / fix 安全检查**:

Fix sanity check: option (b) manualChunks for node_modules/@tiptap + node_modules/prosemirror- is behaviorally zero-risk and improves cache-invalidation granularity, though a modulepreloaded chunk still parses near startup — partial win. Option (a) React.lazy(MentionEditor) fully removes it from the critical path but the Home page (TerminalShell.tsx:481 → Home.tsx:106 ManageComposer) renders the composer as first-paint hero content, so the editor is needed within ~1 frame of mount; the shim must tolerate the forwarded MentionEditorHandle ref being null briefly (TPane.tsx:424 inputRef, ManageComposer.tsx:95 — focus-on-mount calls) and a read-only textarea placeholder momentarily blocks typing. Neither option touches the documented invariants: wire-stability lives in mentionDoc.ts (unchanged by chunking), nodesRef single-writer / per-tree pane maps / stream terminal safety live in chatStore, outside the composer module graph. Recommended hybrid: manualChunks rule + eager import() preload kicked off after first paint. Measured evidence: gzip -c index-ClcNLzNP.js = 280946 B; npx esbuild --minify totals for the imported tiptap/pm dists = 350,749 B.

---

## #32 [bundle-startup] Electron cold start fully serializes: no window is shown until the forked backend passes its health poll

- **位置**: `electron/main.ts:773`
- **影响**: low | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every packaged-app launch (cold start); pays the full backend boot latency before any UI appears.

**机制**:

app.whenReady() does `const backendPort = await startBackend()` → fork + `await waitForBackend(port)` (150ms retry poll, main.ts:264) → `await installDevExtensions()` → `await createWindow(backendPort)`. In packaged prod the renderer loads from the backend origin so the *navigation* must wait for Express listen, but window creation itself does not: the user stares at nothing (no window, no splash) for the entire backend boot — node startup + initDb/migrations + recoverInterruptedTurns + runtime registration (server.ts:103-207) — before the BrowserWindow even exists. Backend-side is already well-pipelined (warm() fires before app.listen and is not awaited, server.ts:228-235), so the remaining serial wait is Electron-side window creation.

**修复建议**:

Create the BrowserWindow (hidden or with a lightweight splash/background matching the theme) in parallel with startBackend(), then loadURL once waitForBackend resolves — i.e. `const winP = createWindowShell(); const port = await startBackend(); await navigate(winP, port)`. Perceived launch latency drops by the entire backend boot duration; actual readiness unchanged.

**验证者笔记**:

Mechanism verified exactly as cited: electron/main.ts:773-776 serializes `await startBackend()` → `await installDevExtensions()` → `await createWindow(backendPort)` inside app.whenReady, and startBackend (main.ts:366-385) forks the backend then blocks on waitForBackend's 150ms /api/health poll (main.ts:264-282). No BrowserWindow, splash, or any visible surface exists during this wait — createWindow itself uses show:false + ready-to-show (main.ts:471, 520-523), so the user sees nothing until backend listen + renderer load complete. No mitigation found: installDevExtensions is a prod no-op but window creation is still strictly after backend health. The claim is also honest about scope: backend is already well-pipelined (warm() not awaited before listen, server.ts:232-240; /api/health responds unconditionally at listen, server.ts:418-420; auth migrations fire-and-forget post-listen), so the gated latency is only node cold start + sync initDb/recoverInterruptedTurns/loadAgentConfig/runtime registration (server.ts:103-210) — likely sub-second to ~1s per cold launch, consistent with the self-assessed "low" impact. Trigger (every packaged cold start) is accurate. Impact "low" is fair, so CONFIRMED rather than OVERSTATED.

**补充证据 / fix 安全检查**:

Key code: main.ts:773-776 `const backendPort = await startBackend(); resolvedBackendPort = backendPort; await installDevExtensions(); await createWindow(backendPort);`; main.ts:377 `await waitForBackend(port)`; main.ts:264 `setTimeout(attempt, 150)`; main.ts:471/520-523 `show: false` + `win.once('ready-to-show', () => { win.show(); })`; server.ts:418-420 health returns 200 at listen regardless of warm; server.ts:234 warmPromise not awaited before app.listen (server.ts:494). Fix sanity-check: parallel window-shell creation is safe w.r.t. the documented invariants (nodesRef single-writer, composer wire-stability, per-tree pane maps, stream terminal safety — all renderer-side state, untouched by main-process window timing). Caveats on the fix: (1) the "hidden window" variant saves ~nothing since ready-to-show still gates visibility on the backend-origin loadURL — only an early-SHOWN themed splash removes the backend boot from perceived latency, so "drops by the entire backend boot duration" applies only to that variant; (2) under VIBRANCY_ENABLED backgroundColor is '#00000000' (main.ts:487-493), so an early-shown empty window renders as a frosted empty pane rather than a themed splash — needs a real splash surface; (3) startBackend can throw after the 15s waitForBackend timeout (main.ts:380-384), so an early-shown window needs an error state instead of today's silent no-window failure; (4) createWindow's null-port loadFile fallback (main.ts:586-593) means navigation target selection must be deferred until the port resolves. Also note installDevExtensions is `if (!isDev) return` (main.ts:731), so it contributes zero to packaged cold start — the claim's inclusion of it in the serial chain is technically true but irrelevant in prod.

---

## #33 [chrome-sidebar] Every composer keystroke is a structural dispatch that re-runs all sidebar/topbar structural selectors

- **位置**: `frontend/src/state/chatStore.tsx:1936`
- **影响**: medium | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every keystroke in any chat composer (the primary typing surface). Cost scales with workspace size: with 50+ threads and 1000+ nodes each keystroke pays O(threads×edges + rows×nodes) selector work on the main thread.

**机制**:

setComposerDraft dispatches 'set-composer-draft' (chatStore.tsx:1936-1941). That action is NOT in HIGH_FREQ_ACTIONS (chatStore.tsx:156-160: only chunk/thought/heartbeat/tool-call/... are), so dispatch() bumps structureVersionRef and calls setNodes(next) synchronously (dispatch body: `if (!HIGH_FREQ_ACTIONS.has(a.type)) { structureVersionRef.current += 1; } ... setNodes(next)`). On commit, the structural channel fires (chatStore.tsx:718-722) and EVERY useStructuralSelector subscriber re-executes its selector: each ThreadRow's treeHasUnread (O(edges)), each WorkspaceRow's nodeStatuses/wsUnread/unreadTreeIds (O(all nodes)), Topbar's selectUnreadTotal + trashGroupCount + archivedCount (3× O(all nodes)), TerminalShell's two selectors, Map's streamingIds if open. The keystroke source is MentionEditor onUpdate → persistComposerDraft with no debounce (MentionEditor.tsx:501-504, TPane.tsx:373-390).

**修复建议**:

Add 'set-composer-draft' to HIGH_FREQ_ACTIONS (composerDraft is not read by any structural selector — verified no useStructuralSelector touches composerDraft; TPane reads it via useChatNode which is notified on the RAF-coalesced commit anyway), and extend chatReducers.structural.test.ts to sample it. Alternatively/additionally debounce persistComposerDraft in TPane (~150ms trailing) so the store write is not per-keystroke at all.

**验证者笔记**:

Mechanism is fully confirmed at every cited location, but the per-keystroke cost is wasted selector CPU (sub-millisecond to low-millisecond even at the claimed scale), not cascading re-renders, so "high" is generous; this is a solid medium.

CONFIRMED mechanism, step by step against the current tree:
1. Keystroke path has no debounce on desktop: MentionEditor.tsx:501-504 TipTap `onUpdate` → `onChange(draft)` per document update; TPane.tsx:1954 `onChange={setDraft}`; TPane.tsx:373-390 `setDraft` → `persistComposerDraft` → `setComposerDraft(nodeId, {...})` with no debounce/throttle. (Mobile ChatScreen.tsx:95-100 DOES debounce 250ms with local state — desktop TPane does not.)
2. chatStore.tsx:1936-1941 dispatches `'set-composer-draft'`. HIGH_FREQ_ACTIONS (chatStore.tsx:156-159) is exactly `chunk, thought, heartbeat, tool-call, tool-call-update, plan, subagent-list-update, subagent-tool-activity, apply-seq` — no `set-composer-draft`.
3. dispatch (chatStore.tsx:829-831, 844-846): non-HIGH_FREQ → `structureVersionRef.current += 1` and synchronous `setNodes(next)` (no RAF coalescing). The reducer also does an O(N) map spread per keystroke (chatReducers.ts:1174 `return { ...nodes, [action.nodeId]: updated }`) and the commit effect runs the O(N) `notifyChangedNodeSubscribers` diff (chatStore.tsx:632-648, 712).
4. Commit effect chatStore.tsx:718-722: version advanced → `structureSubscribersRef.current.forEach((l) => l())`. useStructuralSelector's getSnapshot (chatStore.tsx:2877-2888) is version-keyed, so every subscriber re-executes its selector body once per keystroke: ThreadRow.tsx:82-83 `treeHasUnread` (rebuilds a childrenOf Map over all branch edges per row, sidebarSelectors.ts:221-249); WorkspaceRow.tsx:203-215 `nodeStatuses` builds a full Record over ALL nodes per workspace row plus an O(N) equality compare; WorkspaceRow.tsx:216 `wsUnread`; Topbar.tsx:86-87 `selectUnreadTotal` O(all nodes), Topbar.tsx:237/245 trash/archived counts O(all nodes), plus paneTitles/Statuses/Kinds/Widths (104-118); TerminalShell.tsx:105,112. No mitigation exists for this action type — the June-2026 structural-channel work is precisely what this action fails to opt into.

Why OVERSTATED rather than CONFIRMED-high:
- The equalityFn/Object.is short-circuit in useStructuralSelector means these selectors return unchanged values while typing, so NO component re-renders result — the cost is pure selector execution + allocations (the claim words this correctly, but the impact grade prices it like render work).
- Magnitude at the stated scale (1000 nodes, 50 threads, ~10 workspaces): ~10-15 linear O(N) scans plus a handful of edge-map builds ≈ tens of thousands of object touches and some Record/Map allocations per keystroke — realistically ~0.5-2ms plus GC pressure. Typing at ~5-10 Hz, this is wasted main-thread work on the most latency-sensitive path, but it is unlikely to be the dominant keystroke cost (the full TPane re-render per keystroke via useChatNode is inherent and larger).
- Minor overreach in the claim: WorkspaceRow's `unreadTreeIds` selector body is gated on `forceExpand` and returns null otherwise (WorkspaceRow.tsx:220-224), and visible ThreadRows are capped by THREAD_PREVIEW_LIMIT=5 per workspace unless expanded (WorkspaceRow.tsx:18,240), so "each of 50+ ThreadRows" only holds with expanded/filter views.

**补充证据 / fix 安全检查**:

Fix sanity check — adding 'set-composer-draft' to HIGH_FREQ_ACTIONS is sound and safe against the documented invariants:
(a) Structural invariant: composerDraft is NOT in STRUCTURAL_FIELDS (chatReducers.structural.test.ts:16-20: status, kind, title, deletedAt, pinnedAt, markedReadAt, seenMessageIds, paneWidth, digest, lastAssistantAt, viewedAt, deletionGroupId), and the reducer case (chatReducers.ts:1166-1175) never changes map shape (same keys; returns `nodes` unchanged if node missing or draft equal). I verified no useStructuralSelector reads composerDraft — consumers are TPane via useChatNode (TPane.tsx:343,366-371), mobile ChatScreen via useChatNodesSnapshot, chatHydration, and workspacePersistence.ts:300 (persistence reads committed `nodes`, which still flips on the RAF commit, so drafts still persist).
(b) nodesRef single-writer: unaffected — dispatch still updates nodesRef synchronously before the RAF (chatStore.tsx:826-827); the commit effect never writes nodesRef back.
(c) Wire-stability of the composer: MentionEditor guards the external→editor re-sync with lastSyncedRef (MentionEditor.tsx:514-523), so the up-to-one-frame RAF delay in the props round-trip cannot setContent or move the caret; TipTap holds its own document state.
(d) Stream terminal safety: untouched — done/error stay non-HIGH_FREQ.
(e) One consequence to note: with RAF coalescing, a set-composer-draft dispatched right before something that reads React state (not nodesRef) sees the value one frame late; all in-repo synchronous readers use nodesRef (e.g. openPaneBindingsKey chatStore.tsx:965-970), so this is fine.
The alternative fix (150ms trailing debounce of persistComposerDraft in TPane) is riskier than claimed: TPane:1561 clears the draft on send via setComposerDraft(nodeId, null); an uncancelled trailing debounce could resurrect the just-cleared draft after submit, and pane close/unmount within the window could drop final characters unless flushed. Mobile's precedent (ChatScreen 250ms debounce over local state) handles this by keeping a local controlled value; the HIGH_FREQ_ACTIONS route is the cleaner fix. The reviewer's suggestion to extend chatReducers.structural.test.ts with a set-composer-draft sample is required — the test is parameterized over HIGH_FREQ_ACTIONS members (chatReducers.structural.test.ts:76-95).

---

## #34 [chrome-sidebar] Sidebar rebuilds the edge adjacency map O(edges) per row per render (treeHasUnread, buildTree, subtreeOpenState)

- **位置**: `frontend/src/state/sidebarSelectors.ts:221`
- **影响**: medium | **工作量**: M | **验证**: OVERSTATED
- **触发**: Every WorkspaceTree render (any change to projectsValue: focus click, pane open/close, selection, tree touch on user-send/done) and every structural dispatch. With 50 threads and a few hundred edges this is tens of thousands of Map inserts per render.

**机制**:

Three walkers each rebuild a childrenOf Map from the project's full edge list on every call: treeHasUnread (sidebarSelectors.ts:229-237), subtreeOpenState (sidebarSelectors.ts:110-117), and buildTree (tree.ts:43-50). ThreadRow calls treeHasUnread inside an INLINE-closure useStructuralSelector (ThreadRow.tsx:82-84) — inline identity change clears the version cache every render (per the hook's own remarks, chatStore.tsx:2868-2872), so the O(edges) rebuild runs on every ThreadRow render AND every structural tick. WorkspaceRow's renderThread additionally calls buildTree(tree.rootNodeId, edges) per displayed tree (WorkspaceRow.tsx:629) and getSubtreeOpenState per tree (WorkspaceRow.tsx:631), and the collapsed-workspace bar reduces getSubtreeOpenState over ALL liveTrees (WorkspaceRow.tsx:274-282) — each call rebuilding the same adjacency map. Net: O(trees × edges) per sidebar render.

**修复建议**:

Build the branch-edge childrenOf Map ONCE per project (useMemo keyed on project.edges) in WorkspaceTree and thread it down to treeHasUnread/subtreeOpenState/buildTree as a parameter (change their signatures to accept a prebuilt Map). Wrap the ThreadRow/WorkspaceRow structural selectors in useCallback so the version cache actually short-circuits between structural ticks.

**验证者笔记**:

Every cited mechanism is real in the current tree: treeHasUnread (sidebarSelectors.ts:230-237), subtreeOpenState (sidebarSelectors.ts:110-117), and buildTree (tree.ts:43-50) each rebuild a childrenOf Map from the project's full edge list on every call; ThreadRow.tsx:82-84 passes an inline closure to useStructuralSelector, and chatStore.tsx:2868-2872 confirms inline identity change nulls the version cache, so the O(edges) walk re-runs on every ThreadRow render; WorkspaceRow.tsx:629/631 run buildTree + getSubtreeOpenState per displayed tree and WorkspaceRow.tsx:274-282 reduce getSubtreeOpenState over ALL liveTrees when the workspace is collapsed (and subtreeOpenState builds the map before its streaming short-circuit). However the "high" impact is overstated on two counts. (1) The hot-path exposure is weaker than implied: useStructuralSelector subscribes to the structural channel and keys on the structure version, which HIGH_FREQ chunk actions do not advance — so streaming SSE chunks do NOT drive these rebuilds; the only per-chunk exposure is the single ThreadRow whose root node is streaming (useChatNode at ThreadRow.tsx:80), one O(edges) rebuild per commit. (2) Expanded workspaces cap displayed ThreadRows at THREAD_PREVIEW_LIMIT=5 (WorkspaceRow.tsx:18,240), so "per row × 50 threads" doesn't materialize for the ThreadRow path; the genuine O(trees×edges) case is the collapsed-workspace bar and forceExpand unread-filter mode. Net worst case at the stated scale (50 trees, few hundred edges, several collapsed workspaces) is ~1-5ms of main-thread Map churn per sidebar render, triggered by discrete user/structural actions (send/done touching lastActiveAt, focus, pane open/close) — wasteful and worth fixing, but not per-keystroke, not per-chunk, and not jank-level. Medium, not high.

**补充证据 / fix 安全检查**:

Fix sanity check: sound and safe. Memoizing one branch-edge adjacency Map per project (keyed on project.edges) and passing it to treeHasUnread/subtreeOpenState/buildTree collapses O(trees×edges) → O(edges); wrapping the ThreadRow/WorkspaceRow selectors in useCallback restores the version-cache short-circuit documented at chatStore.tsx:2852-2856. None of the documented invariants are at risk — these are pure read-only derived selectors (no nodesRef writes, no composer/wire path, no pane-map or stream-lifecycle involvement). Two implementation caveats: (a) buildTree currently applies isAlive at map-build time (tree.ts:46) while treeHasUnread applies no aliveness filter — a shared prebuilt map must defer alive-filtering to traversal so treeHasUnread semantics (sidebarSelectors.unread.test.ts) are preserved; (b) useCallback on the ThreadRow selector only short-circuits if projectEdges is referentially stable, and ThreadRow.tsx:81 `projects.find(...)?.edges ?? []` allocates a fresh [] fallback each render — needs a module-level EMPTY constant. Additional adjacent (unclaimed) cost observed: WorkspaceRow.tsx:203-215 nodeStatuses selector is also an inline closure that iterates ALL nodes per workspace row per render — same class of issue, would benefit from the same useCallback treatment.

---

## #35 [chrome-sidebar] WorkspaceRow builds a full status Record over ALL nodes (global, not project-scoped) per workspace row

- **位置**: `frontend/src/components/terminal/WorkspaceRow.tsx:203`
- **影响**: medium | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every sidebar render and every structural dispatch (which, per finding 1, currently includes every composer keystroke). With 5 workspaces × 1000 nodes = 5000 entries + 5000 comparisons per tick per pass.

**机制**:

nodeStatuses selector iterates Object.entries(ns) over the entire nodes map and materializes a fresh Record for every node in every workspace, then the equality fn does another O(N) key walk (WorkspaceRow.tsx:203-215). This runs per WorkspaceRow (so W workspaces × N total nodes), and because the selector is an inline closure the useStructuralSelector cache is invalidated on every render, making it run per render, not just per structural change. It also always returns a new Record reference, so `(a,b)` deep-compare is the only thing preventing re-render — the allocation itself is unavoidable per run.

**修复建议**:

Scope the selector to the workspace: iterate project.chatIds instead of all nodes (statuses of other workspaces' nodes are irrelevant to this row's open-state bar), and wrap in useCallback([project.chatIds]) so the structural-version cache holds between ticks. Even better: only collect ids whose status !== 'idle' into a small Set.

**验证者笔记**:

Every element of the claimed mechanism checks out in the current tree. (1) WorkspaceRow.tsx:203-215 builds a fresh Record over the GLOBAL nodes map (`for (const [id, n] of Object.entries(ns)) result[id] = n.status`) with an O(N) equality fn — the selector receives store.getNodes(), never project-scoped data. (2) The selector is an inline closure, and useStructuralSelector (chatStore.tsx:2868-2872) explicitly nulls its version cache when selector identity changes; the hook's own docstring (chatStore.tsx:2852-2855) warns callers to useCallback-wrap selectors, which WorkspaceRow does not. So every WorkspaceRow render re-runs the O(N) body even when the structure version is unchanged. (3) The per-keystroke trigger is real: 'set-composer-draft' is NOT in HIGH_FREQ_ACTIONS (chatStore.tsx:156-159), MentionEditor.tsx:501-504 fires onChange per ProseMirror transaction with no debounce, TPane.tsx:1954 wires it straight to setComposerDraft → dispatch, and chatStore.tsx:829-830 bumps structureVersionRef on every non-high-freq action, firing all structural subscribers (chatStore.tsx:718-722). The reducer (chatReducers.ts:1166) produces a new nodes ref while typing so the prev===next early-return at chatStore.tsx:710 never saves it. (4) One WorkspaceRow per project (WorkspaceTree.tsx:701), so cost multiplies W×N as claimed. The June-2026 structural channel does shield this from per-SSE-chunk traffic (chunks don't bump the version) — but the claim correctly limited itself to structural dispatches/keystrokes, so it is not already-mitigated for the stated trigger. Impact 'medium' is fair at the audit's stated scaling targets (per-keystroke O(W×N) iteration + W fresh N-key Record allocations + GC pressure on the composer critical path; sub-ms at 5×1000 but low-ms with allocation churn at 20 rows × 5000 nodes); it would be low at small scale, which the claim's own arithmetic makes transparent.

**补充证据 / fix 安全检查**:

Key excerpts: WorkspaceRow.tsx:203-215 `const nodeStatuses = useStructuralSelector((ns) => { const result: Record<string, ChatNodeState['status']> = {}; for (const [id, n] of Object.entries(ns)) result[id] = n.status; return result; }, (a, b) => { const ak = Object.keys(a); if (ak.length !== Object.keys(b).length) return false; ... })` — inline, global-map, O(N) compare. chatStore.tsx:2868 `if (selectorRef.current !== selector) { lastRef.current = null; }` confirms per-render cache invalidation for inline selectors. chatStore.tsx:156-159 HIGH_FREQ_ACTIONS = {chunk, thought, heartbeat, tool-call, tool-call-update, plan, subagent-list-update, subagent-tool-activity, apply-seq} — 'set-composer-draft' absent, so chatStore.tsx:829-830 bumps the structure version per keystroke and chatStore.tsx:718-722 notifies all structural subscribers. MentionEditor.tsx:501-504 onUpdate → onChange(draft) per transaction, no debounce; TPane.tsx:1954 onChange={setDraft} → TPane.tsx:373-381 setComposerDraft dispatch. FIX SANITY CHECK: the proposed fix is sound and safe. project.chatIds covers all of the workspace's nodes; getNodeOpenState (WorkspaceRow.tsx:259-263) only looks up ids in this row's trees and already defaults missing ids to 'idle'. useCallback([project.chatIds]) is correct because status changes invalidate via the version bump, not selector identity. No documented invariant is at risk: the fix is read-side only (nodesRef single-writer untouched), doesn't touch composer wire format (mentionDoc), per-tree pane maps, or stream terminal-safety paths. Note the sibling selectors wsUnread (WorkspaceRow.tsx:216-218) and unreadTreeIds (220-232) are also inline closures with the same per-render cache-bust and would benefit from the same useCallback treatment. Minor caveat on the claim: WorkspaceRow does not necessarily RE-RENDER per keystroke (equality fn suppresses that); it is the selector+equality WORK that runs per keystroke per row, which is what the claim priced.

---

## #36 [chrome-sidebar] Map page: visibleMapNodeIds runs findTreeIdForNode per chatId, rebuilding the parentOf map O(N×E)

- **位置**: `frontend/src/components/terminal/pages/mapVisibility.ts:22`
- **影响**: medium | **工作量**: S | **验证**: CONFIRMED
- **触发**: While the Map page is open: every structural store commit and every workspace/selection change. Scales quadratically with workspace size.

**机制**:

visibleMapNodeIds filters project.chatIds and calls findTreeIdForNode(id, project) for each id (mapVisibility.ts:21-26). findTreeIdForNode rebuilds the full child→parent Map from project.edges on EVERY call (tree.ts:114-118) and then walks ancestors. So the pre-layout pass is O(chatIds × edges) — with 500 nodes / 500 edges that is ~250k Map inserts before dagre even starts. This memo re-fires whenever nodesSnapshot identity changes while Map re-renders (any structural commit: title set, done, pane focus), and it feeds liveSet → branchChildren/graphChildren → treeSummaries → layout, cascading into a full per-tree dagre re-layout (Map.tsx:227-246).

**修复建议**:

In visibleMapNodeIds, build the parentOf map once and resolve each node's root by walking with memoized root-per-node results (union-find style caching), turning the pass into O(N+E). Optionally add a findTreeIdForNode overload accepting a prebuilt parentOf Map so other hot callers (WorkspaceTree reveal effect, dispatch's touch-tree at chatStore dispatch NODE_ACTIVITY block) can share it.

**验证者笔记**:

Mechanism verified at every cited location in the current tree. mapVisibility.ts:21-26 calls findTreeIdForNode(id, project) inside project.chatIds.filter(...). tree.ts:114-118 rebuilds the child→parent Map from project.edges on EVERY call, and additionally does an O(trees) project.trees.find() at each step of the ancestor walk (tree.ts:122-127), so the pass is O(chatIds × edges) or worse — the 250k-inserts estimate for 500 nodes/500 edges is honest, if anything slightly understated. No mitigation exists: no caching in mapVisibility, no prebuilt-parentOf overload anywhere (all ~20 findTreeIdForNode call sites rebuild). Trigger claim is accurate and correctly scoped: Map.tsx:140-143 keys the memo on [activeProject, nodesSnapshot]; useChatNodesSnapshot (chatStore.tsx:2780-2784) is a non-subscribing raw store.getNodes() read, so the memo re-fires on any Map re-render after any dispatch advanced nodesRef. Pure streamed-chunk commits do not re-render the Map (HIGH_FREQ actions keep the structural version still, chatStore.tsx:829-841, and streamingIds uses useStructuralSelector), so the claim's "every structural store commit while Map open" — tool-call, title, done, status flips, selection/workspace changes — is the right characterization, not per-chunk. The cascade claim is also real: liveIds is produced by .filter() so it gets a fresh array identity every recompute even with identical contents, invalidating liveSet → branchChildren/graphChildren → treeSummaries → the per-tree dagre layout memo (Map.tsx:202-312, dagre.layout at :246). Impact "medium" is fair: cost only accrues while the lazily-mounted Map page is open (TerminalShell.tsx:17,:484), but at 500+ nodes each structural commit during an active stream burns tens of ms of pre-layout work plus a full dagre re-layout on the main thread.

**补充证据 / fix 安全检查**:

Key excerpts: tree.ts:114-118 `const parentOf = new Map<string, string>(); for (const e of project.edges) { if (e.kind !== undefined && e.kind !== 'branch') continue; parentOf.set(e.target, e.source); }` — rebuilt per call; also tree.ts:124 `const matched = project.trees.find((t) => t.rootNodeId === cur)` inside the walk loop adds an O(trees) factor per ancestor hop that the claim didn't even count. mapVisibility.ts:24 `const treeId = findTreeIdForNode(id, project);` inside chatIds.filter. Map.tsx:140-143 memo on [activeProject, nodesSnapshot] where nodesSnapshot = useChatNodesSnapshot() = raw store.getNodes() (chatStore.tsx:2780-2784, no subscription — fresh identity whenever nodesRef advanced between renders). Cascade confirmed: Map.tsx:145 liveSet, :147-169 branchChildren/graphChildren, :171-194 treeSummaries, :202-312 layout with dagre.layout(g) at :246. FIX SANITY-CHECK: the proposed O(N+E) rewrite (build parentOf once, memoize per-node root resolution) would genuinely help and is pure-function work — mapVisibility.ts and tree.ts have no side effects, so none of the documented invariants (nodesRef single-writer, composer wire-stability, per-tree openPanes/focusedPane maps, stream terminal safety) are at risk. A findTreeIdForNode overload taking a prebuilt parentOf Map is also safe and would benefit other hot callers (chatStore.tsx:66-67 touch-tree per dispatch, useLazyTreeMessages.ts:58, WorkspaceTree.tsx:340/503). CAVEAT for the fixer: speeding up visibleMapNodeIds alone does NOT stop the dagre cascade — liveIds still gets a fresh .filter() array identity on every recompute, re-firing all downstream memos including dagre.layout. To capture most of the win, also stabilize liveIds identity (return the previous array when shallow-equal, or hoist it into a useNodesSelector with shallowArrayEqual which already exists at chatStore.tsx:2895).

---

## #37 [chrome-sidebar] Sidebar rows are unmemoized — every projectsValue change re-renders the whole workspace/thread tree

- **位置**: `frontend/src/components/terminal/WorkspaceTree.tsx:836`
- **影响**: medium | **工作量**: M | **验证**: CONFIRMED
- **触发**: Every pane focus change, pane open/close, selection toggle, message turn start/end (touch-tree), agent status heartbeat. In a 5-workspace / 50-thread sidebar this is hundreds of row renders per interaction.

**机制**:

WorkspaceRow, ThreadRow, and the renderThread helper are plain functions/components without React.memo (WorkspaceRow.tsx:112, ThreadRow.tsx:65). WorkspaceTree subscribes via useChatProjects, whose memo re-fires on ANY of: projects (touched by 'touch-tree' on every user-send/done via NODE_ACTIVITY_ACTIONS, chatStore.tsx:848-860), focusedPane/focusedNodeId (every pane focus click), selection, openPanes, agentStatus, etc. (chatStore.tsx:2292-2342). Each such change re-renders every workspace row, every thread row, and every expanded branch row — and because the structural selectors inside them are inline closures (findings 2/3), the re-render also re-executes all the O(E)/O(N) derivations rather than hitting the version cache.

**修复建议**:

Memoize the actions object with useMemo in WorkspaceTree, convert the per-project inline predicate props to stable useCallback refs (they already read prefs via closures — pass prefs.sidebarExpanded down as a value instead), then wrap WorkspaceRow/ThreadRow/BranchRow in React.memo. This confines a focus-change re-render to the two affected rows.

**验证者笔记**:

Every load-bearing element of the claim checks out in the current tree. (1) WorkspaceTree subscribes via useChatProjects (WorkspaceTree.tsx:61-70), and projectsValue (chatStore.tsx:2292-2342) re-fires on projects/openPanes/focusedPane/focusedNodeId/selection/treeSelection/agentStatus changes. (2) NODE_ACTIVITY_ACTIONS ('user-send','done','error','set-title','set-follow-ups',… per chatReducers.ts:13-24) trigger setProjects via touch-tree at chatStore.tsx:848-860, so every turn start/end changes projects identity and re-renders the whole sidebar. (3) WorkspaceRow (WorkspaceRow.tsx:112), ThreadRow (ThreadRow.tsx:65), and BranchRow (BranchRow.tsx:45) are plain unmemoized function components; WorkspaceTree.tsx:836 maps renderProject inline with a fresh actions object literal (725-758) and fresh inline predicate lambdas (710-719). (4) The cache-bust claim is real: useStructuralSelector clears its version cache when selector identity changes (chatStore.tsx:2868-2872), and WorkspaceRow/ThreadRow pass inline closures — nodeStatuses (WorkspaceRow.tsx:203-215) does Object.entries over the ENTIRE nodes map (O(N)) per workspace row per render; treeHasUnread/unreadTreeIds/wsUnread and buildTree/subtreeOpenState (WorkspaceRow.tsx:629,631,274-282) each rebuild edge adjacency maps O(E) per thread per render. The impact estimate is honest: it correctly avoids claiming per-chunk cost (chunk is HIGH_FREQ; projectsValue deps exclude nodes, so streaming does not wake the sidebar) and pegs the trigger at discrete interactions. At 5 workspaces/50 threads/1000+ nodes this is real multi-ms main-thread work on every focus click and turn boundary — medium is fair. Minor inaccuracies that do not change the verdict: there is no agentStatus "heartbeat" (it loads once with retry + on explicit reload events, chatStore.tsx:359-474), and THREAD_PREVIEW_LIMIT=5 caps visible unpinned thread rows per workspace (though the O(N)/O(E) selector work runs regardless of row visibility).

**补充证据 / fix 安全检查**:

Fix sanity-check: the proposed fix is directionally right but INCOMPLETE as stated. React.memo on the rows would be bypassed because the rows subscribe to the same context themselves: WorkspaceRow.tsx:193 `const { projects, openPanes, focusedPane } = useChatProjects();`, ThreadRow.tsx:77 `const { treeSelection, focusedNodeId, projects } = useChatProjects();`, BranchRow.tsx:73 `const { focusedNodeId } = useChatProjects();`. Any projectsValue identity change re-renders them via their own subscription regardless of memoized props — confining a focus change to two rows requires also narrowing these subscriptions (split contexts or selector-style hooks) and stabilizing the inline useStructuralSelector closures (the hook's own @remarks at chatStore.tsx:2852-2855 warns identity must be stable for the version cache to work; WorkspaceRow.tsx:203-232 and ThreadRow.tsx:82-84 violate this today). Also note ThreadRow.tsx:81 does `projects.find(...)` per row per render (O(P)) just to get edges, and getNodeOpenState (WorkspaceRow.tsx:259-263) depends on openPanes/focusedPane/nodeStatuses so it changes identity on every focus click, cascading into getSubtreeOpenState. No documented invariants are at risk from the fix: it touches only sidebar render plumbing — nodesRef single-writer (dispatch at chatStore.tsx:826-827), composer wire-stability, per-tree pane maps, and stream terminal safety are unrelated code paths. One caution: if prefs.sidebarExpanded is passed down as a value for memoized predicates, ensure toggles still propagate (they will, since the prop identity changes on setPref).

---

## #38 [chrome-sidebar] Topbar computes trash/archived group counts over all nodes on every structural tick, on every page

- **位置**: `frontend/src/components/terminal/Topbar.tsx:237`
- **影响**: low | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every structural dispatch and every Topbar re-render (focus changes, sidebar resizing flag flips), regardless of current page. O(total nodes) each, ~3× per tick.

**机制**:

trashGroupCount and archivedCount are useStructuralSelector calls that iterate Object.values(nodesMap) building Sets of deletionGroupIds (Topbar.tsx:237-251). They are unconditional — computed even when page !== 'trash'/'archived' where their output is unused (only rendered at Topbar.tsx:545/555 behind page checks). Both are inline closures, so they also re-run on every Topbar render (pane focus, sidebar resize state, scroll-sync state changes), not just structural ticks. Together with selectUnreadTotal (Topbar.tsx:86-88, also O(N) over all nodes) that is 3 full-map scans per tick.

**修复建议**:

Gate the selectors on page: `useStructuralSelector(useCallback((ns) => page === 'trash' ? countTrash(ns) : 0, [page]))` (returning a constant when unused short-circuits via Object.is), and wrap all three topbar count selectors in useCallback so the structural version cache holds across unrelated Topbar re-renders.

**验证者笔记**:

Mechanism verified exactly as claimed: Topbar.tsx:237-243 and 245-251 compute trashGroupCount/archivedCount via unconditional useStructuralSelector calls that iterate Object.values(nodesMap) building Sets, while their output is only rendered behind page === 'trash' (Topbar.tsx:537) / page === 'archived' (Topbar.tsx:547) checks. Both selectors (plus unreadTotal at Topbar.tsx:86-88, backed by selectUnreadTotal's for-in over all nodes at sidebarSelectors.ts:208-215) are inline closures, and the hook's own implementation (chatStore.tsx:2868-2872) nulls the version cache whenever selector identity changes — its @remarks (chatStore.tsx:2852-2855) explicitly tells callers to wrap inline lambdas in useCallback, which Topbar does not do. So all three O(N) scans re-run on every Topbar render (focus changes, sidebarResizing flips, openPanes changes) in addition to every structural tick, on every page. Critically, the claim is honest about what it is NOT: it does not claim per-SSE-chunk cost, and I verified streaming commits keep structureVersion still (chatStore.tsx:717-722) and Topbar has no per-chunk subscription, so per-chunk cost is genuinely zero. The stated impact "low" is fair: 3 field-check scans over even several thousand nodes is sub-millisecond per occurrence. The proposed fix (page-gate inside useCallback-wrapped selectors, constant return off-page short-circuiting via Object.is) is correct, restores the version cache across unrelated renders, and touches no documented invariant (read-only selector; nodesRef single-writer, composer wire format, per-tree pane maps, and stream terminal safety are all unaffected). unreadTotal cannot be page-gated (badge always visible) but benefits from useCallback([focusedNodeId]).

**补充证据 / fix 安全检查**:

Topbar.tsx:237 `const trashGroupCount = useStructuralSelector((nodesMap) => { const gids = new Set<string>(); for (const n of Object.values(nodesMap)) { if (n.deletionGroupId && !isArchiveGroupId(n.deletionGroupId)) gids.add(n.deletionGroupId); } return gids.size; });` — inline closure. chatStore.tsx:2868-2872: `if (selectorRef.current !== selector) { lastRef.current = null; }` confirms cache defeat per render; chatStore.tsx:2853-2855 remarks: "Wrap inline lambdas with useCallback". Streaming exemption confirmed: chatStore.tsx:716-722 only notifies structure subscribers when `structureVersionRef` advanced, so no per-chunk re-run. Additional unconditional Topbar renders come from `sidebarResizing` state (Topbar.tsx:139, flipped at drag start/end only) — scroll sync (Topbar.tsx:141-154) writes scrollLeft via ref, no setState. Minor extra: Topbar.tsx:244 `projects.filter((p) => p.deletedAt)` also runs unconditionally every render (O(projects), trivial). Fix sanity: page-gated useCallback selectors are safe — one-time cache clear on page change, Object.is short-circuit off-page; no interaction with nodesRef single-writer, composer wire-stability, per-tree openPanes/focusedPane maps, or done/error stream termination. paneTitles/paneStatuses/paneKinds/paneWidths (Topbar.tsx:104-121) are also inline closures with the same cache-defeat, but only O(openPanes) — worth folding into the same useCallback cleanup.

---

## #39 [memory-longsession] applyTurnEvent recomputes full-answer sentinel strip on every chunk (O(L²) per turn, frontend main thread AND backend event loop)

- **位置**: `shared/src/turnProjection.ts:387`
- **影响**: medium | **工作量**: S | **验证**: OVERSTATED
- **触发**: Every SSE chunk of every streaming turn (typically 20-60/s). Cost grows linearly with accumulated answer length, so a long 50k-char reply pays ~50KB of throwaway string allocation + a full scan per chunk near the end — sustained GC pressure exactly when the UI is busiest.

**机制**:

The shared projector's 'chunk' case does `content: answerContent(blocks)` where answerContent = join of ALL answer blocks' rawText + stripTurnMetadataSentinels over the full concatenated string (char-by-char scan, turnProjection.ts:365-369, 180+). Each chunk therefore allocates two full-message-length strings and scans them, so a turn of L chars costs O(L²) total string allocation. This runs twice per chunk: on the backend inside chatHub.append → applyTurnEvent (chatHub.ts:305), and on the frontend inside the 'chunk' reducer → projectAssistantStreamEvent → applyTurnEvent (chatReducers.ts:425, assistantBlocks.ts:147). The frontend adapter's own comment (assistantBlocks.ts:130-136) says the returned content is 'discarded entirely' and that computing it per chunk would be 'O(L²) over a streaming turn' — but the shared projector still computes it internally, defeating that optimization.

**修复建议**:

In applyTurnEvent's 'chunk' case, stop recomputing content per chunk: keep `content: ''` (or carry the previous value) during 'active' status and compute it once in the 'done'/'error' cases, which already call finalizeTurnContent(rawAnswer). Backend checkpoints that need visible content can derive it lazily in checkpointTurn from blocks.

**验证者笔记**:

The mechanism is fully confirmed: shared/src/turnProjection.ts:387-393 'chunk' case computes `content: answerContent(blocks)` where answerContent (:365-369) joins all answer-block rawText and runs the char-by-char stripTurnMetadataSentinels (:180-222) over the full accumulated string — O(L²) allocation+scan per turn. It runs per SSE chunk on BOTH sides: frontend chatStreamRunner.ts:156 dispatches 'chunk' per SSE event, chatStore.tsx:826 runs reduceNodes synchronously per dispatch (the rAF coalescing at :836-846 only batches React renders, not reducer work), chatReducers.ts:420-428 → projectAssistantStreamEvent → applyTurnEvent; backend chatHub.ts:305 applies it in append() for every event. The frontend adapter (assistantBlocks.ts:130-136 comment, :148-154 return) explicitly discards the computed content, so the shared projector's internal computation defeats that documented optimization — the irony in the claim is accurate. Backend only consumes content at 1.5s checkpoints (dbRepository.ts:1199 checkpointTurn → writeAssistantSnapshot :1077), so per-chunk computation is throwaway there too. However, 'high' overstates magnitude: I microbenchmarked the actual strip algorithm — a 50k-char strip costs ~0.16ms; the claim's adverse scenario (50k chars, 1000 chunks) totals ~105ms main-thread work and ~50-100MB transient string allocation per side spread across the entire multi-second turn (~2-5ms/s CPU). Typical 2-5k-char replies cost ~1ms total. Real quadratic on the hottest path, paid twice, but no frame-budget jank in realistic use → medium.

**补充证据 / fix 安全检查**:

Fix sanity-check: the proposed fix is sound. Frontend already discards projected content (assistantBlocks.ts:148-154), so keeping content stale/'' during status==='active' changes nothing there. The 'done'/'error' cases already recompute content via finalizeTurnContent(rawAnswer) (turnProjection.ts:462, :475), so terminal correctness is preserved. Backend checkpoints DO persist content mid-turn (writeAssistantSnapshot dbRepository.ts:1082-1089 writes message.content every ~1.5s via checkpointTurn :1199 and TURN_CHECKPOINT_INTERVAL_MS=1_500 chatHub.ts:75), so the fix must derive answerContent(blocks) lazily at checkpoint time to keep crash-recovery rows identical — computing it 1×/1.5s instead of per chunk. Note: blocks are also persisted at checkpoint and frontend hydration prefers blocks (migrateAssistantToBlocks), so even content='' checkpoints would mostly be tolerated, but lazy derivation is the safe variant. No conflict with documented invariants: nodesRef single-writer untouched (reducer still returns fresh message objects, block element identity preserved for sameBlockRefs memo per cloneBlocks comment assistantBlocks.ts:27-33); composer wire-stability, per-tree pane maps, and stream-terminal safety (done/error still finalize) are all unaffected. Minor claim correction: the per-chunk work is stripTurnMetadataSentinels only (no title/follow-up regexes — those run only at done/error via finalizeTurnContent), slightly cheaper than the adapter comment implies. Benchmark: node microbench of extracted strip: 0.16ms per 50k-char scan; 1000-chunk/50k-char turn = 105ms total, 25M chars scanned per side.

---

## #40 [memory-longsession] Per-SSE-chunk reducer clones the entire nodes record plus the node's whole messages array

- **位置**: `frontend/src/state/chatReducers.ts:423`
- **影响**: low | **工作量**: M | **验证**: OVERSTATED
- **触发**: Every SSE chunk/thought/tool event during streaming (20-60/s), on the main thread, concurrently for each streaming pane in a fanout. Cost scales with total resident node count × per-node message count — exactly the 1000+ message / 50+ thread long-session regime.

**机制**:

The 'chunk' (and thought/plan/tool-call/tool-call-update) cases do `n.messages.map(...)` — an O(#messages) array allocation where only the last element changes — then `return { ...nodes, [action.nodeId]: {...} }` which shallow-copies the Record holding EVERY node of EVERY workspace/tree loaded in the session. With 500+ nodes resident (see finding 3: bodies are never evicted) and a 200-message node, each chunk allocates a ~500-key object + a 200-element array + the node object, all garbage one frame later.

**修复建议**:

For streaming events, replace `.map` with an index-targeted copy (assistant message is almost always last: check tail first, else indexOf, then `msgs = n.messages.slice(); msgs[i] = next`) and consider splitting the flat `nodes` Record into per-project sub-records (or a Map) so the per-chunk spread copies only the active project's keys. The tail-first check alone removes the O(#messages) id comparisons per chunk.

**验证者笔记**:

The mechanism is real and exactly where claimed: chatReducers.ts:423-428 does `n.messages.map(...)` (O(#messages) closure calls + new array) then `{ ...nodes, [action.nodeId]: {...} }` (shallow copy of the whole flat nodes Record), repeated for thought/plan/tool-call/image/tool-call-update at :433, :443, :453, :473, :491. The per-chunk trigger also survives scrutiny: chatStreamRunner.ts:156 dispatches one 'chunk' action per SSE chunk with no coalescing of reducer work — the RAF batching in chatStore.tsx:836-843 only batches React renders (setNodes); `reduceNodes` at chatStore.tsx:826 runs synchronously on every dispatch. In fact it is slightly worse than claimed: `trackSeq` (chatStreamRunner.ts:130-135, called at :154) dispatches an additional 'apply-seq' action per chunk, whose case (chatReducers.ts:393-400) does a second full-Record spread. Nothing mitigates the allocation itself.

However, the impact estimate is not honest for the stated numbers. A shallow spread of a 500-key object plus a 200-1000-element `.map` is tens of microseconds in V8; at 20-60 events/s × 2 dispatches, even a 5-pane fanout totals low-single-digit ms per second of main-thread work plus short-lived minor-GC garbage — well under 1-2% CPU, not user-perceivable, and dwarfed by other per-chunk costs the claim does not mention (see extraEvidence). The genuinely expensive per-chunk work in this same call chain is elsewhere: shared/src/turnProjection.ts:391 recomputes `content: answerContent(blocks)` on every chunk — a join + full `stripTurnMetadataSentinels` scan over the ENTIRE accumulated answer text (O(L) per chunk, O(L²) per turn) — and the frontend adapter (assistantBlocks.ts:148-154) then discards that content entirely. That cost grows with answer length and is 1-2 orders of magnitude larger than the Record spread for long replies. The claimed finding is real but is the small component of the per-chunk profile; as written ("medium") it overstates. Adjusted: low.

**补充证据 / fix 安全检查**:

Confirmed code: chatReducers.ts:423 `const msgs = n.messages.map((m) => m.id === action.assistantId ? projectAssistantStreamEvent(...) : m);` and :428 `return { ...nodes, [action.nodeId]: { ...n, messages: msgs, streamingIdleMs: undefined } };`. Dispatch path unbatched at reducer level: chatStore.tsx:819-846 — `const next = reduceNodes(nodesRef.current, a); nodesRef.current = next;` runs per dispatch; only `setNodes` is RAF-coalesced for HIGH_FREQ_ACTIONS (chatStore.tsx:156-159 includes 'chunk','thought','tool-call','tool-call-update','plan','apply-seq'). Extra per-chunk dispatch: chatStreamRunner.ts:153-156 calls `trackSeq(seq, turnId)` → 'apply-seq' → second `{...nodes,...}` spread at chatReducers.ts:393-400.

Bigger unclaimed cost in the same chain: assistantBlocks.ts:113-155 `projectAssistantStreamEvent` builds a fresh DurableTurnSnapshot per chunk and calls shared applyTurnEvent; turnProjection.ts:387-393 'chunk' case computes `content: answerContent(blocks)` = `stripTurnMetadataSentinels(blocks.map(...).join(''))` (turnProjection.ts:365-369, :180+) — an O(full-answer-length) scan per chunk whose result the frontend return (assistantBlocks.ts:148-154) throws away. The in-code comment at assistantBlocks.ts:130-135 acknowledges avoiding this on the INPUT side but the OUTPUT-side computation still runs. If anyone optimizes this path, that is the item to fix, not the spread.

Fix sanity check: the tail-first index-targeted copy (`slice(); msgs[i] = next`) is safe — it still produces new array/node/record references, so notifyChangedNodeSubscribers' reference-diff (chatStore.tsx:632-648) and the useEffect commit gate (chatStore.tsx:707-723) keep working; it lives entirely inside reduceNodes so the nodesRef single-writer invariant (chatStore.tsx:694-706) is untouched. It saves only the O(#messages) id comparisons, a micro-optimization. The second half of the proposed fix — splitting the flat nodes Record into per-project sub-records — is NOT worth the risk: getNodes()/getNode() consumers, the Object.keys diff in notifyChangedNodeSubscribers, useLazyTreeMessages, deletedIdsKey scan (chatStore.tsx:574-578), and workspacePersistence all assume the flat Record; the win is microseconds while the refactor touches the store's most invariant-laden surface.

---

## #41 [memory-longsession] Lazily-loaded tree message bodies are never evicted — memory grows monotonically with every tree visited

- **位置**: `frontend/src/state/useLazyTreeMessages.ts:38`
- **影响**: low | **工作量**: M | **验证**: OVERSTATED
- **触发**: Long sessions where the user browses many threads: each tree switch adds that tree's entire transcript to resident heap. 50 threads × a few hundred KB–MB of transcript each = tens–hundreds of MB retained until reload, and every retained node also inflates the per-chunk `{...nodes}` spread (finding 2).

**机制**:

useLazyTreeMessages loads a tree's full message bodies on first activation and records the key in `loadedKeysRef` (a Set that only ever grows; deletes only on fetch failure, :85). The 'messages-loaded' reducer installs the bodies (chatReducers.ts:604-610) and no reducer action ever flips a node back to `messagesLoaded: false` or drops `messages` (the only `messages: []` sites are node-creation paths at chatReducers.ts:251/737/810). Pane hibernation unmounts DOM but the state arrays — every ChatMessage with full rawText blocks, tool inputJson/output strings — stay in the chatStore Record forever.

**修复建议**:

Add a `messages-unloaded` action that resets non-active, non-streaming trees' nodes to `messagesLoaded: false, messages: []` (bodies are backend-authored and refetchable — the loader already retries), triggered when the count of loaded trees exceeds a small LRU budget (e.g. 5). Remove the corresponding key from loadedKeysRef so reactivation refetches.

**验证者笔记**:

The core mechanism is real and unmitigated: useLazyTreeMessages.ts:38 loadedKeysRef only grows (delete only on fetch failure :85; comment :17-18 says re-activation is intentionally a cache hit), 'messages-loaded' (chatReducers.ts:604-610 → applyTreeMessages, chatHydration.ts:328-347) installs bodies, and grep confirms no eviction action exists — the only `messages: []` sites are node creation (chatReducers.ts:251/737/810). Pane hibernation unmounts DOM only. So heap does grow monotonically with each tree visited, until reload. But the impact is overstated on two counts. (1) The claimed CPU amplification is false: the per-chunk `{...nodes}` spread (chatReducers.ts:420-428) copies node *references*; placeholder nodes for every workspace already exist after hydration whether or not bodies are loaded, so retained message payloads add zero per-chunk cost — eviction would not shrink the spread. (2) The retention ceiling equals the pre-lazy-load eager baseline: lazy loading (a June-2026 shipped optimization) fixed boot cost; steady-state worst case was always "all transcripts resident". This is a bounded cache-without-LRU, not a leak — bounded by content the user actually visits in one session. Memory-only, no jank, no hot-path work; realistic cost is tens of MB in an Electron renderer for heavy multi-thread sessions, only reaching "hundreds of MB" in speculative extremes. That is a legitimate remaining gap in the shipped lazy-load optimization, but at low impact.

**补充证据 / fix 安全检查**:

Mechanism citations: useLazyTreeMessages.ts:37-38 `const loadedKeysRef = useRef<Set<string>>(new Set());` (delete only at :85 on fetch failure); :49 `if (loadedKeysRef.current.has(key)) return;`; chatReducers.ts:604-610 `case 'messages-loaded': ... return applyTreeMessages(nodes, action.messagesByNode);`; chatHydration.ts:328-347 applyTreeMessages flips `messagesLoaded: true` and syncs messageCount; grep of frontend/src/state finds no 'messages-unloaded'/evict action. Refuted amplification: chatReducers.ts:420-428 chunk case spreads `{...nodes}` (reference copies keyed by node COUNT, which is constant — placeholders exist regardless of body load; chatHydration.ts:567 creates placeholder nodes with messagesLoaded:false for meta rows). Fix sanity-check: (a) FOOTGUN — loadedKeysRef is hook-private; a reducer-only 'messages-unloaded' that doesn't clear the ref permanently bricks reloading that tree because :49 early-returns; eviction must be driven from (or signal back to) the hook, e.g. derive "loaded" from node state instead of the Set. (b) Eviction must preserve `messageCount` (placeholder count display) and only touch non-active, non-streaming trees — Dashboard only renders active-tree panes so no visible pane goes blank. (c) Persistence is safe: workspacePersistence.ts:580 and :685 already suppress message write-back when `messagesLoaded === false`, so evicted placeholders won't clobber backend rows; node-level dirty (d.nodeIds) may fire spuriously on the eviction tick but is harmless. (d) nodesRef single-writer is preserved if eviction goes through dispatch. (e) Regression the proposal misses: GlobalSearch.tsx:4 uses the LOCAL state/search.ts searchMessages over in-memory nodes ("message content only" hint at GlobalSearch.tsx:120) — evicting trees removes them from ⇧⌘F search results, silently shrinking search coverage for previously-visited trees. Digest staleness is safe: digest.ts:71 skips messagesLoaded:false sources.

---

## #42 [memory-longsession] Backend sessionRegistry accumulates HistoryStubSession full transcripts for the process lifetime; node deletion never drops registry entries

- **位置**: `backend/src/agents/sessionRegistry.ts:64`
- **影响**: medium | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every branch/fork/resume whose parent chain is not live (i.e. any branching after a backend restart, and all four runtimes call it: ClaudeRuntime.ts:115, CodexRuntime.ts:212, KiroRuntime.ts:785, AntigravityRuntime.ts:99). Each deep chain load pins its full ancestor transcripts in Node heap forever; in cloud mode this compounds across all users, and deleted chats' stubs are also retained.

**机制**:

ensureAncestorChainLoaded walks a chat's whole parent chain and, for each ancestor missing from the module-level `sessions` Map, loads EVERY message row from SQLite into an in-memory HistoryStubSession (`history.push({ role, content: text })`, :55-64). Stubs are registered with `ownerUserId: null` and there is no eviction: dropSession is only called by runtimes retiring their own live sessions (ClaudeSessionManager/CodexRuntime/KiroRuntime/etc.) and by michi.ts:138 retireLiveSession; grep of graphCommands.ts/domainCommands.ts and the persistence delete routes (persistence.ts:172, :210) shows node/workspace deletion never touches sessionRegistry. clearAllSessions runs only at shutdown (server.ts:518).

**修复建议**:

Evict stubs by tagging entries and sweeping only reloadable stubs with an LRU/TTL. Do not wire deletion routes to bare `sessionRegistry.dropSession`: live sessions require a separate cancel-and-wait-terminal → runtime.releaseSession → registry drop lifecycle, with node→session bindings captured before purge.

**验证者笔记**:

Mechanism verified exactly as claimed. backend/src/agents/sessionRegistry.ts:7 has module-level `const sessions = new Map<string, Entry>()`; ensureAncestorChainLoaded (:40-71) walks the whole parent chain and for each ancestor missing from the map loads EVERY message row (`store.listMessages(cursor)` :54, `history.push({ role, content: text })` :60) into a HistoryStubSession registered at :64 with `ownerUserId: null`. All four runtimes call it on every branch/fork with a non-live parent: ClaudeRuntime.ts:115, CodexRuntime.ts:212, KiroRuntime.ts:785, AntigravityRuntime.ts:99 (each immediately before getAncestors, so the whole chain is materialized).

Eviction gap verified: grep of graphCommands.ts, domainCommands.ts, and routes/persistence.ts (delete handlers at :172 deleteWorkspace, :196 emptyWorkspaceTrash, :210 purgeWorkspaceNodes) finds zero sessionRegistry references — node/workspace deletion never drops registry entries, so deleted chats' stubs (and live sessions) stay pinned. clearAllSessions runs only in gracefulShutdown (server.ts:518). dropSession callers are exclusively runtimes retiring their own live sessions (ClaudeSessionManager.ts:208/310/342, CodexRuntime.ts:403, PiRuntime.ts:233, KiroRuntime.ts:147/840, AntigravityRuntime.ts:180) plus michi.ts:138 retireLiveSession.

One partial mitigation exists but does not defeat the claim: if the user later sends a message TO a chat that currently has a stub, michi.ts's message route sees it as `liveSession` (michi.ts:812), `liveSessionMatches` is false (runtimeId "stub"), and the fallback path calls retireLiveSession → dropSession, or an exact resume overwrites it via registerSession. So stubs for actively-resumed chats are evicted. But ancestor chats that are only ever branched FROM (the common fork pattern) and deleted chats retain stubs for the process lifetime. Growth is deduplicated (Map keyed by chatId, `visited` set), so the ceiling is "every distinct chat ever used as an ancestor, full transcript text, once" — worst case approaching the whole SQLite messages table resident in Node heap on a long-running cloud instance, compounding across users. Medium is a fair rating: it is memory-only (no per-chunk/per-keystroke CPU), invisible on frequently-restarted desktop Electron, but genuinely unbounded for the server-lifetime cloud path and correctness-adjacent (stale deleted-chat data retained).

**补充证据 / fix 安全检查**:

Fix sanity check: (a) LRU/TTL sweep of stub-tagged entries is safe — stubs are pure read-through caches; every consumer path (all four runtimes) calls ensureAncestorChainLoaded synchronously immediately before getSession/getAncestors with no await in between, so an evicted stub is transparently reloaded from SQLite and there is no async race window. (b) Calling sessionRegistry.dropSession from deleteWorkspace/purgeWorkspaceNodes/emptyWorkspaceTrash needs one caveat: for LIVE sessions a bare dropSession leaks the underlying child process — server.ts:512-519 comment documents that skipping runtime.shutdown()/releaseSession orphans claude/kiro children that keep POSTing to /api/mcp/:slotId. The delete path should mirror michi.ts:130-139 retireLiveSession (runtime.releaseSession → dropSession), not raw dropSession. Also note persistence.ts delete handlers only receive nodeIds, while the registry is keyed by chatId (acp_session_id) — the fix must map node → acp_session_id (getNodeSessionBinding / node row) before dropping. None of the documented frontend invariants (nodesRef single-writer, composer wire-stability, per-tree pane maps) are touched — this is backend-only; stream terminal safety is only implicated if a node is purged mid-stream, in which case releaseSession-based retirement (which cancels) is the correct behavior anyway. Minor adjacent observation (not part of this claim): michi.ts:867 treats a parent STUB as "live" (`if (sessionRegistry.getSession(parentChatId)) return null`), skipping the SQLite merge-context fallback — correct today because the runtime's ensureAncestorChainLoaded covers it, but an eviction sweep must keep that on-demand reload path intact (it does, per (a)).

---

## #43 [memory-longsession] Every turn-end rebuilds the whole transcript fingerprint: full-node string concatenation + per-message finalizeTurnContent regex scans

- **位置**: `frontend/src/state/chatReducers.ts:555`
- **影响**: low | **工作量**: S | **验证**: CONFIRMED
- **触发**: Once per completed turn per node (chatReducers.ts 'done'). Cheap on small nodes, but on deep long-lived threads it produces a visible main-thread stall + a large short-lived allocation right at stream end — and it re-scans messages whose content has not changed since the previous fingerprint.

**机制**:

The 'done' reducer calls computeTranscriptFingerprint(msgs), which for EVERY message in the node runs assistantPersistenceContent → finalizeTurnContent (title regex + follow-up matchAll + char-by-char stripTurnMetadataSentinels over the message's full joined rawText, turnProjection.ts:156-171/180+) and concatenates everything into one giant `payload` string via `payload +=` before hashing. For a 1000-message node this is a multi-MB transient string plus ~1000 full regex scans on the main thread at the moment the turn completes.

**修复建议**:

Hash incrementally by carrying the existing FNV state across the exact `${role}\0${content}\0\0` segments, without building a concatenated payload. Memoize the expensive finalized assistant content string in a WeakMap keyed by the immutable ChatMessage object; do not attempt to combine independent per-message hashes.

**验证者笔记**:

Mechanism verified in the current tree. (1) frontend/src/state/chatReducers.ts:555 — the 'done' reducer computes `resumeFingerprint: computeTranscriptFingerprint(msgs)` over the node's ENTIRE message array on every turn completion. (2) frontend/src/state/transcriptFingerprint.ts:6-13 — `let payload = ''; for (const m of messages) { const content = m.role === 'assistant' ? assistantPersistenceContent(m) : m.text ?? ''; payload += ... }` builds one concatenated string then char-loops it in fnv1a32 (charCodeAt forces rope flattening → the multi-MB transient allocation is real). (3) frontend/src/state/assistantBlocks.ts:92-94 — assistantPersistenceContent → finalizeTurnContent(assistantAnswerRawText(m)), and assistantAnswerRawText itself joins all answer blocks per message. (4) shared/src/turnProjection.ts:156-170 finalizeTurnContent runs titleMatch, followUpsMatch (multiple matchAll passes incl. INLINE_FOLLOW_UPS_RE and PROSE_FOLLOW_UP_RE over the full raw), then stripTurnMetadataSentinels (turnProjection.ts:180-222, a genuine char-by-char cursor loop with per-char regex tests), plus two more full-string .replace passes. So every assistant message's full text gets ~4-5 full scans, for every message in the node, on the main thread, at every turn end. No memoization exists anywhere on this path (no WeakMap, no cache in transcriptFingerprint.ts, assistantBlocks.ts, or turnProjection.ts), and it is not covered by any June-2026 optimization (streamingProjection/memoized blocks are render-side; this is reducer-side). The trigger estimate is honest: exactly once per completed turn per node (grep confirms chatReducers.ts:555 is the only frontend call site), cheap on small nodes, O(total transcript chars × ~5 passes) on large ones. The claimed impact of "low" is fair — a one-shot 10-50ms stall + transient allocation at stream end on 1000-message nodes, not per-chunk work.

**补充证据 / fix 安全检查**:

Fix sanity check — one important correction and one hard constraint. Constraint: the fingerprint is a WIRE-COMPATIBLE value, not frontend-internal. The frontend value is sent as body.resumeFingerprint and compared on the backend against a backend-recomputed fingerprint: backend/src/routes/michi.ts:804-807 `const currentFingerprint = computeTranscriptFingerprint(transcript); const storedFingerprint = normalizeSignaturePart(body.resumeFingerprint) ?? normalizeSignaturePart(row?.resume_fingerprint)` feeding chooseResumeStrategy (backend/src/services/resumeStrategy.ts:113 — mismatch degrades resume to 'compatible' strategy, which re-injects a truncated transcript preamble). The backend has its OWN duplicate implementation (resumeStrategy.ts:125-131, same role\u0000content\u0000\u0000 + fnv1a32 layout). Any fix MUST keep the hash byte-identical to the backend's, or every resume silently downgrades to 'compatible'. Correction to the proposed fix: (a) streaming fnv1a32 over per-message strings WITHOUT building the payload is safe and identical (FNV-1a is a sequential fold; just carry `h` across `${m.role}\u0000${content}\u0000\u0000` segments) — this kills the multi-MB allocation. (b) "memoize per-message content HASHES in a WeakMap" does NOT compose with FNV-1a — the hash state is prefix-dependent, so a cached per-message hash is unusable unless all preceding bytes are unchanged. What actually works: memoize the per-message finalizeTurnContent OUTPUT STRING (the expensive ~5-pass scan) in a WeakMap keyed by the ChatMessage object — message objects are immutably replaced on change (assistantBlocks.ts append helpers return new objects), so WeakMap identity caching is sound — then stream fnv1a32 over the cached strings. That preserves the exact hash. Invariant check: the fix touches only pure functions (transcriptFingerprint.ts / a new cache module); it does not touch nodesRef single-writer, composer wire-stability, per-tree pane maps, or stream terminal safety. Minor caveat: WeakMap-on-message caching of assistantPersistenceContent would also benefit messageForPersistence (assistantBlocks.ts:337-351) which re-derives the same content on persistence writes.

---

## #44 [memory-longsession] PaneOwnershipRegistry never sweeps expired claims — one dead entry retained per chat ever opened

- **位置**: `backend/src/agents/paneOwnership.ts:45`
- **影响**: low | **工作量**: S | **验证**: CONFIRMED
- **触发**: Every pane open on every chat; growth is one small object per chatId, so it takes a very long multi-week desktop session (or cloud deployment) to matter — but it is a genuine unbounded Map with no eviction on chat delete either.

**机制**:

claim() inserts a PaneClaim per chatId into the module-singleton `claims` Map. Expired leases are treated as dead by isLive() but the entry object is never deleted unless the exact original ownerToken calls release() (:61-66); a crashed tab, closed window, or a re-claim by a different token leaves the old entry in place (re-claim overwrites, but chats never revisited keep their stale claim forever). The Map grows monotonically with the number of distinct chats ever claimed across the process lifetime.

**修复建议**:

Delete expired entries opportunistically: in claim()/heartbeat()/hasLiveClaim(), when isLive() returns false, `this.claims.delete(chatId)` before proceeding; optionally add a periodic unref'd sweep timer.

**验证者笔记**:

Mechanism verified in current tree: backend/src/agents/paneOwnership.ts:21 holds a module-singleton Map (exported instance at :83); claim() (:35-52) only overwrites the entry for the same chatId, release() (:61-66) deletes only on exact ownerToken match, and isLive()/heartbeat()/hasLiveClaim()/isHeldBy()/isHeldByAnotherToken() (:30-80) treat expired leases as dead without ever deleting them. DEFAULT_LEASE_TTL_MS (:18) is used only for liveness checks. The only call sites are backend/src/routes/michi.ts:986,1047,1112,1121,1132 — no chat-delete path or any other code evicts entries, so the Map grows monotonically with distinct chatIds claimed over the process lifetime. The claimed impact (low) is honest: growth is one ~200-300 byte object per distinct chat ever opened, bounded by re-claim overwrite, resetting on backend restart (desktop Electron); only a very long-lived cloud process accumulates meaningfully (~2-3 MB per 10k chats). The proposed fix (delete expired entries in claim/heartbeat/hasLiveClaim when isLive() is false, optionally an unref'd sweep timer) is behavior-preserving — every read path already treats expired claims as absent — and touches none of the documented frontend invariants (nodesRef single-writer, composer wire-stability, per-tree pane maps, stream terminal safety), which are all frontend concerns with no coupling to this backend-only registry.

**补充证据 / fix 安全检查**:

paneOwnership.ts:45-50 `this.claims.set(chatId, { chatId, ownerToken, windowId, lastHeartbeat: this.now() })` — set without sweep; :64 `this.claims.delete(chatId)` is the sole delete, gated on token match at :63. heartbeat() at :56 returns false for expired claims (`!this.isLive(existing)`) but leaves the entry. Grep confirms no other mutation sites: only michi.ts routes use the singleton (claim :1112, heartbeat :1121, release :1132, reads :986/:1047). Fix safety: deleting an expired entry inside claim() before the set at :45, inside heartbeat() when isLive fails, or inside hasLiveClaim() changes no observable semantics because all five read methods already coerce expired→dead; a subsequent claim by any token succeeds identically. No risk to nodesRef single-writer, composer wire-stability, per-tree openPanes/focusedPane maps, or stream terminal safety — none of those code paths import or depend on paneOwnership.

---
