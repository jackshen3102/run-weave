import SwiftUI
import UIKit

/// A plain-text reader. Link attributes are presentation only and never change the saved body.
struct RecordBody: UIViewRepresentable {
  let text: String
  var lineLimit: Int = 0
  var linksOnly: Bool = false
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

  func makeUIView(context: Context) -> RecordBodyTextView {
    let view = RecordBodyTextView()
    view.isEditable = false
    view.isSelectable = true
    view.isScrollEnabled = false
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.adjustsFontForContentSizeCategory = true
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }

  func updateUIView(_ view: RecordBodyTextView, context: Context) {
    if view.text != text {
      let attributed = NSMutableAttributedString(string: text)
      let range = NSRange(text.startIndex..<text.endIndex, in: text)
      view.linkRanges = []
      for match in Self.detector?.matches(in: text, range: range) ?? [] {
        guard let url = match.url, let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else { continue }
        attributed.addAttribute(.link, value: url, range: match.range)
        view.linkRanges.append(match.range)
      }
      view.attributedText = attributed
    }
    view.font = .preferredFont(forTextStyle: .body)
    view.textColor = UIColor(SuijiTheme.ink)
    view.linkTextAttributes = [.foregroundColor: UIColor(SuijiTheme.green), .underlineStyle: NSUnderlineStyle.single.rawValue]
    view.textContainer.maximumNumberOfLines = lineLimit
    view.textContainer.lineBreakMode = lineLimit > 0 ? .byTruncatingTail : .byWordWrapping
    view.linksOnly = linksOnly
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: RecordBodyTextView, context: Context) -> CGSize? {
    guard let width = proposal.width, width > 0 else { return nil }
    let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    return CGSize(width: width, height: ceil(size.height))
  }
}

final class RecordBodyTextView: UITextView {
  var linksOnly = false
  var linkRanges: [NSRange] = []

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    guard super.point(inside: point, with: event) else { return false }
    guard linksOnly else { return true }
    // In a feed card, ordinary text and whitespace pass through to the navigation link.
    // Link touches stay in UITextView, which owns opening and the native long-press menu.
    return linkRanges.contains { range in
      guard let start = position(from: beginningOfDocument, offset: range.location),
            let end = position(from: start, offset: range.length),
            let textRange = textRange(from: start, to: end) else { return false }
      return selectionRects(for: textRange).contains { $0.rect.contains(point) }
    }
  }
}
