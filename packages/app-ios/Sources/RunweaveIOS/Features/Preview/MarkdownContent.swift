import MarkdownUI
import SwiftUI

/// Shared rendering for file previews and Agent conversation messages.
struct MarkdownContent: View {
  let content: String

  var body: some View {
    Markdown(content)
      .textSelection(.enabled)
      .markdownBlockStyle(\.table) { configuration in
        ScrollView(.horizontal) {
          configuration.label
            .fixedSize(horizontal: true, vertical: true)
            .markdownTableBorderStyle(.init(color: Color.secondary.opacity(0.35)))
            .markdownTableBackgroundStyle(
              .alternatingRows(Color(uiColor: .systemBackground), Color(uiColor: .secondarySystemBackground))
            )
        }
        .markdownMargin(top: 0, bottom: 16)
      }
      .markdownBlockStyle(\.tableCell) { configuration in
        tableCell(configuration)
          .markdownTextStyle {
            if configuration.row == 0 { FontWeight(.semibold) }
            BackgroundColor(nil)
          }
          .padding(.vertical, 6)
          .padding(.horizontal, 13)
          .relativeLineSpacing(.em(0.25))
      }
      .markdownTheme(.gitHub)
  }

  @ViewBuilder private func tableCell(_ configuration: TableCellConfiguration) -> some View {
    if #available(iOS 16.0, *) {
      MarkdownTableCellLayout { configuration.label }
    } else {
      configuration.label
    }
  }
}

/// Measure row height at the capped text width, including during the Grid's ideal-size pass.
@available(iOS 16.0, *)
private struct MarkdownTableCellLayout: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let cell = subviews.first else { return .zero }
    let width = min(cell.sizeThatFits(.unspecified).width, 260)
    let size = cell.sizeThatFits(ProposedViewSize(width: width, height: nil))
    return CGSize(width: width, height: size.height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: nil))
  }
}
