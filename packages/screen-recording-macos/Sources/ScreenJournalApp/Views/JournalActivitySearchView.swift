import SwiftUI

struct JournalActivitySearchView: View {
    let service: JournalReadService
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var from = Calendar.searchShanghai.date(byAdding: .day, value: -6, to: Date())!
    @State private var to = Date()
    @State private var response: AnalysisSearchResponse?
    @State private var message = "输入关键词后搜索"
    @State private var generation = 0
    @State private var task: Task<Void, Never>?
    @State private var loading = false
    private var today: Date { Calendar.searchShanghai.startOfDay(for: Date()) }
    private var earliest: Date { Calendar.searchShanghai.date(byAdding: .day, value: -29, to: today)! }
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    TextField("搜索标题和摘要", text: Binding(get: { query }, set: { if query != $0 { query = $0; invalidate() } }))
                        .textFieldStyle(.roundedBorder).onSubmit(search)
                        .accessibilityIdentifier("activity-search-query")
                    Button("搜索", action: search).disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .keyboardShortcut(.return, modifiers: .command)
                }
                HStack {
                    ForEach([1,7,30], id: \.self) { days in
                        Button(days == 1 ? "今天" : "近 \(days) 天") {
                            to = today; from = Calendar.searchShanghai.date(byAdding: .day, value: 1-days, to: today)!; invalidate()
                        }
                    }
                    DatePicker("从", selection: Binding(get: { from }, set: { if !Calendar.searchShanghai.isDate(from, inSameDayAs: $0) { from = $0; invalidate() } }), in: earliest...Date(), displayedComponents: .date)
                    DatePicker("至", selection: Binding(get: { to }, set: { if !Calendar.searchShanghai.isDate(to, inSameDayAs: $0) { to = $0; invalidate() } }), in: earliest...Date(), displayedComponents: .date)
                }
                Text("上海时间 · 仅搜索已整理事项").font(.caption).foregroundStyle(.secondary)
                if loading { ProgressView() }
                Text(message).foregroundStyle(.secondary)
                List(response?.items ?? []) { item in
                    if let response {
                        NavigationLink {
                            JournalSearchDetail(service: service, item: item, source: response) {
                                invalidate(); message = "记录服务已变化或不可达，请重新搜索"
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("\(item.day) · \(searchTime(item.firstStartMs))–\(searchTime(item.lastEndMs))" + (item.spanCount > 1 ? " · 多段" : "")).font(.caption)
                                Text(item.title).font(.headline)
                                Text(item.summary).lineLimit(3)
                                Text((item.actor == "agent" ? "Agent 后台" : item.actor == "mixed" ? "混合" : "本人活动") + " · 命中" + item.matchedFields.map { $0 == "title" ? "标题" : "摘要" }.joined(separator: "／")).font(.caption)
                            }.padding(.vertical, 4)
                        }
                    }
                }
            }.padding().navigationTitle("搜索事项")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { invalidate(); dismiss() } } }
        }
        .environment(\.timeZone, TimeZone(identifier: "Asia/Shanghai")!)
        .frame(minWidth: 760, minHeight: 560)
        .onDisappear { task?.cancel(); generation += 1 }
    }
    private func invalidate() {
        task?.cancel(); generation += 1; response = nil; loading = false
        message = query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "输入关键词后搜索" : "条件已改变，请搜索"
    }
    private func search() {
        invalidate()
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let current = generation
        let request = AnalysisSearchRequest(q: query, from: analysisDay(Int64(from.timeIntervalSince1970*1000)), to: analysisDay(Int64(to.timeIntervalSince1970*1000)))
        loading = true; message = "正在搜索…"
        task = Task {
            do {
                let (capability,_) = try await service.analysisRequest("analysisStatus", input: "{}")
                guard try JSONDecoder().decode(AnalysisStatus.self, from: capability).keywordSearchVersion == 1 else { throw JournalReadError("UPDATE_REQUIRED") }
                let (data,_) = try await service.analysisRequest("analysisSearch", input: analysisJSON(request))
                let result = try JSONDecoder().decode(AnalysisSearchResponse.self, from: data)
                let status = try await service.status()
                guard !Task.isCancelled, current == generation else { return }
                guard status.deviceID == result.deviceID, status.serverEpoch == result.serverEpoch else { throw JournalReadError("VIEW_EXPIRED") }
                response = result; loading = false
                message = result.hasMore ? "已显示最新 100 条，请缩小日期范围或补充关键词" : result.items.isEmpty ? "未找到匹配的已整理事项，可调整关键词／日期或查看原始记录" : "找到 \(result.items.count) 条事项"
            } catch {
                guard !Task.isCancelled, current == generation else { return }
                loading = false; message = searchError(error)
            }
        }
    }
}

private struct JournalSearchDetail: View {
    let service: JournalReadService
    let item: AnalysisSearchItem
    let source: AnalysisSearchResponse
    let onInvalidated: () -> Void
    @State private var snapshot: AnalysisExport?
    @State private var card: AnalysisCard?
    @State private var message = "正在读取事项…"
    var body: some View {
        VStack(alignment: .leading) {
            if !message.isEmpty { Text(message).foregroundStyle(.secondary).padding() }
            if let card, let snapshot {
                JournalActivityDetail(service: service, selected: card, evidence: snapshot.evidence, deviceID: snapshot.deviceID)
            }
        }.navigationTitle("事项详情").task {
            do {
                try await checkSource()
                let (data,_) = try await service.analysisRequest("analysisExport", input: analysisJSON(["day": item.day]))
                let value = try JSONDecoder().decode(AnalysisExport.self, from: data)
                try await checkSource()
                guard !Task.isCancelled else { return }
                guard value.deviceID == source.deviceID, let current = value.cards.first(where: { $0.cardID == item.cardID }) else { throw JournalReadError("NOT_FOUND") }
                snapshot = value; card = current; message = current.revision == item.revision ? "" : "事项已更新，正在显示当前内容"
                while !Task.isCancelled { try await Task.sleep(for: .seconds(2)); try await checkSource() }
            } catch {
                guard !Task.isCancelled else { return }
                snapshot = nil; card = nil; message = "事项已变化或服务不可用，请返回重新搜索"
                onInvalidated()
            }
        }
    }
    private func checkSource() async throws {
        let status = try await service.status()
        guard status.deviceID == source.deviceID, status.serverEpoch == source.serverEpoch else { throw JournalReadError("VIEW_EXPIRED") }
    }
}
private extension Calendar {
    static var searchShanghai: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "Asia/Shanghai")!; return c }
}
private func searchTime(_ ms: Int64) -> String {
    let f = DateFormatter(); f.timeZone = TimeZone(identifier: "Asia/Shanghai"); f.dateFormat = "HH:mm"
    return f.string(from: Date(timeIntervalSince1970: Double(ms)/1000))
}
private func searchError(_ error: Error) -> String {
    switch (error as? JournalReadError)?.code {
    case "UPDATE_REQUIRED", "INCOMPATIBLE": return "请更新 Mac 记录服务以搜索事项"
    case "INVALID_ARGUMENT": return "请输入最多 100 个字符、8 个词，并选择最近 30 天内的有效起止日期"
    case "NOT_RUNNING": return "记录服务不可达，请稍后重试"
    case "VIEW_EXPIRED": return "记录服务已变化，请重新搜索"
    case "BUSY": return "搜索繁忙，请缩小范围后重试"
    default: return "查询失败，请重试；原始记录仍可查看"
    }
}
