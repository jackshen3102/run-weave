import Clarity
import SwiftUI

@available(iOS 17.0, *)
struct ScreenRecordingBrowserView: View {
    @ObservedObject var session: AppSession
    var openConversation: (TerminalConversation.Target) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var tab = "raw"
    @State private var reload = 0
    @State private var lastConfirmed: ContinuousClock.Instant?
    @State private var status: ScreenRecordingStatus?
    @State private var day = ""
    @State private var analysisDays: [String] = []
    @State private var ranges: [ScreenRecordingRange] = []
    @State private var revision = ""
    @State private var loadedDay: String?
    @State private var rangeRequest = 0
    @State private var loadingRanges = false
    @State private var connecting = true
    @State private var connectionMessage = ""
    @State private var rangeError = ""
    private var selectableDays: [String] {
        Array(Set((status?.days.map(\.day) ?? []) + analysisDays)).sorted(by: >)
    }
    private var scope: String { "\(session.generation):\(session.authenticated):\(session.foreground):\(session.health.status.rawValue)" }
    var body: some View {
        NavigationStack {
            List {
                if let status, status.availability == "ready" {
                    Section {
                        Label(status.deviceName.isEmpty ? "当前 Mac" : status.deviceName, systemImage: "desktopcomputer")
                        HStack {
                            Label(status.captureState == "recording" ? "正在记录" : "当前未在记录", systemImage: status.captureState == "recording" ? "record.circle" : "pause.circle")
                            Spacer()
                            Text(status.timeZone).foregroundStyle(.secondary)
                        }.font(.caption)
                        if !selectableDays.isEmpty {
                            Picker("日期", selection: $day) {
                                ForEach(selectableDays, id: \.self) { Text($0).tag($0) }
                            }
                        }
                        Picker("查看内容", selection: $tab) {
                            Text("录屏记录").tag("raw")
                            Text("整理事项").tag("activities")
                        }.pickerStyle(.segmented)
                        if status.hasPending {
                            Label("最新录屏正在保存，完成后自动出现", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if tab == "activities" {
                        Section {
                            Button { tab = "raw" } label: {
                                Label(loadedDay == day && !ranges.isEmpty ? "查看当天 \(ranges.count) 段录屏" : "查看录屏记录", systemImage: "play.rectangle")
                            }
                        }
                        ScreenRecordingActivitiesView(session: session, day: day, openConversation: openConversation)
                            .id("\(status.serverEpoch):\(reload)")
                    } else {
                        recordingContent(status)
                    }
                } else if connecting {
                    ProgressView("正在连接记录服务…")
                } else {
                    ContentUnavailableView {
                        Label("暂时无法读取录屏", systemImage: "wifi.exclamationmark")
                    } description: { Text(connectionMessage) } actions: {
                        Button("重新连接") { reload += 1 }.buttonStyle(.bordered)
                    }
                }
            }
            .navigationTitle("屏幕记录")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("刷新记录", systemImage: "arrow.clockwise") { reload += 1 } }
            }
            .refreshable { reload += 1 }
            .task(id: scope + ":\(reload)") {
                invalidate(); analysisDays = []; connecting = true
                guard session.authenticated, session.foreground, session.health.status == .online else {
                    connecting = false; connectionMessage = "当前电脑未连接。请回到首页检查连接后重试。"; return
                }
                // A restart or transient failure must recover without reopening the page.
                while !Task.isCancelled {
                    await refresh()
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                }
            }
            .task {
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
                    if let confirmed = lastConfirmed, confirmed.duration(to: .now) > .seconds(5) {
                        invalidate(); connectionMessage = "与这台 Mac 的连接已中断，正在自动重连。"
                    }
                }
            }
            .task(id: day) { await loadRanges() }
            .task(id: scope + ":\(tab):\(reload)") {
                guard tab == "activities", session.authenticated, session.foreground,
                      session.health.status == .online, let api = session.api else { return }
                let generation = session.generation
                if let analysis = try? await api.screenAnalysisStatus(), !Task.isCancelled, generation == session.generation {
                    analysisDays = analysis.days ?? []
                    if day.isEmpty { day = selectableDays.first ?? "" }
                }
            }
        }.id(session.generation).clarityMask()
    }
    @ViewBuilder private func recordingContent(_ status: ScreenRecordingStatus) -> some View {
        Section {
            if loadingRanges || loadedDay != day && rangeError.isEmpty {
                ProgressView("正在读取录屏…")
            } else if !rangeError.isEmpty {
                ContentUnavailableView {
                    Label("录屏列表暂不可用", systemImage: "exclamationmark.triangle")
                } description: { Text(rangeError) } actions: {
                    Button("重试") { reload += 1 }
                }
            } else if ranges.isEmpty {
                ContentUnavailableView {
                    Label(status.hasPending ? "录屏正在保存" : "当天没有录屏", systemImage: "video")
                } description: {
                    Text(status.hasPending ? "已有画面正在保存，完成后会自动显示。" : status.days.isEmpty ? "这台 Mac 暂无可回看的录屏。请在 Mac 的 ScreenJournal 中确认录屏已开启并获得授权。" : "所选日期没有可回看的录屏，可以选择其他日期。")
                }
            } else if let api = session.api {
                ForEach(ranges) { range in
                    NavigationLink {
                        ScreenRecordingPlaybackView(session: session, api: api, range: range, revision: revision, timeZone: status.timeZone)
                            .id("\(session.generation):\(status.serverEpoch):" + range.rangeID)
                    } label: {
                        HStack(spacing: 12) {
                            ScreenRecordingRangeThumbnail(api: api, range: range, revision: revision)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(time(range.startMs))–\(time(range.endMs))").font(.headline)
                                Text("\(range.sampleCount) 帧 · 显示器 \(range.displayID)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        } header: { Text(loadedDay == day && !ranges.isEmpty ? "当天 \(ranges.count) 段录屏" : "录屏记录") }
    }
    private func invalidate() {
        rangeRequest += 1
        status = nil; ranges = []; revision = ""; loadedDay = nil; lastConfirmed = nil; loadingRanges = false; rangeError = ""
    }
    private func refresh() async {
        guard let api = session.api else { return }
        let generation = session.generation
        do {
            let result = try await api.screenStatus()
            guard !Task.isCancelled, generation == session.generation else { return }
            connecting = false
            guard result.availability == "ready" else {
                invalidate()
                switch result.availability {
                case "notRunning": connectionMessage = "这台 Mac 的 ScreenJournal 尚未运行，请在 Mac 打开它。"
                case "unsupported": connectionMessage = "当前连接的电脑不支持屏幕记录，请切换到开启 ScreenJournal 的 Mac。"
                case "incompatible": connectionMessage = "这台 Mac 的记录服务版本不兼容，请更新 ScreenJournal。"
                default: connectionMessage = "记录服务暂不可用，正在自动重连。"
                }
                return
            }
            let changed = status?.serverEpoch != result.serverEpoch || status?.deviceID != result.deviceID || revision != result.catalogRevision
            status = result; lastConfirmed = .now; connectionMessage = ""
            if !selectableDays.contains(day) {
                day = selectableDays.first ?? ""
            }
            if changed || loadedDay != day || !rangeError.isEmpty { await loadRanges() }
        } catch {
            guard !Task.isCancelled, generation == session.generation else { return }
            invalidate(); connecting = false
            connectionMessage = (error as? ScreenRecordingReadError)?.code == "UPDATE_REQUIRED"
                ? "当前连接的电脑需要更新 Runweave Backend 才能查看录屏。"
                : "无法连接这台 Mac 的记录服务，正在自动重连。已有录屏不会因此删除。"
        }
    }
    private func loadRanges() async {
        guard let api = session.api, let status, status.availability == "ready" else { return }
        rangeRequest += 1
        let request = rangeRequest, selected = day, generation = session.generation, epoch = status.serverEpoch
        ranges = []; loadedDay = nil; rangeError = ""; loadingRanges = true
        defer { if request == rangeRequest { loadingRanges = false } }
        if selected.isEmpty { loadedDay = selected; revision = status.catalogRevision; return }
        do {
            var cursor: String?; var items: [ScreenRecordingRange] = []; var version = ""
            repeat {
                let page = try await api.screenRanges(day: selected, cursor: cursor)
                try Task.checkCancellation()
                items += page.items; cursor = page.nextCursor; version = page.catalogRevision
            } while cursor != nil
            guard !Task.isCancelled, request == rangeRequest, generation == session.generation, day == selected, self.status?.serverEpoch == epoch else { return }
            ranges = items; revision = version; loadedDay = selected
        } catch {
            guard !Task.isCancelled, request == rangeRequest, generation == session.generation, day == selected else { return }
            rangeError = "录屏目录正在更新或连接暂时中断，正在自动重试。"
        }
    }
    private func time(_ ms: Int64) -> String {
        let formatter = DateFormatter(); formatter.timeStyle = .short; formatter.timeZone = TimeZone(identifier: status?.timeZone ?? "") ?? .current
        return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
}
