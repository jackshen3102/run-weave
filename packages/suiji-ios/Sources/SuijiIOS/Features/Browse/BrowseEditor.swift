import Clarity
import PhotosUI
import SwiftUI
struct BrowseEditor: View {
  @ObservedObject var model: BrowseModel
  @State private var photo: PhotosPickerItem?
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    NavigationStack {
      Form {
        Section("保存到浏览") {
          TextEditor(text:$model.local.draft.body).frame(minHeight:180).accessibilityLabel("浏览文字")
          TextField("原文链接（可选）",text:$model.local.draft.url).textInputAutocapitalization(.never).keyboardType(.URL)
          DatePicker("归属日期", selection:Binding(get:{ MaterialInput(inputType:"text",date:ISO8601DateFormatter().date(from:model.local.draft.date + "T00:00:00+08:00") ?? Date()).date },set:{ model.local.draft.date = MaterialInput.day($0) }), in:...Date(),displayedComponents:.date)
          PhotosPicker(selection:$photo,matching:.images) { Label("选择照片或截图",systemImage:"photo") }
          if let data = model.local.draft.image, let image = UIImage(data:data) { Image(uiImage:image).resizable().scaledToFit(); Button("移除图片") { model.local.draft.image = nil; model.saveDraft() } }
        }.disabled(model.local.draft.pending != nil || model.busy)
        if model.local.draft.pending != nil { Text("保存结果待确认；再次保存沿用原请求，不修改已发送内容。").foregroundStyle(.orange) }
        if !model.message.isEmpty { Text(model.message).foregroundStyle(.orange) }
      }.clarityMask().navigationTitle("保存浏览").environment(\.timeZone,TimeZone(identifier:"Asia/Shanghai")!)
        .toolbar { ToolbarItem(placement:.cancellationAction) { Button("收起") { model.saveDraft(); dismiss() } }; ToolbarItem(placement:.confirmationAction) { Button("保存") { Task { await model.save() } }.disabled(model.busy) } }
        .onChange(of:model.local.draft.body) { _,_ in model.saveDraft() }.onChange(of:model.local.draft.url) { _,_ in model.saveDraft() }.onChange(of:model.local.draft.date) { _,_ in model.saveDraft() }
        .onChange(of:photo) { _, value in Task {
          do {
            guard let data = try await value?.loadTransferable(type:Data.self), let image = UIImage(data:data), let jpeg = image.jpegData(compressionQuality:0.85), jpeg.count <= 5 * 1024 * 1024 else { throw MessageError(message:"请选择不超过 5 MiB 的图片") }
            model.local.draft.image = jpeg; model.saveDraft()
          } catch { model.message = error.localizedDescription }
        } }
    }
  }
}
