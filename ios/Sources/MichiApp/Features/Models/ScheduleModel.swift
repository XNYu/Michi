import Foundation
import Combine
import MichiCore

enum FeatureScheduleMode: String, CaseIterable, Identifiable {
    case interval, daily, weekdays, weekly, once, cron
    var id: String { rawValue }
}

enum FeatureIntervalUnit: String {
    case minutes, hours, days
}

struct FeatureScheduleDraft: Identifiable {
    var id: String { jobId ?? "new" }
    var jobId: String?
    var name = ""
    var workspaceId = ""
    var prompt = ""
    var mode: FeatureScheduleMode = .daily
    var intervalValue = 1
    var intervalUnit: FeatureIntervalUnit = .hours
    var timeOfDay = Calendar.current.date(from: DateComponents(hour: 9, minute: 0)) ?? Date()
    var weekdays: Set<Int> = [1]
    var cron = "0 9 * * 1-5"
    var timezone = featureTimeZoneId()
    var onceAt = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
    var runtimeId = ""
    var providerId = ""
    var modelId = ""
    var reasoning = ""
    var permissionMode = "trust"
    var sessionMode = "persistent"
    var notify = true
    var timeoutMinutes = 30
    var sourceJob: JSONValue?
    var sourceSchedule: JSONValue?
    var sourceEverySeconds: Int?
    var sourceTimeoutSeconds: Int?
    var loadedMode: FeatureScheduleMode = .daily
    var loadedIntervalValue = 1
    var loadedIntervalUnit: FeatureIntervalUnit = .hours
    var loadedTimeoutMinutes = 30

    static let weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    func scheduleJSON() throws -> JSONValue {
        switch mode {
        case .interval:
            if intervalUnchanged, let source = sourceEverySeconds {
                if let original = sourceSchedule, original["kind"].stringValue == "every" { return original }
                return ["kind": "every", "everySeconds": .number(Double(source))]
            }
            let seconds = intervalValue * (intervalUnit == .minutes ? 60 : intervalUnit == .hours ? 3600 : 86_400)
            if seconds < 60 { throw FeatureRequestError(message: "Run at most once a minute") }
            return ["kind": "every", "everySeconds": .number(Double(seconds))]
        case .daily, .weekdays, .weekly:
            let parts = Calendar.current.dateComponents([.hour, .minute], from: timeOfDay)
            let hour = parts.hour ?? 9
            let minute = parts.minute ?? 0
            let days: String
            if mode == .weekdays {
                days = "1-5"
            } else if mode == .weekly {
                let selected = weekdays.sorted()
                if selected.isEmpty { throw FeatureRequestError(message: "Pick at least one day") }
                days = selected.map(String.init).joined(separator: ",")
            } else {
                days = "*"
            }
            return ["kind": "cron", "expression": .string("\(minute) \(hour) * * \(days)"), "timezone": .string(timezone)]
        case .once:
            return ["kind": "at", "at": .number(featureMillis(onceAt))]
        case .cron:
            let expression = cron.trimmingCharacters(in: .whitespacesAndNewlines)
            if expression.isEmpty { throw FeatureRequestError(message: "Enter a cron expression") }
            if let original = sourceSchedule,
               original["kind"].stringValue == "cron",
               original["expression"].stringValue == expression,
               (original["timezone"].optionalString ?? timezone) == timezone {
                return original
            }
            return ["kind": "cron", "expression": .string(expression), "timezone": .string(timezone)]
        }
    }

    private var intervalUnchanged: Bool {
        mode == .interval && intervalValue == loadedIntervalValue && intervalUnit == loadedIntervalUnit
    }

    private var timeoutUnchanged: Bool {
        timeoutMinutes == loadedTimeoutMinutes
    }

    var resolvedTimeoutSeconds: Int {
        if timeoutUnchanged, let source = sourceTimeoutSeconds, source > 0 { return source }
        return timeoutMinutes * 60
    }

    func inputJSON() throws -> JSONValue {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { throw FeatureRequestError(message: "Give the job a name") }
        if workspaceId.isEmpty { throw FeatureRequestError(message: "Pick a workspace") }
        if prompt.isEmpty { throw FeatureRequestError(message: "Write the prompt to run") }
        if timeoutMinutes < 1 || timeoutMinutes > 1440 { throw FeatureRequestError(message: "Timeout must be 1–1440 minutes") }
        var body: [String: JSONValue] = [
            "workspaceId": .string(workspaceId),
            "name": .string(name),
            "prompt": .string(prompt),
            "schedule": try scheduleJSON(),
            "permissionMode": .string(permissionMode),
            "sessionMode": .string(sessionMode),
            "notify": .bool(notify),
            "timeoutSeconds": .number(Double(resolvedTimeoutSeconds)),
        ]
        body["runtimeId"] = runtimeId.isEmpty ? .null : .string(runtimeId)
        body["providerId"] = runtimeId.isEmpty || providerId.isEmpty ? .null : .string(providerId)
        body["modelId"] = runtimeId.isEmpty || modelId.isEmpty ? .null : .string(modelId)
        body["reasoning"] = runtimeId.isEmpty || reasoning.isEmpty ? .null : .string(reasoning)
        return .object(body)
    }

    func patchJSON(against job: JSONValue) throws -> JSONValue {
        featureSchedulePatch(job: job, draft: try inputJSON())
    }

    static func from(_ job: JSONValue, defaultWorkspace: String, sessionMode: String) -> FeatureScheduleDraft {
        var draft = FeatureScheduleDraft()
        draft.sourceJob = job
        draft.jobId = job.id.isEmpty ? nil : job.id
        draft.name = job["name"].stringValue
        draft.workspaceId = job["workspaceId"].optionalString ?? defaultWorkspace
        draft.prompt = job["prompt"].stringValue
        draft.permissionMode = job["permissionMode"].optionalString ?? "trust"
        draft.sessionMode = job["sessionMode"].optionalString ?? sessionMode
        draft.notify = job["notify"].isNull ? true : job["notify"].boolValue
        draft.sourceTimeoutSeconds = job["timeoutSeconds"].intValue
        draft.timeoutMinutes = max(1, job["timeoutSeconds"].intValue / 60)
        draft.loadedTimeoutMinutes = draft.timeoutMinutes
        draft.runtimeId = job["runtimeId"].stringValue
        draft.providerId = job["providerId"].stringValue
        draft.modelId = job["modelId"].stringValue
        draft.reasoning = job["reasoning"].stringValue
        applySchedule(job["schedule"], to: &draft)
        return draft
    }

    static func applySchedule(_ schedule: JSONValue, to draft: inout FeatureScheduleDraft) {
        draft.sourceSchedule = schedule
        switch schedule["kind"].stringValue {
        case "every":
            draft.mode = .interval
            let seconds = schedule["everySeconds"].intValue
            draft.sourceEverySeconds = seconds
            if seconds % 86_400 == 0 {
                draft.intervalUnit = .days
                draft.intervalValue = max(1, seconds / 86_400)
            } else if seconds % 3600 == 0 {
                draft.intervalUnit = .hours
                draft.intervalValue = max(1, seconds / 3600)
            } else {
                draft.intervalUnit = .minutes
                draft.intervalValue = max(1, seconds / 60)
            }
            draft.loadedIntervalValue = draft.intervalValue
            draft.loadedIntervalUnit = draft.intervalUnit
            draft.loadedMode = .interval
        case "at":
            draft.mode = .once
            draft.loadedMode = .once
            if let date = featureDate(schedule["at"].featureOptionalNumber) { draft.onceAt = date }
        case "cron":
            let expression = schedule["expression"].stringValue
            draft.timezone = schedule["timezone"].optionalString ?? featureTimeZoneId()
            draft.cron = expression
            if let parsed = featureSupportedCron(expression) {
                draft.timeOfDay = Calendar.current.date(from: DateComponents(hour: parsed.hour, minute: parsed.minute)) ?? draft.timeOfDay
                if parsed.days == "*" {
                    draft.mode = .daily
                } else if parsed.days == "1-5" {
                    draft.mode = .weekdays
                } else {
                    draft.mode = .weekly
                    draft.weekdays = Set(parsed.days.split(separator: ",").compactMap { Int($0) })
                }
            } else {
                draft.mode = .cron
            }
            draft.loadedMode = draft.mode
        default:
            draft.mode = .daily
            draft.loadedMode = .daily
        }
    }
}

func featureSupportedCron(_ expression: String) -> (minute: Int, hour: Int, days: String)? {
    let parts = expression.trimmingCharacters(in: .whitespacesAndNewlines)
        .split(separator: " ", omittingEmptySubsequences: true)
        .map(String.init)
    guard parts.count == 5, parts[2] == "*", parts[3] == "*" else { return nil }
    guard parts[0].allSatisfy(\.isNumber), parts[1].allSatisfy(\.isNumber),
          let minute = Int(parts[0]), let hour = Int(parts[1]),
          (0...59).contains(minute), (0...23).contains(hour) else { return nil }
    let days = parts[4]
    if days == "*" || days == "1-5" { return (minute, hour, days) }
    let tokens = days.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
    guard !tokens.isEmpty, tokens.allSatisfy({ token in
        token.count == 1 && token.allSatisfy(\.isNumber) && (0...6).contains(Int(token) ?? -1)
    }) else { return nil }
    return (minute, hour, days)
}

func featureSchedulePatch(job: JSONValue, draft: JSONValue) -> JSONValue {
    var patch: [String: JSONValue] = [:]
    for (key, value) in draft.objectValue where job[key] != value {
        patch[key] = value
    }
    return .object(patch)
}

@MainActor
final class FeatureScheduleModel: ObservableObject {
    let api: MichiAPI
    @Published var workspaces: [JSONValue]

    @Published var jobs: [JSONValue] = []
    @Published var scheduler: JSONValue = .null
    @Published var blocked: [JSONValue] = []
    @Published var runs: [JSONValue] = []
    @Published var detail: JSONValue = .null
    @Published var loading = false
    @Published var mutating = false
    @Published var error: String?
    @Published var detailError: String?
    @Published var editorError: String?
    @Published var settingsError: String?
    @Published var editor: FeatureScheduleDraft?
    @Published var previewResult: JSONValue?
    @Published var sessionMode = "persistent"
    @Published var confirmingStopIds: Set<String> = []

    init(api: MichiAPI, workspaces: [JSONValue]) {
        self.api = api
        self.workspaces = workspaces
    }

    func refresh() async {
        loading = true
        defer { loading = false }
        do {
            let payload = try await FeatureAPI.get(api, "/scheduled-jobs")
            jobs = featureItems(payload, key: "jobs")
            scheduler = payload["scheduler"]
            blocked = scheduler["blockedExecutions"].arrayValue
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func loadDetail(jobId: String) async {
        do {
            detail = try await FeatureAPI.get(api, "/scheduled-jobs/\(FeatureAPI.segment(jobId))")
            if let index = jobs.firstIndex(where: { $0.id == jobId }) {
                jobs[index] = detail
            }
            let history = try await FeatureAPI.get(api, "/scheduled-jobs/\(FeatureAPI.segment(jobId))/runs")
            runs = featureItems(history, key: "runs")
            detailError = nil
        } catch is CancellationError {
        } catch {
            detailError = featureErrorMessage(error)
        }
    }

    func beginCreate() {
        var draft = FeatureScheduleDraft()
        draft.workspaceId = workspaces.first?.id ?? ""
        draft.sessionMode = sessionMode
        editorError = nil
        previewResult = nil
        editor = draft
    }

    func beginEdit(_ job: JSONValue) {
        editorError = nil
        previewResult = nil
        editor = FeatureScheduleDraft.from(job, defaultWorkspace: workspaces.first?.id ?? "", sessionMode: sessionMode)
    }

    func preview(_ draft: FeatureScheduleDraft) async {
        do {
            previewResult = try await FeatureAPI.send(
                api,
                "/scheduled-jobs/preview",
                method: "POST",
                body: ["schedule": try draft.scheduleJSON()]
            )
        } catch {
            previewResult = ["valid": false, "error": .string(featureErrorMessage(error)), "nextRuns": .array([])]
        }
    }

    func save(_ draft: FeatureScheduleDraft) async -> Bool {
        mutating = true
        defer { mutating = false }
        do {
            if let jobId = draft.jobId {
                let current = jobs.first(where: { $0.id == jobId }) ?? draft.sourceJob ?? detail
                let body = try draft.patchJSON(against: current)
                if !body.objectValue.isEmpty {
                    _ = try await FeatureAPI.send(api, "/scheduled-jobs/\(FeatureAPI.segment(jobId))", method: "PATCH", body: body)
                }
            } else {
                _ = try await FeatureAPI.send(api, "/scheduled-jobs", method: "POST", body: try draft.inputJSON())
            }
            editorError = nil
            await refresh()
            return true
        } catch {
            editorError = featureErrorMessage(error)
            return false
        }
    }

    func setEnabled(jobId: String, enabled: Bool) async {
        await mutate(jobId: jobId) {
            _ = try await FeatureAPI.send(
                api,
                "/scheduled-jobs/\(FeatureAPI.segment(jobId))",
                method: "PATCH",
                body: ["enabled": .bool(enabled)]
            )
        }
    }

    func runNow(jobId: String) async {
        await mutate(jobId: jobId) {
            _ = try await FeatureAPI.send(api, "/scheduled-jobs/\(FeatureAPI.segment(jobId))/run", method: "POST")
        }
    }

    func cancel(jobId: String) async {
        await mutate(jobId: jobId) {
            _ = try await FeatureAPI.send(api, "/scheduled-jobs/\(FeatureAPI.segment(jobId))/cancel", method: "POST")
        }
    }

    func delete(jobId: String) async -> Bool {
        var ok = false
        await mutate(jobId: jobId) {
            _ = try await FeatureAPI.send(api, "/scheduled-jobs/\(FeatureAPI.segment(jobId))", method: "DELETE")
            ok = true
        }
        return ok
    }

    func confirmStopped(runId: String) async {
        guard !runId.isEmpty, !confirmingStopIds.contains(runId) else { return }
        confirmingStopIds.insert(runId)
        defer { confirmingStopIds.remove(runId) }
        do {
            _ = try await FeatureAPI.send(
                api,
                "/scheduled-jobs/executions/\(FeatureAPI.segment(runId))/confirm-stopped",
                method: "POST",
                body: ["executionStopped": true]
            )
            error = nil
            await refresh()
        } catch {
            self.error = featureErrorMessage(error)
        }
    }

    func loadSettings() async {
        do {
            let settings = try await FeatureAPI.get(api, "/scheduled-jobs/settings")
            sessionMode = settings["sessionMode"].optionalString ?? sessionMode
            settingsError = nil
        } catch {
            settingsError = featureErrorMessage(error)
        }
    }

    func saveSettings() async {
        do {
            let settings = try await FeatureAPI.send(
                api,
                "/scheduled-jobs/settings",
                method: "PATCH",
                body: ["sessionMode": .string(sessionMode)]
            )
            sessionMode = settings["sessionMode"].optionalString ?? sessionMode
            settingsError = nil
        } catch {
            settingsError = featureErrorMessage(error)
        }
    }

    private func mutate(jobId: String, _ work: () async throws -> Void) async {
        mutating = true
        defer { mutating = false }
        do {
            try await work()
            detailError = nil
            await refresh()
            await loadDetail(jobId: jobId)
        } catch {
            detailError = featureErrorMessage(error)
        }
    }
}

func featureJobStatus(_ job: JSONValue) -> String {
    if job["activeRunId"].optionalString != nil { return "Running" }
    if job["autoPaused"].boolValue { return "Auto-paused" }
    if !job["enabled"].boolValue { return "Paused" }
    if let status = job["lastStatus"].optionalString, !status.isEmpty { return status }
    return "Scheduled"
}

func featureScheduleSummary(_ schedule: JSONValue) -> String {
    switch schedule["kind"].stringValue {
    case "every":
        let seconds = schedule["everySeconds"].intValue
        if seconds % 86_400 == 0 { return "Every \(seconds / 86_400)d" }
        if seconds % 3600 == 0 { return "Every \(seconds / 3600)h" }
        return "Every \(max(1, seconds / 60))m"
    case "at":
        return "Once \(featureFormatDate(schedule["at"].featureOptionalNumber))"
    case "cron":
        return schedule["expression"].stringValue
    default:
        return "Schedule"
    }
}
