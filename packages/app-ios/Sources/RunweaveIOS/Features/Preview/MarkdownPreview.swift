import SwiftUI

struct MarkdownPreview: View {
  let content: String

  // Keep YAML front matter visible as source rather than interpreting it as headings.
  private var renderedContent: String {
    let lines = content.components(separatedBy: "\n")
    guard lines.first?.trimmingCharacters(in: .whitespaces) == "---",
      let end = lines.indices.dropFirst().first(where: {
        lines[$0].trimmingCharacters(in: .whitespaces) == "---"
      }) else { return content }
    let frontmatter = lines[...end].map { "    " + $0 }.joined(separator: "\n")
    return frontmatter + "\n\n" + lines.dropFirst(end + 1).joined(separator: "\n")
  }

  var body: some View {
    ScrollView {
      MarkdownContent(content: renderedContent)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }
    .environment(\.openURL, OpenURLAction { url in
      ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") ? .systemAction : .discarded
    })
  }
}
