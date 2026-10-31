import SwiftUI

struct JournalPlaybackView: View {
    @StateObject private var model: JournalPlaybackModel
    let service: JournalReadService
    let range: JournalRange
    let revision: String
    @State private var zoom: CGFloat = 1
    init(service: JournalReadService, range: JournalRange, revision: String) {
        self.service = service
        _model = StateObject(wrappedValue: JournalPlaybackModel(service: service)); self.range = range; self.revision = revision
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(time(range.startMs))–\(time(range.endMs)) 的屏幕记录").font(.title2.bold())
            GeometryReader { geometry in
                ZStack {
                    Color.black.opacity(0.9)
                    if let image = model.image {
                        ScrollView([.horizontal, .vertical]) {
                            Image(nsImage: image).resizable().scaledToFit().frame(width: geometry.size.width * zoom, height: geometry.size.height * zoom)
                        }.gesture(MagnifyGesture().onChanged { value in if model.state == "paused" { zoom = min(4, max(1, value.magnification)) } })
                    } else {
                        VStack { Image(systemName: model.current?.privacyPlaceholder == true ? "lock.fill" : "photo").font(.largeTitle); Text(model.message) }.foregroundStyle(.white)
                    }
                }.clipShape(RoundedRectangle(cornerRadius: 12))
            }
            if let current = model.current {
                Text(current.privacyPlaceholder ? "\(time(current.capturedAtMs)) · 隐私保护" : "\(time(current.capturedAtMs)) · 前台应用：\(current.frontmostApplication?.name ?? "未知应用")").font(.caption)
            }
            Slider(value: Binding(get: { model.position }, set: { model.scrub($0) }), in: Double(range.startMs)...Double(max(range.startMs + 1, range.endMs)), onEditingChanged: { if $0 { model.beginScrub() } else { model.endScrub() } }).accessibilityLabel("回放时间")
            HStack {
                Button("上一帧", systemImage: "backward.end.fill") { model.step(-1) }
                Button(model.state == "playing" || model.state == "buffering" ? "暂停" : "播放", systemImage: model.state == "playing" ? "pause.fill" : "play.fill") { model.toggle() }
                Button("下一帧", systemImage: "forward.end.fill") { model.step(1) }
                Picker("速度", selection: Binding(get: { model.speed }, set: { model.setSpeed($0) })) { ForEach([20,40,60], id: \.self) { Text("\($0)×").tag($0) } }.frame(width: 140)
                Spacer(); Text(time(Int64(model.position))).monospacedDigit()
            }
            ScrollView(.horizontal) {
                LazyHStack {
                    ForEach(model.state == "unavailable" ? [] : (model.view?.captures ?? [])) { capture in
                        Button { model.select(capture) } label: {
                            VStack { if model.state != "unavailable", let view = model.view { JournalFilmstripFrame(service: service, viewID: view.viewID, capture: capture) }; Text(time(capture.capturedAtMs)).font(.caption2) }
                                .frame(width: 80, height: 65).background(model.current?.id == capture.id ? Color.accentColor.opacity(0.25) : Color.gray.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 6))
                        }.buttonStyle(.plain)
                    }
                }
            }.frame(height: 80)
        }.padding()
        .task { await model.open(range, revision: revision) }
        .onChange(of: model.state) { _, value in if value == "playing" { zoom = 1 } }
        .onDisappear { model.close() }
    }
    private func time(_ value: Int64) -> String { Date(timeIntervalSince1970: Double(value) / 1000).formatted(date: .omitted, time: .standard) }
}
