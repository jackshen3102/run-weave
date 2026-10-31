import SwiftUI
import Clarity

@available(iOS 17.0, *)
struct ScreenRecordingActivitiesView: View {
    @ObservedObject var session: AppSession
    let day: String
    @State private var snapshot: ScreenAnalysisExport?
    @State private var message = "正在读取事项…"
    @State private var reload = 0
    @State private var retryKeys: [String:String] = [:]
    @State private var retryRevisions: [String:Int] = [:]
    private var scope: String { "\(session.generation):\(session.authenticated):\(session.foreground):\(session.health.status.rawValue):\(day):\(reload)" }
    var body: some View {
        Section {
            Text(message).font(.caption).foregroundStyle(.secondary)
            Button("刷新事项") { reload += 1 }
            ForEach(Array((snapshot?.missingIntervals ?? []).enumerated()), id: \.offset) { _, gap in
                if gap.reason == "failed", let batch = gap.batchID {
                    Button("重试分析缺失区间") { Task {
                        guard let api = session.api, let currentRevision = snapshot?.revision else { return }
                        let rev = retryRevisions[batch] ?? currentRevision; retryRevisions[batch] = rev
                        let generation = session.generation
                        let key = retryKeys[batch] ?? UUID().uuidString; retryKeys[batch] = key
                        do {
                            _ = try await api.screenAnalysisRetry(batchID: batch, revision: rev, operationID: key)
                            if generation == session.generation { retryKeys.removeValue(forKey: batch); retryRevisions.removeValue(forKey: batch); reload += 1 }
                        } catch { if generation == session.generation { message = "重试请求未确认，请刷新后重试" } }
                    } }
                }
            }
            ForEach(snapshot?.cards ?? []) { card in
                NavigationLink {
                    ScreenRecordingActivityDetail(session: session,card: card,evidence: snapshot?.evidence ?? [])
                        .id("\(session.generation):\(card.cardID):\(card.revision)")
                } label: {
                    VStack(alignment: .leading,spacing: 6) {
                        Text(card.title).font(.headline)
                        Text(card.summary).font(.subheadline)
                        Text(card.actor == "agent" ? "Agent 后台 · 后台执行" : card.actor == "mixed" ? "混合" : "本人活动").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }.clarityMask().task(id: scope) {
            snapshot = nil
            guard session.authenticated, session.foreground, session.health.status == .online, let api = session.api else { message = "当前连接不可用"; return }
            let generation = session.generation
            do {
                let value = try await api.screenAnalysisExport(day: day)
                guard !Task.isCancelled, generation == session.generation else { return }
                snapshot = value
                message = value.cards.isEmpty ? "尚未整理出事项，可切换原始记录" : "仅已记录范围 · 上海时间"
                if value.coverage != "complete" { message += " · 覆盖不完整" }
                message += "\n" + value.summary
            } catch { if !Task.isCancelled { message = "事项暂不可用，原始记录仍可查看" } }
        }
    }
}
@available(iOS 17.0, *)
private struct ScreenRecordingActivityDetail: View {
    @ObservedObject var session: AppSession
    let card: ScreenAnalysisCard
    let evidence: [ScreenAnalysisEvidence]
    @State private var playback: ScreenRecordingView?
    @State private var revision = ""
    @State private var captureID: String?
    @State private var message = ""
    private var online: Bool { session.authenticated && session.foreground && session.health.status == .online }
    var body: some View {
        List {
            if online {
                Text(card.title).font(.title2)
                Text(card.summary); Text(card.detail)
                Text("事实状态：\(card.state)").font(.caption)
                ForEach(Array(card.spans.enumerated()),id: \.offset) { _, span in
                    Text("\(time(span.startMs))–\(time(span.endMs))" + (span.actor == "agent" ? " · 后台执行" : ""))
                }
                ForEach(evidence.filter { card.evidenceIDs.contains($0.id) },id: \.id) { item in
                    if let capture = item.captureID {
                        Button("查看 \(time(item.occurredAtMs)) 的画面证据") { Task { await resolve(capture) } }
                    }
                }
                if let playback, let api = session.api {
                    NavigationLink("打开原始画面") {
                        ScreenRecordingPlaybackView(session: session,api: api,range: playback.range,revision: revision,timeZone: "Asia/Shanghai",initialCaptureID: captureID)
                    }
                }
                if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
            } else { Text("当前连接不可用") }
        }.navigationTitle("事项详情").clarityMask()
        .onChange(of: online) { _, available in if !available { playback = nil; captureID = nil } }
    }
    private func time(_ ms: Int64) -> String {
        let f = DateFormatter(); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "HH:mm:ss"
        return f.string(from: Date(timeIntervalSince1970: Double(ms)/1000))
    }
    private func resolve(_ id: String) async {
        guard let api = session.api, online else { return }; let generation = session.generation
        do {
            let target = try await api.screenAnalysisResolve(captureID: id)
            guard let rangeID = target["rangeID"], let rev = target["catalogRevision"] else { return }
            let value = try await api.screenOpen(rangeID: rangeID,catalogRevision: rev)
            await api.screenClose(viewID: value.viewID)
            guard !Task.isCancelled, generation == session.generation, online else { return }
            revision = rev; captureID = id; playback = value; message = ""
        } catch { if generation == session.generation { playback = nil; message = "画面证据已过期或不可用，文字事项保留" } }
    }
}
