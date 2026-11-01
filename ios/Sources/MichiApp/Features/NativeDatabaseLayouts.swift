import SwiftUI
import ImageIO
import MichiCore

/// Supplied only while the view's rows can be put in a new saved order (no
/// active sort, editable database). The model re-validates every drop.
struct NativeDatabaseRowOrdering {
    let item: @MainActor (JSONValue) -> DatabaseOrderingDragItem
    let accepts: @MainActor (DatabaseOrderingDragItem) -> Bool
    let onDrop: @MainActor (DatabaseOrderingDragItem, JSONValue) -> Void
    let onStep: @MainActor (JSONValue, DatabaseOrderingDirection) -> Void
}

/// Receives already filtered/sorted rows. Reading a layout never edits data or
/// starts a request. Date changes and cover downloads require an explicit action.
struct NativeDatabaseLayoutView: View {
    let type: String
    let rows: [JSONValue]
    let columns: [JSONValue]
    let config: JSONValue
    var isTasks = false
    var isThreads = false
    var disabled = false
    let onOpenRow: (JSONValue) -> Void
    var onMoveDate: ((JSONValue, JSONValue, String) async -> Bool)? = nil
    var onConfigChange: ((JSONValue) -> Void)? = nil
    var rowOrdering: NativeDatabaseRowOrdering? = nil
    @State private var month = NativeDatabaseDay.at(Date()) ?? NativeDatabaseDay("2000-01-01")!
    @State private var selectedDay: String?
    @State private var page = 0
    @State private var move: NativeDatabaseDateMove?

    private var actualColumn: JSONValue? { NativeDatabaseLayout.dateColumn(columns, config: config, isThreads: isThreads) }
    private var planColumn: JSONValue? { NativeDatabaseLayout.planColumn(columns, config: config) }
    private var today: NativeDatabaseDay { NativeDatabaseDay.at(Date()) ?? month }
    private var pageRows: [JSONValue] { Array(rows.dropFirst(safePage * NativeDatabaseLayout.pageSize).prefix(NativeDatabaseLayout.pageSize)) }
    private var safePage: Int { min(page, max(0, (rows.count - 1) / NativeDatabaseLayout.pageSize)) }
    private func title(_ row: JSONValue) -> String { NativeDatabaseLayout.title(row, columns: columns, isTasks: isTasks, isThreads: isThreads) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if type == "calendar" { calendar }
            else if type == "gallery" { gallery }
            else if type == "timeline" { timeline }
        }
        .sheet(item: $move) { intent in
            NativeDatabaseMoveSheet(intent: intent, onMove: onMoveDate)
        }
        .onChange(of: type) { _, _ in page = 0 }
    }

    @ViewBuilder private var calendar: some View {
        if let column = actualColumn {
            dateColumnPicker(column)
            HStack {
                Text("\(Self.monthNames[month.month - 1]) \(String(month.year))").font(.headline)
                Spacer()
                Button { shiftMonth(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous month").disabled(month.year == 1 && month.month == 1)
                Button("Today") { month = today; selectedDay = today.key }
                Button { shiftMonth(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next month").disabled(month.year == 9999 && month.month == 12)
            }.buttonStyle(.borderless)
            let days = NativeDatabaseLayout.month(year: month.year, month: month.month, rows: rows, dateColumnID: column.id, today: today)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 7), spacing: 5) {
                ForEach(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"], id: \.self) { Text($0).font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
                ForEach(days) { day in
                    Button { selectedDay = day.date.key } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(String(day.date.day)).font(.caption.weight(day.today ? .bold : .regular))
                            ForEach(Array(day.rows.prefix(2).enumerated()), id: \.offset) { _, row in Text(title(row)).font(.system(size: 9)).lineLimit(1) }
                            if day.rows.count > 2 { Text("+\(day.rows.count - 2)").font(.system(size: 9)).foregroundStyle(.secondary) }
                            Spacer(minLength: 0)
                        }.frame(maxWidth: .infinity, minHeight: 65, alignment: .topLeading).padding(4)
                            .background(selectedDay == day.id ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(day.inMonth ? 0.07 : 0.02), in: RoundedRectangle(cornerRadius: 5))
                            .overlay(RoundedRectangle(cornerRadius: 5).stroke(day.today ? Color.accentColor : .clear, lineWidth: 1))
                            .foregroundStyle(day.inMonth ? Color.primary : Color.secondary)
                    }.buttonStyle(.plain).accessibilityLabel("\(day.date.key), \(day.rows.count) records")
                        .dropDestination(for: String.self) { ids, _ in
                            guard !disabled, onMoveDate != nil, NativeDatabaseLayout.editable(column), ids.count == 1,
                                  let row = rows.first(where: { $0.id == ids[0] }) else { return false }
                            move = .init(row: row, column: column, target: day.date, title: title(row)); return true
                        }
                }
            }
            if let selectedDay {
                let dayRows = days.first { $0.id == selectedDay }?.rows ?? []
                Text(selectedDay).font(.headline)
                if dayRows.isEmpty { Text("No records on this day.").foregroundStyle(.secondary) }
                NativeDatabaseCalendarRows(rows: dayRows, column: column, title: title, disabled: disabled, canMove: onMoveDate != nil, onOpen: onOpenRow) { row in
                    move = .init(row: row, column: column, target: NativeDatabaseDay(selectedDay) ?? today, title: title(row))
                }.id(selectedDay)
            } else { Text("Select a day to open or move its records.").font(.caption).foregroundStyle(.secondary) }
            let undated = rows.filter { NativeDatabaseDates.span($0["values"][column.id]) == nil }
            if !undated.isEmpty {
                DisclosureGroup("No valid date (\(undated.count))") {
                    NativeDatabaseCalendarRows(rows: undated, column: column, title: title, disabled: disabled, canMove: onMoveDate != nil, onOpen: onOpenRow) { row in
                        move = .init(row: row, column: column, target: today, title: title(row))
                    }
                }
            }
        } else { ContentUnavailableView("Add a date column to see a calendar", systemImage: "calendar") }
    }

    @ViewBuilder private var gallery: some View {
        let cover = NativeDatabaseLayout.coverColumn(columns, config: config)
        if let onConfigChange, !isThreads {
            Picker("Cover image", selection: Binding(get: { cover?.id ?? "" }, set: { id in var next = config; next["cover"] = .string(id); onConfigChange(next) })) {
                Text("No image column").tag("")
                ForEach(columns.filter { $0["type"] == "image" }, id: \.id) { Text(featureNamed($0)).tag($0.id) }
            }.disabled(disabled)
        }
        if rows.isEmpty { ContentUnavailableView("No matching records", systemImage: "rectangle.grid.2x2") }
        if rowOrdering != nil && !disabled && rows.count > 1 {
            Text("Hold a card and drop it on another to change the saved order.").font(.caption).foregroundStyle(.secondary)
        }
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 12)], spacing: 12) {
            ForEach(pageRows, id: \.id) { row in
                let card = NativeDatabaseGalleryCard(row: row, title: title(row), snippet: NativeDatabaseLayout.snippet(row, columns: columns, isThreads: isThreads),
                    imageURL: cover.flatMap { NativeDatabaseLayout.imageURL(row["values"][$0.id]) },
                    facts: NativeDatabaseLayout.galleryFacts(columns: columns, config: config, isThreads: isThreads), onOpen: { onOpenRow(row) })
                if let rowOrdering, !disabled {
                    card
                        .draggable(rowOrdering.item(row))
                        .dropDestination(for: DatabaseOrderingDragItem.self) { items, _ in
                            // One card, from this database and revision; anything else is refused unread.
                            guard items.count == 1, let item = items.first, rowOrdering.accepts(item) else { return false }
                            rowOrdering.onDrop(item, row); return true
                        }
                        .accessibilityAction(named: "Move earlier") { rowOrdering.onStep(row, .up) }
                        .accessibilityAction(named: "Move later") { rowOrdering.onStep(row, .down) }
                } else { card }
            }
        }
        pageControls
    }

    @ViewBuilder private var timeline: some View {
        if let actualColumn {
            dateColumnPicker(actualColumn)
            if let onConfigChange, !isThreads {
                Picker("Plan dates", selection: Binding(get: { planColumn?.id ?? "" }, set: { id in var next = config; next["planDate"] = id.isEmpty ? .null : .string(id); onConfigChange(next) })) {
                    Text("None").tag("")
                    ForEach(columns.filter { $0["type"] == "date" && $0.id != actualColumn.id }, id: \.id) { Text(featureNamed($0)).tag($0.id) }
                }.disabled(disabled)
            }
            let spans = rows.flatMap { row -> [NativeDatabaseSpan] in
                [NativeDatabaseDates.span(row["values"][actualColumn.id]), planColumn.flatMap { NativeDatabaseDates.span(row["values"][$0.id]) }].compactMap { $0 }
            }
            let axis = NativeDatabaseLayout.axis(spans: spans, today: today)
            HStack(spacing: 14) {
                Label("Actual", systemImage: "rectangle.fill").foregroundStyle(Color.accentColor)
                Label("Plan", systemImage: "rectangle").foregroundStyle(.secondary)
                Label("Past plan", systemImage: "rectangle.fill").foregroundStyle(.orange)
            }.font(.caption2)
            Text("\(axis.first.key) – \(axis.labels.last?.key ?? axis.first.key)").font(.caption).foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 0) {
                        Text("Record").font(.caption.weight(.semibold)).frame(width: 150, alignment: .leading)
                        HStack(spacing: 0) {
                            ForEach(axis.labels) { day in
                                VStack(spacing: 2) { Text(day.day == 1 || day == axis.first ? "\(day.month)/" : " "); Text(String(day.day)) }.font(.system(size: 10, design: .monospaced)).frame(width: 30)
                            }
                        }
                    }.padding(.bottom, 8)
                    ForEach(pageRows, id: \.id) { row in
                        let actual = NativeDatabaseDates.span(row["values"][actualColumn.id])
                        let plan = planColumn.flatMap { NativeDatabaseDates.span(row["values"][$0.id]) }
                        Button { onOpenRow(row) } label: {
                            HStack(spacing: 0) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(title(row)).font(.subheadline).lineLimit(2)
                                    if let actual { Text(actual.start.key + (actual.start == actual.end ? "" : " → " + actual.end.key)).font(.caption2).foregroundStyle(.secondary) }
                                    else { Text("No actual date").font(.caption2).foregroundStyle(.secondary) }
                                    if let plan { Text("Plan: " + plan.start.key + " → " + plan.end.key).font(.caption2).foregroundStyle(.secondary) }
                                }.frame(width: 146, alignment: .leading).padding(.trailing, 4)
                                NativeDatabaseTimelineTrack(axis: axis, actual: actual, plan: plan)
                            }.padding(.vertical, 8).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                        Divider()
                    }
                }
            }
            if rows.isEmpty { Text("No matching records.").foregroundStyle(.secondary) }
            pageControls
        } else { ContentUnavailableView("Add a date column to see a timeline", systemImage: "chart.bar.xaxis") }
    }

    @ViewBuilder private func dateColumnPicker(_ column: JSONValue) -> some View {
        if let onConfigChange, !isThreads {
            Picker("Date column", selection: Binding(get: { column.id }, set: { id in var next = config; next["date"] = .string(id); if next["planDate"] == .string(id) { next["planDate"] = .null }; onConfigChange(next) })) {
                ForEach(columns.filter { $0["type"] == "date" }, id: \.id) { Text(featureNamed($0)).tag($0.id) }
            }.disabled(disabled)
        } else { Text(featureNamed(column)).font(.caption).foregroundStyle(.secondary) }
    }
    @ViewBuilder private var pageControls: some View {
        if rows.count > NativeDatabaseLayout.pageSize {
            HStack {
                Button("Previous") { page = max(0, safePage - 1) }.disabled(safePage == 0)
                Spacer()
                Text("\(safePage * NativeDatabaseLayout.pageSize + 1)–\(min(rows.count, (safePage + 1) * NativeDatabaseLayout.pageSize)) of \(rows.count)").font(.caption)
                Spacer()
                Button("Next") { page = safePage + 1 }.disabled((safePage + 1) * NativeDatabaseLayout.pageSize >= rows.count)
            }.buttonStyle(.borderless)
        }
    }
    private func shiftMonth(_ by: Int) {
        let monthIndex = (month.year - 1) * 12 + month.month - 1 + by
        guard monthIndex >= 0, monthIndex < 9999 * 12, let date = NativeDatabaseDay(year: monthIndex / 12 + 1, month: monthIndex % 12 + 1, day: 1) else { return }
        month = date; selectedDay = nil
    }
    private static let monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
}

private struct NativeDatabaseCalendarRows: View {
    let rows: [JSONValue]
    let column: JSONValue
    let title: (JSONValue) -> String
    let disabled: Bool
    let canMove: Bool
    let onOpen: (JSONValue) -> Void
    let onMove: (JSONValue) -> Void
    @State private var page = 0
    private var safePage: Int { min(page, max(0, (rows.count - 1) / NativeDatabaseLayout.pageSize)) }
    var body: some View {
        ForEach(Array(rows.dropFirst(safePage * NativeDatabaseLayout.pageSize).prefix(NativeDatabaseLayout.pageSize)), id: \.id) { row in
            HStack {
                if canMove && NativeDatabaseLayout.editable(column) && !disabled {
                    Button(title(row)) { onOpen(row) }.draggable(row.id)
                    Spacer()
                    Button { onMove(row) } label: { Image(systemName: "calendar.badge.clock") }.accessibilityLabel("Move date for " + title(row))
                } else { Button(title(row)) { onOpen(row) }; Spacer() }
            }.buttonStyle(.borderless).padding(.vertical, 4)
        }
        if rows.count > NativeDatabaseLayout.pageSize {
            HStack { Button("Previous records") { page = max(0, safePage - 1) }.disabled(safePage == 0); Spacer(); Button("Next records") { page = safePage + 1 }.disabled((safePage + 1) * NativeDatabaseLayout.pageSize >= rows.count) }.font(.caption)
        }
    }
}

private struct NativeDatabaseDateMove: Identifiable {
    let id = UUID()
    let row: JSONValue
    let column: JSONValue
    let target: NativeDatabaseDay
    let title: String
}

private struct NativeDatabaseMoveSheet: View {
    let intent: NativeDatabaseDateMove
    let onMove: ((JSONValue, JSONValue, String) async -> Bool)?
    @Environment(\.dismiss) private var dismiss
    @State private var day: String
    @State private var error: String?
    @State private var busy = false
    init(intent: NativeDatabaseDateMove, onMove: ((JSONValue, JSONValue, String) async -> Bool)?) { self.intent = intent; self.onMove = onMove; _day = State(initialValue: intent.target.key) }
    var body: some View {
        NavigationStack {
            Form {
                Text(intent.title).font(.headline)
                TextField("YYYY-MM-DD", text: $day).textInputAutocapitalization(.never).autocorrectionDisabled()
                DatePicker("New start", selection: Binding(get: { (NativeDatabaseDay(day) ?? intent.target).pickerDate }, set: { day = NativeDatabaseDay.at($0, timeZone: TimeZone(secondsFromGMT: 0)!)?.key ?? day }), displayedComponents: .date)
                    .datePickerStyle(.graphical).environment(\.timeZone, TimeZone(secondsFromGMT: 0)!).environment(\.calendar, Calendar(identifier: .gregorian))
                Text("The range keeps its original length. Date and time values become calendar dates.").font(.footnote).foregroundStyle(.secondary)
                if let operation = try? nativeDatabaseCalendarMoveOperation(row: intent.row, column: intent.column, to: day), let span = NativeDatabaseDates.span(operation["values"][intent.column.id]) {
                    LabeledContent("New dates", value: span.start.key + (span.start == span.end ? "" : " → " + span.end.key))
                }
                if let error { Text(error).foregroundStyle(.red) }
                Button("Move date") {
                    Task {
                        do {
                            guard try nativeDatabaseCalendarMoveOperation(row: intent.row, column: intent.column, to: day) != nil else { dismiss(); return }
                            guard let onMove else { return }; busy = true; defer { busy = false }
                            if await onMove(intent.row, intent.column, day) { dismiss() }
                            else { error = "The date could not be saved. Your selected date is still here; review the database error before trying again." }
                        } catch { self.error = error.localizedDescription }
                    }
                }.disabled(busy || NativeDatabaseDay(day) == nil)
            }.disabled(busy).navigationTitle("Move date").navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Cancel") { dismiss() }.disabled(busy) }.interactiveDismissDisabled(busy)
        }
    }
}

private struct NativeDatabaseTimelineTrack: View {
    let axis: NativeDatabaseAxis
    let actual: NativeDatabaseSpan?
    let plan: NativeDatabaseSpan?
    var body: some View {
        ZStack(alignment: .topLeading) {
            HStack(spacing: 0) { ForEach(0..<axis.days, id: \.self) { _ in Rectangle().fill(Color.secondary.opacity(0.12)).frame(width: 1, height: 52).frame(width: 30, alignment: .leading) } }
            if let plan, let p = NativeDatabaseLayout.placement(plan, axis: axis) {
                RoundedRectangle(cornerRadius: 3).stroke(Color.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [4, 2])).frame(width: CGFloat(p.length) * 30 - 2, height: 12).offset(x: CGFloat(p.start) * 30 + 1, y: 30)
            }
            if let actual, let p = NativeDatabaseLayout.placement(actual, axis: axis) {
                RoundedRectangle(cornerRadius: 3).fill(plan.map { actual.end > $0.end } == true ? Color.orange : Color.accentColor).frame(width: CGFloat(p.length) * 30 - 2, height: 17).offset(x: CGFloat(p.start) * 30 + 1, y: 6)
                if p.clippedBefore { Text("‹").font(.caption.bold()).offset(x: 2, y: 7) }
                if p.clippedAfter { Text("›").font(.caption.bold()).offset(x: CGFloat(axis.days) * 30 - 10, y: 7) }
            } else if actual != nil { Text("Outside displayed dates").font(.caption2).foregroundStyle(.secondary).offset(y: 7) }
            let todayIndex = axis.today.ordinal - axis.first.ordinal
            if todayIndex >= 0 && todayIndex < axis.days { Rectangle().fill(Color.red.opacity(0.7)).frame(width: 1, height: 52).offset(x: CGFloat(todayIndex) * 30 + 15) }
        }.frame(width: CGFloat(axis.days) * 30, height: 52)
            .accessibilityElement(children: .ignore).accessibilityLabel("Actual " + label(actual) + ". Plan " + label(plan))
    }
    private func label(_ span: NativeDatabaseSpan?) -> String { span.map { $0.start.key + " through " + $0.end.key } ?? "not set" }
}

private struct NativeDatabaseGalleryCard: View {
    let row: JSONValue
    let title: String
    let snippet: String
    let imageURL: URL?
    let facts: [JSONValue]
    let onOpen: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let imageURL { NativeDatabaseCover(url: imageURL).id(imageURL) }
            else { Text(snippet.isEmpty ? "No preview" : snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(5).frame(maxWidth: .infinity, minHeight: 100, alignment: .topLeading) }
            Button(action: onOpen) { Text(title).font(.headline).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading) }.buttonStyle(.plain)
            ForEach(Array(facts.prefix(5)), id: \.id) { column in
                let text = featureCellText(row["values"][column.id], type: column["type"].stringValue)
                if !text.isEmpty { Text(featureNamed(column) + ": " + text).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
            }
            if facts.count > 5 { Button("All properties", action: onOpen).font(.caption) }
        }.padding(10).frame(maxWidth: .infinity, alignment: .topLeading).background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct NativeDatabaseCover: View {
    let url: URL
    @State private var image: UIImage?
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        VStack(spacing: 5) {
            if let image { Image(uiImage: image).resizable().scaledToFill().frame(height: 130).frame(maxWidth: .infinity).clipped().accessibilityLabel("Record cover") }
            else if loading { ProgressView("Loading image…").frame(height: 130) }
            else {
                Button {
                    Task {
                        loading = true; defer { loading = false }
                        do { image = try await NativeDatabaseCoverDownload.load(url); error = nil }
                        catch { self.error = error.localizedDescription }
                    }
                } label: { Label(error == nil ? "Load image" : "Retry image", systemImage: "photo").frame(maxWidth: .infinity, minHeight: 100) }.buttonStyle(.borderless)
                Text(error ?? url.host ?? "Image").font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }
}

private final class NativeDatabaseCoverDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
}

private enum NativeDatabaseCoverDownload {
    static func load(_ url: URL) async throws -> UIImage {
        guard NativeDatabaseLayout.imageURL(.string(url.absoluteString)) == url else { throw NativeFailure("This cover address cannot be loaded.") }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.httpShouldSetCookies = false; configuration.timeoutIntervalForRequest = 20; configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration, delegate: NativeDatabaseCoverDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.setValue("image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        let (bytes, response) = try await session.bytes(for: request)
        defer { bytes.task.cancel() }
        let maxBytes = 8 * 1024 * 1024
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"].contains(http.mimeType?.lowercased() ?? ""), response.expectedContentLength <= maxBytes else { throw NativeFailure("The address did not return a supported image within 8 MB.") }
        var data = Data()
        for try await byte in bytes { guard data.count < maxBytes else { throw NativeFailure("The image exceeds 8 MB.") }; data.append(byte) }
        try Task.checkCancellation()
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1200, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { throw NativeFailure("This image cannot be displayed.") }
        return UIImage(cgImage: thumbnail)
    }
}
