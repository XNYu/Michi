import SwiftUI
import MichiCore

struct FeatureViewEditor: View {
    @Binding var view: JSONValue
    let columns: [JSONValue]

    var body: some View {
        Form {
            if featureCanHostRegisteredCustomView(view) {
                FeatureUnsupportedCustomNotice(value: view)
                Text("Native filter and sort save cannot rewrite a registered custom view. Use the dedicated custom view binding editor to change the component, pinned version, props, or height.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if featureIsUnsupportedCustomView(view) {
                FeatureUnsupportedCustomNotice(value: view)
            } else {
                TextField("Name", text: Binding(
                    get: { view["name"].stringValue },
                    set: { view["name"] = .string($0) }
                ))
                Picker("Type", selection: Binding(
                    get: { view["type"].stringValue },
                    set: { view["type"] = .string($0) }
                )) {
                    Text("Table").tag("table")
                    Text("Board").tag("board")
                    Text("List").tag("list")
                    Text("Calendar").tag("calendar")
                    Text("Gallery").tag("gallery")
                    Text("Timeline").tag("timeline")
                }
                if view["type"].stringValue == "board" {
                    Picker("Group by", selection: Binding(
                        get: { view["config"]["group"].stringValue },
                        set: { view["config"]["group"] = $0.isEmpty ? .null : .string($0) }
                    )) {
                        Text("First select column").tag("")
                        ForEach(columns.filter { ["select", "multi", "checkbox", "app"].contains($0["type"].stringValue) }, id: \.id) { column in
                            Text(column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue).tag(column.id)
                        }
                    }
                }
                Picker("Match", selection: Binding(
                    get: { view["config"]["match"].optionalString ?? "all" },
                    set: { view["config"]["match"] = .string($0) }
                )) {
                    Text("All filters").tag("all")
                    Text("Any filter").tag("any")
                }
                Section("Filters") {
                    ForEach(Array(view["config"]["filters"].arrayValue.enumerated()), id: \.offset) { index, filter in
                        FeatureFilterEditor(filter: Binding(
                            get: { view["config"]["filters"].arrayValue.indices.contains(index) ? view["config"]["filters"].arrayValue[index] : filter },
                            set: { next in
                                var filters = view["config"]["filters"].arrayValue
                                if filters.indices.contains(index) { filters[index] = next }
                                view["config"]["filters"] = .array(filters)
                            }
                        ), columns: columns)
                    }
                    Button("Add filter") {
                        var filters = view["config"]["filters"].arrayValue
                        let column = columns.first?.id ?? ""
                        filters.append(["column": .string(column), "op": "not-empty"])
                        view["config"]["filters"] = .array(filters)
                    }
                }
                Section("Sorts") {
                    ForEach(Array(view["config"]["sorts"].arrayValue.enumerated()), id: \.offset) { index, sort in
                        FeatureSortEditor(sort: Binding(
                            get: { view["config"]["sorts"].arrayValue.indices.contains(index) ? view["config"]["sorts"].arrayValue[index] : sort },
                            set: { next in
                                var sorts = view["config"]["sorts"].arrayValue
                                if sorts.indices.contains(index) { sorts[index] = next }
                                view["config"]["sorts"] = .array(sorts)
                            }
                        ), columns: columns)
                    }
                    Button("Add sort") {
                        var sorts = view["config"]["sorts"].arrayValue
                        let column = columns.first?.id ?? ""
                        sorts.append(["column": .string(column), "dir": "asc"])
                        view["config"]["sorts"] = .array(sorts)
                    }
                }
                Section("Visible columns") {
                    DatabaseVisibleColumnControls(view: $view, columns: columns)
                }
            }
        }
    }
}

private struct FeatureFilterEditor: View {
    @Binding var filter: JSONValue
    let columns: [JSONValue]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("Column", selection: Binding(
                get: { filter["column"].stringValue },
                set: { filter["column"] = .string($0) }
            )) {
                ForEach(columns, id: \.id) { column in
                    Text(column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue).tag(column.id)
                }
            }
            Picker("Operator", selection: Binding(
                get: { filter["op"].stringValue },
                set: { filter["op"] = .string($0) }
            )) {
                ForEach(featureDatabaseFilterOps, id: \.self) { op in
                    Text(op).tag(op)
                }
            }
            if !featureDatabaseNoValueFilterOps.contains(filter["op"].stringValue) {
                TextField("Value", text: Binding(
                    get: { featureCellDraft(filter["value"], type: selectedType) },
                    set: { filter["value"] = $0.isEmpty ? .null : .string($0) }
                ))
            }
        }
    }

    private var selectedType: String {
        columns.first { $0.id == filter["column"].stringValue }?["type"].stringValue ?? "text"
    }
}

private struct FeatureSortEditor: View {
    @Binding var sort: JSONValue
    let columns: [JSONValue]

    var body: some View {
        HStack {
            Picker("Column", selection: Binding(
                get: { sort["column"].stringValue },
                set: { sort["column"] = .string($0) }
            )) {
                ForEach(columns, id: \.id) { column in
                    Text(column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue).tag(column.id)
                }
            }
            Picker("Direction", selection: Binding(
                get: { sort["dir"].stringValue },
                set: { sort["dir"] = .string($0) }
            )) {
                Text("Ascending").tag("asc")
                Text("Descending").tag("desc")
            }
        }
    }
}

struct FeatureStructuredRowForm: View {
    let columns: [JSONValue]
    let isTasks: Bool
    @Binding var drafts: [String: String]
    @Binding var structured: [String: JSONValue]
    @Binding var bodyText: String
    let baseline: JSONValue
    let error: String?
    var onSave: () -> Void
    var onReload: () -> Void
    var onDelete: (() -> Void)?

    var body: some View {
        Group {
            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Discard edits and reload", role: .destructive, action: onReload)
                }
            }
            Section(isTasks ? "Task" : "Cells") {
                ForEach(columns, id: \.id) { column in
                    if featureCanEditColumn(column) {
                        FeatureCellField(column: column, text: Binding(
                            get: { drafts[column.id] ?? "" },
                            set: { drafts[column.id] = $0 }
                        ))
                    } else if featureCanEditStructuredColumn(column) {
                        FeatureStructuredCellEditor(
                            column: column,
                            value: Binding(
                                get: { structured[column.id] ?? featureStructuredCellDraft(baseline["values"][column.id], type: column["type"].stringValue) },
                                set: { structured[column.id] = $0 }
                            )
                        )
                    } else {
                        LabeledContent(
                            column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue,
                            value: featureCellText(baseline["values"][column.id], type: column["type"].stringValue)
                        )
                    }
                }
            }
            Section("Notes") {
                TextEditor(text: $bodyText)
                    .frame(minHeight: 96)
            }
            Section {
                Button("Apply", action: onSave)
                if let onDelete {
                    Button("Delete row", role: .destructive, action: onDelete)
                }
            }
        }
    }
}

struct FeatureStructuredCellEditor: View {
    let column: JSONValue
    @Binding var value: JSONValue

    var body: some View {
        let name = column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue
        switch column["type"].stringValue {
        case "date":
            FeatureDateCellEditor(name: name, value: $value)
        case "multi":
            FeatureMultiCellEditor(name: name, column: column, value: $value)
        case "threads":
            FeatureThreadsCellEditor(name: name, value: $value)
        default:
            LabeledContent(name, value: featureCellText(value, type: column["type"].stringValue))
        }
    }
}

private struct FeatureDateCellEditor: View {
    let name: String
    @Binding var value: JSONValue
    @State private var start = ""
    @State private var end = ""
    @State private var range = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(name).font(.subheadline)
            Toggle("Date range", isOn: $range)
            TextField("Start (YYYY-MM-DD)", text: $start)
                .textInputAutocapitalization(.never)
                .keyboardType(.numbersAndPunctuation)
            if range {
                TextField("End (YYYY-MM-DD)", text: $end)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.numbersAndPunctuation)
            }
            Button("Clear date") {
                start = ""; end = ""; range = false; value = .null
            }
            .font(.footnote)
        }
        .onAppear { adopt() }
        .onChange(of: start) { _, _ in write() }
        .onChange(of: end) { _, _ in write() }
        .onChange(of: range) { _, _ in write() }
    }

    private func adopt() {
        start = value["start"].stringValue
        end = value["end"].stringValue
        range = !end.isEmpty
    }

    private func write() {
        value = (try? featureParseDateCell(start: start, end: range ? end : nil)) ?? value
    }
}

private struct FeatureMultiCellEditor: View {
    let name: String
    let column: JSONValue
    @Binding var value: JSONValue

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(name).font(.subheadline)
            let selected = Set(featureStringList(value))
            ForEach(column["options"].arrayValue, id: \.featureOptionValue) { option in
                let key = option.featureOptionValue
                Toggle(option["label"].optionalString ?? key, isOn: Binding(
                    get: { selected.contains(key) },
                    set: { on in
                        var next = featureStringList(value)
                        if on {
                            if !next.contains(key) { next.append(key) }
                        } else {
                            next.removeAll { $0 == key }
                        }
                        value = (try? featureParseMultiCell(next, options: column["options"].arrayValue)) ?? .array(next.map { .string($0) })
                    }
                ))
            }
            if column["options"].arrayValue.isEmpty {
                Text("Add options on the database schema first.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct FeatureThreadsCellEditor: View {
    let name: String
    @Binding var value: JSONValue
    @State private var draft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(name).font(.subheadline)
            Text("Conversation ids, one per line. Unknown values are kept as written.")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $draft)
                .frame(minHeight: 72)
            ForEach(featureStringList(value), id: \.self) { id in
                Label(id, systemImage: "bubble.left")
                    .font(.footnote)
            }
        }
        .onAppear { draft = featureStringList(value).joined(separator: "\n") }
        .onChange(of: draft) { _, next in
            value = (try? featureParseThreadsCell(next.split(whereSeparator: \.isNewline).map(String.init))) ?? value
        }
    }
}

struct FeatureSchemaEditor: View {
    @ObservedObject var model: FeatureDatabaseModel
    @State private var columnName = ""
    @State private var columnType = "text"
    @State private var optionValue = ""
    @State private var optionColumnId = ""
    @State private var renameColumnId = ""
    @State private var renameValue = ""

    var body: some View {
        Form {
            Section("Columns") {
                NavigationLink("Manage views & columns") { DatabaseManagementScreen(model: model) }
                ForEach(model.columns, id: \.id) { column in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue)
                            .font(.headline)
                        Text(column["type"].stringValue)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if column["type"].stringValue == "select" || column["type"].stringValue == "multi" {
                            ForEach(column["options"].arrayValue, id: \.featureOptionValue) { option in
                                Text(option["label"].optionalString ?? option["value"].stringValue)
                                    .font(.footnote)
                            }
                        }
                    }
                }
            }
            Section("Add column") {
                TextField("Name", text: $columnName)
                Picker("Type", selection: $columnType) {
                    ForEach(featureDatabaseColumnTypes.filter { $0 != "app" && $0 != "threads" }, id: \.self) { type in
                        Text(type).tag(type)
                    }
                }
                Button("Add column") {
                    Task {
                        if await model.addColumn(name: columnName, type: columnType) {
                            columnName = ""
                        }
                    }
                }
                .disabled(columnName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section("Rename column") {
                Picker("Column", selection: $renameColumnId) {
                    Text("Choose a column").tag("")
                    ForEach(model.columns.filter { $0["builtin"] != true }, id: \.id) { column in
                        Text(column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue).tag(column.id)
                    }
                }
                TextField("New name", text: $renameValue)
                Button("Rename") {
                    Task {
                        if let column = model.columns.first(where: { $0.id == renameColumnId }),
                           await model.renameColumn(column, name: renameValue) {
                            renameValue = ""
                        }
                    }
                }
                .disabled(renameColumnId.isEmpty || renameValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section("Add option") {
                Picker("Column", selection: $optionColumnId) {
                    Text("Choose a column").tag("")
                    ForEach(model.columns.filter { ["select", "multi", "status"].contains($0["type"].stringValue) }, id: \.id) { column in
                        Text(column["name"].stringValue.isEmpty ? column.id : column["name"].stringValue).tag(column.id)
                    }
                }
                TextField("Value", text: $optionValue)
                Button("Add option") {
                    Task {
                        if await model.addOption(columnId: optionColumnId, value: optionValue) {
                            optionValue = ""
                        }
                    }
                }
                .disabled(optionColumnId.isEmpty || optionValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .navigationTitle("Schema")
        .onAppear {
            if optionColumnId.isEmpty {
                optionColumnId = model.columns.first { ["select", "multi"].contains($0["type"].stringValue) }?.id ?? ""
            }
        }
    }
}
