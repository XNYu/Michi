import SwiftUI
import Charts
import MichiCore

struct NativePageHomeSectionView: View {
    @ObservedObject var model: NativePageHomeSectionModel
    let section: NativeHomeSection
    let onOpen: (NativeHomeSectionItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(section.title)
                    .font(MichiFont.sans(size: 13, relativeTo: .caption, weight: .medium))
                    .tracking(0.8)
                    .textCase(.uppercase)
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                if let data = model.sections[section] { Text(data.total.formatted()).font(MichiFont.meta).monospacedDigit().accessibilityLabel("\(data.total) reminders in all workspaces") }
            }
            Text("All workspaces").font(MichiFont.meta).foregroundStyle(.secondary)
            if let error = model.error {
                Text(model.sections.isEmpty ? error : "Showing the last loaded reminders. \(error)").font(.caption).foregroundStyle(.orange)
                Button("Retry reminders") { Task { await model.refresh() } }.disabled(model.loading)
            }
            if let issue = model.sourceIssue { Label(issue, systemImage: "exclamationmark.triangle").font(.caption) }
            if let data = model.sections[section] {
                let rows = model.items(in: section)
                if rows.isEmpty {
                    Text(data.total == 0 ? section.emptyMessage : "No reminders match the current preview rules.").foregroundStyle(.secondary)
                }
                ForEach(rows) { item in
                    DesignPagesActivityRow(
                        title: item.title,
                        subtitle: [item.workspaceName, item.summary].filter { !$0.isEmpty }.joined(separator: " · "),
                        state: section == .stalled ? .stalled : section == .waiting ? .waiting : .done
                    ) { onOpen(item) }
                    .accessibilityLabel("\(actionLabel(item)): \(item.title), \(item.workspaceName)")
                }
                if !data.ruleIDs.isEmpty { Text("Preview follows your Spaces Home layout rules.").font(.caption).foregroundStyle(.secondary) }
                if model.expanded.contains(section) {
                    if let error = model.extraErrors[section] {
                        Text("Couldn’t update the full list. \(error)").font(.caption).foregroundStyle(.orange)
                        Button("Retry full list") { Task { await model.loadMore(section) } }.disabled(model.extraLoading.contains(section))
                    }
                    Text("Showing \(rows.count) of \(data.total)").font(.caption).foregroundStyle(.secondary)
                    Button("Show less") { Task { await model.setExpanded(section, false) } }
                } else if data.total > data.items.count {
                    Button("View all") { Task { await model.setExpanded(section, true) } }
                }
                if model.extraLoading.contains(section) { ProgressView("Loading conversations") }
            } else if model.loading { ProgressView("Loading reminders") }
        }
        .buttonStyle(.borderless)
    }

    private func actionLabel(_ item: NativeHomeSectionItem) -> String {
        if case .page = item.target { return "Review" }
        switch section { case .waiting: return "Back to chat"; case .stalled: return "Continue"; case .done: return "View chat" }
    }
}

/// The menu is computed from the current saved block on every render. It never
/// stores resolved passage snapshots or guesses where a stale anchor moved.
struct NativePageSourcesControl: View {
    let block: JSONValue
    var savedContent = false
    @Environment(\.openMichiReference) private var openReference

    var body: some View {
        let provenance = NativePageProvenance(block: block)
        if provenance.isVisible {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 12) {
                    if savedContent { Text("Sources for the saved content").font(.caption).foregroundStyle(.secondary) }
                    ForEach(Array(provenance.groups.enumerated()), id: \.element.id) { groupIndex, group in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(group.label).font(.caption.weight(.semibold))
                            if let passage = group.passage {
                                Text(verbatim: passage).font(.footnote).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("page-source-passage-\(block.id)-\(groupIndex)")
                            } else {
                                Text("Recorded for the whole block.")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            ForEach(Array(group.sources.enumerated()), id: \.element.id) { sourceIndex, source in
                                Button { openReference(source.reference) } label: {
                                    Label("Source \(sourceIndex + 1) · Open exact message", systemImage: "text.bubble")
                                }
                                .font(.footnote).buttonStyle(.borderless)
                                .accessibilityLabel("Open source \(sourceIndex + 1) for \(group.label)")
                                .accessibilityIdentifier("page-source-open-\(block.id)-\(groupIndex)-\(sourceIndex)")
                            }
                        }
                    }
                    if provenance.unavailablePassages {
                        Text("Passage sources could not be matched to the current text.")
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("page-sources-stale-\(block.id)")
                    }
                    if provenance.invalidSources { Text("Some source details are unavailable.").font(.caption).foregroundStyle(.secondary) }
                    if provenance.limited { Text("Additional sources are not shown here.").font(.caption).foregroundStyle(.secondary) }
                }.padding(.vertical, 6)
            } label: {
                Label(provenance.sourceCount > 0 ? "Sources (\(provenance.sourceCount))" : "Sources unavailable", systemImage: "quote.bubble")
                    .font(.caption)
            }
            .accessibilityIdentifier("page-sources-" + block.id)
        }
    }
}

struct NativePageChangeSourcesView: View {
    let source: JSONValue
    @Environment(\.openMichiReference) private var openReference
    var body: some View {
        let provenance = NativePageChangeProvenance(source: source)
        VStack(alignment: .leading, spacing: 6) {
            Label(provenance.label, systemImage: "quote.bubble").font(.caption).foregroundStyle(.secondary)
            if let read = provenance.readSummary { Text(read).font(.caption).foregroundStyle(.secondary) }
            ForEach(provenance.links) { link in
                Button(link.label) { openReference(link.reference) }.font(.footnote).buttonStyle(.borderless)
            }
        }.accessibilityIdentifier("page-change-sources")
    }
}

/// All controls keep the page's identity and revision. A host may omit actions
/// it cannot perform; those are shown as unavailable instead of faking a save.
struct NativeRichPageBlock: View {
    let block: JSONValue
    var pageBlocks: [JSONValue] = []
    var onApply: ((JSONValue, String, Int) async -> Bool)?
    var onApplyPageBlock: ((JSONValue, String, Int) async -> Bool)?
    var onOpenThread: ((String) -> Void)?
    var onOpenPage: ((String) -> Void)?
    var onOpenDatabase: ((String, String?) -> Void)?
    var onOpenTasks: ((String?) -> Void)?
    var onPrompt: ((String) async -> Bool)?
    var onOpenFile: ((String) -> Void)?
    var onScrollToBlock: ((String) -> Void)?
    var onOpenComponent: ((String, Int?) -> Void)?
    var homeSectionContent: ((String) -> AnyView)?
    var threadRows: [JSONValue] = []
    var depth = 0
    var visitedViews: Set<String> = []
    var outlineTop = true
    var navigationScope: [JSONValue]? = nil
    @Environment(\.pageNavigationCommand) private var navigationCommand
    @Environment(\.pageNavigationJump) private var navigationJump
    @Environment(\.michiReferenceAPI) private var referenceAPI
    @Environment(\.openMichiReference) private var openMichiReference
    @Environment(\.michiTokens) private var tokens
    @Environment(\.nativePageComponentOwnership) private var pageComponentOwnership
    @Environment(\.nativePageComponentActions) private var pageComponentActions
    @State private var busy = false
    @State private var error: String?
    @State private var selectedTab = 0
    @State private var toggleExpanded = false
    @State private var inlineView: RichPageViewSelection?
    @State private var presentedView: RichPageViewSelection?
    @State private var formValues: [String: JSONValue] = [:]
    @State private var pollSelection: Set<Int> = []

    private var type: String { block["type"].stringValue }
    private var items: [JSONValue] { Array(block["items"].arrayValue.prefix(100)) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let error { Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red) }
            if depth > 6 {
                Label("This content is nested too deeply to display.", systemImage: "square.stack.3d.up")
            } else {
                if !["heading", "view", "toggle", "progress", "countdown", "form", "chart"].contains(type) {
                    title(block["title"].stringValue)
                }
                content
                NativePageSourcesControl(block: block)
                if block["interaction"]["action"]["type"] == "open-view" {
                    Button(block["interaction"]["label"].stringValue) { openView(block["interaction"]["action"]) }
                }
                if let view = inlineView?.resolve(blocks: pageBlocks, visited: visitedViews) {
                    DisclosureGroup(isExpanded: Binding(get: { self.inlineView != nil }, set: { if !$0 { self.inlineView = nil } })) {
                        PageNavigationScopedViewport(blocks: view.blocks) {
                            ScrollView { viewContent(view).padding(.vertical, 8) }
                                .frame(height: 420)
                        }
                    } label: { Text(view.title).font(.headline) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(busy)
        .id(block.id)
        .modifier(PageNavigationAnchorPresence(id: block.id))
        .modifier(PageNavigationHighlight(id: blockHighlightID))
        .accessibilityIdentifier(block.id.isEmpty ? "page-block-\(type)" : PageNavigation.blockAccessibilityID(block.id))
        .sheet(item: presentedViewBinding) { view in
            NavigationStack {
                PageNavigationScopedViewport(blocks: view.blocks) {
                    ScrollView { viewContent(view).padding() }
                }
                .navigationTitle(view.title)
                .toolbar { Button("Done") { presentedView = nil } }
            }
            .nativeMichiReferences(api: referenceAPI)
            .presentationDetents(view.presentation == "modal" ? [.large] : [.medium, .large])
        }
        .onChange(of: block["fields"]) { _, _ in formValues = [:] }
        .onChange(of: block["options"]) { _, _ in pollSelection = [] }
        .onChange(of: pageBlocks) { _, _ in closeUnavailableViews() }
        .onChange(of: visitedViews) { _, _ in closeUnavailableViews() }
        .onChange(of: block.id) { _, _ in
            formValues = [:]; pollSelection = []; selectedTab = 0; toggleExpanded = false; inlineView = nil; presentedView = nil; error = nil
        }
        .onAppear { applyNavigationReveal() }
        .onChange(of: navigationCommand?.token) { _, _ in applyNavigationReveal() }
        .environment(\.openURL, OpenURLAction { url in
            if let action = RichPageBlockModel.viewAction(href: url) { openView(action); return .handled }
            return nativeMichiOpenURL(url, allowInternal: referenceAPI != nil, open: openMichiReference)
        })
    }
    @ViewBuilder private var content: some View {
        switch type {
        case "heading": Text(block["text"].stringValue).font(.title2.bold()).accessibilityAddTraits(.isHeader)
        case "markdown":
            NativeMarkdown(
                text: block["text"].stringValue,
                headingAnchorIDs: PageNavigation.headingAnchorIDs(
                    blockID: block.id,
                    text: block["text"].stringValue,
                    topLevel: outlineTop,
                    editing: PageNavigation.hasEditMarker(block)
                )
            )
            ForEach(Array(RichPageBlockModel.markdownViewLinks(block["text"].stringValue).enumerated()), id: \.offset) { _, link in
                Button(link.label) { openView(link.action) }
            }
        case "quote":
            VStack(alignment: .leading, spacing: 8) {
                Text(block["text"].stringValue).italic()
                note(block["cite"].stringValue)
            }.padding(.leading, 12).overlay(alignment: .leading) { Rectangle().fill(.secondary).frame(width: 3) }
        case "divider": Divider()
        case "callout":
            Label { NativeMarkdown(text: block["text"].stringValue) } icon: { Image(systemName: toneSymbol(block["tone"].stringValue)) }
                .padding(12).background(toneColor(block["tone"].stringValue).opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
        case "checklist": checklist
        case "metrics": metrics
        case "next-steps", "timeline", "criteria", "forgot", "milestones", "agenda": structuredList
        case "plan-actual": planActual
        case "compare", "conflict", "choice": decisions
        case "table": NativeRichTable(columns: block["columns"].arrayValue.map(RichPageBlockModel.text), rows: block["rows"].arrayValue.map { $0.arrayValue.map(RichPageBlockModel.text) })
        case "chart": NativeRichChart(block: block)
        case "gallery", "carousel": pictures
        case "image": NativeRichPicture(item: block)
        case "before-after":
            NativeRichPicture(item: ["url": block["before"], "caption": "Before"])
            NativeRichPicture(item: ["url": block["after"], "caption": "After"])
            note(block["caption"].stringValue)
        case "video", "audio": NativeMediaPlayer(item: block)
        case "embed":
            Label("Embedded web content opens in your browser.", systemImage: "safari")
            safeLink(block["url"].stringValue, label: "Open \(block["title"].optionalString ?? "content")")
        case "link", "place", "person": referenceCard
        case "file":
            callbackButton(block["title"].optionalString ?? block["path"].stringValue, icon: "doc", available: onOpenFile != nil) { onOpenFile?(block["path"].stringValue) }
            note(block["note"].stringValue)
        case "threads": threadCards
        case "home-section":
            if let homeSectionContent { homeSectionContent(block["section"].stringValue) }
            else { note("Live reminders are unavailable in this preview.") }
        case "page-link": callbackButton("Open linked page", icon: "doc", available: onOpenPage != nil) { onOpenPage?(block["pageId"].stringValue) }
        case "database-ref": callbackButton("Open database view", icon: "tablecells", available: onOpenDatabase != nil) { onOpenDatabase?(block["databaseId"].stringValue, block["viewId"].optionalString) }
        case "task-view": callbackButton("Open workspace tasks", icon: "checklist", available: onOpenTasks != nil) { onOpenTasks?(block["viewId"].optionalString) }
        case "toggle":
            DisclosureGroup(isExpanded: $toggleExpanded) {
                nested(block["blocks"].arrayValue, collection: "blocks")
            } label: {
                Text(block["title"].stringValue)
            }
        case "columns": containerColumns
        case "grid": containerGrid
        case "tabs": containerTabs
        case "view": EmptyView()
        case "view-link": Button(block["label"].stringValue) { openView(block["action"]) }
        case "toc": tableOfContents
        case "code": source(block["code"].stringValue, language: block["lang"].stringValue)
        case "diff":
            GroupBox("Before") { source(block["before"].stringValue, language: block["lang"].stringValue) }
            GroupBox("After") { source(block["after"].stringValue, language: block["lang"].stringValue) }
        case "mermaid":
            NativeMermaidBlock(source: block["code"].stringValue)
        case "math":
            NativeMathView(tex: block["tex"].stringValue, display: block["display"].boolValue)
        case "keyvalue":
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                LabeledContent(item["key"].stringValue) { Text(RichPageBlockModel.text(item["value"])).textSelection(.enabled) }
            }
        case "tags":
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100))], alignment: .leading) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Text(item["label"].stringValue).font(.caption).padding(8)
                        .background(toneColor(item["tone"].stringValue).opacity(0.12), in: Capsule())
                }
            }
        case "status":
            Label(block["label"].stringValue, systemImage: toneSymbol(block["tone"].stringValue)).foregroundStyle(toneColor(block["tone"].stringValue)).font(.headline)
            Text(block["summary"].stringValue); note(block["note"].stringValue)
        case "stat": statistic
        case "progress", "ring", "gauge": progress
        case "leaderboard", "rating": rankings
        case "pros-cons": prosCons(block)
        case "stepper": steps
        case "calendar": calendar
        case "gantt": gantt
        case "countdown":
            title(block["title"].stringValue)
            if let date = RichPageBlockModel.date(block["to"].stringValue) {
                Text(date, style: .relative).font(.title.monospacedDigit())
                Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption)
            } else { Text(block["to"].stringValue) }
        case "clocks":
            TimelineView(.periodic(from: .now, by: 60)) { context in
                ForEach(Array(block["zones"].arrayValue.prefix(12).enumerated()), id: \.offset) { _, zone in
                    if let timeZone = TimeZone(identifier: zone["tz"].stringValue) {
                        LabeledContent(zone["label"].stringValue, value: clockText(context.date, zone: timeZone))
                    } else { Label("Unknown time zone: \(zone["tz"].stringValue)", systemImage: "clock.badge.exclamationmark") }
                }
            }
        case "actions":
            ForEach(Array(block["buttons"].arrayValue.prefix(6).enumerated()), id: \.offset) { _, item in
                Button(item["label"].stringValue) { sendPrompt(item["prompt"].stringValue) }.disabled(onPrompt == nil)
            }
            promptAvailability
        case "form": form
        case "poll": poll
        case "component":
            pageComponentBlock
        default:
            Label("This block type is not supported yet.", systemImage: "square.dashed")
            DisclosureGroup("Saved content") { source(block.prettyPrinted, language: "JSON") }
        }
    }

    @ViewBuilder private var pageComponentBlock: some View {
        if let api = referenceAPI, let ownership = pageComponentOwnership,
           NativePageComponentContract.pageHost(ownership: ownership, block: block) != nil {
            NativePageBoundComponentHost(
                api: api,
                ownership: ownership,
                block: block,
                onNavigatePage: pageComponentActions.navigationHandler,
                onAskDraft: pageComponentActions.draftHandler
            )
            pageComponentDetails
        } else if featureCanHostRegisteredComponent(block) {
            Label(pageComponentUnavailableTitle, systemImage: "puzzlepiece.extension")
            Text(pageComponentUnavailableReason).font(.caption).foregroundStyle(.secondary)
            pageComponentDetails
        } else {
            Label("This component uses browser code.", systemImage: "puzzlepiece.extension")
            Text(featureUnsupportedCustomReason(block)).font(.caption).foregroundStyle(.secondary)
            pageComponentDetails
        }
    }

    @ViewBuilder private var pageComponentDetails: some View {
        if let onOpenComponent, !block["componentId"].stringValue.isEmpty {
            Button("Component details & versions") {
                onOpenComponent(block["componentId"].stringValue, nativeComponentVersion(block["pinnedVersion"]))
            }
        }
        DisclosureGroup("Saved properties") { source(block["props"].prettyPrinted, language: "JSON") }
    }

    private var pageComponentUnavailableTitle: String {
        if pageComponentOwnership?.readOnly == true { return "Component paused" }
        return "Registered component"
    }

    private var pageComponentUnavailableReason: String {
        guard let ownership = pageComponentOwnership else {
            return "This component needs the open page's workspace and identity before it can run."
        }
        if !ownership.available {
            return "This component runs after the page is confirmed."
        }
        if ownership.readOnly {
            return "This page is read-only, so the component is paused."
        }
        if referenceAPI == nil {
            return "This component needs the connected backend before it can run."
        }
        return "This component cannot run on this page."
    }

    private var checklist: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
            Button { changeItem(index, field: "done", value: .bool(!item["done"].boolValue)) } label: {
                Label(item["text"].stringValue, systemImage: item["done"].boolValue ? "checkmark.circle.fill" : "circle")
            }.buttonStyle(.plain).disabled(onApply == nil)
                .accessibilityValue(item["done"].boolValue ? "Completed" : "Not completed")
        }
    }
    private var metrics: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 145))], alignment: .leading, spacing: 12) {
            ForEach(Array(items.prefix(12).enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 6) {
                    note(item["label"].stringValue)
                    Text(item["value"].stringValue).font(.title2.bold()).foregroundStyle(item["tone"] == "accent" ? Color.accentColor : Color.primary)
                    note(item["note"].stringValue)
                    if item["action"]["type"] == "open-view" { Button("Details") { openView(item["action"]) }.accessibilityLabel("Details for \(item["label"].stringValue)") }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
    private var structuredList: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: rowSymbol(item)).foregroundStyle(toneColor(item["tone"].stringValue))
                VStack(alignment: .leading, spacing: 5) {
                    let label = item["title"].optionalString ?? item["text"].optionalString ?? item["label"].stringValue
                    Text(label).font(.body.weight(.medium))
                    if type == "next-steps" { note(item["who"] == "user" ? "You" : "Assistant"); note(item["unblocks"].stringValue.isEmpty ? "" : "Unblocks \(item["unblocks"].stringValue)") }
                    if type == "criteria" { note(item["state"].stringValue.replacingOccurrences(of: "-", with: " ")); note(item["now"].stringValue); note(item["from"].stringValue) }
                    if type == "forgot" { note(item["state"] == "shipped" ? "Shipped" : "Unfinished") }
                    note(RichPageBlockModel.timestamp(item["at"]))
                    note(item["date"].stringValue); note(item["time"].stringValue)
                    note(item["detail"].stringValue); note(item["note"].stringValue)
                }
            }.accessibilityElement(children: .combine).padding(.vertical, 3)
        }
    }
    private var planActual: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
            VStack(alignment: .leading, spacing: 6) {
                Text(item["label"].stringValue).font(.headline)
                if item["planned"].isNull {
                    LabeledContent("Planned", value: "\(item["planStart"].stringValue) → \(item["planEnd"].stringValue)")
                    LabeledContent("Actual", value: item["actualStart"].isNull ? "Not started" : "\(item["actualStart"].stringValue) → \(item["actualEnd"].optionalString ?? "Now")")
                    if !item["forecastEnd"].isNull { LabeledContent("Forecast", value: "\(item["forecastStart"].stringValue) → \(item["forecastEnd"].stringValue)") }
                } else {
                    LabeledContent("Planned", value: amount(item["planned"], unit: item["unit"].stringValue))
                    LabeledContent("Actual", value: amount(item["actual"], unit: item["unit"].stringValue))
                    if !item["forecast"].isNull { LabeledContent("Forecast", value: amount(item["forecast"], unit: item["unit"].stringValue)) }
                    if let planned = RichPageBlockModel.number(item["planned"]), let actual = RichPageBlockModel.number(item["actual"]) {
                        ProgressView(value: min(actual, max(planned, 1)), total: max(planned, 1))
                        if actual > planned { Label("Over plan by \(amount(.number(actual - planned), unit: item["unit"].stringValue))", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange) }
                    }
                }
            }.padding(.vertical, 6)
        }
    }
    private var decisions: some View {
        VStack(alignment: .leading, spacing: 12) {
            title(block["question"].stringValue)
            ForEach(Array(block["options"].arrayValue.prefix(50).enumerated()), id: \.offset) { index, item in
                VStack(alignment: .leading, spacing: 7) {
                    Text(item.optionalString ?? item["name"].optionalString ?? item["text"].stringValue).font(.headline)
                    if !item["value"].isNull { Text(amount(item["value"], unit: item["unit"].stringValue)).font(.title3) }
                    note(item["note"].stringValue); note(item["from"].stringValue); note(RichPageBlockModel.timestamp(item["at"]))
                    if item["lean"].boolValue { Label("Recommended", systemImage: "star").font(.caption) }
                    if type == "compare" { prosCons(item) }
                    if !item["nodeId"].stringValue.isEmpty {
                        callbackButton("Open source conversation", icon: "bubble.left", available: onOpenThread != nil) { onOpenThread?(item["nodeId"].stringValue) }
                    }
                    let field = type == "compare" ? "picked" : type == "choice" ? "selected" : "resolution"
                    let selected = block[field] == .number(Double(index)) || (type == "conflict" && block[field] == "both")
                    Button { change(field, to: .number(Double(index))) } label: {
                        Label(selected ? "Selected" : type == "conflict" ? "Keep this version" : "Choose", systemImage: selected ? "checkmark.circle.fill" : "circle")
                    }.disabled(onApply == nil)
                }.padding(12).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
            }
            if type == "conflict" { Button("Keep both") { change("resolution", to: "both") }.disabled(onApply == nil) }
        }
    }
    private var pictures: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180))], spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in NativeRichPicture(item: item) }
        }
    }
    private var referenceCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            if type == "person", !block["avatar"].stringValue.isEmpty { NativeRichPicture(item: ["url": block["avatar"], "alt": block["name"]]) }
            if !block["image"].stringValue.isEmpty { NativeRichPicture(item: ["url": block["image"], "alt": block["title"]]) }
            if !block["name"].stringValue.isEmpty { Text(block["name"].stringValue).font(.headline) }
            note(block["description"].stringValue); note(block["role"].stringValue); note(block["address"].stringValue); note(block["note"].stringValue)
            safeLink(block["url"].stringValue, label: "Open link")
            ForEach(Array(block["links"].arrayValue.prefix(10).enumerated()), id: \.offset) { _, link in safeLink(link["url"].stringValue, label: link["label"].stringValue) }
        }
    }
    private var threadCards: some View {
        ForEach(Array(block["nodeIds"].arrayValue.prefix(20).enumerated()), id: \.offset) { _, id in
            let row = threadRows.first { $0.id == id.stringValue }
            callbackButton(row?["title"].optionalString ?? "Conversation \(id.stringValue)", icon: "bubble.left", available: onOpenThread != nil) { onOpenThread?(id.stringValue) }
            if let row { note(row["status"].stringValue) }
        }
    }
    private var containerColumns: some View {
        // iPhone stacks columns in reading order, matching the mobile page.
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(block["columns"].arrayValue.prefix(4).enumerated()), id: \.offset) { group, column in
                nested(column.arrayValue, collection: "columns", group: group)
                if group + 1 < block["columns"].arrayValue.count { Divider() }
            }
        }
    }
    private var containerGrid: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(block["regions"].arrayValue.prefix(12).enumerated()), id: \.offset) { index, region in
                VStack(alignment: .leading, spacing: 8) {
                    title(region["title"].stringValue)
                    nested(region["blocks"].arrayValue, collection: "regions", group: index)
                }.id(region.id)
            }
        }
    }
    private var containerTabs: some View {
        VStack(alignment: .leading, spacing: 12) {
            let tabs = Array(block["tabs"].arrayValue.prefix(6))
            Picker("Section", selection: $selectedTab) {
                ForEach(Array(tabs.enumerated()), id: \.offset) { index, tab in Text(tab["label"].stringValue).tag(index) }
            }.pickerStyle(.menu)
            if tabs.indices.contains(selectedTab) { nested(tabs[selectedTab]["blocks"].arrayValue, collection: "tabs", group: selectedTab) }
        }.onChange(of: block["tabs"]) { _, _ in selectedTab = 0 }
    }
    private func nested(_ children: [JSONValue], collection: String, group: Int? = nil) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(children.prefix(20).enumerated()), id: \.offset) { index, child in
                AnyView(childView(child, apply: nestedApply(collection: collection, group: group, index: index)))
            }
        }
    }
    private func nestedApply(collection: String, group: Int?, index: Int) -> ((JSONValue, String, Int) async -> Bool)? {
        mutationRoute.nested(parent: block, collection: collection, group: group, index: index, onError: { error = $0 }).local
    }
    private var mutationRoute: RichPageMutationRoute { RichPageMutationRoute(page: onApplyPageBlock ?? onApply, local: onApply) }
    private func childView(_ child: JSONValue, apply: ((JSONValue, String, Int) async -> Bool)?, outlineTop: Bool = false) -> NativeRichPageBlock {
        NativeRichPageBlock(block: child, pageBlocks: pageBlocks, onApply: apply, onApplyPageBlock: mutationRoute.page,
                            onOpenThread: onOpenThread, onOpenPage: onOpenPage, onOpenDatabase: onOpenDatabase,
                            onOpenTasks: onOpenTasks, onPrompt: onPrompt, onOpenFile: onOpenFile,
                            onScrollToBlock: onScrollToBlock, onOpenComponent: onOpenComponent, homeSectionContent: homeSectionContent,
                            threadRows: threadRows, depth: depth + 1, visitedViews: visitedViews, outlineTop: outlineTop,
                            navigationScope: navigationScope)
    }
    private func viewContent(_ view: RichPageView) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(view.blocks.enumerated()), id: \.offset) { _, target in
                var child = childView(target, apply: mutationRoute.namedView(view, pageBlocks: pageBlocks, onError: { error = $0 }).local, outlineTop: true)
                child.visitedViews = visitedViews.union([view.id])
                child.navigationScope = view.blocks
                return AnyView(child)
            }
        }
    }
    /// The sheet receives a freshly resolved value through its binding, even if
    /// the selected named-view identity stays the same after a page refresh.
    private var presentedViewBinding: Binding<RichPageView?> {
        Binding(get: { presentedView?.resolve(blocks: pageBlocks, visited: visitedViews) },
                set: { if $0 == nil { presentedView = nil } })
    }
    private func closeUnavailableViews() {
        var closed = false
        if let inlineView, inlineView.resolve(blocks: pageBlocks, visited: visitedViews) == nil { self.inlineView = nil; closed = true }
        if let presentedView, presentedView.resolve(blocks: pageBlocks, visited: visitedViews) == nil { self.presentedView = nil; closed = true }
        if closed { error = "The open view is no longer available on this page." }
    }
    private var tableOfContents: some View {
        VStack(alignment: .leading, spacing: 8) {
            title("Contents")
            let heads = PageNavigation.outline(navigationScope ?? pageBlocks)
            if heads.isEmpty {
                Text("This page has no headings yet").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(Array(heads.enumerated()), id: \.offset) { index, heading in
                Button {
                    jumpToHeading(heading.id)
                } label: {
                    Text(heading.text)
                        .padding(.leading, CGFloat(max(0, heading.level - (heads.map(\.level).min() ?? heading.level))) * 12)
                }
                .disabled(jumpAction == nil)
                .accessibilityIdentifier(PageNavigation.tocAccessibilityID(heading.id))
                .accessibilityLabel("\(index + 1). \(heading.text)")
            }
        }
    }

    private var jumpAction: ((String) -> Void)? { navigationJump ?? onScrollToBlock }

    private func jumpToHeading(_ id: String) {
        jumpAction?(id)
    }

    private var blockHighlightID: String? {
        guard !block.id.isEmpty else { return nil }
        if navigationCommand?.target.scrollID == block.id { return block.id }
        if navigationCommand?.target.blockID == block.id, navigationCommand?.target.segmentIndex == nil { return block.id }
        return nil
    }

    private func applyNavigationReveal() {
        guard let command = navigationCommand else { return }
        for reveal in command.target.reveals {
            switch reveal {
            case .toggle(let id) where id == block.id:
                toggleExpanded = true
            case .tab(let id, let index) where id == block.id:
                if block["tabs"].arrayValue.prefix(6).indices.contains(index) { selectedTab = index }
            default:
                break
            }
        }
    }
    private var statistic: some View {
        VStack(alignment: .leading, spacing: 8) {
            note(block["label"].stringValue)
            Text(block["value"].stringValue).font(.largeTitle.bold()).minimumScaleFactor(0.6)
            if !block["delta"].stringValue.isEmpty { Label(block["delta"].stringValue, systemImage: block["deltaTone"] == "down" ? "arrow.down" : block["deltaTone"] == "up" ? "arrow.up" : "minus").font(.subheadline) }
            if !block["spark"].arrayValue.isEmpty {
                NativeRichChart(block: ["type": "chart", "kind": "sparkline", "title": "", "values": block["spark"]])
            }
        }
    }
    @ViewBuilder private var progress: some View {
        if type == "ring" {
            ForEach(Array(items.prefix(8).enumerated()), id: \.offset) { _, item in
                if let value = RichPageBlockModel.number(item["value"]) {
                    HStack { Gauge(value: min(1, max(0, value))) { Text(item["label"].stringValue) }.gaugeStyle(.accessoryCircular)
                        Text("\(item["label"].stringValue): \(value.formatted(.percent))") }
                }
            }
        } else if type == "gauge", let value = RichPageBlockModel.number(block["value"]), let min = RichPageBlockModel.number(block["min"]), let max = RichPageBlockModel.number(block["max"]), max > min {
            Gauge(value: Swift.min(max, Swift.max(min, value)), in: min...max) { Text(block["title"].stringValue) } currentValueLabel: { Text(amount(block["value"], unit: block["unit"].stringValue)) }
        } else {
            title(block["title"].stringValue)
            if let value = RichPageBlockModel.number(block["actual"]) { ProgressView(value: min(1, max(0, value))) { Text("Actual: \(value.formatted(.percent))") } }
            if let expected = RichPageBlockModel.number(block["expected"]) { note("Expected: \(expected.formatted(.percent))") }
        }
    }
    private var rankings: some View {
        let rows = type == "leaderboard" ? items.sorted { $0["value"].doubleValue > $1["value"].doubleValue } : items
        return ForEach(Array(rows.enumerated()), id: \.offset) { index, item in
            HStack {
                Text(type == "leaderboard" ? "\(index + 1). \(item["name"].stringValue)" : item["label"].stringValue)
                Spacer()
                Text(type == "rating" ? "\(RichPageBlockModel.text(item["score"])) / 5 ★" : RichPageBlockModel.text(item["value"])).monospacedDigit()
            }.accessibilityElement(children: .combine)
            note(item["note"].stringValue)
        }
    }
    private var steps: some View {
        ForEach(Array(block["steps"].arrayValue.prefix(50).enumerated()), id: \.offset) { index, step in
            VStack(alignment: .leading, spacing: 5) {
                Label(step["label"].stringValue, systemImage: index < block["current"].intValue ? "checkmark.circle.fill" : index == block["current"].intValue ? "arrow.right.circle" : "circle")
                note(step["text"].stringValue)
            }
        }
    }
    private var calendar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(block["month"].stringValue).font(.headline)
            ForEach(Array(block["events"].arrayValue.prefix(100).sorted { $0["date"].stringValue < $1["date"].stringValue }.enumerated()), id: \.offset) { _, event in
                LabeledContent(event["date"].stringValue, value: event["title"].stringValue)
            }
            if block["events"].arrayValue.isEmpty { note("No events this month") }
        }
    }
    private var gantt: some View {
        VStack(alignment: .leading, spacing: 8) {
            Chart {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    if let start = RichPageBlockModel.date(item["start"].stringValue), let end = RichPageBlockModel.date(item["end"].stringValue) {
                        BarMark(xStart: .value("Start", start), xEnd: .value("End", end), y: .value("Task", item["label"].stringValue))
                            .foregroundStyle(by: .value("Group", item["group"].stringValue))
                    }
                }
            }
            .michiChartSeriesPalette(items.filter { RichPageBlockModel.date($0["start"].stringValue) != nil && RichPageBlockModel.date($0["end"].stringValue) != nil }.map { $0["group"].stringValue }, tokens: tokens)
            .frame(height: CGFloat(min(460, max(180, items.count * 32)))).accessibilityLabel(block["title"].stringValue)
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                Text("\(item["label"].stringValue): \(item["start"].stringValue) → \(item["end"].stringValue)").font(.caption)
                if let done = RichPageBlockModel.number(item["done"]) { note("\(done.formatted(.percent)) done") }
            }
        }
    }
    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            title(block["title"].stringValue)
            ForEach(Array(block["fields"].arrayValue.prefix(20).enumerated()), id: \.offset) { _, field in
                formField(field)
            }
            Button(block["submitLabel"].optionalString ?? "Submit") {
                do { sendPrompt(try RichPageBlockModel.formPrompt(block, values: formValues)) }
                catch { self.error = error.localizedDescription }
            }.disabled(onPrompt == nil)
            promptAvailability
        }
    }
    @ViewBuilder private func formField(_ field: JSONValue) -> some View {
        let key = field["key"].stringValue
        let label = field["label"].stringValue + (field["required"].boolValue ? " *" : "")
        let binding = Binding<String>(get: { formValues[key]?.stringValue ?? "" }, set: { formValues[key] = .string($0) })
        switch field["type"].stringValue {
        case "checkbox": Toggle(label, isOn: Binding(get: { formValues[key]?.boolValue ?? false }, set: { formValues[key] = .bool($0) }))
        case "select":
            Picker(label, selection: binding) {
                Text("Choose…").tag("")
                ForEach(Array(field["options"].arrayValue.enumerated()), id: \.offset) { _, option in Text(option.stringValue).tag(option.stringValue) }
            }
        case "date":
            Toggle(label, isOn: Binding(get: { formValues[key]?.isNull == false }, set: { enabled in
                formValues[key] = enabled ? .string(RichPageBlockModel.localDay(Date())) : .null
            }))
            if let value = formValues[key], !value.isNull {
                DatePicker(label, selection: Binding(get: { RichPageBlockModel.localDate(value.stringValue) ?? Date() }, set: { formValues[key] = .string(RichPageBlockModel.localDay($0)) }), displayedComponents: .date)
            }
        default:
            TextField(label, text: binding).textFieldStyle(.roundedBorder)
                .keyboardType(field["type"] == "number" ? .numbersAndPunctuation : .default)
        }
    }
    private var poll: some View {
        VStack(alignment: .leading, spacing: 10) {
            title(block["question"].stringValue)
            ForEach(Array(block["options"].arrayValue.prefix(50).enumerated()), id: \.offset) { index, option in
                Button {
                    if block["multi"].boolValue {
                        if !pollSelection.insert(index).inserted { pollSelection.remove(index) }
                    } else { pollSelection = [index] }
                } label: { Label(option.stringValue, systemImage: pollSelection.contains(index) ? "checkmark.circle.fill" : "circle") }.buttonStyle(.plain)
            }
            Button("Vote") {
                let chosen = block["options"].arrayValue.enumerated().filter { pollSelection.contains($0.offset) }.map { $0.element.stringValue }
                sendPrompt("For “\(block["question"].stringValue)” I pick: \(chosen.joined(separator: ", "))")
            }.disabled(onPrompt == nil || pollSelection.isEmpty)
            promptAvailability
        }
    }
    private func prosCons(_ value: JSONValue) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(Array(value["pros"].arrayValue.prefix(50).enumerated()), id: \.offset) { _, line in Label(line.stringValue, systemImage: "plus.circle").foregroundStyle(.green) }
            ForEach(Array(value["cons"].arrayValue.prefix(50).enumerated()), id: \.offset) { _, line in Label(line.stringValue, systemImage: "minus.circle").foregroundStyle(.orange) }
        }
    }
    @ViewBuilder private var promptAvailability: some View {
        if onPrompt == nil { note("The assistant is not available from this page.") }
    }
    @ViewBuilder private func callbackButton(_ label: String, icon: String, available: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Label(label, systemImage: icon) }.disabled(!available)
        if !available { note("This action is not available from this page.") }
    }
    @ViewBuilder private func safeLink(_ raw: String, label: String) -> some View {
        if let url = URL(string: raw), MarkdownDocument.safeLink(url) || NativeMichiReference.parse(raw) != nil {
            Link(label, destination: url)
        } else if !raw.isEmpty { Text(raw).font(.caption).textSelection(.enabled) }
    }
    @ViewBuilder private func title(_ value: String) -> some View {
        if !value.isEmpty { Text(value).font(.headline).accessibilityAddTraits(.isHeader) }
    }
    @ViewBuilder private func note(_ value: String) -> some View {
        if !value.isEmpty { Text(value).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
    }
    private func source(_ text: String, language: String) -> some View {
        ScrollView(.vertical) { NativeCodeBlock(language: language, text: text) }.frame(maxHeight: 360)
    }
    private func amount(_ value: JSONValue, unit: String) -> String { RichPageBlockModel.text(value) + (unit.isEmpty ? "" : " \(unit)") }
    private func clockText(_ date: Date, zone: TimeZone) -> String {
        let formatter = DateFormatter(); formatter.timeZone = zone; formatter.timeStyle = .short; formatter.dateStyle = .none
        return formatter.string(from: date) + " · " + zone.identifier
    }
    private func rowSymbol(_ item: JSONValue) -> String {
        if type == "next-steps" { return item["who"] == "user" ? "person" : "sparkles" }
        if type == "criteria" { return item["state"] == "done" ? "checkmark.circle.fill" : item["state"] == "stalled" ? "exclamationmark.circle" : "circle" }
        if type == "milestones" { return item["done"].boolValue ? "checkmark.circle.fill" : "circle" }
        if type == "forgot" { return item["state"] == "shipped" ? "shippingbox" : "clock" }
        return toneSymbol(item["tone"].stringValue)
    }
    private func toneSymbol(_ tone: String) -> String {
        switch tone { case "success": return "checkmark.circle"; case "warn": return "exclamationmark.triangle"; case "danger": return "exclamationmark.octagon"; default: return "info.circle" }
    }
    private func toneColor(_ tone: String) -> Color {
        switch tone { case "success": return .green; case "warn": return .orange; case "danger": return .red; default: return .accentColor }
    }
    private func change(_ field: String, to value: JSONValue) {
        var next = featureBlockInput(from: block); next[field] = value; save(next)
    }
    private func changeItem(_ index: Int, field: String, value: JSONValue) {
        var next = featureBlockInput(from: block), items = block["items"].arrayValue
        guard items.indices.contains(index) else { return }
        items[index][field] = value; next["items"] = .array(items); save(next)
    }
    private func save(_ next: JSONValue) {
        guard !busy, let onApply else { return }
        busy = true; error = nil
        Task { defer { busy = false }; if !(await onApply(next, block.id, block["rev"].intValue)) { error = "The change was not saved. Your page content has been kept." } }
    }
    private func sendPrompt(_ prompt: String) {
        guard !busy, let onPrompt, !prompt.isEmpty else { return }
        busy = true; error = nil
        Task { defer { busy = false }; if !(await onPrompt(prompt)) { error = "The assistant did not accept this request." } }
    }
    private func openView(_ action: JSONValue) {
        do {
            let view = try RichPageViewSelection(action: action, blocks: pageBlocks, visited: visitedViews)
            if view.presentation == "inline" { inlineView = view } else { presentedView = view }
        } catch { self.error = error.localizedDescription }
    }
}

private struct NativeRichTable: View {
    let columns: [String]
    let rows: [[String]]
    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                GridRow {
                    ForEach(Array(columns.prefix(8).enumerated()), id: \.offset) { _, name in
                        Text(name).font(.subheadline.bold()).frame(minWidth: 100, maxWidth: 220, alignment: .leading).accessibilityAddTraits(.isHeader)
                    }
                }
                ForEach(Array(rows.prefix(50).enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(columns.prefix(8).enumerated()), id: \.offset) { index, column in
                            let value = row.indices.contains(index) ? row[index] : ""
                            Text(value).font(.subheadline).textSelection(.enabled)
                                .frame(minWidth: 100, maxWidth: 220, alignment: .leading)
                                .accessibilityLabel("\(column): \(value)")
                        }
                    }
                }
            }.padding(.vertical, 4)
        }.accessibilityLabel("Data table")
    }
}

private struct NativeRichPicture: View {
    let item: JSONValue
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let url = RichPageBlockModel.mediaURL(item["url"].stringValue) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit().frame(maxHeight: 300).clipShape(RoundedRectangle(cornerRadius: 10))
                            .accessibilityLabel(item["alt"].optionalString ?? item["caption"].optionalString ?? "Image")
                    case .failure: Label("Image could not load", systemImage: "photo.badge.exclamationmark")
                    default: ProgressView("Loading image…").frame(height: 100)
                    }
                }
                Link("Open image", destination: url).font(.caption)
            } else {
                Label("This image address cannot load here.", systemImage: "photo.badge.exclamationmark").font(.caption)
                Text(item["url"].stringValue).font(.caption).textSelection(.enabled)
            }
            if !item["caption"].stringValue.isEmpty { Text(item["caption"].stringValue).font(.caption).foregroundStyle(.secondary) }
        }
    }
}

private struct NativeRichChart: View {
    let block: JSONValue
    @Environment(\.michiTokens) private var tokens
    private var kind: String { block["kind"].stringValue }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !block["title"].stringValue.isEmpty { Text(block["title"].stringValue).font(.headline).accessibilityAddTraits(.isHeader) }
            switch kind {
            case "pie": pie
            case "heatmap": heatmap
            case "funnel": funnel
            case "sankey": sankey
            case "bar", "line", "area", "composite", "scatter", "bubble", "sparkline", "radar":
                if let points = try? RichPageBlockModel.chartPoints(block), !points.isEmpty {
                    if kind == "radar" { NativeRichRadar(points: points, axes: block["axes"].arrayValue.map(\.stringValue)) }
                    else { NativeRichCartesianChart(points: points, stacked: block["stacked"].boolValue).frame(height: kind == "sparkline" ? 100 : 240) }
                    DisclosureGroup("Chart values") {
                        NativeRichTable(columns: ["Series", "Label", "Value"], rows: points.map { [$0.series, $0.label, RichPageBlockModel.text(.number($0.y))] })
                    }
                } else { Label("This chart has missing or invalid data.", systemImage: "chart.bar.xaxis") }
            default:
                Label("This chart kind is not supported yet.", systemImage: "chart.bar.xaxis")
                DisclosureGroup("Chart data") { Text(block.prettyPrinted).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
            }
            if !block["unit"].stringValue.isEmpty { Text(block["unit"].stringValue).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private var pie: some View {
        let slices = Array(block["slices"].arrayValue.prefix(50))
        return VStack {
            Chart {
                ForEach(Array(slices.enumerated()), id: \.offset) { _, item in
                    if let value = RichPageBlockModel.number(item["value"]), value >= 0 {
                        SectorMark(angle: .value("Value", value), innerRadius: .ratio(block["donut"].boolValue ? 0.6 : 0))
                            .foregroundStyle(by: .value("Slice", item["label"].stringValue))
                            .accessibilityLabel(item["label"].stringValue).accessibilityValue(RichPageBlockModel.text(item["value"]))
                    }
                }
            }
            .michiChartSeriesPalette(slices.filter { (RichPageBlockModel.number($0["value"]) ?? -1) >= 0 }.map { $0["label"].stringValue }, tokens: tokens)
            .frame(height: 240)
            NativeRichTable(columns: ["Slice", "Value"], rows: slices.map { [$0["label"].stringValue, RichPageBlockModel.text($0["value"])] })
        }
    }
    private var heatmap: some View {
        let days = Array(block["days"].arrayValue.prefix(400))
        let maximum = max(days.map { abs($0["value"].doubleValue) }.max() ?? 1, 1)
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 5), count: 7), spacing: 5) {
            ForEach(Array(days.enumerated()), id: \.offset) { _, day in
                VStack(spacing: 2) {
                    Text(String(day["date"].stringValue.suffix(5))).font(.system(size: 10))
                    Text(RichPageBlockModel.text(day["value"])).font(.caption2.monospacedDigit())
                }.frame(maxWidth: .infinity, minHeight: 38)
                    .background(Color.accentColor.opacity(0.1 + 0.65 * min(1, abs(day["value"].doubleValue) / maximum)), in: RoundedRectangle(cornerRadius: 4))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(day["date"].stringValue): \(RichPageBlockModel.text(day["value"]))")
            }
        }
    }
    private var funnel: some View {
        let steps = Array(block["steps"].arrayValue.prefix(50))
        let maximum = max(steps.map { $0["value"].doubleValue }.max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                ProgressView(value: min(maximum, max(0, step["value"].doubleValue)), total: maximum) {
                    LabeledContent(step["label"].stringValue, value: RichPageBlockModel.text(step["value"]))
                }
            }
        }
    }
    private var sankey: some View {
        let links = Array(block["links"].arrayValue.prefix(100))
        return VStack(alignment: .leading, spacing: 12) {
            NativeRichFlow(nodes: block["nodes"].arrayValue.prefix(50).map { $0["name"].stringValue }, links: links)
            DisclosureGroup("Flow values") {
                NativeRichTable(columns: ["From", "To", "Value"], rows: links.map { [$0["source"].stringValue, $0["target"].stringValue, RichPageBlockModel.text($0["value"])] })
            }
        }
    }
}

/// Theme-token series colors, accent first, so Swift Charts never falls back to
/// its default system-blue palette. Past six series the colors repeat at lower
/// opacity, keeping series distinguishable without inventing new hues.
private enum NativeRichChartPalette {
    static func domain(_ names: [String]) -> [String] {
        var seen = Set<String>()
        return names.filter { seen.insert($0).inserted }
    }
    static func colors(count: Int, tokens: MichiTokens) -> [Color] {
        let base = [tokens.accent, tokens.select, tokens.digest, tokens.mauve, tokens.info, tokens.danger]
        return (0..<count).map { index in base[index % base.count].opacity(max(0.3, 1 - 0.35 * Double(index / base.count))) }
    }
}

private extension View {
    /// Pins each series (in first-seen order, matching the legend) to a token color.
    @ViewBuilder func michiChartSeriesPalette(_ names: [String], tokens: MichiTokens) -> some View {
        let domain = NativeRichChartPalette.domain(names)
        if domain.isEmpty { self } else {
            chartForegroundStyleScale(domain: domain, range: NativeRichChartPalette.colors(count: domain.count, tokens: tokens))
        }
    }
}

private struct NativeRichCartesianChart: View {
    let points: [RichChartPoint]
    let stacked: Bool
    @Environment(\.michiTokens) private var tokens
    private var numericX: Bool { points.allSatisfy { $0.x != nil } }
    var body: some View {
        Chart(points) { point in
            if numericX { numericMark(point) } else { categoryMark(point) }
        }
        .michiChartSeriesPalette(points.map(\.series), tokens: tokens)
        .chartLegend(position: .bottom)
        .accessibilityLabel("Chart with \(points.count) values. The Chart values disclosure contains the full data.")
    }
    @ChartContentBuilder private func numericMark(_ point: RichChartPoint) -> some ChartContent {
        switch point.kind {
        case "line", "radar":
            LineMark(x: .value("X", point.x ?? 0), y: .value("Value", point.y)).foregroundStyle(by: .value("Series", point.series))
        case "area":
            AreaMark(x: .value("X", point.x ?? 0), y: .value("Value", point.y), stacking: stacked ? .standard : .unstacked).foregroundStyle(by: .value("Series", point.series)).opacity(0.6)
        case "scatter", "bubble":
            PointMark(x: .value("X", point.x ?? 0), y: .value("Value", point.y))
                .foregroundStyle(by: .value("Series", point.series)).symbolSize(CGFloat(point.kind == "bubble" ? min(400, max(12, abs(point.size ?? 1) * 10)) : 35))
        default:
            if stacked {
                BarMark(x: .value("X", point.x ?? 0), y: .value("Value", point.y)).foregroundStyle(by: .value("Series", point.series))
            } else {
                BarMark(x: .value("X", point.x ?? 0), y: .value("Value", point.y)).foregroundStyle(by: .value("Series", point.series)).position(by: .value("Series", point.series))
            }
        }
    }
    @ChartContentBuilder private func categoryMark(_ point: RichChartPoint) -> some ChartContent {
        switch point.kind {
        case "line", "radar":
            LineMark(x: .value("Label", point.label), y: .value("Value", point.y)).foregroundStyle(by: .value("Series", point.series))
        case "area":
            AreaMark(x: .value("Label", point.label), y: .value("Value", point.y), stacking: stacked ? .standard : .unstacked).foregroundStyle(by: .value("Series", point.series)).opacity(0.6)
        default:
            if stacked {
                BarMark(x: .value("Label", point.label), y: .value("Value", point.y)).foregroundStyle(by: .value("Series", point.series))
            } else {
                BarMark(x: .value("Label", point.label), y: .value("Value", point.y)).foregroundStyle(by: .value("Series", point.series)).position(by: .value("Series", point.series))
            }
        }
    }
}

private struct NativeRichRadar: View {
    let points: [RichChartPoint]
    let axes: [String]
    @Environment(\.michiTokens) private var tokens
    var body: some View {
        let names = Array(Set(points.map(\.series))).sorted()
        let colors = NativeRichChartPalette.colors(count: max(names.count, 1), tokens: tokens)
        VStack {
            Canvas { context, size in
                guard axes.count >= 3 else { return }
                let center = CGPoint(x: size.width / 2, y: size.height / 2), radius = min(size.width, size.height) * 0.34
                let low = min(0, points.map(\.y).min() ?? 0), high = max(1, points.map(\.y).max() ?? 1)
                func position(_ index: Int, _ scale: Double) -> CGPoint {
                    let angle = Double(index) / Double(axes.count) * .pi * 2 - .pi / 2
                    return CGPoint(x: center.x + radius * CGFloat(scale * cos(angle)), y: center.y + radius * CGFloat(scale * sin(angle)))
                }
                for index in axes.indices {
                    var line = Path(); line.move(to: center); line.addLine(to: position(index, 1))
                    context.stroke(line, with: .color(.secondary.opacity(0.4)), lineWidth: 1)
                    context.draw(Text(axes[index]).font(.caption2), at: position(index, 1.27))
                }
                for (index, name) in names.enumerated() {
                    let values = points.filter { $0.series == name }
                    var polygon = Path()
                    for (axis, label) in axes.enumerated() {
                        let value = values.first { $0.label == label }?.y ?? low
                        let point = position(axis, (value - low) / (high - low))
                        if axis == 0 { polygon.move(to: point) } else { polygon.addLine(to: point) }
                    }
                    polygon.closeSubpath()
                    context.fill(polygon, with: .color(colors[index % colors.count].opacity(0.12)))
                    context.stroke(polygon, with: .color(colors[index % colors.count]), lineWidth: 2)
                }
            }.frame(height: 260).accessibilityLabel("Radar chart. Full values follow.")
            ForEach(Array(names.enumerated()), id: \.offset) { index, name in
                Label(name, systemImage: "circle.fill").font(.caption).foregroundStyle(colors[index % colors.count])
            }
        }
    }
}

private struct NativeRichFlow: View {
    let nodes: [String]
    let links: [JSONValue]
    var body: some View {
        Canvas { context, size in
            var seen: Set<String> = []
            let names = nodes.filter { seen.insert($0).inserted }
            guard names.count > 1 else { return }
            var levels = Dictionary(uniqueKeysWithValues: names.map { ($0, 0) })
            for _ in 0..<names.count {
                var changed = false
                for link in links {
                    let source = link["source"].stringValue, target = link["target"].stringValue
                    guard let from = levels[source], let to = levels[target], source != target else { continue }
                    let next = min(names.count - 1, from + 1)
                    if next > to { levels[target] = next; changed = true }
                }
                if !changed { break }
            }
            let maxLevel = max(levels.values.max() ?? 1, 1)
            var positions: [String: CGPoint] = [:]
            for level in 0...maxLevel {
                let column = names.filter { levels[$0] == level }
                for (index, name) in column.enumerated() {
                    positions[name] = CGPoint(x: 48 + CGFloat(level) / CGFloat(maxLevel) * max(1, size.width - 96),
                                              y: CGFloat(index + 1) / CGFloat(column.count + 1) * size.height)
                }
            }
            let maximum = max(links.map { $0["value"].doubleValue }.max() ?? 1, 1)
            for link in links {
                guard let start = positions[link["source"].stringValue], let end = positions[link["target"].stringValue] else { continue }
                var path = Path(); path.move(to: start)
                path.addCurve(to: end, control1: CGPoint(x: (start.x + end.x) / 2, y: start.y), control2: CGPoint(x: (start.x + end.x) / 2, y: end.y))
                context.stroke(path, with: .color(.accentColor.opacity(0.25)), lineWidth: CGFloat(2 + 16 * max(0, link["value"].doubleValue) / maximum))
            }
            for name in names {
                guard let point = positions[name] else { continue }
                context.fill(Path(roundedRect: CGRect(x: point.x - 4, y: point.y - 10, width: 8, height: 20), cornerRadius: 3), with: .color(.accentColor))
                context.draw(Text(name).font(.caption2), at: CGPoint(x: point.x, y: point.y - 20))
            }
        }.frame(height: CGFloat(min(440, max(220, nodes.count * 24)))).accessibilityLabel("Flow diagram. Full source, destination and values follow.")
    }
}
