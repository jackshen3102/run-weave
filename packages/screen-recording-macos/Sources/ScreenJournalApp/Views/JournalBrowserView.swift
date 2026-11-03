import SwiftUI
import AppKit

struct JournalBrowserView: View {
    @ObservedObject var recorder: CaptureCoordinator
    let openSettings: () -> Void
    @State private var tab = "raw"
    @State private var selectedDay = ""
    @State private var screenAccess = CGPreflightScreenCaptureAccess()
    var body: some View {
        Group {
            if tab == "activities", let service = recorder.readService { JournalActivitiesView(service: service, day: $selectedDay) { tab = "raw" } }
            else { JournalRawBrowserView(recorder: recorder, selectedDay: $selectedDay) }
        }
        .frame(minWidth: 980, minHeight: 650)
        .safeAreaInset(edge: .bottom) {
            if !screenAccess {
                HStack {
                    Label("授权屏幕录制后，才能开始记录此 Mac 的屏幕。已有记录仍可查看。", systemImage: "info.circle")
                    Spacer()
                    Button("授权屏幕录制", action: requestPermission)
                }.padding().background(.bar)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            screenAccess = CGPreflightScreenCaptureAccess()
        }
        .onChange(of: recorder.status.state) { _, _ in screenAccess = CGPreflightScreenCaptureAccess() }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("查看内容", selection: $tab) {
                    Text("录屏记录").tag("raw"); Text("整理事项").tag("activities")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 220)
            }
            ToolbarItemGroup(placement: .primaryAction) {
                Label(screenAccess ? recorder.status.displayState : "需要授权", systemImage: "circle.fill")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(recorder.status.state == "recording" ? .green : .secondary)
                    .font(.caption)
                if !screenAccess {
                    Button("授权录屏", action: requestPermission)
                } else if ["failed", "blockedStorage", "blockedPermission"].contains(recorder.status.state) {
                    Button("重试记录", systemImage: "arrow.clockwise") { recorder.start() }
                } else if recorder.status.desiredRecording {
                    Button("暂停记录", systemImage: "pause.fill") { recorder.pause() }
                } else {
                    Button("恢复记录", systemImage: "record.circle") { recorder.start() }
                }
                Button("设置", systemImage: "gearshape", action: openSettings)
                    .help("设置（⌘,）")
            }
        }
    }
    private func requestPermission() {
        _ = CGRequestScreenCaptureAccess()
        screenAccess = CGPreflightScreenCaptureAccess()
    }
}
struct JournalRawBrowserView: View {
    @ObservedObject var recorder: CaptureCoordinator
    @State private var status: JournalStatus?
    @State private var days: [JournalDay] = []
    @Binding var selectedDay: String
    @State private var ranges: [JournalRange] = []
    @State private var revision = ""
    @State private var selected: JournalRange?
    @State private var selectedRevision = ""
    @State private var error = ""
    @State private var loading = true
    @State private var requestGeneration = 0
    private var dayIntervals: [JournalInterval] {
        guard let day = days.first(where: { $0.day == selectedDay }) else { return [] }
        return (status?.intervals ?? []).filter { $0.endMs > day.startMs && $0.startMs < day.endMs }.map {
            JournalInterval(startMs: max(day.startMs, $0.startMs), endMs: min(day.endMs, $0.endMs), kind: $0.kind)
        }.sorted { $0.startMs < $1.startMs }
    }
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading) {
                Text("录屏记录").font(.title2.bold())
                if let status { Text(status.deviceName).font(.caption).foregroundStyle(.secondary) }
                Text(status?.timeZone ?? "采集 Mac 的时区").font(.caption).foregroundStyle(.secondary)
                Picker("日期", selection: $selectedDay) { ForEach(Array(Set(days.map(\.day) + (selectedDay.isEmpty ? [] : [selectedDay]))).sorted(by: >), id: \.self) { Text($0).tag($0) } }
                Button("刷新记录") { Task { await refresh() } }
                if status?.hasPending == true { Text("最新录屏正在保存，完成后自动出现").font(.caption) }
                if !ranges.isEmpty { Text("当天 \(ranges.count) 段录屏").font(.caption).foregroundStyle(.secondary) }
                List(selection: Binding(get: { selected?.rangeID }, set: { id in
                    guard selected?.rangeID != id else { return }
                    selected = ranges.first { $0.rangeID == id }; selectedRevision = revision
                })) {
                    ForEach(ranges) { range in
                    VStack(alignment: .leading) {
                    if let service = recorder.readService { JournalRangeThumbnail(service: service, range: range, revision: revision) }
                    VStack(alignment: .leading) {
                        Text("\(time(range.startMs))–\(time(range.endMs))").font(.headline).lineLimit(2)
                        Text(summary(range)).font(.caption).foregroundStyle(.secondary)
                        if let changes = range.transientChangeCount, changes > 0 {
                            Text("含 \(changes) 次短暂画面变化").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    }.tag(range.rangeID).padding(.vertical, 5)
                    }
                    if !dayIntervals.isEmpty {
                        Section("暂停与缺口") {
                            ForEach(Array(dayIntervals.enumerated()), id: \.offset) { _, interval in
                                VStack(alignment: .leading) {
                                    Text("\(time(interval.startMs))–\(time(interval.endMs))").font(.caption)
                                    Text(interval.kind == "systemInactive" ? "系统未活跃，未采集" : interval.kind == "paused" ? "采集已暂停" : interval.kind == "unknown" ? "无采样，原因未知" : "采集失败或不可记录")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                if !error.isEmpty { Text(error).foregroundStyle(.secondary) }
                if loading { ProgressView("正在读取录屏…") }
            }.padding().frame(minWidth: 240)
        } detail: {
            if let selected, let service = recorder.readService {
                JournalPlaybackView(service: service, range: selected, revision: selectedRevision).id(selected.rangeID + selectedRevision)
            } else if loading {
                ProgressView("正在读取录屏…")
            } else if !error.isEmpty {
                ContentUnavailableView("录屏列表暂不可用", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if ranges.isEmpty {
                ContentUnavailableView(status?.hasPending == true ? "录屏正在保存" : "当天没有录屏", systemImage: "video", description: Text(status?.hasPending == true ? "已有画面正在保存，完成后会自动显示。" : days.isEmpty ? "暂无可回看的录屏。请确认已授权并开启屏幕录制。" : "所选日期没有可回看的录屏，可以选择其他日期。"))

            } else {
                ContentUnavailableView("选择一段录屏开始回看", systemImage: "play.rectangle", description: Text("当天已有 \(ranges.count) 段录屏，无需等待事项整理。"))
            }
        }
        .frame(minWidth: 980, minHeight: 650)
        .task {
            while !Task.isCancelled {
                await refresh()
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
        .task {
            guard let service = recorder.readService else { return }
            let stream = await service.invalidations()
            var first = true
            for await _ in stream {
                guard !Task.isCancelled else { return }
                if first { first = false; continue }
                selected = nil; ranges = []; revision = ""; await refresh()
            }
        }
        .task(id: selectedDay) { await loadRanges(resetSelection: true) }
    }
    private func summary(_ range: JournalRange) -> String {
        let seconds = max(0, (range.endMs - range.startMs) / 1000)
        let minutes = seconds / 60
        let duration = seconds == 0 ? "单次采样" : minutes == 0 ? "不足 1 分钟" : minutes < 60 ? "\(minutes) 分钟" : "\(minutes / 60) 小时 \(minutes % 60) 分钟"
        let kind: String
        switch range.activityKind {
        case "quiet": kind = "无输入 · 主体画面稳定"
        case "passive": kind = "无输入 · 画面有变化"
        case "unknown": kind = "无输入 · 变化状态未知"
        case "privacy": kind = "隐私保护"
        default: kind = "已记录画面"
        }
        return duration + " · " + kind
    }
    private func time(_ ms: Int64) -> String {
        let formatter = DateFormatter(); formatter.timeStyle = .short; formatter.timeZone = TimeZone(identifier: status?.timeZone ?? "") ?? .current
        return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
    private func refresh() async {
        guard let service = recorder.readService else { error = "记录服务尚未就绪，正在自动重试。"; loading = false; return }
        do {
            let value = try await service.status()
            guard !Task.isCancelled else { return }
            let changed = status?.serverEpoch != value.serverEpoch || revision != value.catalogRevision
            if let status, status.serverEpoch != value.serverEpoch { selected = nil; ranges = []; revision = "" }
            status = value; days = value.days
            if selectedDay.isEmpty { selectedDay = days.first?.day ?? "" }
            if changed || !error.isEmpty { await loadRanges() }
        } catch {
            guard !Task.isCancelled else { return }
            selected = nil; ranges = []; loading = false; self.error = "暂时无法读取录屏，正在自动重试。"
        }
    }
    private func loadRanges(resetSelection: Bool = false) async {
        guard let service = recorder.readService else { return }
        requestGeneration += 1
        let request = requestGeneration, day = selectedDay
        loading = true; error = ""
        if resetSelection { selected = nil; ranges = [] }
        defer { if request == requestGeneration { loading = false } }
        guard !day.isEmpty else { revision = status?.catalogRevision ?? ""; return }
        do {
            var cursor: String?; var result: [JournalRange] = []; var version = ""
            repeat {
                let page = try await service.ranges(day: day, cursor: cursor, limit: 200)
                try Task.checkCancellation()
                result += page.items; cursor = page.nextCursor; version = page.catalogRevision
            } while cursor != nil
            guard !Task.isCancelled, selectedDay == day, request == requestGeneration else { return }
            // An open view owns its frame snapshot. A different catalog revision
            // must not recreate it while its range is still listed and readable.
            if let selected, !result.contains(where: { $0.rangeID == selected.rangeID }) { self.selected = nil }
            ranges = result; revision = version
        } catch {
            guard !Task.isCancelled, selectedDay == day, request == requestGeneration else { return }
            self.error = "录屏目录正在更新或暂不可用，正在自动重试。"
        }
    }
}
