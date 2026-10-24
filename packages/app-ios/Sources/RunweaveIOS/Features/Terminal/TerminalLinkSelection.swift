import Foundation

enum TerminalLinkSelection {
  enum WrappedLink {
    case candidate(String)
    case incomplete(String)
  }

  /// Legacy tmux can discard OSC 8. Recover only a visibly parenthesized URL,
  /// with full rows at every hard wrap, and ask the user before navigating it.
  /// Reuse the immutable native hit snapshot; never join arbitrary prose.
  static func wrappedURL(_ tap: TerminalFileTap) -> WrappedLink? {
    guard tap.explicit == nil else { return nil }
    if let labelTarget = labelURL(tap) { return labelTarget }
    return parenthesizedURL(tap)
  }

  /// A styled Markdown label followed immediately by its printed URL is still
  /// only a candidate. Require the same native underline/color run and confirm.
  private static func labelURL(_ tap: TerminalFileTap) -> WrappedLink? {
    guard let hit = tap.cells[tap.row]?.first(where: { tap.col >= $0.col && tap.col < $0.col + $0.width }),
      hit.attribute.style.contains(.underline),
      tap.cells[tap.row]?.filter({ $0.col >= hit.col }).allSatisfy({
        $0.text.allSatisfy(\.isWhitespace) || ($0.attribute.style.contains(.underline) && $0.attribute.fg == hit.attribute.fg)
      }) == true else { return nil }
    for row in (tap.row + 1)...(tap.row + 4) {
      let content = (tap.cells[row] ?? []).drop(while: { $0.text.allSatisfy(\.isWhitespace) })
      guard let first = content.first else { return nil }
      if first.text == "(", let scheme = content.dropFirst().first,
        scheme.attribute.style.contains(.underline), scheme.attribute.fg == hit.attribute.fg {
        let anchor = TerminalFileTap(row: row, col: scheme.col, viewportRow: tap.viewportRow + row - tap.row,
          cols: tap.cols, rows: tap.rows, explicit: nil, firstRow: tap.firstRow,
          cells: tap.cells, wrapped: tap.wrapped)
        return parenthesizedURL(anchor, confirmUnwrapped: true)
      }
      guard content.allSatisfy({
        $0.text.allSatisfy(\.isWhitespace) || ($0.attribute.style.contains(.underline) && $0.attribute.fg == hit.attribute.fg)
      }) else { return nil }
    }
    return nil
  }

  private static func parenthesizedURL(_ tap: TerminalFileTap, confirmUnwrapped: Bool = false) -> WrappedLink? {
    for startRow in max(0, tap.row - 7)...tap.row {
      let first = tap.cells[startRow] ?? []
      for opening in first.indices where first[opening].text == "(" {
        let prefix = first.dropFirst(opening + 1).map(\.text).joined().lowercased()
        guard prefix.hasPrefix("https://") || prefix.hasPrefix("http://") else { continue }
        var target = ""
        var depth = 1
        var hit = false
        var hardWrapped = false
        var stopped = false
        for row in startRow...min(startRow + 7, tap.row + 7) {
          let cells = tap.cells[row] ?? []
          let start = row == startRow ? opening + 1 : cells.firstIndex(where: { !$0.text.allSatisfy(\.isWhitespace) }) ?? cells.count
          let end = cells.lastIndex(where: { !$0.text.allSatisfy(\.isWhitespace) }).map { $0 + 1 } ?? start
          guard start < end else { stopped = true; break }
          if row > startRow, !tap.wrapped.contains(row) { hardWrapped = true }
          for index in start..<end {
            let cell = cells[index]
            if cell.text == "(" { depth += 1 }
            if cell.text == ")" { depth -= 1 }
            if depth == 0 {
              if hit, selectedURL(target) != nil {
                return hardWrapped || confirmUnwrapped ? .candidate(target) : nil
              }
              stopped = true
              break
            }
            guard !cell.text.contains(where: { $0.isWhitespace || $0.isNewline }), target.utf8.count < 4096 else {
              stopped = true
              break
            }
            if row == tap.row, tap.col >= cell.col, tap.col < cell.col + cell.width { hit = true }
            target += cell.text
          }
          if stopped { break }
          // A short, hard-broken row is a boundary, not evidence of continuation.
          if cells[end - 1].col + cells[end - 1].width < tap.cols - 1,
            !tap.wrapped.contains(row + 1) { break }
        }
        if hit, hardWrapped || target.utf8.count >= max(0, tap.cols - first[opening].col - 2) {
          return .incomplete(target)
        }
      }
    }
    return nil
  }

  /// SwiftTerm joins soft wraps but preserves real linefeeds. Never repair a mixed selection.
  static func selectedURL(_ text: String) -> String? {
    guard !text.contains(where: { $0.isWhitespace || $0.isNewline }),
      let components = URLComponents(string: text), components.url != nil,
      ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
      let host = components.host, !host.isEmpty,
      let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    else { return nil }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    let matches = detector.matches(in: text, range: range)
    guard matches.count == 1, matches[0].range.location == 0 else { return nil }
    // A detector can exclude legal trailing punctuation. Never trim the selected target;
    // URL policy makes the final safety decision, including explanatory local-address errors.
    return text
  }
}
