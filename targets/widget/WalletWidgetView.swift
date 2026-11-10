import SwiftUI
import WidgetKit

/// Small: wallet name, balance, Receive and Send.
/// Medium: wallet name, balance, fiat + "Updated 14:32", Receive, Scan, Send.
/// Buttons are deep links into the app (the same ones the Android widget
/// uses); the app then shows its normal Receive / Send screens, app lock and
/// payment confirmation included. A widget never pays. What the text says is
/// decided in WidgetDisplay.swift.
struct WalletWidgetView: View {
  let entry: WalletEntry
  @Environment(\.widgetFamily) private var family

  private var palette: WidgetPalette { entry.style.palette }

  var body: some View {
    content
      .foregroundColor(palette.text)
      .environment(\.locale, L10n.locale)
      .widgetBackground(palette)
  }

  @ViewBuilder private var content: some View {
    switch entry.content {
    case .empty:
      // No widgetURL: a tap just opens the app.
      MessageView(text: L10n.string("widget.empty"))
    case let .wallet(wallet, index, count):
      let display = WalletDisplay(wallet: wallet, hideBalance: entry.hideBalance, now: entry.date)
      Group {
        if family == .systemMedium {
          MediumWalletView(entry: entry, display: display, index: index, count: count)
        } else {
          SmallWalletView(entry: entry, display: display, index: index, count: count)
        }
      }
      // Taps outside the buttons open Receive for this wallet.
      .widgetURL(DeepLink.url(.receive, walletId: wallet.id))
    }
  }
}

// MARK: Sizes

private struct SmallWalletView: View {
  let entry: WalletEntry
  let display: WalletDisplay
  let index: Int
  let count: Int

  var body: some View {
    let palette = entry.style.palette
    VStack(spacing: 0) {
      WalletHeader(entry: entry, display: display, count: count, centred: true)
      Spacer(minLength: 4)
      BalanceView(display: display, palette: palette, size: 24, centred: true)
      DetailView(display: display, palette: palette, size: 10.5)
      Spacer(minLength: 4)
      // Apple lists systemSmall among the families with room for several
      // `Link` targets ("Linking to specific app scenes from your widget"),
      // and from iOS 17 small widgets are interactive. Before iOS 17 a small
      // widget has one tap target (its widgetURL, Receive), so only that
      // button is shown.
      if #available(iOS 17.0, *) {
        HStack(spacing: 6) {
          ActionLink(action: .receive, walletId: display.walletId, palette: palette, primary: true)
          ActionLink(action: .send, walletId: display.walletId, palette: palette, primary: false)
        }
      } else {
        ActionPill(action: .receive, palette: palette, primary: true)
      }
      PageDots(index: index, count: count, color: palette.text)
        .padding(.top, 6)
    }
    .padding(12)
  }
}

private struct MediumWalletView: View {
  let entry: WalletEntry
  let display: WalletDisplay
  let index: Int
  let count: Int

  var body: some View {
    let palette = entry.style.palette
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        WalletHeader(entry: entry, display: display, count: count, centred: false)
        Spacer(minLength: 6)
        PageDots(index: index, count: count, color: palette.text)
      }
      Spacer(minLength: 4)
      BalanceView(display: display, palette: palette, size: 28, centred: false)
      DetailView(display: display, palette: palette, size: 12)
      Spacer(minLength: 6)
      HStack(spacing: 8) {
        ActionLink(action: .receive, walletId: display.walletId, palette: palette, primary: true)
        ActionLink(action: .scan, walletId: display.walletId, palette: palette, primary: false)
        ActionLink(action: .send, walletId: display.walletId, palette: palette, primary: false)
      }
    }
    .padding(14)
  }
}

// MARK: Pieces

/// Connection dot + wallet name, with ‹ › on iOS 17+ when there's more than
/// one wallet to switch between.
private struct WalletHeader: View {
  let entry: WalletEntry
  let display: WalletDisplay
  let count: Int
  let centred: Bool

  var body: some View {
    HStack(spacing: 4) {
      if showArrows { SwitchButton(entry: entry, offset: -1) }
      if centred { Spacer(minLength: 0) }
      Circle()
        .fill(display.connected ? Color.lpConnected : Color.lpDisconnected)
        .frame(width: 6, height: 6)
        .accessibilityHidden(true)
      Text(display.name)
        .font(.system(size: 12, weight: .bold))
        .lineLimit(1)
      if centred { Spacer(minLength: 0) }
      if showArrows { SwitchButton(entry: entry, offset: 1) }
    }
  }

  private var showArrows: Bool { entry.canSwitch && count > 1 }
}

private struct SwitchButton: View {
  let entry: WalletEntry
  let offset: Int

  var body: some View {
    if #available(iOS 17.0, *) {
      Button(
        intent: SwitchWalletIntent(
          cursorKey: entry.cursorKey, startingWalletId: entry.startingWalletId, offset: offset)
      ) {
        Image(systemName: offset < 0 ? "chevron.left" : "chevron.right")
          .font(.system(size: 13, weight: .bold))
          .opacity(0.8)
          .frame(width: 22, height: 22)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(
        L10n.string(offset < 0 ? "widget.a11y.previousWallet" : "widget.a11y.nextWallet"))
    }
  }
}

private struct BalanceView: View {
  let display: WalletDisplay
  let palette: WidgetPalette
  let size: CGFloat
  let centred: Bool

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 3) {
      Text(display.balanceText)
        .font(.system(size: size, weight: .heavy))
        .foregroundColor(palette.balance)
        .lineLimit(1)
        .minimumScaleFactor(0.5)
      if let unit = display.unitText {
        Text(unit)
          .font(.system(size: size * 0.5, weight: .bold))
          .foregroundColor(palette.balance.opacity(0.8))
      }
    }
    .frame(maxWidth: centred ? .infinity : nil, alignment: centred ? .center : .leading)
    // Redacted where iOS hides private data (locked phone, StandBy, Today
    // View with "Allow access when locked" off); shown on the home screen.
    .privacySensitive()
    .accentedWhenTinted()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(display.balanceLabel)
  }
}

private struct DetailView: View {
  let display: WalletDisplay
  let palette: WidgetPalette
  let size: CGFloat

  var body: some View {
    if let detail = display.detailText {
      Text(detail)
        .font(.system(size: size, weight: .semibold))
        .foregroundColor(palette.secondaryText)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .padding(.top, 2)
        .privacySensitive()
    }
  }
}

private struct ActionLink: View {
  let action: DeepLink.Action
  let walletId: String
  let palette: WidgetPalette
  let primary: Bool

  var body: some View {
    Link(destination: DeepLink.url(action, walletId: walletId)) {
      ActionPill(action: action, palette: palette, primary: primary)
    }
    .accessibilityLabel(L10n.string(action.labelKey))
  }
}

/// The look of a Receive / Scan / Send button.
private struct ActionPill: View {
  let action: DeepLink.Action
  let palette: WidgetPalette
  let primary: Bool

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: action.symbol)
        .font(.system(size: 11, weight: .bold))
      if action != .scan {
        Text(L10n.string(action.labelKey))
          .font(.system(size: 12, weight: .bold))
          .lineLimit(1)
          .minimumScaleFactor(0.7)
      }
    }
    .foregroundColor(primary ? palette.primaryButtonText : palette.secondaryButtonText)
    .frame(maxWidth: action == .scan ? 30 : .infinity, minHeight: 30, maxHeight: 30)
    .padding(.horizontal, action == .scan ? 0 : 8)
    .background(PillBackground(fill: primary ? palette.primaryButton : palette.secondaryButton))
  }
}

/// A filled capsule in full colour. In the tinted / clear home-screen modes
/// (iOS 18+) the system draws every opaque shape in one tint, so a filled
/// capsule would swallow its label: there it becomes an outline instead.
private struct PillBackground: View {
  let fill: AnyShapeStyle

  var body: some View {
    if #available(iOS 16.0, *) {
      RenderingModeAwarePill(fill: fill)
    } else {
      Capsule().fill(fill)
    }
  }
}

@available(iOS 16.0, *)
private struct RenderingModeAwarePill: View {
  let fill: AnyShapeStyle
  @Environment(\.widgetRenderingMode) private var renderingMode

  var body: some View {
    if renderingMode == .fullColor {
      Capsule().fill(fill)
    } else {
      Capsule().strokeBorder(Color.primary.opacity(0.6), lineWidth: 1.5)
    }
  }
}

/// Decorative: one dot per wallet (VoiceOver users switch with ‹ ›). At most
/// seven, sliding so the current wallet's dot stays shown (as on Android).
private struct PageDots: View {
  let index: Int
  let count: Int
  let color: Color

  var body: some View {
    if count > 1 {
      let window = PageDotsWindow.visible(pageCount: count, pageIndex: index)
      HStack(spacing: 4) {
        ForEach(0..<window.count, id: \.self) { dot in
          let current = dot == window.active
          Capsule()
            .fill(color.opacity(current ? 1 : 0.35))
            .frame(width: current ? 12 : 5, height: 5)
        }
      }
      .accessibilityHidden(true)
    }
  }
}

private struct MessageView: View {
  let text: String

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: "bolt.circle.fill")
        .font(.system(size: 26, weight: .bold))
        .accessibilityHidden(true)
      Text(text)
        .font(.system(size: 13, weight: .semibold))
        .multilineTextAlignment(.center)
        .minimumScaleFactor(0.7)
    }
    .padding(14)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

// MARK: Rendering modes and background

extension View {
  /// The balance takes the accent tint in the tinted home-screen mode, so it
  /// stands out from the rest of the (single-colour) widget.
  @ViewBuilder func accentedWhenTinted() -> some View {
    if #available(iOS 16.0, *) {
      self.widgetAccentable()
    } else {
      self
    }
  }

  /// containerBackground on iOS 17+ (the system removes it in the tinted and
  /// clear modes); a plain background before.
  @ViewBuilder func widgetBackground(_ palette: WidgetPalette) -> some View {
    if #available(iOS 17.0, *) {
      self.containerBackground(for: .widget) {
        ZStack {
          Rectangle().fill(palette.background)
          if let border = palette.border { ContainerRelativeShape().strokeBorder(border, lineWidth: 1) }
        }
      }
    } else {
      self
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
          ZStack {
            Rectangle().fill(palette.background)
            if let border = palette.border { ContainerRelativeShape().strokeBorder(border, lineWidth: 1) }
          })
    }
  }
}
