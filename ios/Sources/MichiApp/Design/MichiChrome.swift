import SwiftUI
import MichiCore

enum MichiThreadState: String, Equatable {
    case idle
    case waiting
    case streaming
    case running
    case stalled
    case done
    case agentDone
    case failed

    var accessibilityLabel: String {
        switch self {
        case .idle: return "Chat only"
        case .waiting: return "Needs you"
        case .streaming: return "Responding"
        case .running: return "In progress"
        case .stalled: return "Stalled"
        case .done: return "Done"
        case .agentDone: return "Agent finished"
        case .failed: return "Failed"
        }
    }

    @MainActor static func of(node: JSONValue, chat: ChatController?) -> MichiThreadState {
        if chat?.pendingPermission != nil || chat?.pendingQuestion != nil { return .waiting }
        switch node["status"].stringValue {
        case "waiting", "needs_input", "permission": return .waiting
        case "streaming": return .streaming
        case "error", "failed": return .failed
        case "stalled": return .stalled
        case "running": return .running
        default: break
        }
        if chat?.busy == true { return .streaming }
        if node["kind"].stringValue == "digest" { return .done }
        return .idle
    }
}

/// Web ThreadStateDot: shape and color change together.
struct MichiThreadStateDot: View {
    let state: MichiThreadState
    @Environment(\.michiTokens) private var tokens
    @Environment(\.michiAppearance) private var appearance
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spin = false

    private var animates: Bool {
        state == .streaming && !reduceMotion && !appearance.reduceMotion
    }

    var body: some View {
        shape
            .frame(width: 10, height: 10)
            .accessibilityLabel(state.accessibilityLabel)
            .onAppear { restartSpin() }
            .onChange(of: state) { _, _ in restartSpin() }
            .onChange(of: appearance.reduceMotion) { _, _ in restartSpin() }
            .onChange(of: reduceMotion) { _, _ in restartSpin() }
    }

    private func restartSpin() {
        spin = false
        guard animates else { return }
        withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) { spin = true }
    }

    @ViewBuilder private var shape: some View {
        switch state {
        case .waiting:
            Circle().fill(tokens.accent)
        case .failed:
            Circle().fill(tokens.danger)
        case .idle:
            Circle().fill(tokens.faint.opacity(0.55))
        case .running:
            Circle().stroke(tokens.mid, lineWidth: 1.4)
        case .streaming:
            Circle()
                .trim(from: 0, to: 0.75)
                .stroke(tokens.select, style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
                .rotationEffect(.degrees(spin ? 360 : 0))
        case .stalled:
            ZStack {
                Circle().stroke(tokens.mauve, lineWidth: 1.4)
                Circle().trim(from: 0, to: 0.5).fill(tokens.mauve)
            }
        case .done:
            MichiCheckGlyph().stroke(tokens.digest, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
        case .agentDone:
            Circle().stroke(tokens.digest, style: StrokeStyle(lineWidth: 1.4, dash: [2, 1.5]))
        }
    }
}

private struct MichiCheckGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + 1.5, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX - 0.4, y: rect.maxY - 1.6))
        path.addLine(to: CGPoint(x: rect.maxX - 1.2, y: rect.minY + 1.4))
        return path
    }
}

struct MichiTag: View {
    let text: String
    var kind: Kind = .plain
    enum Kind { case plain, accent, ok, warn, bad, tool, info }
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        Text(text)
            .font(MichiFont.tag)
            .tracking(0.44)
            .textCase(.uppercase)
            .foregroundStyle(foreground)
            .padding(.horizontal, 6)
            .frame(height: 18)
            .background(background, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
    }
    private var foreground: Color {
        switch kind {
        case .plain: return tokens.mid
        case .accent: return tokens.accentText
        case .ok: return tokens.digest
        case .warn: return tokens.selectInk
        case .bad: return tokens.dangerText
        case .tool: return tokens.mauve
        case .info: return tokens.info
        }
    }
    private var background: Color {
        switch kind {
        case .plain: return tokens.alt
        case .accent: return tokens.accentF
        case .ok: return tokens.digestF
        case .warn: return tokens.selectF
        case .bad: return tokens.accentF.opacity(0.001)
        case .tool: return tokens.mauveF
        case .info: return tokens.infoF
        }
    }
}

struct MichiChip: View {
    let title: String
    var systemImage: String? = nil
    var selected = false
    let action: () -> Void
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let systemImage { Image(systemName: systemImage).font(.system(size: 11, weight: .medium)) }
                Text(title).font(MichiFont.chip)
            }
            .foregroundStyle(selected ? tokens.accentText : tokens.mid)
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(selected ? tokens.accentF : Color.clear, in: Capsule())
            .overlay {
                if !selected { Capsule().stroke(tokens.line, lineWidth: 1) }
            }
            .padding(.vertical, 8)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .michiHitTarget()
    }
}

struct MichiHairlineRow<Leading: View, Trailing: View>: View {
    let title: String
    var subtitle: String? = nil
    var indent: CGFloat = 0
    var titleColor: Color? = nil
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            leading()
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(MichiFont.row)
                    .foregroundStyle(titleColor ?? tokens.fg)
                    .lineLimit(2)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(MichiFont.rowSecondary)
                        .foregroundStyle(tokens.muted)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 10)
        .padding(.leading, 20 + indent)
        .padding(.trailing, 20)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }
}

struct MichiUserBubble: View {
    let text: String
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        Text(text)
            .font(MichiFont.sans(size: 15.5, relativeTo: .body))
            .foregroundStyle(tokens.fg)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tokens.bubble, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            .overlay(alignment: .trailing) { Rectangle().fill(tokens.accent).frame(width: 2) }
            .padding(.leading, 56)
    }
}

struct MichiAssistantLabel: View {
    var status: String? = nil
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        HStack(spacing: 8) {
            Text(">").font(MichiFont.prompt).foregroundStyle(tokens.accent)
            Text("michi").font(MichiFont.meta).foregroundStyle(tokens.muted)
            if let status {
                MichiThreadStateDot(state: .streaming)
                Text(status).font(MichiFont.meta).foregroundStyle(tokens.selectInk)
            }
        }
    }
}

struct MichiToolRow: View {
    let title: String
    var detail: String? = nil
    var state: MichiThreadState = .running
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "terminal")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(tokens.mauve)
            Text(title)
                .font(MichiFont.mono(size: 12.5, relativeTo: .caption))
                .foregroundStyle(tokens.mid)
                .lineLimit(1)
            Spacer()
            if let detail {
                Text(detail)
                    .font(MichiFont.meta)
                    .foregroundStyle(state == .waiting ? tokens.accentText : tokens.muted)
            }
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 36)
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1)
        }
    }
}

struct MichiComposerBar<Accessory: View>: View {
    @Binding var text: String
    var placeholder: String
    var focused: FocusState<Bool>.Binding
    var canSend: Bool
    var isBusy: Bool
    var onPlus: () -> Void
    var onSend: () -> Void
    var onStop: (() -> Void)? = nil
    @ViewBuilder var accessory: () -> Accessory
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if focused.wrappedValue {
                accessory()
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
            }
            HStack(alignment: .bottom, spacing: 4) {
                Button(action: onPlus) {
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(tokens.fg)
                        .frame(width: 38, height: 38)
                        .background(tokens.alt.opacity(0.55), in: Circle())
                        .padding(3)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .michiHitTarget()
                .accessibilityLabel("Add context")

                TextField(placeholder, text: $text, axis: .vertical)
                    .font(MichiFont.sans(size: 16, relativeTo: .body))
                    .foregroundStyle(tokens.fg)
                    .focused(focused)
                    .lineLimit(1...6)
                    .padding(.vertical, 8)
                    .accessibilityIdentifier("composer")

                NativeDictationButton(draft: $text, enabled: !isBusy)

                if isBusy, let onStop {
                    Button(action: onStop) {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(tokens.accentInk)
                            .frame(width: 38, height: 38)
                            .background(tokens.accent, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .michiHitTarget()
                    .accessibilityLabel("Stop response")
                    .accessibilityIdentifier("stop-response")
                } else if canSend {
                    Button(action: onSend) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(tokens.accentInk)
                            .frame(width: 38, height: 38)
                            .background(tokens.accent, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .michiHitTarget()
                    .accessibilityLabel("Send message")
                    .accessibilityIdentifier("send-message")
                }
            }
        }
        .padding(4)
        .michiGlassCapsule()
    }
}

struct MichiMapBackground: View {
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        Canvas { context, size in
            let step: CGFloat = 18
            var x: CGFloat = 8
            while x < size.width {
                var y: CGFloat = 8
                while y < size.height {
                    context.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 1.2, height: 1.2)), with: .color(tokens.mid.opacity(0.18)))
                    y += step
                }
                x += step
            }
        }
        .background(tokens.bg)
        .allowsHitTesting(false)
    }
}

struct MichiQuoteBlock: View {
    let text: String
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        Text(text)
            .font(MichiFont.sans(size: 15.5, relativeTo: .body))
            .italic()
            .foregroundStyle(tokens.mid)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tokens.alt)
            .overlay(alignment: .leading) { Rectangle().fill(tokens.accent).frame(width: 2) }
    }
}

struct MichiCodeWell<Content: View>: View {
    var language: String = ""
    @ViewBuilder var content: () -> Content
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !language.isEmpty {
                HStack {
                    Text(language)
                        .font(MichiFont.tag)
                        .tracking(0.88)
                        .textCase(.uppercase)
                        .foregroundStyle(tokens.muted)
                    Spacer()
                }
                .padding(.horizontal, 10)
                .frame(height: 30)
            }
            content()
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
        }
        .background(tokens.bgDeep, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1)
        }
    }
}

struct MichiListStyle: ViewModifier {
    @Environment(\.michiTokens) private var tokens
    func body(content: Content) -> some View {
        content
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(tokens.bg)
            .listRowSeparatorTint(tokens.sep)
            .michiScrollEdge()
    }
}

extension View {
    func michiPlainList() -> some View { modifier(MichiListStyle()) }

    func michiFloatingComposer<Composer: View>(@ViewBuilder composer: () -> Composer) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0) {
            composer()
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
    }
}
