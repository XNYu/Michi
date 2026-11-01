import Foundation
import MichiCore

/// Byte-exact opaque identity. Swift `String` equality is Unicode-normalized
/// and must not merge distinct server IDs.
struct DesignPageOpaqueID: Hashable, Sendable {
    let raw: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.raw.utf8.elementsEqual(rhs.raw.utf8)
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(raw.utf8.count)
        for byte in raw.utf8 { hasher.combine(byte) }
    }

    static func same(_ a: String, _ b: String) -> Bool {
        a.utf8.elementsEqual(b.utf8)
    }
}

struct DesignPagesHomeIdentity: Hashable, Sendable {
    let pageId: DesignPageOpaqueID
    let workspaceId: DesignPageOpaqueID

    init(pageId: String, workspaceId: String) {
        self.pageId = DesignPageOpaqueID(raw: pageId)
        self.workspaceId = DesignPageOpaqueID(raw: workspaceId)
    }
}

struct DesignPagesPageIdentity: Hashable, Sendable {
    let pageId: DesignPageOpaqueID
    let workspaceId: DesignPageOpaqueID

    init(pageId: String, workspaceId: String) {
        self.pageId = DesignPageOpaqueID(raw: pageId)
        self.workspaceId = DesignPageOpaqueID(raw: workspaceId)
    }
}

struct DesignPagesDatabaseIdentity: Hashable, Sendable {
    let databaseId: DesignPageOpaqueID
    let workspaceId: DesignPageOpaqueID

    init(databaseId: String, workspaceId: String) {
        self.databaseId = DesignPageOpaqueID(raw: databaseId)
        self.workspaceId = DesignPageOpaqueID(raw: workspaceId)
    }
}

struct DesignPagesDirectoryGroup: Identifiable, Equatable {
    let id: DesignPageOpaqueID
    let label: String
    var pages: [JSONValue]
}

enum DesignPageBatchKind: Equatable, Sendable {
    case acceptSelected
    case rejectAll
}

struct DesignPageBatchSession: Equatable, Sendable {
    let kind: DesignPageBatchKind
    let intendedIDs: [String]
    var index = 0
}

enum DesignPageBatchNext: Equatable {
    case perform(JSONValue)
    case finished
    case unavailable
}

enum DesignPageBatch {
    static func intendedIDs(
        kind: DesignPageBatchKind,
        pending: [JSONValue],
        selected: Set<DesignPageOpaqueID>
    ) -> [String] {
        let live = pending.filter(featureIsPendingProposal)
        switch kind {
        case .rejectAll:
            return live.map(\.id)
        case .acceptSelected:
            return live.filter { selected.contains($0.designPageOpaqueID) }.map(\.id)
        }
    }

    static func next(session: DesignPageBatchSession, pending: [JSONValue]) -> DesignPageBatchNext {
        guard session.index < session.intendedIDs.count else { return .finished }
        let intended = session.intendedIDs[session.index]
        guard let record = pending.first(where: { DesignPageOpaqueID.same($0.id, intended) }) else {
            return .unavailable
        }
        guard featureIsPendingProposal(record) else { return .unavailable }
        return .perform(record)
    }

    /// Sequential writes only. First failed write, cancellation, or
    /// missing/non-pending intended item leaves later IDs unwritten.
    static func run(
        session: inout DesignPageBatchSession,
        isCancelled: () -> Bool,
        pending: () -> [JSONValue],
        write: (JSONValue) async -> Bool
    ) async {
        while !isCancelled() {
            switch next(session: session, pending: pending()) {
            case .finished, .unavailable:
                return
            case .perform(let change):
                let succeeded = await write(change)
                if !succeeded || isCancelled() { return }
                session.index += 1
            }
        }
    }

    static func directoryGroups(_ spaces: [JSONValue]) -> [DesignPagesDirectoryGroup] {
        var groups: [DesignPagesDirectoryGroup] = []
        var index: [DesignPageOpaqueID: Int] = [:]
        for space in spaces {
            let identity = DesignPageOpaqueID(raw: space.featureWorkspaceKey)
            if let existing = index[identity] {
                groups[existing].pages.append(space)
            } else {
                index[identity] = groups.count
                let label = space["workspaceName"].optionalString ?? featureWorkspaceName(space)
                groups.append(DesignPagesDirectoryGroup(id: identity, label: label, pages: [space]))
            }
        }
        return groups
    }

    static func homePageID(_ item: JSONValue) -> String {
        item["homePageId"].stringValue
    }
}

extension JSONValue {
    var designPageOpaqueID: DesignPageOpaqueID {
        DesignPageOpaqueID(raw: id)
    }

    var designPagesWorkspaceIdentity: DesignPageOpaqueID {
        DesignPageOpaqueID(raw: featureWorkspaceKey)
    }

    var designPagesPageIdentity: DesignPagesPageIdentity {
        DesignPagesPageIdentity(pageId: id, workspaceId: featureWorkspaceKey)
    }

    var designPagesDatabaseIdentity: DesignPagesDatabaseIdentity {
        DesignPagesDatabaseIdentity(
            databaseId: self["databaseId"].stringValue.isEmpty ? id : self["databaseId"].stringValue,
            workspaceId: self["workspaceId"].stringValue
        )
    }
}
