import Clarity
import SwiftUI

@available(iOS 17.0, *)
struct ScreenRecordingBrowserView: View {
    @ObservedObject var session: AppSession
    @Environment(\.dismiss) private var dismiss
    @State private var reload = 0
    @State private var lastConfirmed: ContinuousClock.Instant?
    @State private var status: ScreenRecordingStatus?
    @State private var days: [ScreenRecordingDay] = []
    @State private var day = ""
    @State private var ranges: [ScreenRecordingRange] = []
    @State private var revision = ""
    @State private var message = "正在连接记录服务…"
    private var scope: String { "\(session.generation):\(session.authenticated):\(session.foreground):\(session.health.status.rawValue)" }
    var body: some View {
        NavigationStack {
            List {
                if let status, status.availability == "ready" {
                    Text(status.timeZone).font(.caption)
                    Picker("日期", selection: $day) { ForEach(days) { Text($0.day).tag($0.day) } }
                    if status.hasPending { Text("最近记录整理中").foregroundStyle(.secondary) }
                    if let api = session.api {
                        ForEach(ranges) { range in
                            NavigationLink {
                                ScreenRecordingPlaybackView(session: session, api: api, range: range, revision: revision, timeZone: status.timeZone)
                                    .id("\(session.generation):" + range.rangeID)
                            } label: {
                                HStack {
                                ScreenRecordingRangeThumbnail(api: api, range: range, revision: revision)
                                VStack(alignment: .leading) {
                                    Text("\(time(range.startMs))–\(time(range.endMs)) 的屏幕记录")
                                    Text("\(range.sampleCount) 帧 · 显示器 \(range.displayID)").font(.caption).foregroundStyle(.secondary)
                                }
                                }
                            }
                        }
                    }
                }
                if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
            }
            .navigationTitle("屏幕记录")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .refreshable { reload += 1 }
            .task(id: scope + ":\(reload)") {
                status = nil; ranges = []; days = []; lastConfirmed = nil
                guard session.authenticated, session.foreground, session.health.status == .online else { message = "当前连接不可用"; return }
                await refresh()
                while !Task.isCancelled, let api = session.api {
                    do {
                        try await Task.sleep(for: .seconds(2))
                        let value = try await api.screenStatus()
                        guard !Task.isCancelled else { return }
                        if value.availability != "ready" || value.serverEpoch != status?.serverEpoch {
                            status = nil; ranges = []; message = "记录服务已变化，请下拉刷新"; return
                        }
                        lastConfirmed = .now
                    } catch {
                        guard !Task.isCancelled else { return }
                        status = nil; ranges = []; lastConfirmed = nil; message = "记录服务不可用，请下拉刷新"; return
                    }
                }
            }
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(100))
                    if let confirmed = lastConfirmed, confirmed.duration(to: .now) > .seconds(5) {
                        status = nil; ranges = []; lastConfirmed = nil; message = "连接已失效，请下拉刷新"
                    }
                }
            }
            .task(id: day) { await loadRanges() }
        }.id(session.generation).clarityMask()
    }
    private func refresh() async {
        guard let api = session.api else { return }; let generation = session.generation
        do {
            let result = try await api.screenStatus()
            guard !Task.isCancelled, generation == session.generation else { return }
            status = result; lastConfirmed = .now
            switch result.availability {
            case "notRunning": message = "请在这台 Mac 启动 ScreenJournal"; return
            case "unsupported": message = "当前连接的机器不支持屏幕记录"; return
            case "incompatible": message = "请更新 Mac 记录服务"; return
            default: break
            }
            var cursor: String?; var items: [ScreenRecordingDay] = []
            repeat { let page = try await api.screenDays(cursor: cursor); items += page.items; cursor = page.nextCursor } while cursor != nil
            guard !Task.isCancelled, generation == session.generation else { return }
            days = items; if !items.contains(where: { $0.day == day }) { day = items.first?.day ?? "" }
            await loadRanges()
        } catch { guard !Task.isCancelled else { return }; message = (error as? ScreenRecordingReadError)?.code == "UPDATE_REQUIRED" ? "请更新当前连接的 Runweave Backend" : "记录服务不可用"; status = nil }
    }
    private func loadRanges() async {
        guard let api = session.api, !day.isEmpty else { message = "当日无记录"; return }
        let selected = day, generation = session.generation
        do {
            var cursor: String?; var items: [ScreenRecordingRange] = []; var version = ""
            repeat { let page = try await api.screenRanges(day: selected, cursor: cursor); items += page.items; cursor = page.nextCursor; version = page.catalogRevision } while cursor != nil
            guard !Task.isCancelled, generation == session.generation, day == selected else { return }
            ranges = items; revision = version; message = items.isEmpty ? "当日无记录" : ""
        } catch { if !Task.isCancelled { ranges = []; message = "目录已变化或连接不可用，请刷新" } }
    }
    private func time(_ ms: Int64) -> String {
        let formatter = DateFormatter(); formatter.timeStyle = .short; formatter.timeZone = TimeZone(identifier: status?.timeZone ?? "") ?? .current
        return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
}
