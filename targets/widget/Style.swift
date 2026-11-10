import SwiftUI

/// The three widget styles agreed in #1849 (same colours as the Android widget).
/// Raw values are stored in the widget configuration, so never rename them.
enum WidgetStyleKind: String, CaseIterable {
  case piggyPink
  case cleanWhite
  case nightGlass

  static let `default`: WidgetStyleKind = .piggyPink

  var palette: WidgetPalette {
    switch self {
    case .piggyPink:
      return WidgetPalette(
        background: AnyShapeStyle(
          LinearGradient(colors: [.lpPink, .lpPurple], startPoint: .topLeading, endPoint: .bottomTrailing)),
        text: .white,
        secondaryText: Color.white.opacity(0.8),
        balance: .white,
        primaryButton: AnyShapeStyle(Color.white),
        primaryButtonText: Color(hex: 0xC21F78),
        secondaryButton: AnyShapeStyle(Color.white.opacity(0.22)),
        secondaryButtonText: .white,
        border: nil
      )
    case .cleanWhite:
      return WidgetPalette(
        background: AnyShapeStyle(Color.white),
        text: Color(hex: 0x1D1B26),
        secondaryText: Color(hex: 0x1D1B26).opacity(0.65),
        balance: Color(hex: 0x1D1B26),
        primaryButton: AnyShapeStyle(
          LinearGradient(colors: [.lpPink, .lpPurple], startPoint: .topLeading, endPoint: .bottomTrailing)),
        primaryButtonText: .white,
        secondaryButton: AnyShapeStyle(Color(hex: 0xF3EEFC)),
        secondaryButtonText: Color(hex: 0x6A35C9),
        border: nil
      )
    case .nightGlass:
      // Home-screen widgets can't be see-through, so the "glass" is the
      // mock-up's rgba(20,14,34,.62) panel flattened onto a dark base.
      return WidgetPalette(
        background: AnyShapeStyle(
          LinearGradient(
            colors: [Color(hex: 0x2A2140), Color(hex: 0x140E22)], startPoint: .top, endPoint: .bottom)),
        text: .white,
        secondaryText: Color.white.opacity(0.75),
        balance: Color(hex: 0xFFD700),
        primaryButton: AnyShapeStyle(Color.lpPink),
        primaryButtonText: .white,
        secondaryButton: AnyShapeStyle(Color.white.opacity(0.12)),
        secondaryButtonText: .white,
        border: Color.white.opacity(0.14)
      )
    }
  }
}

struct WidgetPalette {
  let background: AnyShapeStyle
  let text: Color
  let secondaryText: Color
  let balance: Color
  let primaryButton: AnyShapeStyle
  let primaryButtonText: Color
  let secondaryButton: AnyShapeStyle
  let secondaryButtonText: Color
  let border: Color?
}

extension Color {
  static let lpPink = Color(hex: 0xFF2D95)
  static let lpPurple = Color(hex: 0x9B40FF)
  static let lpConnected = Color(hex: 0x4CAF50)
  static let lpDisconnected = Color(hex: 0xF44336)

  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }
}
