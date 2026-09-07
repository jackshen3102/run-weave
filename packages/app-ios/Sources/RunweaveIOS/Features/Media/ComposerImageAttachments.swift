import SwiftUI

struct ComposerImageAttachments: View {
  @ObservedObject var drafts: TerminalImageDrafts
  @ObservedObject var session: AppSession
  let terminalID: String
  @State private var preview: TerminalDraftImage?

  var body: some View {
    let images = drafts.images[terminalID] ?? []
    if !images.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(alignment: .top, spacing: 8) {
          ForEach(Array(images.enumerated()), id: \.element.id) { index, image in
            tile(image, number: index + 1)
          }
        }.padding(.vertical, 8).padding(.trailing, 8)
      }
      .sheet(item: $preview) { image in
        NavigationView {
          ImagePreview(image: image.preview)
            .navigationTitle("图片预览").navigationBarTitleDisplayMode(.inline)
            .toolbar {
              ToolbarItem(placement: .confirmationAction) {
                Button("完成") { preview = nil }
              }
            }
        }.navigationViewStyle(.stack)
      }
    }
  }

  private func tile(_ image: TerminalDraftImage, number: Int) -> some View {
    VStack(spacing: 4) {
      Button {
        preview = image
      } label: {
        Image(uiImage: image.preview).resizable().scaledToFill()
          .frame(width: 80, height: 80).clipped()
          .overlay(alignment: .bottom) {
            if image.path == nil && image.failure == nil {
              HStack(spacing: 4) {
                ProgressView().tint(.white)
                Text("上传中").font(.caption2)
              }.foregroundColor(.white).frame(maxWidth: .infinity).padding(.vertical, 4)
                .background(.black.opacity(0.65))
            }
          }
          .clipShape(RoundedRectangle(cornerRadius: 12))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("预览图片 \(number)")
      .accessibilityValue(image.path != nil ? "已上传" : (image.failure == nil ? "上传中" : "上传失败"))
      .overlay(alignment: .topTrailing) {
        Button {
          drafts.remove([image.id], terminalID: terminalID)
        } label: {
          Image(systemName: "xmark.circle.fill").font(.system(size: 21))
            .symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.8))
            .frame(width: 44, height: 44)
        }.buttonStyle(.plain).offset(x: 8, y: -8).accessibilityLabel("移除图片 \(number)")
      }
      if let failure = image.failure {
        Button {
          drafts.upload(image.id, terminalID: terminalID, session: session)
        } label: {
          Label("重试", systemImage: "arrow.clockwise").font(.caption).foregroundColor(.red)
            .frame(minHeight: 32)
        }.buttonStyle(.plain).disabled(!session.canWrite)
          .accessibilityLabel("重试图片 \(number)").accessibilityHint(failure)
        Text(failure).font(.caption2).foregroundColor(.red).lineLimit(2).frame(width: 80)
      }
    }
  }
}
