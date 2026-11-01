import SwiftUI
import MichiCore
#if canImport(UIKit)
import UIKit
#endif

enum DesignPagesFormat {
    static func weekday(_ date: Date = Date()) -> String {
        date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    static func agentLine(firstRun: JSONValue) -> String {
        switch firstRun["summary"]["state"].stringValue {
        case "running": return "Meta agent is reading conversations"
        case "due": return "Meta agent is due to check conversations"
        case "waiting": return "Meta agent is waiting to start"
        case "done": return "Meta agent · up to date"
        default:
            if firstRun.isNull { return "Meta agent status is unavailable" }
            return "Meta agent · \(firstRun["summary"]["state"].stringValue)"
        }
    }

    static func workspaceSubtitle(_ item: JSONValue) -> String {
        var parts: [String] = []
        if item["pageCount"].intValue > 0 { parts.append("\(item["pageCount"].intValue) pages") }
        if item["threadCount"].intValue > 0 { parts.append("\(item["threadCount"].intValue) threads") }
        if item["pendingProposals"].intValue > 0 {
            parts.append("\(item["pendingProposals"].intValue) waiting on you")
        }
        if !item["hiddenAt"].isNull { parts.append("Hidden") }
        return parts.isEmpty ? "Workspace home" : parts.joined(separator: " · ")
    }

    static func cardState(_ card: JSONValue) -> MichiThreadState {
        let text = (card["awaitingDetail"].optionalString ?? card["statusLine"].optionalString ?? card["status"].stringValue).lowercased()
        if text.contains("wait") { return .waiting }
        if text.contains("respond") || text.contains("stream") { return .streaming }
        if text.contains("stall") { return .stalled }
        if text.contains("done") || text.contains("finish") { return .done }
        if text.contains("fail") { return .failed }
        return .running
    }
}

struct DesignPagesProposalBar: View {
    let count: Int
    var actionTitle: String = "Review"
    let action: () -> Void
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "wrench")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tokens.accentText)
            Text(count == 1 ? "1 suggested change" : "\(count) suggested changes")
                .font(MichiFont.sans(size: 14.5, relativeTo: .subheadline, weight: .semibold))
                .foregroundStyle(tokens.fg)
            Spacer(minLength: 8)
            Button(actionTitle, action: action)
                .font(MichiFont.sans(size: 14, relativeTo: .subheadline, weight: .semibold))
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(tokens.accent, in: Capsule())
                .foregroundStyle(tokens.accentInk)
                .michiHitTarget()
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(tokens.accentF, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(tokens.accent.opacity(0.35), lineWidth: 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(count == 1 ? "1 suggested change" : "\(count) suggested changes")
    }
}

struct DesignPagesAgentLine: View {
    let text: String
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "wrench")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(tokens.muted)
            Text(text)
                .font(MichiFont.meta)
                .foregroundStyle(tokens.muted)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .accessibilityElement(children: .combine)
    }
}

struct DesignPagesDocumentHeader: View {
    var kick: String? = nil
    let title: String
    var date: String? = nil
    var meta: String? = nil
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let kick, !kick.isEmpty {
                Text(kick)
                    .font(MichiFont.tag)
                    .tracking(0.88)
                    .textCase(.uppercase)
                    .foregroundStyle(tokens.muted)
            }
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(title)
                    .font(MichiFont.largeTitle)
                    .tracking(-0.56)
                    .foregroundStyle(tokens.fg)
                if let date {
                    Text(date)
                        .font(MichiFont.meta)
                        .foregroundStyle(tokens.muted)
                }
            }
            if let meta, !meta.isEmpty {
                Text(meta)
                    .font(MichiFont.meta)
                    .foregroundStyle(tokens.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .accessibilityAddTraits(.isHeader)
    }
}

struct DesignPagesChatCard: View {
    let title: String
    var subtitle: String? = nil
    var quote: String? = nil
    var state: MichiThreadState = .idle
    let action: () -> Void
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .center, spacing: 8) {
                    MichiThreadStateDot(state: state)
                    Text(title)
                        .font(MichiFont.sans(size: 14.5, relativeTo: .subheadline, weight: .medium))
                        .foregroundStyle(tokens.fg)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(MichiFont.meta)
                        .foregroundStyle(tokens.muted)
                }
                if let quote, !quote.isEmpty {
                    Text(quote)
                        .font(MichiFont.sans(size: 14, relativeTo: .subheadline))
                        .foregroundStyle(tokens.mid)
                        .multilineTextAlignment(.leading)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(tokens.bgDeep, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(tokens.line, lineWidth: 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
        .michiHitTarget()
    }
}

struct DesignPagesFocusList: View {
    let items: [String]
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 10) {
                    Text("•")
                        .font(MichiFont.sans(size: 15, relativeTo: .body))
                        .foregroundStyle(tokens.faint)
                    Text(item)
                        .font(MichiFont.sans(size: 15, relativeTo: .body))
                        .foregroundStyle(tokens.fg)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }
}

struct DesignPagesActivityRow: View {
    let title: String
    var subtitle: String? = nil
    var state: MichiThreadState = .idle
    var action: (() -> Void)? = nil
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        Button {
            action?()
        } label: {
            MichiHairlineRow(title: title, subtitle: subtitle, leading: {
                MichiThreadStateDot(state: state)
            }, trailing: {
                if action != nil {
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(tokens.faint)
                }
            })
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }
}

struct DesignPagesInsetGroup<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(spacing: 0) { content() }
            .overlay(alignment: .top) { Rectangle().fill(tokens.sep).frame(height: 1) }
            .overlay(alignment: .bottom) { Rectangle().fill(tokens.sep).frame(height: 1) }
    }
}

struct DesignPagesAssistantFAB: View {
    let action: () -> Void
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack {
            Spacer()
            Button(action: action) {
                Text(">_")
                    .font(MichiFont.prompt)
                    .foregroundStyle(tokens.accent)
                    .frame(width: 52, height: 52)
            }
            .buttonStyle(.plain)
            .michiGlassCircle()
            .accessibilityLabel("Assistant")
            .padding(.trailing, 16)
            .padding(.bottom, 8)
        }
    }
}

struct DesignPagesChangeBody: View {
    let change: JSONValue
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let before = text(change["before"]["block"]["text"]), let after = text(change["after"]["block"]["text"]), before != after {
                if !before.isEmpty {
                    Text(before)
                        .strikethrough()
                        .foregroundStyle(tokens.dangerText)
                }
                if !after.isEmpty {
                    Text(after)
                        .foregroundStyle(tokens.digest)
                }
            } else if let row = featurePageChangeEditedRow(change) {
                Text(row.prettyPrinted)
                    .font(MichiFont.code)
                    .foregroundStyle(tokens.mid)
            } else if let block = featurePageChangeEditedBlock(change) {
                Text(block["text"].stringValue.isEmpty ? featurePageChangeLabel(change) : block["text"].stringValue)
                    .foregroundStyle(tokens.fg)
            } else {
                Text(featurePageChangeLabel(change))
                    .foregroundStyle(tokens.fg)
            }
        }
        .font(MichiFont.sans(size: 15, relativeTo: .body))
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func text(_ value: JSONValue) -> String? {
        value.isNull ? nil : value.stringValue
    }
}

struct DesignPagesBoardColumn: View {
    let title: String
    let count: Int
    var state: MichiThreadState = .idle
    var onAdd: (() -> Void)? = nil
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        HStack(spacing: 8) {
            MichiThreadStateDot(state: state)
            Text(title)
                .font(MichiFont.sans(size: 13, relativeTo: .caption, weight: .medium))
                .foregroundStyle(tokens.fg)
            Text("\(count)")
                .font(MichiFont.meta)
                .foregroundStyle(tokens.muted)
            Spacer()
            if let onAdd {
                Button(action: onAdd) {
                    Image(systemName: "plus")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(tokens.muted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .michiHitTarget()
                .accessibilityLabel("Add to \(title)")
            }
        }
    }
}

struct DesignPagesBoardCard: View {
    let title: String
    var meta: String? = nil
    var tag: String? = nil
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(MichiFont.sans(size: 14.5, relativeTo: .subheadline, weight: .medium))
                .foregroundStyle(tokens.fg)
                .multilineTextAlignment(.leading)
            HStack(spacing: 8) {
                if let meta, !meta.isEmpty {
                    Text(meta)
                        .font(MichiFont.meta)
                        .foregroundStyle(tokens.muted)
                }
                Spacer()
                if let tag, !tag.isEmpty {
                    MichiTag(text: tag, kind: .warn)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tokens.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(tokens.sep, lineWidth: 0.5)
        }
    }
}

struct DesignPagesBoardLayout: View {
    @ObservedObject var model: FeatureDatabaseModel
    @Binding var openedRow: EntityRef?
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(Array(model.orderingRowGroups.enumerated()), id: \.offset) { _, group in
                    column(group)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    private func column(_ group: DatabaseOrderingGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            DesignPagesBoardColumn(
                title: group.title.isEmpty ? "No value" : group.title,
                count: group.rows.count,
                onAdd: {
                    Task {
                        if model.isTasks { await model.addTask() } else { await model.addBlankRow() }
                    }
                }
            )
            ForEach(group.rows, id: \.id) { row in
                Button { openedRow = EntityRef(row) } label: {
                    DesignPagesBoardCard(
                        title: featureRowTitle(row, columns: model.columns, isTasks: model.isTasks),
                        meta: boardMeta(row),
                        tag: model.isTasks ? featureTaskStatusLabel(row["values"]["status"]) : nil
                    )
                }
                .buttonStyle(.plain)
                .nativeDatabaseBoardCardDrag(
                    item: model.orderingDragItem(row: row.id, in: group),
                    group: group,
                    enabled: !model.orderingBlocked,
                    rejection: { model.orderingDropRejection($0, kind: .row) },
                    onDrop: { item, action in applyBoardDrop(item, action, into: group) }
                )
                .contextMenu {
                    ForEach(Array(model.orderingRowGroups.enumerated()), id: \.offset) { _, other in
                        if other.id != group.id {
                            Button(other.title.isEmpty ? "No value" : other.title) {
                                Task { await model.moveBoardCard(row, to: other.key) }
                            }
                        }
                    }
                    Button("Delete", role: .destructive) {
                        Task { await model.deleteRow(row) }
                    }
                }
            }
        }
        .padding(12)
        .frame(width: 260, alignment: .topLeading)
        .background(tokens.bgDeep, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(tokens.line, lineWidth: 1)
        }
        .nativeDatabaseBoardColumnDrop(
            group: group,
            enabled: !model.orderingBlocked,
            rejection: { model.orderingDropRejection($0, kind: .row) },
            onDrop: { item, action in applyBoardDrop(item, action, into: group) }
        )
    }

    private func applyBoardDrop(_ item: DatabaseOrderingDragItem, _ action: NativeDatabaseBoardDropAction, into group: DatabaseOrderingGroup) {
        Task {
            switch action {
            case .moveOnto(let targetID):
                _ = await model.dropOrderedRow(item, onto: targetID)
            case .transfer(let index):
                _ = await model.transferOrderedRow(item, into: group, at: index)
            }
        }
    }

    private func boardMeta(_ row: JSONValue) -> String? {
        if let first = model.columns.first(where: { $0.id != "title" && $0.id != "status" }) {
            let text = featureCellText(row["values"][first.id], type: first["type"].stringValue)
            return text.isEmpty ? nil : text
        }
        return nil
    }
}

struct DesignPagesAllTasksBoard: View {
    @ObservedObject var model: FeatureAllTasksModel
    @Environment(\.michiTokens) private var tokens

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 12) {
                ForEach(Array(model.boardGroups.enumerated()), id: \.offset) { _, group in
                    VStack(alignment: .leading, spacing: 10) {
                        DesignPagesBoardColumn(
                            title: group.label.isEmpty ? "No status" : group.label,
                            count: group.rows.count
                        )
                        ForEach(group.rows, id: \.nativeTaskRowIdentity) { row in
                            NavigationLink {
                                FeatureAllTasksRowScreen(model: model, row: row)
                            } label: {
                                DesignPagesBoardCard(
                                    title: featureRowTitle(row, columns: model.columns, isTasks: true),
                                    tag: featureTaskStatusLabel(row["values"]["status"])
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(12)
                    .frame(width: 260, alignment: .topLeading)
                    .background(tokens.bgDeep, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(tokens.line, lineWidth: 1)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }
}

enum DesignPagesShare {
    static func page(_ title: String) {
        #if canImport(UIKit)
        let text = title.isEmpty ? "Michi page" : title
        let controller = UIActivityViewController(activityItems: [text], applicationActivities: nil)
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let root = scene.keyWindow?.rootViewController ?? scene.windows.first?.rootViewController
        else { return }
        var presenter = root
        while let next = presenter.presentedViewController { presenter = next }
        presenter.present(controller, animated: true)
        #endif
    }
}

private extension UIWindowScene {
    var keyWindow: UIWindow? { windows.first(where: \.isKeyWindow) }
}
