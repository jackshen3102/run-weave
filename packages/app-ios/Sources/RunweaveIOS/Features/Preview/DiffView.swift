import SwiftUI

struct DiffLine: Identifiable, Sendable {
  let id: Int
  let kind: String
  let old: Int?
  let new: Int?
  let content: String
}

enum DiffBuilder {
  static func build(old: String, new: String) -> [DiffLine] {
    func split(_ text: String) -> [String] {
      guard !text.isEmpty else { return [] }
      return (text.hasSuffix("\n") ? String(text.dropLast()) : text).components(separatedBy: "\n")
    }
    let a = split(old)
    let b = split(new)
    var result: [DiffLine] = []
    func append(_ kind: String, _ i: Int?, _ j: Int?, _ content: String) {
      result.append(
        DiffLine(
          id: result.count, kind: kind, old: i.map { $0 + 1 }, new: j.map { $0 + 1 },
          content: content))
    }
    let changes = b.difference(from: a)
    var removed = IndexSet()
    var added = IndexSet()
    for change in changes {
      switch change {
      case .remove(let offset, _, _): removed.insert(offset)
      case .insert(let offset, _, _): added.insert(offset)
      }
    }
    var i = 0
    var j = 0
    while i < a.count || j < b.count {
      if removed.contains(i) {
        append("removed", i, nil, a[i])
        i += 1
      } else if added.contains(j) {
        append("added", nil, j, b[j])
        j += 1
      } else {
        append("equal", i, j, a[i])
        i += 1
        j += 1
      }
    }
    var collapsed: [DiffLine] = []
    var cursor = 0
    while cursor < result.count {
      if result[cursor].kind != "equal" {
        collapsed.append(result[cursor])
        cursor += 1
        continue
      }
      let start = cursor
      while cursor < result.count && result[cursor].kind == "equal" { cursor += 1 }
      if cursor - start <= 6 {
        collapsed.append(contentsOf: result[start..<cursor])
      } else {
        collapsed.append(contentsOf: result[start..<(start + 3)])
        collapsed.append(
          DiffLine(
            id: result[start + 3].id, kind: "collapsed", old: nil, new: nil,
            content: "\(cursor - start - 6) unchanged lines"))
        collapsed.append(contentsOf: result[(cursor - 3)..<cursor])
      }
    }
    return collapsed
  }
}

struct DiffView: View {
  let lines: [DiffLine]
  var body: some View {
    GeometryReader { geometry in
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(lines) { line in
            HStack(alignment: .top, spacing: 8) {
              Text(line.old.map(String.init) ?? "").frame(width: 36, alignment: .trailing)
              Text(line.new.map(String.init) ?? "").frame(width: 36, alignment: .trailing)
              Text(line.kind == "added" ? "+" : line.kind == "removed" ? "−" : " ")
              Text(verbatim: line.content.isEmpty ? " " : line.content)
            }
            .font(.system(size: 12, design: .monospaced))
            .foregroundColor(line.kind == "collapsed" ? .secondary : .primary)
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              line.kind == "added"
                ? Color.green.opacity(0.15)
                : line.kind == "removed" ? Color.red.opacity(0.15) : Color.clear)
          }
        }.textSelection(.enabled).padding()
          .frame(
            minWidth: geometry.size.width, minHeight: geometry.size.height, alignment: .topLeading)
      }
    }
  }
}
