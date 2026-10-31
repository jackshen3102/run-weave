import Clarity
import SwiftUI

@available(iOS 17.0, *)
struct ScreenRecordingPlaybackView: View {
    @StateObject private var model: ScreenRecordingPlaybackModel
    @ObservedObject var session: AppSession
    let api: APIClient
    let range: ScreenRecordingRange
    let revision: String
    let timeZone: String
    @State private var zoom: CGFloat = 1
    @Environment(\.scenePhase) private var scenePhase
    init(session: AppSession, api: APIClient, range: ScreenRecordingRange, revision: String, timeZone: String) {
        self.session = session; self.api = api
        _model = StateObject(wrappedValue: ScreenRecordingPlaybackModel(service: ScreenRecordingSource(api: api))); self.range = range; self.revision = revision; self.timeZone = timeZone
    }
    private var lifecycle: String {
        "\(scenePhase):\(session.generation):\(session.foreground):\(session.authenticated):\(session.health.status.rawValue)"
    }
    var body: some View {
        GeometryReader { geometry in
            if geometry.size.width > geometry.size.height {
                HStack(spacing: 16) {
                    preview
                    VStack(alignment: .leading, spacing: 8) {
                        heading.font(.headline)
                        metadata
                        timeline
                        transport.labelStyle(.iconOnly)
                        Text(time(Int64(model.position))).font(.caption).monospacedDigit()
                        filmstrip
                    }.frame(width: min(310, geometry.size.width * 0.4))
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    heading.font(.title2.bold()).lineLimit(2).minimumScaleFactor(0.75).frame(maxWidth: .infinity, alignment: .leading)
                    preview
                    metadata
                    timeline
                    transport
                    Text(time(Int64(model.position))).font(.caption).monospacedDigit()
                    filmstrip
                }
            }
        }.padding().clarityMask()
        .task(id: lifecycle) {
            if scenePhase == .active, session.foreground, session.authenticated, session.health.status == .online { await model.activate(range, revision: revision) }
            else { model.close() }
        }
        .onChange(of: model.state) { _, value in if value == "playing" { zoom = 1 } }
        .onDisappear { model.close() }

    }
    private var heading: Text { Text("\(time(range.startMs))–\(time(range.endMs)) 的屏幕记录") }
    private var preview: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.9)
                if let image = model.image {
                    ScrollView([.horizontal, .vertical]) {
                        Image(uiImage: image).resizable().scaledToFit()
                            .frame(width: geometry.size.width * zoom, height: geometry.size.height * zoom)
                    }.gesture(MagnifyGesture().onChanged { value in
                        if model.state == "paused" { zoom = min(4, max(1, value.magnification)) }
                    })
                } else {
                    VStack {
                        Image(systemName: model.current?.privacyPlaceholder == true ? "lock.fill" : "photo").font(.largeTitle)
                        Text(model.message)
                    }.foregroundStyle(.white)
                }
            }.clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
    @ViewBuilder private var metadata: some View {
        if let current = model.current {
            Text(current.privacyPlaceholder ? "\(time(current.capturedAtMs)) · 隐私保护" : "\(time(current.capturedAtMs)) · 前台应用：\(current.frontmostApplication?.name ?? "未知应用")").font(.caption)
        }
    }
    private var timeline: some View {
        ScreenRecordingTimelineSlider(value: Binding(get: { model.position }, set: { model.scrub($0) }),
            bounds: Double(range.startMs)...Double(max(range.startMs + 1, range.endMs)),
            enabled: model.state != "unavailable" && model.view != nil,
            began: { model.beginScrub() }, ended: { model.endScrub() })
            .frame(height: 31)
    }
    private var transport: some View {
        HStack {
            Button("上一帧", systemImage: "backward.end.fill") { model.step(-1) }
            Button(model.state == "playing" || model.state == "buffering" ? "暂停" : "播放", systemImage: model.state == "playing" ? "pause.fill" : "play.fill") { model.toggle() }
            Button("下一帧", systemImage: "forward.end.fill") { model.step(1) }
            Picker("速度", selection: Binding(get: { model.speed }, set: { model.setSpeed($0) })) {
                ForEach([20,40,60], id: \.self) { Text("\($0)×").tag($0) }
            }.frame(width: 85)
        }.disabled(model.state == "unavailable" || model.view == nil)
    }
    private var filmstrip: some View {
        ScrollView(.horizontal) {
            LazyHStack {
                ForEach(model.state == "unavailable" ? [] : (model.view?.captures ?? [])) { capture in
                    Button { model.select(capture) } label: {
                        VStack {
                            if let view = model.view {
                                ScreenRecordingFilmstripFrame(service: model.service, viewID: view.viewID, capture: capture)
                            }
                            Text(time(capture.capturedAtMs)).font(.caption2)
                        }.frame(width: 80, height: 65)
                            .background(model.current?.id == capture.id ? Color.accentColor.opacity(0.25) : Color.gray.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(.plain)
                }
            }
        }.frame(height: 80)
    }
    private func time(_ value: Int64) -> String {
        let formatter = DateFormatter(); formatter.timeStyle = .medium
        formatter.timeZone = TimeZone(identifier: timeZone) ?? .current
        return formatter.string(from: Date(timeIntervalSince1970: Double(value) / 1000))
    }
}

// Keep one native control throughout playback updates. SwiftUI Slider can emit
// a second editing-began callback while reconciling an editing-ended update.
@available(iOS 17.0, *)
private struct ScreenRecordingTimelineSlider: UIViewRepresentable {
    @Binding var value: Double
    let bounds: ClosedRange<Double>
    let enabled: Bool
    let began: () -> Void
    let ended: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UISlider {
        let slider = UISlider()
        slider.minimumValue = 0; slider.maximumValue = 1; slider.isContinuous = true
        slider.accessibilityLabel = "回放时间"
        slider.addTarget(context.coordinator, action: #selector(Coordinator.begin), for: .touchDown)
        slider.addTarget(context.coordinator, action: #selector(Coordinator.changed), for: .valueChanged)
        slider.addTarget(context.coordinator, action: #selector(Coordinator.end), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        return slider
    }
    func updateUIView(_ slider: UISlider, context: Context) {
        context.coordinator.parent = self
        slider.isEnabled = enabled
        if !slider.isTracking {
            slider.value = Float((value - bounds.lowerBound) / (bounds.upperBound - bounds.lowerBound))
        }
    }
    final class Coordinator: NSObject {
        var parent: ScreenRecordingTimelineSlider
        private var tracking = false
        init(_ parent: ScreenRecordingTimelineSlider) { self.parent = parent }
        @objc func begin(_ slider: UISlider) {
            guard !tracking, parent.enabled else { return }
            tracking = true; parent.began()
        }
        @objc func changed(_ slider: UISlider) {
            guard parent.enabled else { return }
            // VoiceOver adjustment has no touch-down/up events.
            let adjustment = !tracking
            if adjustment { parent.began() }
            parent.value = parent.bounds.lowerBound + Double(slider.value) * (parent.bounds.upperBound - parent.bounds.lowerBound)
            if adjustment { parent.ended() }
        }
        @objc func end(_ slider: UISlider) {
            guard tracking else { return }
            changed(slider); tracking = false; parent.ended()
        }
    }
}
