import SwiftUI
import Clarity

@available(iOS 17.0, *)
struct ScreenRecordingActivitySearchView: View {
    @ObservedObject var session: AppSession
    var openConversation: (TerminalConversation.Target) -> Void
    @State private var query = ""
    @State private var from = Calendar.searchShanghai.date(byAdding: .day, value: -6, to: Date())!
    @State private var to = Date()
    @State private var response: ScreenAnalysisSearchResponse?
    @State private var resultScope = ""
    @State private var message = "输入关键词后搜索"
    @State private var generation = 0
    @State private var task: Task<Void, Never>?
    @State private var loading = false
    private var scope: String { "\(session.generation):\(session.authenticated):\(session.foreground):\(session.health.status.rawValue)" }
    private var online: Bool { session.authenticated && session.foreground && session.health.status == .online }
    private var today: Date { Calendar.searchShanghai.startOfDay(for: Date()) }
    private var earliest: Date { Calendar.searchShanghai.date(byAdding: .day, value: -29, to: today)! }
    var body: some View {
        List {
            Section {
                TextField("搜索标题和摘要", text: Binding(get: { query }, set: { if query != $0 { query = $0; invalidate() } }))
                    .submitLabel(.search).onSubmit(search).autocorrectionDisabled()
                    .accessibilityIdentifier("activity-search-query")
                HStack {
                    ForEach([1,7,30], id: \.self) { days in
                        Button(days == 1 ? "今天" : "近 \(days) 天") {
                            to = today; from = Calendar.searchShanghai.date(byAdding: .day, value: 1-days, to: today)!; invalidate()
                        }.buttonStyle(.bordered)
                    }
                }
                DatePicker("开始日期", selection: Binding(get: { from }, set: { if !Calendar.searchShanghai.isDate(from, inSameDayAs: $0) { from = $0; invalidate() } }), in: earliest...Date(), displayedComponents: .date)
                DatePicker("结束日期", selection: Binding(get: { to }, set: { if !Calendar.searchShanghai.isDate(to, inSameDayAs: $0) { to = $0; invalidate() } }), in: earliest...Date(), displayedComponents: .date)
                Button("搜索", action: search).disabled(!online || query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Text("上海时间 · 仅搜索已整理事项").font(.caption).foregroundStyle(.secondary)
            }
            Section {
                if loading { ProgressView("正在搜索…") }
                Text(online ? message : "当前连接不可用").foregroundStyle(.secondary)
                if online, resultScope == scope, let response {
                    ForEach(response.items) { item in
                        NavigationLink {
                            ScreenRecordingSearchDetail(session: session, item: item, source: response, sourceScope: scope, openConversation: openConversation, onInvalidated: {
                                invalidate(); message = "记录服务已变化或不可达，请重新搜索"
                            })
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(item.day) · \(searchTime(item.firstStartMs))–\(searchTime(item.lastEndMs))" + (item.spanCount > 1 ? " · 多段" : "")).font(.caption)
                                Text(item.title).font(.headline)
                                Text(item.summary).lineLimit(3)
                                Text((item.actor == "agent" ? "Agent 后台" : item.actor == "mixed" ? "混合" : "本人活动") + " · 命中" + item.matchedFields.map { $0 == "title" ? "标题" : "摘要" }.joined(separator: "／")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }.navigationTitle("搜索事项").clarityMask()
        .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
        .onChange(of: scope) { _, _ in invalidate(); message = online ? "连接状态已变化，请重新搜索" : "当前连接不可用" }
        .onDisappear { task?.cancel(); generation += 1; loading = false }
        .task(id: scope) {
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                    guard let response, let api = session.api, online else { continue }
                    let current = generation
                    do {
                        let status = try await api.screenStatus()
                        guard !Task.isCancelled, current == generation else { continue }
                        guard status.availability == "ready", status.deviceID == response.deviceID, status.serverEpoch == response.serverEpoch else { throw ScreenRecordingReadError("VIEW_EXPIRED") }
                    } catch {
                        guard !Task.isCancelled, current == generation else { continue }
                        invalidate(); message = "记录服务已变化或不可达，请重新搜索"
                    }
                } catch { return }
            }
        }
    }
    private func invalidate() {
        task?.cancel(); generation += 1; response = nil; resultScope = ""; loading = false
        message = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "输入关键词后搜索" : "条件已改变，请搜索"
    }
    private func search() {
        invalidate()
        guard online, let api = session.api, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let current = generation, requestedScope = scope
        let request = ScreenAnalysisSearchRequest(q: query, from: searchDay(from), to: searchDay(to))
        loading = true; message = ""
        task = Task {
            do {
                let capability = try await api.screenAnalysisStatus()
                guard capability.keywordSearchVersion == 1 else { throw ScreenRecordingReadError("INCOMPATIBLE") }
                let value = try await api.screenAnalysisSearch(request)
                let status = try await api.screenStatus()
                guard !Task.isCancelled, current == generation, requestedScope == scope, online else { return }
                guard status.availability == "ready", status.deviceID == value.deviceID, status.serverEpoch == value.serverEpoch else { throw ScreenRecordingReadError("VIEW_EXPIRED") }
                response = value; resultScope = requestedScope; loading = false
                message = value.hasMore ? "已显示最新 100 条，请缩小日期范围或补充关键词" : value.items.isEmpty ? "未找到匹配的已整理事项，可调整关键词／日期或查看原始记录" : "找到 \(value.items.count) 条事项"
            } catch {
                guard !Task.isCancelled, current == generation, requestedScope == scope else { return }
                loading = false; message = searchError(error)
            }
        }
    }
}

@available(iOS 17.0, *)
private struct ScreenRecordingSearchDetail: View {
    @ObservedObject var session: AppSession
    let item: ScreenAnalysisSearchItem
    let source: ScreenAnalysisSearchResponse
    let sourceScope: String
    var openConversation: (TerminalConversation.Target) -> Void
    let onInvalidated: () -> Void
    @State private var snapshot: ScreenAnalysisExport?
    @State private var card: ScreenAnalysisCard?
    @State private var invalidated = false
    @State private var message = "正在读取事项…"
    private var scope: String { "\(session.generation):\(session.authenticated):\(session.foreground):\(session.health.status.rawValue)" }
    private var available: Bool { !invalidated && scope == sourceScope && session.authenticated && session.foreground && session.health.status == .online }
    var body: some View {
        Group {
            if available, let card, let snapshot {
                VStack(spacing: 0) {
                    if !message.isEmpty { Text(message).font(.caption).foregroundStyle(.secondary).padding() }
                    ScreenRecordingActivityDetail(session: session, card: card, evidence: snapshot.evidence, openConversation: openConversation)
                }
            } else { Text(available ? message : "事项已变化或连接不可用，请返回重新搜索").padding() }
        }.navigationTitle("事项详情").clarityMask()
        .onChange(of: scope) { _, _ in invalidated = true; card = nil; snapshot = nil; onInvalidated() }
        .task(id: scope) {
            guard available, let api = session.api else { card = nil; snapshot = nil; return }
            do {
                try await checkSource(api)
                let value = try await api.screenAnalysisExport(day: item.day)
                try await checkSource(api)
                guard !Task.isCancelled, available else { return }
                guard value.deviceID == source.deviceID, let current = value.cards.first(where: { $0.cardID == item.cardID }) else { throw ScreenRecordingReadError("NOT_FOUND") }
                snapshot = value; card = current; message = current.revision == item.revision ? "" : "事项已更新，正在显示当前内容"
                while !Task.isCancelled { try await Task.sleep(for: .seconds(2)); try await checkSource(api) }
            } catch {
                guard !Task.isCancelled else { return }
                invalidated = true; card = nil; snapshot = nil; onInvalidated()
            }
        }
    }
    private func checkSource(_ api: APIClient) async throws {
        let status = try await api.screenStatus()
        guard available, status.availability == "ready", status.deviceID == source.deviceID, status.serverEpoch == source.serverEpoch else { throw ScreenRecordingReadError("VIEW_EXPIRED") }
    }
}
private extension Calendar {
    static var searchShanghai: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "Asia/Shanghai")!; return c }
}
private func searchDay(_ date: Date) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "yyyy-MM-dd"
    return f.string(from: date)
}
private func searchTime(_ ms: Int64) -> String {
    let f = DateFormatter(); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "HH:mm"
    return f.string(from: Date(timeIntervalSince1970: Double(ms)/1000))
}
private func searchError(_ error: Error) -> String {
    switch (error as? ScreenRecordingReadError)?.code {
    case "UPDATE_REQUIRED": return "请更新当前连接的 Runweave Backend"
    case "INCOMPATIBLE", "INVALID_METHOD": return "请更新 Mac 记录服务以搜索事项"
    case "INVALID_ARGUMENT": return "请输入最多 100 个字符、8 个词，并选择最近 30 天内的有效起止日期"
    case "NOT_RUNNING", "TIMEOUT": return "记录服务不可达，请稍后重试"
    case "VIEW_EXPIRED": return "记录服务已变化，请重新搜索"
    case "BUSY": return "搜索繁忙，请缩小范围后重试"
    default: return "查询失败，请重试；原始记录仍可查看"
    }
}
