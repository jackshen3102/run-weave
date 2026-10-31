import SwiftUI
import AppKit

struct JournalActivitiesView: View {
    let service: JournalReadService
    @Binding var day: String
    let openRecordings: () -> Void
    @State private var days: [String] = []
    @State private var rawCount: Int?
    @State private var loading = true
    @State private var failed = false
    @State private var snapshot: AnalysisExport?
    @State private var message = "正在读取事项…"
    @State private var selected: AnalysisCard?
    @State private var searching = false
    @State private var retryKeys: [String:String] = [:]
    @State private var retryRevisions: [String:Int] = [:]
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading) {
                Text("整理事项").font(.title2.bold())
                Text("事项是录屏的辅助整理，不影响直接回看。").font(.caption).foregroundStyle(.secondary)
                if !days.isEmpty {
                    Picker("日期", selection: $day) { ForEach(days, id: \.self) { Text($0).tag($0) } }
                }
                Button(rawCount.map { $0 > 0 ? "查看当天 \($0) 段录屏" : "查看录屏记录" } ?? "查看录屏记录", systemImage: "play.rectangle", action: openRecordings)
                Button("搜索事项", systemImage: "magnifyingglass") { searching = true }
                Button("刷新事项") { Task { await refresh() } }
                Text(message).font(.caption).foregroundStyle(.secondary)
                ForEach(Array((snapshot?.missingIntervals ?? []).enumerated()), id: \.offset) { _, gap in
                    if gap.reason == "failed", let batch = gap.batchID {
                        Button("重试分析缺失区间") { Task { await retry(batch) } }
                    }
                }
                List(snapshot?.cards ?? [], selection: Binding(get: { selected?.cardID }, set: { id in selected = snapshot?.cards.first { $0.cardID == id } })) { card in
                    VStack(alignment: .leading) {
                        Text(card.title).font(.headline)
                        Text(card.summary).lineLimit(3)
                        Text(card.actor == "agent" ? "Agent 后台" : card.actor == "mixed" ? "混合" : "本人活动").font(.caption)
                    }.tag(card.cardID)
                }
            }.padding().frame(minWidth: 250)
        } detail: {
            if let selected, let snapshot {
                JournalActivityDetail(service: service, selected: selected, evidence: snapshot.evidence, deviceID: snapshot.deviceID)
                    .id("\(selected.cardID):\(selected.revision)")
            } else if loading {
                ProgressView("正在读取事项…")
            } else {
                ContentUnavailableView {
                    Label(snapshot?.cards.isEmpty == false ? "选择一条事项" : failed ? "事项暂不可用" : "当天尚未生成事项", systemImage: "list.bullet.rectangle")
                } description: {
                    Text(rawCount.map { $0 > 0 ? "当天已有 \($0) 段录屏，可以直接回看。" : "事项与录屏分别保存，可前往录屏记录查看。" } ?? "可以先查看录屏记录。")
                } actions: {
                    Button("查看录屏记录", action: openRecordings).buttonStyle(.borderedProminent)
                }
            }
        }
        .task(id: day) {
            snapshot = nil; selected = nil; rawCount = nil; loading = true
            await refresh()
        }
        .sheet(isPresented: $searching) { JournalActivitySearchView(service: service) }
    }
    @State private var refreshGeneration = 0
    private func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        failed = false
        do {
            let (statusData,_) = try await service.analysisRequest("analysisStatus",input: "{}")
            let analysis = try JSONDecoder().decode(AnalysisStatus.self,from: statusData)
            let raw = try await service.status().days.map(\.day)
            guard !Task.isCancelled, generation == refreshGeneration else { return }
            days = Array(Set(analysis.days + raw + (day.isEmpty ? [] : [day]))).sorted(by: >)
            if day.isEmpty, let first = days.first { day = first; return }
            guard !day.isEmpty else { snapshot = nil; message = "尚未生成事项。录屏可直接回看。"; loading = false; return }
            let requestedDay = day
            // Raw catalogue failures must not hide independently stored activities.
            let count = try? await recordingCount(on: requestedDay)
            guard !Task.isCancelled, generation == refreshGeneration, requestedDay == day else { return }
            rawCount = count
            let (data,_) = try await service.analysisRequest("analysisExport", input: analysisJSON(["day":requestedDay]))
            guard !Task.isCancelled, generation == refreshGeneration, requestedDay == day else { return }
            loading = false
            snapshot = try JSONDecoder().decode(AnalysisExport.self, from: data)
            selected = snapshot?.cards.first { $0.cardID == selected?.cardID }
            message = snapshot?.cards.isEmpty == true ? "当天尚未生成事项，无需等待即可回看录屏。" : "仅已记录范围 · 上海时间"
            if snapshot?.coverage != "complete" { message += " · 覆盖不完整" }
            if let summary = snapshot?.summary { message += "\n" + summary }
        } catch {
            guard generation == refreshGeneration, !Task.isCancelled else { return }
            snapshot = nil; selected = nil; loading = false; failed = true
            message = "事项读取失败，不影响查看录屏。请刷新重试。"
        }
    }
    private func recordingCount(on day: String) async throws -> Int {
        var cursor: String?; var count = 0
        repeat {
            let page = try await service.ranges(day: day, cursor: cursor, limit: 200)
            try Task.checkCancellation()
            count += page.items.count; cursor = page.nextCursor
        } while cursor != nil
        return count
    }
    private func retry(_ batch: String) async {
        guard let currentRevision = snapshot?.revision else { return }
        let revision = retryRevisions[batch] ?? currentRevision; retryRevisions[batch] = revision
        let key = retryKeys[batch] ?? UUID().uuidString; retryKeys[batch] = key
        do {
            struct Input: Encodable { let batchID: String; let expectedRevision: Int; let operationID: String }
            _ = try await service.analysisRequest("retryAnalysis",input: analysisJSON(Input(batchID: batch,expectedRevision: revision,operationID: key)))
            retryKeys.removeValue(forKey: batch); retryRevisions.removeValue(forKey: batch)
            await refresh()
        } catch { message = "重试请求未确认，请刷新后重试" }
    }
}

struct JournalActivityDetail: View {
    let service: JournalReadService
    let selected: AnalysisCard
    let evidence: [AnalysisEvidence]
    let deviceID: String
    @State private var playback: JournalView?
    @State private var playbackRevision = ""
    @State private var captureID: String?
    @State private var message = ""
    var body: some View {
        VStack(alignment: .leading) {
            if playback != nil { Button("返回事项详情") { playback = nil; captureID = nil } }
            if let playback { JournalPlaybackView(service: service, range: playback.range, revision: playbackRevision, initialCaptureID: captureID).id(playback.viewID) }
            else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(selected.title).font(.title2)
                        Text(selected.summary); Text(selected.detail)
                        Text("事实状态：\(selected.state)").font(.caption)
                        ForEach(Array(selected.spans.enumerated()), id: \.offset) { _, span in
                            Text("\(time(span.startMs))–\(time(span.endMs))" + (span.actor == "agent" ? " · 后台执行" : ""))
                        }
                        ForEach(evidence.filter { selected.evidenceIDs.contains($0.id) }, id: \.id) { evidence in
                            if let capture = evidence.captureID {
                                Button("查看 \(time(evidence.occurredAtMs)) 的画面证据") { Task { await open(capture) } }
                            } else if evidence.source == "agent", evidence.provider == "codex", let thread = evidence.threadID {
                                Button("打开 Agent 会话") { openConversation(thread) }
                            }
                        }
                        Text(message).font(.caption).foregroundStyle(.secondary)
                    }.padding().frame(maxWidth: .infinity, alignment: .leading)
                }

            }
        }
    }
    private func time(_ ms: Int64) -> String {
        let f = DateFormatter(); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "HH:mm:ss"
        return f.string(from: Date(timeIntervalSince1970: Double(ms)/1000))
    }
    private func openConversation(_ thread: String) {
        let device = deviceID
        var link = URLComponents(); link.scheme = "runweave"; link.host = "screen-conversation"
        link.queryItems = [URLQueryItem(name: "deviceID", value: device), URLQueryItem(name: "provider", value: "codex"), URLQueryItem(name: "threadID", value: thread)]
        #if DEBUG
        if CommandLine.arguments.contains("--validation-data-dir") {
            // Isolated fixtures must never send navigation into the installed Stable app.
            guard let index = CommandLine.arguments.firstIndex(of: "--validation-conversation-app"),
                  CommandLine.arguments.indices.contains(index+1) else {
                message = "会话入口不可用，隔离验证未指定 Beta 应用；文字事项保留"; return
            }
            let app = URL(fileURLWithPath: CommandLine.arguments[index+1])
            guard Bundle(url: app)?.bundleIdentifier?.hasPrefix("com.runweave.desktop.beta.") == true else {
                message = "隔离会话入口必须是 Runweave Beta；文字事项保留"; return
            }
            link.scheme = "runweave-beta"
            guard let url = link.url else { return }
            NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                Task { @MainActor in
                    message = error == nil ? "已交由 Runweave Beta 校验会话来源" : "会话入口不可用，文字事项保留"
                }
            }
            return
        }
        #endif
        guard let url = link.url, NSWorkspace.shared.urlForApplication(toOpen: url) != nil,
              NSWorkspace.shared.open(url) else { message = "会话入口不可用，请更新并打开 Runweave；文字事项保留"; return }
        message = "已交由 Runweave 校验会话来源；不可达时文字事项仍保留"
    }
    private func open(_ capture: String) async {
        do {
            let (data,_) = try await service.analysisRequest("resolveAnalysisCapture", input: analysisJSON(["captureID":capture]))
            let target = try JSONDecoder().decode([String:String].self, from: data)
            guard let id = target["rangeID"], let revision = target["catalogRevision"] else { return }
            let value = try await service.open(rangeID: id,catalogRevision: revision)
            await service.close(viewID: value.viewID)
            playbackRevision = revision; captureID = capture; playback = value
        } catch { playback = nil; message = "画面证据已过期或不可用，文字事项保留" }
    }
}
