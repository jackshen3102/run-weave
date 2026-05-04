# 图谱报告 - . (2026-05-04)

## 语料检查

- 大型语料：380 个文件，约 192,278 词。语义抽取会消耗较多模型 token；建议针对子目录运行，或保持 AST-only 方式。

## 摘要

- 1543 个节点 · 2623 条边 · 检测到 65 个社区
- 抽取结果：93% 明确抽取 · 7% 推断 · 0% 不确定 · 推断边：185 条（平均置信度：0.8）
- Token 消耗：输入 0 · 输出 0

## 社区入口（导航）

- [[_COMMUNITY_start.mjs 33|start.mjs 33]]
- [[_COMMUNITY_Electron 外壳 17|Electron 外壳 17]]
- [[_COMMUNITY_终端运行时 18|终端运行时 18]]
- [[_COMMUNITY_终端运行时 11|终端运行时 11]]
- [[_COMMUNITY_frontend 70|frontend 70]]
- [[_COMMUNITY_浏览器控制 9|浏览器控制 9]]
- [[_COMMUNITY_Electron 外壳 71|Electron 外壳 71]]
- [[_COMMUNITY_Electron 外壳 54|Electron 外壳 54]]
- [[_COMMUNITY_Electron 外壳 26|Electron 外壳 26]]
- [[_COMMUNITY_终端预览 1|终端预览 1]]
- [[_COMMUNITY_终端浏览器 20|终端浏览器 20]]
- [[_COMMUNITY_终端运行时 50|终端运行时 50]]
- [[_COMMUNITY_终端运行时 37|终端运行时 37]]
- [[_COMMUNITY_终端运行时 36|终端运行时 36]]
- [[_COMMUNITY_终端预览 63|终端预览 63]]
- [[_COMMUNITY_终端预览 38|终端预览 38]]
- [[_COMMUNITY_终端预览 27|终端预览 27]]
- [[_COMMUNITY_终端运行时 73|终端运行时 73]]
- [[_COMMUNITY_终端运行时 41|终端运行时 41]]
- [[_COMMUNITY_终端预览 46|终端预览 46]]
- [[_COMMUNITY_终端预览 14|终端预览 14]]
- [[_COMMUNITY_DevTools 桥接 12|DevTools 桥接 12]]
- [[_COMMUNITY_质量诊断 40|质量诊断 40]]
- [[_COMMUNITY_认证流程 23|认证流程 23]]
- [[_COMMUNITY_质量诊断 45|质量诊断 45]]
- [[_COMMUNITY_质量诊断 48|质量诊断 48]]
- [[_COMMUNITY_终端浏览器 35|终端浏览器 35]]
- [[_COMMUNITY_终端运行时 49|终端运行时 49]]
- [[_COMMUNITY_浏览器控制 21|浏览器控制 21]]
- [[_COMMUNITY_终端运行时 31|终端运行时 31]]
- [[_COMMUNITY_DevTools 桥接 52|DevTools 桥接 52]]
- [[_COMMUNITY_DevTools 桥接 8|DevTools 桥接 8]]
- [[_COMMUNITY_认证流程 32|认证流程 32]]
- [[_COMMUNITY_认证流程 67|认证流程 67]]
- [[_COMMUNITY_终端预览 4|终端预览 4]]
- [[_COMMUNITY_终端运行时 34|终端运行时 34]]
- [[_COMMUNITY_终端运行时 16|终端运行时 16]]
- [[_COMMUNITY_终端运行时 39|终端运行时 39]]
- [[_COMMUNITY_终端预览 3|终端预览 3]]
- [[_COMMUNITY_终端运行时 6|终端运行时 6]]
- [[_COMMUNITY_终端运行时 58|终端运行时 58]]
- [[_COMMUNITY_终端运行时 13|终端运行时 13]]
- [[_COMMUNITY_终端预览 29|终端预览 29]]
- [[_COMMUNITY_终端运行时 51|终端运行时 51]]
- [[_COMMUNITY_backend 57|backend 57]]
- [[_COMMUNITY_DevTools 桥接 15|DevTools 桥接 15]]
- [[_COMMUNITY_会话工作区 47|会话工作区 47]]
- [[_COMMUNITY_质量诊断 25|质量诊断 25]]
- [[_COMMUNITY_DevTools 桥接 5|DevTools 桥接 5]]
- [[_COMMUNITY_认证流程 61|认证流程 61]]
- [[_COMMUNITY_会话工作区 60|会话工作区 60]]
- [[_COMMUNITY_DevTools 桥接 7|DevTools 桥接 7]]
- [[_COMMUNITY_浏览器控制 30|浏览器控制 30]]
- [[_COMMUNITY_终端运行时 42|终端运行时 42]]
- [[_COMMUNITY_DevTools 桥接 55|DevTools 桥接 55]]
- [[_COMMUNITY_DevTools 桥接 19|DevTools 桥接 19]]
- [[_COMMUNITY_浏览器控制 22|浏览器控制 22]]
- [[_COMMUNITY_Electron 外壳 43|Electron 外壳 43]]
- [[_COMMUNITY_质量诊断 24|质量诊断 24]]
- [[_COMMUNITY_终端运行时 53|终端运行时 53]]
- [[_COMMUNITY_终端浏览器 0|终端浏览器 0]]
- [[_COMMUNITY_终端浏览器 2|终端浏览器 2]]
- [[_COMMUNITY_终端浏览器 28|终端浏览器 28]]
- [[_COMMUNITY_终端运行时 56|终端运行时 56]]
- [[_COMMUNITY_浏览器控制 10|浏览器控制 10]]

## 核心节点（连接最多的核心抽象）

1. `TerminalSessionManager` - 38 条边
2. `LowDbTerminalSessionStore` - 37 条边
3. `requestJson()` - 36 条边
4. `TmuxService` - 32 条边
5. `SessionManager` - 26 条边
6. `QualityProbeStore` - 21 条边
7. `AuthService` - 21 条边
8. `CdpSessionManager` - 19 条边
9. `handleMessage()` - 19 条边
10. `BrowserService` - 18 条边

## 意外连接（可能容易忽略的跨模块关系）

- `createBrowserTabState()` --调用--> `createTerminalBrowserDeviceState()` [推断]
  frontend/src/features/terminal/preview-store.ts → packages/shared/src/terminal-browser-device.ts
- `normalizeTerminalBrowserHeaderRules()` --调用--> `setTerminalBrowserHeaderRules()` [推断]
  packages/shared/src/terminal-browser-headers.ts → electron/src/terminal-browser-view.ts
- `run()` --调用--> `resolvePort()` [推断]
  electron-dev.mjs → dev.mjs
- `run()` --调用--> `startBackend()` [推断]
  electron-dev.mjs → dev.mjs
- `run()` --调用--> `stopProcesses()` [推断]
  electron-dev.mjs → dev.mjs

## 社区（共 121 个，省略 16 个较薄社区）

### 社区 33 - "start.mjs 33"

内聚度：0.27
节点（13）： readCliOption(), resolveBackendArgs(), parsePort(), removeCliOption(), resolveStartTarget(), resolveLocalHost(), resolveNetworkHost(), isPortAvailable()（另有 5 个）

### 社区 17 - "Electron 外壳 17"

内聚度：0.23
节点（21）： run(), createBackendEnv(), resolveHealthcheckTimeoutMs(), createFrontendEnv(), canListenOnHost(), isPortAvailable(), normalizeProbeHosts(), resolvePort()（另有 13 个）

### 社区 18 - "终端运行时 18"

内聚度：0.12
节点（13）： readPerfScenario(), shouldRunScenario(), summarize(), summarizeLongTasks(), toFiniteNumber(), readProbeEvent(), buildRepeatedSeedPayload(), buildSeedCommand()（另有 5 个）

### 社区 11 - "终端运行时 11"

内聚度：0.07
节点（20）： syncVisibility(), resolveClientMode(), readClientModeOverride(), resolveCurrentClientMode(), useClientMode(), shouldExposeLocalDevelopmentConnection(), buildLocalDevelopmentConnection(), resolveNeedsConnection()（另有 12 个）

### 社区 9 - "浏览器控制 9"

内聚度：0.08
节点（13）： isBrowserProtocol(), shouldRegisterRunweavePwa(), applyButtonStyle(), showRunweavePwaRefreshBanner(), registerRunweavePwa(), registerRunweavePwaAfterDomReady(), createInitialSnapshot(), cloneRecord()（另有 5 个）

### 社区 26 - "Electron 外壳 26"

内聚度：0.24
节点（13）： loadConnectionAuthStore(), saveConnectionAuthStore(), cleanupLegacyAuthStorage(), getConnectionAuth(), setConnectionAuth(), clearConnectionAuth(), setConnectionToken(), clearConnectionToken()（另有 5 个）

### 社区 1 - "终端预览 1"

内聚度：0.06
节点（49）： resolveCachedTerminalSurfaceIds(), buildStorageKey(), loadRecentTerminalSelection(), saveRecentTerminalSelection(), resolveNewTerminalRuntimePreference(), useTerminalPreviewPanelActions(), resolvePreferredSessionId(), useSessionSelectionShortcuts()（另有 41 个）

### 社区 20 - "终端浏览器 20"

内聚度：0.13
节点（13）： normalizeTerminalBrowserUrl(), validateHttpUrl(), useTerminalBrowserHeaderRules(), openUrlExternally(), isNavigationAbortError(), buildTabUpdateFromElectronSnapshot(), buildTabUpdateFromElectronUpdate(), buildTabStateFromElectronSnapshot()（另有 5 个）

### 社区 50 - "终端运行时 50"

内聚度：0.39
节点（5）： normalizeSourceCols(), syncTerminalHistorySize(), writeTerminalHistoryOutput(), syncSize(), refreshTerminalViewport()

### 社区 37 - "终端运行时 37"

内聚度：0.18
节点（6）： shouldThrottleTmuxScroll(), buildTmuxScrollInput(), filterBrowserHandledTerminalOutput(), shouldSuppressWheelInput(), syncSize(), refreshTerminalViewport()

### 社区 36 - "终端运行时 36"

内聚度：0.15
节点（3）： createResizeScheduler(), scheduleTerminalViewportRefresh(), TerminalMobileKeybar()

### 社区 63 - "终端预览 63"

内聚度：0.6
节点（3）： createBrowserTabState(), createUniqueBrowserTabState(), labelBrowserUrl()

### 社区 38 - "终端预览 38"

内聚度：0.23
节点（6）： normalizePath(), dirname(), resolveMarkdownPreviewHref(), resolveMarkdownPreviewAssetPath(), getMarkdownRenderer(), renderMarkdown()

### 社区 27 - "终端预览 27"

内聚度：0.19
节点（12）： extensionOf(), isSupportedTerminalImagePreviewPath(), getTerminalPreviewFileKind(), getTerminalPreviewMonacoLanguage(), extensionToLanguageHint(), renderEmpty(), compactDirectory(), sortChangeTreeNodes()（另有 4 个）

### 社区 41 - "终端运行时 41"

内聚度：0.27
节点（6）： buildTerminalWsUrl(), isTerminalPerfLoggingEnabled(), summarizeTerminalChunk(), logTerminalPerf(), shouldAutoReconnectTerminalClose(), getTerminalReconnectDelay()

### 社区 46 - "终端预览 46"

内聚度：0.24
节点（5）： useTerminalConnection(), TerminalPreviewMenu(), TerminalSurface(), TerminalProjectDialog(), TerminalHeadlessConnection()

### 社区 14 - "终端预览 14"

内聚度：0.11
节点（18）： stripTerminalControlSequences(), commandName(), toLabel(), colorForState(), primaryActionForState(), inferTerminalState(), buildFallbackTmuxSessionName(), resolveTmuxSessionName()（另有 10 个）

### 社区 12 - "DevTools 桥接 12"

内聚度：0.07
节点（23）： getViewerSecurityState(), hasTab(), pruneByTabIds(), viewerConnectionReducer(), getViewerSurfaceState(), resolveApiBase(), toWebSocketBase(), toHttpBase()（另有 15 个）

### 社区 40 - "质量诊断 40"

内聚度：0.2
节点（3）： cloneLog(), FrontendDiagnosticLogRecorder, formatDiagnosticLogResult()

### 社区 23 - "认证流程 23"

内聚度：0.17
节点（10）： savePosition(), formatActionError(), loadInitialState(), handleDragEnd(), authHeaders(), getDiagnosticLogStatus(), startDiagnosticLogs(), stopDiagnosticLogs()（另有 2 个）

### 社区 45 - "质量诊断 45"

内聚度：0.22
节点（3）： createAiDiagnosticLog(), createTestServer(), createDiagnosticLogsRouter()

### 社区 35 - "终端浏览器 35"

内聚度：0.19
节点（6）： validateRules(), saveRules(), hasControlCharacter(), isBlockedTerminalBrowserHeaderName(), validateTerminalBrowserHeaderRule(), normalizeTerminalBrowserHeaderRules()

### 社区 49 - "终端运行时 49"

内聚度：0.22
节点（4）： SessionList(), HomeSidebar(), NewSessionForm(), useHomeSessions()

### 社区 21 - "浏览器控制 21"

内聚度：0.13
节点（10）： getProxyStatusLabel(), getSessionSourceLabel(), getHeaderSummaryLabel(), parseSessionHeaders(), parseViewportDimension(), parseBrowserProfileInput(), normalizeLocale(), normalizeTimezoneId()（另有 2 个）

### 社区 31 - "终端运行时 31"

内聚度：0.25
节点（12）： readCliOption(), parsePort(), resolveRuntimeConfig(), resolveSessionRestoreEnabled(), resolveTerminalHookToken(), createRuntimeServices(), attachLifecycleHandlers(), startRuntime()（另有 4 个）

### 社区 52 - "DevTools 桥接 52"

内聚度：0.25
节点（5）： parseConfiguredOrigins(), createHttpApp(), resolveFrontendDistDir(), createDevtoolsRouter(), createTestRouter()

### 社区 8 - "DevTools 桥接 8"

内聚度：0.09
节点（19）： getBearerToken(), createRequireAuth(), readBearerToken(), encodePayload(), decodePayload(), signPayload(), issueToken(), verifyToken()（另有 11 个）

### 社区 4 - "终端预览 4"

内聚度：0.05
节点（31）： isTmuxBackedSession(), resolveTmuxTarget(), ensureTerminalRuntime(), readTerminalScrollback(), readTerminalScrollbackCapture(), killTmuxSessionForTerminal(), PtyService, createShellPromptTracker()（另有 23 个）

### 社区 34 - "终端运行时 34"

内聚度：0.21
节点（8）： buildProjectRecord(), buildRecord(), createRuntimeRecord(), toPersisted(), isExistingDirectory(), getInitialTerminalActiveCommand(), createTerminalSessionId(), createUniqueTerminalSessionId()

### 社区 16 - "终端运行时 16"

内聚度：0.1
节点（3）： toPersistedProject(), TerminalSessionManager, validateTerminalWebSocketHandshake()

### 社区 39 - "终端运行时 39"

内聚度：0.33
节点（9）： limitScrollbackLines(), getLiveTerminalScrollback(), countUtf8Bytes(), trimTextToTailBytes(), normalizeChunk(), createScrollbackBuffer(), appendToScrollbackBuffer(), readScrollbackBuffer()（另有 1 个）

### 社区 3 - "终端预览 3"

内聚度：0.06
节点（53）： TerminalPreviewError, ensureProjectPath(), toRelativePath(), isInsidePath(), resolvePreviewPath(), detectLanguage(), detectImageMimeType(), isLikelyBinary()（另有 45 个）

### 社区 6 - "终端运行时 6"

内聚度：0.06
节点（16）： loadNodePtyModule(), ensureSpawnHelperExecutable(), isUnsetEnvValue(), normalizePathForAppImage(), buildPtyEnv(), resolveNodePtyDirectory(), extractShellPromptMetadata(), ensureZshHookDirectory()（另有 8 个）

### 社区 58 - "终端运行时 58"

内聚度：0.6
节点（4）： buildDirectoryLabel(), basename(), normalizeLegacyCommand(), normalizeActiveCommand()

### 社区 29 - "终端预览 29"

内聚度：0.14
节点（5）： TerminalCompletionEventStore, createTestServer(), registerTerminalPreviewRoutes(), createTerminalRouter(), createInternalTerminalCompletionRouter()

### 社区 15 - "DevTools 桥接 15"

内聚度：0.1
节点（9）： isPortAvailable(), listenOnPort(), findAvailablePort(), listenWithFallback(), closeServer(), getFreePort(), buildLaunchArgs(), resolveViewport()（另有 1 个）

### 社区 47 - "会话工作区 47"

内聚度：0.31
节点（7）： expandHomePath(), resolveStoragePaths(), SessionProfileValidationError, SessionProfileConflictError, resolveSessionProfileBinding(), ensureProfilePathAvailable(), validateCustomProfilePath()

### 社区 25 - "质量诊断 25"

内聚度：0.18
节点（8）： createRedactionReport(), normalizeLog(), redactUrlString(), redactString(), redactValue(), redactLogs(), toJsonl(), DiagnosticLogRecorder

### 社区 5 - "DevTools 桥接 5"

内聚度：0.05
节点（23）： inferDataUrlPayload(), defaultFetchFaviconForPage(), defaultResolvePageForSessionTab(), createSessionFaviconRouter(), createSessionFaviconHandler(), readForwardedHeader(), resolveRequestHost(), resolveWebSocketProtocol()（另有 15 个）

### 社区 7 - "DevTools 桥接 7"

内聚度：0.05
节点（23）： parseClientMessage(), normalizeCursor(), resolveCursorAtPoint(), createCursorSyncController(), hasScheme(), normalizeNavigationUrl(), getNavigationHistory(), getNavigationCapability()（另有 15 个）

### 社区 30 - "浏览器控制 30"

内聚度：0.19
节点（9）： hasShortcutModifier(), isCopyOrCutShortcut(), readSelectedText(), getClipboardCopyTextBeforeInput(), truncateClipboardText(), buildCopyEventPayload(), handlePageInputMessage(), buildKeyboardCommand()（另有 1 个）

### 社区 19 - "DevTools 桥接 19"

内聚度：0.1
节点（3）： FakeCDPSession, FakePage, FakeContext

### 社区 43 - "Electron 外壳 43"

内聚度：0.31
节点（7）： resolveDefaultCacheRoot(), isRetriableHdiutilResizeBusyError(), runWithRetries(), commandName(), runStreamingCommand(), runCheckedCommand(), main()

### 社区 24 - "质量诊断 24"

内聚度：0.18
节点（11）： readChangedFiles(), expandStepsForLayers(), selectLayersForChangedFiles(), selectStepsForChangedFiles(), classifyFailure(), buildEvidence(), buildRiskSummary(), buildStepEnv()（另有 3 个）

### 社区 53 - "终端运行时 53"

内聚度：0.5
节点（7）： readOption(), readPositiveIntOption(), percentile(), summarize(), countOccurrences(), runIteration(), main()

### 社区 0 - "终端浏览器 0"

内聚度：0.06
节点（69）： getTerminalBrowserDevicePreset(), normalizeTerminalBrowserDevicePresetId(), createTerminalBrowserDeviceState(), isBlockedCommand(), classifyCdpCommand(), buildVersionResponse(), buildTargetInfo(), isCdpConnectionLimitReached()（另有 61 个）

### 社区 2 - "终端浏览器 2"

内聚度：0.05
节点（42）： resolveCdpProxyPort(), isPortAvailable(), findAvailableCdpProxyPort(), roundToTwo(), bytesToMb(), buildRuntimeStatsSnapshot(), createWindow(), setupSessionIntercept()（另有 34 个）

### 社区 56 - "终端运行时 56"

内聚度：0.57
节点（5）： normalizeHookEventName(), detectTerminalBundleId(), buildHookEventMessage(), parseHookEventPayload(), firstNonBlankString()

### 社区 10 - "浏览器控制 10"

内聚度：0.13
节点（38）： mergeJsonHookEntry(), renderTraeHookBlock(), buildLauncherScript(), installHooksIfNeeded(), installAllHooks(), writeLauncherScript(), installClaudeHooks(), installCodexHooks()（另有 30 个）

## 知识缺口

- **4 个孤立节点：** `FakeCdpSession`、`FakeCDPSession`、`SessionProfileValidationError`、`SessionProfileConflictError`
  这些节点只有 1 条或更少连接，可能存在缺失边或未文档化的组件。
- **报告省略了 16 个较薄社区（少于 3 个节点）**，可运行 `graphify query` 继续探索孤立节点。

## 建议问题

_这份图谱特别适合回答的问题：_

- **为什么 `TmuxService` 会连接 `终端运行时 6`、`终端预览 4`、`终端运行时 31`？**
  _中介中心性较高（0.276），说明该节点是跨社区桥接点。_
- **为什么 `HttpError` 会连接 `终端预览 1`、`终端运行时 36`、`终端运行时 37`、`终端预览 38`、`终端运行时 41`、`DevTools 桥接 12`、`终端预览 14`、`终端运行时 50`、`Electron 外壳 26`？**
  _中介中心性较高（0.253），说明该节点是跨社区桥接点。_
- **为什么 `findAvailablePort()` 会连接 `终端浏览器 2`、`终端运行时 6`？**
  _中介中心性较高（0.224），说明该节点是跨社区桥接点。_
- **`requestJson()` 相关的 29 条推断关系（例如与 `getDiagnosticLogStatus()`、`startDiagnosticLogs()` 的关系）是否准确？**
  _`requestJson()` 有 29 条推断边，这些是基于模型推理的连接，需要进一步验证。_
- **`FakeCdpSession`、`FakeCDPSession`、`SessionProfileValidationError` 是如何连接到系统其他部分的？**
  _发现 4 个弱连接节点，可能代表文档缺口或缺失边。_
- **`终端运行时 18` 是否应该拆分成更小、更聚焦的模块？**
  _内聚度为 0.12，说明该社区内节点之间连接较弱。_
- **`终端运行时 11` 是否应该拆分成更小、更聚焦的模块？**
  _内聚度为 0.07，说明该社区内节点之间连接较弱。_
