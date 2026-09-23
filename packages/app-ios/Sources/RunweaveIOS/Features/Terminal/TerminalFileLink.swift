import Foundation
import SwiftTerm

struct TerminalFileReference {
  let path: String
  var line: Int?
  var column: Int?
  var context: TerminalFileLinkContext?

  static func parse(_ value: String) -> Self? {
    var path = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !path.isEmpty, !path.unicodeScalars.contains(where: { $0.value < 32 }) else { return nil }
    if path.lowercased().hasPrefix("file://") {
      guard let url = URLComponents(string: path),
        url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
      path = url.path
      if let fragment = url.fragment, let position = fragment.range(of: #"^L[0-9]+(?:C[0-9]+)?$"#, options: .regularExpression) {
        path += ":" + fragment[position].dropFirst().replacingOccurrences(of: "C", with: ":")
      }
    } else if path.contains("://") { return nil }
    if let first = path.first, "\"'`".contains(first), path.last == first {
      path = String(path.dropFirst().dropLast())
    }
    var line: Int?
    var column: Int?
    if let range = path.range(of: #":[0-9]+(?::[0-9]+)?$"#, options: .regularExpression) {
      let parts = path[range].dropFirst().split(separator: ":")
      guard let row = Int(parts[0]), row > 0,
        let col = parts.count == 2 ? Int(parts[1]) : 1, col > 0 else { return nil }
      line = row; column = col
      path = String(path[..<range.lowerBound])
    }
    path = path.trimmingCharacters(in: CharacterSet(charactersIn: "\"'`"))
    guard !path.isEmpty, !path.hasPrefix("~"),
      path.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) == nil,
      isSupportedTerminalFileLinkPath(path) else { return nil }
    return Self(path: path, line: line, column: column)
  }
}

/// Immutable text/cell snapshot captured at the native hit; resolution never reads a later frame.
public struct TerminalFileTap: Identifiable {
  public let id = UUID()
  let row: Int
  let col: Int
  let viewportRow: Int
  let cols: Int
  let rows: Int
  let explicit: String?
  let firstRow: Int
  let cells: [Int: [(text: String, col: Int, width: Int)]]
  let wrapped: Set<Int>

  @MainActor static func capture(_ terminal: Terminal, hit: Position) -> Self? {
    let explicit = terminal.link(at: .buffer(hit), mode: .explicitOnly)
    if let explicit, TerminalFileReference.parse(explicit) == nil { return nil }
    var cells: [Int: [(String, Int, Int)]] = [:]
    var wrapped = Set<Int>()
    var first = hit.row
    while first > max(0, hit.row - 31), terminal.displayLine(atBufferRow: first)?.isWrapped == true { first -= 1 }
    for row in max(0, first - 4)...max(first + 31, hit.row + 4) {
      guard let line = terminal.displayLine(atBufferRow: row) else { break }
      if line.isWrapped { wrapped.insert(row) }
      var items: [(String, Int, Int)] = []
      for col in 0..<min(terminal.cols, line.count) {
        let cell = line[col]
        guard cell.width > 0 else { continue }
        let char = cell.getCharacter()
        items.append((char == "\0" ? " " : String(char), col, Int(cell.width)))
      }
      cells[row] = items
    }
    let tap = Self(row: hit.row, col: hit.col,
      viewportRow: hit.row - terminal.displayTopVisibleRow, cols: terminal.cols, rows: terminal.rows,
      explicit: explicit, firstRow: first, cells: cells, wrapped: wrapped)
    return tap.reference() == nil ? nil : tap
  }

  func reference(geometry: TerminalFilePanel.Geometry? = nil) -> TerminalFileReference? {
    if let explicit { return TerminalFileReference.parse(explicit) }
    let left = geometry?.paneLeft ?? 0
    let right = geometry.map { $0.paneLeft + $0.paneWidth } ?? cols
    var text = ""
    var offset: Int?
    var positions: [(row: Int, col: Int)] = []
    // Split panes have no reliable soft-wrap markers; only join their bounded
    // path continuations below, never the neighboring pane's text.
    var lastRow = row
    if geometry == nil {
      while wrapped.contains(lastRow + 1), cells[lastRow + 1] != nil { lastRow += 1 }
    }
    let sourceRows = geometry == nil ? Array(firstRow...lastRow) : [row]
    for sourceRow in sourceRows {
      for cell in cells[sourceRow] ?? [] where cell.col >= left && cell.col < right {
        if sourceRow == row, col >= cell.col, col < cell.col + cell.width { offset = text.utf16.count }
        text += cell.text
        positions.append(contentsOf: repeatElement((row: sourceRow, col: cell.col), count: cell.text.utf16.count))
      }
    }
    guard let offset else { return nil }
    let pattern = #""[^"\r\n]+"(?::\d+(?::\d+)?)?|'[^'\r\n]+'(?::\d+(?::\d+)?)?|`[^`\r\n]+`(?::\d+(?::\d+)?)?|[^\s<>"'`()\[\]{},;]+"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let string = text as NSString
    for match in regex.matches(in: text, range: NSRange(location: 0, length: string.length)) {
      guard NSLocationInRange(offset, match.range) else { continue }
      var raw = string.substring(with: match.range).replacingOccurrences(of: #"[.!?:]+$"#, with: "", options: .regularExpression)
      if TerminalFileReference.parse(raw) == nil,
        string.substring(from: NSMaxRange(match.range)).trimmingCharacters(in: .whitespaces).isEmpty,
        let continued = continuedPath(raw, after: lastRow, left: left, right: right, geometry: geometry) {
        raw = continued
      }
      guard var reference = TerminalFileReference.parse(raw) else { return nil }
      if !raw.hasPrefix("\""), !raw.hasPrefix("'"), !raw.hasPrefix("`"),
        !raw.lowercased().hasPrefix("file://"), match.range.location < positions.count {
        let start = positions[match.range.location]
        let prefix = (cells[start.row] ?? []).filter { $0.col >= left && $0.col < start.col }.map(\.text).joined()
        if prefix.trimmingCharacters(in: .whitespaces).isEmpty {
          let minimumRow = geometry.map { row - viewportRow + $0.paneTop } ?? 0
          let previous = (max(minimumRow, start.row - 4)..<start.row).map { sourceRow in
            (cells[sourceRow] ?? []).filter { $0.col >= left && $0.col < right }.map(\.text).joined()
          }
          reference.context = TerminalFileLinkContext(linePrefix: prefix, precedingLines: previous)
        }
      }
      return reference
    }
    return nil
  }

  /// TUI renderers wrap paths with hard newlines and indentation rather than
  /// terminal soft wraps. Only extend an unfinished path at the end of a row;
  /// never concatenate the row padding or consume prose/bullets on the next row.
  private func continuedPath(_ fragment: String, after lastRow: Int, left: Int, right: Int,
    geometry: TerminalFilePanel.Geometry?) -> String? {
    guard !fragment.contains("://"),
      fragment.range(of: #"[\s<>\"'`()\[\]{},;|&$#!?]"#, options: .regularExpression) == nil else { return nil }
    let minimumRow = geometry.map { row - viewportRow + $0.paneTop } ?? 0
    let originRow = geometry == nil ? firstRow : row
    let previous = originRow > minimumRow
      ? (cells[originRow - 1] ?? []).filter { $0.col >= left && $0.col < right }.map(\.text).joined()
      : ""
    let previousToken = previous.split(whereSeparator: \.isWhitespace).last.map(String.init) ?? ""
    guard fragment.contains("/") || (previousToken.contains("/") && TerminalFileReference.parse(previousToken) == nil) else { return nil }
    let bottom = geometry.map { row - viewportRow + $0.paneTop + $0.paneHeight - 1 } ?? lastRow + 4
    guard lastRow < bottom else { return nil }
    var path = fragment
    for nextRow in (lastRow + 1)...min(lastRow + 4, bottom) {
      let text = (cells[nextRow] ?? []).filter { $0.col >= left && $0.col < right }.map(\.text).joined()
      let trimmed = text.trimmingCharacters(in: .whitespaces)
      guard !trimmed.isEmpty,
        let range = trimmed.range(of: #"^[^\s<>\"'`()\[\]{},;|&$#!?]+"#, options: .regularExpression) else { return nil }
      let token = String(trimmed[range])
      guard token != "-", token != "•", !token.contains("://") else { return nil }
      path += token
      let candidate = path.replacingOccurrences(of: #"[.!?:]+$"#, with: "", options: .regularExpression)
      if TerminalFileReference.parse(candidate) != nil { return candidate }
      guard range.upperBound == trimmed.endIndex else { return nil }
    }
    return nil
  }
}
