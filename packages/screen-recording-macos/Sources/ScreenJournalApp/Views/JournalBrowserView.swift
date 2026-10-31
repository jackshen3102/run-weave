import SwiftUI

struct JournalBrowserView: View {
    @ObservedObject var recorder: CaptureCoordinator
    @State private var status: JournalStatus?
    @State private var days: [JournalDay] = []
    @State private var selectedDay = ""
    @State private var ranges: [JournalRange] = []
    @State private var revision = ""
    @State private var selected: JournalRange?
    @State private var error = ""
    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading) {
                Text("屏幕记录").font(.title2.bold())
                Text(status?.timeZone ?? "采集 Mac 的时区").font(.caption).foregroundStyle(.secondary)
                Picker("日期", selection: $selectedDay) { ForEach(days) { day in Text(day.day).tag(day.day) } }
                Button("刷新记录") { Task { await refresh() } }
                if status?.hasPending == true { Text("最近记录整理中").font(.caption) }
                List(ranges, selection: Binding(get: { selected?.rangeID }, set: { id in selected = ranges.first { $0.rangeID == id } })) { range in
                    VStack(alignment: .leading) {
                    if let service = recorder.readService { JournalRangeThumbnail(service: service, range: range, revision: revision) }
                    VStack(alignment: .leading) {
                        Text("\(time(range.startMs))–\(time(range.endMs))").font(.headline).lineLimit(2)
                        Text("\(range.sampleCount) 帧 · 显示器 \(range.displayID)").font(.caption).foregroundStyle(.secondary)
                    }
                    }.tag(range.rangeID).padding(.vertical, 5)
                }
                if !error.isEmpty { Text(error).foregroundStyle(.secondary) }
                if ranges.isEmpty && error.isEmpty { Text("当日无记录").foregroundStyle(.secondary) }
            }.padding().frame(minWidth: 240)
        } detail: {
            if let selected, let service = recorder.readService {
                JournalPlaybackView(service: service, range: selected, revision: revision).id(selected.rangeID + revision)
            } else { ContentUnavailableView("选择时间范围", systemImage: "photo.on.rectangle", description: Text("查看整屏记录，不影响后台采集")) }
        }
        .frame(minWidth: 980, minHeight: 650)
        .task { await refresh() }
        .task {
            guard let service = recorder.readService else { return }
            let stream = await service.invalidations()
            var first = true
            for await _ in stream {
                guard !Task.isCancelled else { return }
                if first { first = false; continue }
                selected = nil; ranges = []; await refresh()
            }
        }
        .task(id: selectedDay) { await loadRanges() }
    }
    private func time(_ ms: Int64) -> String {
        let formatter = DateFormatter(); formatter.timeStyle = .short; formatter.timeZone = TimeZone(identifier: status?.timeZone ?? "") ?? .current
        return formatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
    private func refresh() async {
        guard let service = recorder.readService else { error = "读取服务不可用"; return }
        do {
            status = try await service.status(); var cursor: String?; var result: [JournalDay] = []
            repeat { let page = try await service.days(cursor: cursor, limit: 30); result += page.items; cursor = page.nextCursor } while cursor != nil
            days = result; if !days.contains(where: { $0.day == selectedDay }) { selectedDay = days.first?.day ?? "" }
            await loadRanges(); error = ""
        } catch { self.error = "读取失败，请刷新重试" }
    }
    private func loadRanges() async {
        guard let service = recorder.readService, !selectedDay.isEmpty else { return }
        let day = selectedDay
        do {
            var cursor: String?; var result: [JournalRange] = []; var version = ""
            repeat { let page = try await service.ranges(day: day, cursor: cursor, limit: 200); result += page.items; cursor = page.nextCursor; version = page.catalogRevision } while cursor != nil
            guard selectedDay == day else { return }
            selected = nil; ranges = result; revision = version; error = ""
        } catch { self.error = "目录已变化或暂不可用，请刷新" }
    }
}
