import Clarity
import MermaidKit
import SwiftUI

/// The bundled engine keeps conversation diagrams available offline.
struct MermaidCodeBlock: View {
  let source: String
  @Environment(\.colorScheme) private var colorScheme
  @State private var failed = false
  @State private var showSource = false
  @State private var expanded = false

  private var configuration: MermaidConfiguration {
    MermaidConfiguration(theme: colorScheme == .dark ? .dark : .default,
      securityLevel: .strict, source: .bundledDefault)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("流程图").font(.caption).foregroundColor(.secondary)
        Spacer()
        if !failed {
          Button { expanded = true } label: {
            Label("放大", systemImage: "arrow.up.left.and.arrow.down.right")
          }
          .font(.caption)
          .accessibilityIdentifier("mermaid-expand")
        }
      }
      if failed {
        Text("流程图暂时无法渲染，原文已保留。")
          .font(.caption).foregroundColor(.secondary)
      } else {
        MermaidView(source, configuration: configuration, onError: { _ in
          failed = true
          showSource = true
        })
        .accessibilityIdentifier("mermaid-diagram")
      }
      DisclosureGroup("查看源码", isExpanded: $showSource) {
        ScrollView(.horizontal) {
          Text(source).font(.system(.caption, design: .monospaced))
            .textSelection(.enabled).fixedSize(horizontal: true, vertical: true)
            .padding(.vertical, 8)
        }
      }
      .font(.caption)
    }
    .padding(12)
    .background(Color(uiColor: .secondarySystemBackground))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .fullScreenCover(isPresented: $expanded) {
      NavigationView {
        MermaidView(source, configuration: configuration, interaction: .panZoom)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Color(uiColor: .systemBackground))
          .navigationTitle("流程图").navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("完成") { expanded = false }
            }
          }
      }.navigationViewStyle(.stack).clarityMask()
    }
  }
}
