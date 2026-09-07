import SwiftUI

private struct MarkdownBlock: Identifiable {
  let id: Int
  let kind: String
  let text: String
}
struct MarkdownPreview: View {
  let content: String
  private var blocks: [MarkdownBlock] {
    var result: [MarkdownBlock] = []
    var code: [String] = []
    var inCode = false
    var frontmatter = false
    let lines = content.components(separatedBy: "\n")
    func append(_ kind: String, _ text: String) {
      result.append(MarkdownBlock(id: result.count, kind: kind, text: text))
    }
    for (index, line) in lines.enumerated() {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if index == 0 && trimmed == "---"
        && lines.dropFirst().contains(where: { $0.trimmingCharacters(in: .whitespaces) == "---" })
      {
        frontmatter = true
        code.append(line)
        continue
      }
      if frontmatter {
        code.append(line)
        if trimmed == "---" {
          append("code", code.joined(separator: "\n"))
          code = []
          frontmatter = false
        }
        continue
      }
      if line.hasPrefix("```") {
        if inCode {
          append("code", code.joined(separator: "\n"))
          code = []
        }
        inCode.toggle()
        continue
      }
      if inCode {
        code.append(line)
        continue
      }
      if trimmed.isEmpty { continue }
      if trimmed == "---" {
        append("rule", "")
        continue
      }
      if trimmed.hasPrefix("### ") {
        append("h3", String(trimmed.dropFirst(4)))
      } else if trimmed.hasPrefix("## ") {
        append("h2", String(trimmed.dropFirst(3)))
      } else if trimmed.hasPrefix("# ") {
        append("h1", String(trimmed.dropFirst(2)))
      } else if trimmed.hasPrefix("> ") {
        append("quote", String(trimmed.dropFirst(2)))
      } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
        append("body", "• " + trimmed.dropFirst(2))
      } else {
        append("body", trimmed)
      }
    }
    if !code.isEmpty { append("code", code.joined(separator: "\n")) }
    return result
  }
  private func inline(_ text: String) -> AttributedString {
    var value =
      (try? AttributedString(
        markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(text)
    for run in value.runs {
      if let link = run.link,
        !["http", "https", "mailto"].contains(link.scheme?.lowercased() ?? "")
      {
        value[run.range].link = nil
      }
    }
    return value
  }
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 12) {
        ForEach(blocks) { block in
          if block.kind == "rule" {
            Divider()
          } else if block.kind == "code" {
            ScrollView(.horizontal) {
              Text(verbatim: block.text).font(.system(.body, design: .monospaced)).padding(8)
            }.background(Color.secondary.opacity(0.1))
          } else {
            Text(inline(block.text))
              .font(
                block.kind == "h1"
                  ? .title : block.kind == "h2" ? .title2 : block.kind == "h3" ? .headline : .body
              )
              .foregroundColor(block.kind == "quote" ? .secondary : .primary)
          }
        }
      }.frame(maxWidth: .infinity, alignment: .leading).padding().textSelection(.enabled)
    }
  }
}
