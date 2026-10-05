import Clarity
import SwiftUI

struct ComposerAttachments: View {
  @ObservedObject var drafts: TerminalAttachmentDrafts
  @ObservedObject var session: AppSession
  let terminalID: String
  @State private var preview: TerminalDraftAttachment?

  var body: some View {
    let attachments = drafts.attachments[terminalID] ?? []
    if !attachments.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(alignment: .top, spacing: 8) {
          ForEach(Array(attachments.enumerated()), id: \.element.id) { index, image in
            tile(image, number: index + 1).clarityMask()
          }
        }.padding(.vertical, 8).padding(.trailing, 8)
      }
      .sheet(item: $preview) { image in
        NavigationView {
          if let thumbnail = image.preview {
            ImagePreview(image: thumbnail)
              .navigationTitle("图片预览").navigationBarTitleDisplayMode(.inline)
              .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                  Button("完成") { preview = nil }
                }
              }
          }
        }.navigationViewStyle(.stack)
      }
    }
  }

  private func tile(_ image: TerminalDraftAttachment, number: Int) -> some View {
    VStack(spacing: 4) {
      Button {
        if image.preview != nil { preview = image }
      } label: {
        Group {
          if let thumbnail = image.preview {
            Image(uiImage: thumbnail).resizable().scaledToFill()
          } else {
            Image(systemName: "doc.fill").font(.system(size: 36))
              .frame(maxWidth: .infinity, maxHeight: .infinity)
              .background(TerminalAppearance.panel)
          }
        }
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
      .accessibilityLabel(image.fileName.map { "文件 \($0)" } ?? "预览图片 \(number)")
      .accessibilityValue(image.path != nil ? "已上传" : (image.failure == nil ? "上传中" : "上传失败"))
      .overlay(alignment: .topTrailing) {
        Button {
          drafts.remove([image.id], terminalID: terminalID)
        } label: {
          Image(systemName: "xmark.circle.fill").font(.system(size: 21))
            .symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.8))
            .frame(width: 44, height: 44)
        }.buttonStyle(.plain).offset(x: 8, y: -8)
          .accessibilityLabel(image.fileName.map { "移除文件 \($0)" } ?? "移除图片 \(number)")
      }
      if let fileName = image.fileName {
        Text(fileName).font(.caption2).lineLimit(2).frame(width: 100)
      }
      if let failure = image.failure {
        Button {
          drafts.upload(image.id, terminalID: terminalID, session: session)
        } label: {
          Label("重试", systemImage: "arrow.clockwise").font(.caption).foregroundColor(.red)
            .frame(minHeight: 32)
        }.buttonStyle(.plain).disabled(!session.canWrite)
          .accessibilityLabel(image.fileName.map { "重试文件 \($0)" } ?? "重试图片 \(number)").accessibilityHint(failure)
        Text(failure).font(.caption2).foregroundColor(.red).lineLimit(2).frame(width: 80)
      }
    }
  }
}
