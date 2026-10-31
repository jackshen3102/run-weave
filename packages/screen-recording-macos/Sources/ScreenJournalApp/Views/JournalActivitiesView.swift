import SwiftUI
import AppKit

struct JournalActivitiesView: View {
    let service: JournalReadService
    @State private var day = ""
    @State private var snapshot: AnalysisExport?
    @State private var message = "正在读取事项…"
    @State private var selected: AnalysisCard?
    @State private var playback: JournalView?
    @State private var retryKeys: [String:String] = [:]
    @State private var retryRevisions: [String:Int] = [:]
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading) {
                TextField("上海日期 YYYY-MM-DD", text: $day)
                Button("刷新事项") { Task { await refresh() } }
                Text(message).font(.caption).foregroundStyle(.secondary)
                ForEach(Array((snapshot?.missingIntervals ?? []).enumerated()), id: \.offset) { _, gap in
                    if gap.reason == "failed", let batch = gap.batchID {
                        Button("重试分析缺失区间") { Task { await retry(batch) } }
                    }
                }
                List(snapshot?.cards ?? [], selection: Binding(get: { selected?.cardID }, set: { id in selected = snapshot?.cards.first { $0.cardID == id }; playback = nil })) { card in
                    VStack(alignment: .leading) {
                        Text(card.title).font(.headline)
                        Text(card.summary).lineLimit(3)
                        Text(card.actor == "agent" ? "Agent 后台" : card.actor == "mixed" ? "混合" : "本人活动").font(.caption)
                    }.tag(card.cardID)
                }
            }.padding().frame(minWidth: 250)
        } detail: {
            if let playback { JournalPlaybackView(service: service, range: playback.range, revision: playbackRevision, initialCaptureID: captureID).id(playback.viewID) }
            else if let selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(selected.title).font(.title2)
                        Text(selected.summary); Text(selected.detail)
                        Text("事实状态：\(selected.state)").font(.caption)
                        ForEach(Array(selected.spans.enumerated()), id: \.offset) { _, span in
                            Text("\(time(span.startMs))–\(time(span.endMs))" + (span.actor == "agent" ? " · 后台执行" : ""))
                        }
                        ForEach(snapshot?.evidence.filter { selected.evidenceIDs.contains($0.id) } ?? [], id: \.id) { evidence in
                            if let capture = evidence.captureID {
                                Button("查看 \(time(evidence.occurredAtMs)) 的画面证据") { Task { await open(capture) } }
                            } else if evidence.source == "agent", evidence.provider == "codex", let thread = evidence.threadID {
                                Button("打开 Agent 会话") { openConversation(thread) }
                            }
                        }
                        Text(message).font(.caption).foregroundStyle(.secondary)
                    }.padding().frame(maxWidth: .infinity, alignment: .leading)
                }
            } else { ContentUnavailableView("选择事项", systemImage: "list.bullet.rectangle", description: Text("尚未整理时可切换原始记录")) }
        }
        .task { await refresh() }
    }
    @State private var playbackRevision = ""
    @State private var captureID: String?
    @State private var refreshGeneration = 0
    private func time(_ ms: Int64) -> String {
        let f = DateFormatter(); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "HH:mm:ss"
        return f.string(from: Date(timeIntervalSince1970: Double(ms)/1000))
    }
    private func refresh() async {
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            if day.isEmpty {
                let (statusData,_) = try await service.analysisRequest("analysisStatus",input: "{}")
                let analysis = try JSONDecoder().decode(AnalysisStatus.self,from: statusData)
                let raw = try await service.status().days.map(\.day)
                day = (analysis.days + raw).max() ?? analysisDay(journalNowMs())
            }
            let requestedDay = day
            let (data,_) = try await service.analysisRequest("analysisExport", input: analysisJSON(["day":requestedDay]))
            guard !Task.isCancelled, generation == refreshGeneration, requestedDay == day else { return }
            snapshot = try JSONDecoder().decode(AnalysisExport.self, from: data)
            selected = snapshot?.cards.first { $0.cardID == selected?.cardID }
            playback = nil; captureID = nil
            message = snapshot?.cards.isEmpty == true ? "尚未整理出事项，可切换原始记录" : "仅已记录范围 · 上海时间"
            if snapshot?.coverage != "complete" { message += " · 覆盖不完整" }
            if let summary = snapshot?.summary { message += "\n" + summary }
        } catch {
            guard generation == refreshGeneration, !Task.isCancelled else { return }
            snapshot = nil; selected = nil; playback = nil; captureID = nil
            message = "事项暂不可用，原始记录仍可查看"
        }
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
    private func openConversation(_ thread: String) {
        guard let device = snapshot?.deviceID else { return }
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
