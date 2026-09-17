import Foundation

enum TerminalLinkSelection {
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
