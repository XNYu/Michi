import Foundation
import MichiCore

/// What history a new branch inherits. The choice becomes the branch edge's
/// `anchorMessageId`, which the backend resolves to the exact parent prefix
/// (`resolveBranchBoundary`). Only durable message ids are offered, so a
/// branch can never be cut at an optimistic or steering row that the
/// backend does not hold.
enum DesignChatBranchContext: String, CaseIterable, Identifiable {
    case currentReply, fullThread
    var id: String { rawValue }
    var title: String { self == .currentReply ? "Current reply" : "Full thread" }
}

struct DesignChatBranchPlan: Equatable {
    /// The exact id the sheet was opened from, when the user picked a reply.
    let requestedAnchor: String?
    /// The saved reply the request started from, when it is not the latest message.
    let currentReplyID: String?
    /// The parent's latest saved message; nil when nothing is saved yet.
    let tailID: String?
    /// The requested reply is no longer a durable id. Current reply must not
    /// silently become the tail; the user has to choose Full thread or pick
    /// another saved reply.
    let missingRequestedAnchor: Bool

    init(requestedAnchor: String?, durableIDs: [String]) {
        self.requestedAnchor = requestedAnchor
        tailID = durableIDs.last
        if let requestedAnchor {
            if let tailID, DesignChatOpaqueID.same(requestedAnchor, tailID) {
                currentReplyID = nil
                missingRequestedAnchor = false
            } else if durableIDs.contains(where: { DesignChatOpaqueID.same($0, requestedAnchor) }) {
                currentReplyID = requestedAnchor
                missingRequestedAnchor = false
            } else {
                currentReplyID = nil
                missingRequestedAnchor = true
            }
        } else {
            currentReplyID = nil
            missingRequestedAnchor = false
        }
    }

    /// When the requested reply is the latest message both choices are the same cut.
    var offersChoice: Bool { currentReplyID != nil }
    /// A missing requested reply still needs an explicit Full thread choice.
    var showsContextPicker: Bool { offersChoice || missingRequestedAnchor }
    var defaultContext: DesignChatBranchContext { (offersChoice || missingRequestedAnchor) ? .currentReply : .fullThread }

    func anchor(for context: DesignChatBranchContext) -> String? {
        switch context {
        case .currentReply:
            return missingRequestedAnchor ? nil : (currentReplyID ?? tailID)
        case .fullThread:
            return tailID
        }
    }

    func allowsCreation(for context: DesignChatBranchContext) -> Bool {
        !(missingRequestedAnchor && context == .currentReply)
    }

    func createAnchor(for context: DesignChatBranchContext) -> Result<String?, NativeFailure> {
        guard allowsCreation(for: context) else { return .failure(NativeFailure(detail(for: context))) }
        return .success(anchor(for: context))
    }

    func detail(for context: DesignChatBranchContext) -> String {
        if missingRequestedAnchor && context == .currentReply {
            return "The reply you branched from is no longer in this thread’s saved history. Choose Full thread to keep the latest saved messages, or go back and branch from a reply that is still saved."
        }
        if tailID == nil { return "This thread has no saved messages yet, so the branch starts from what exists when it is created." }
        if !offersChoice { return "The branch keeps this thread’s history through its latest saved message." }
        return context == .currentReply
            ? "The branch keeps history up to the reply you branched from. Later messages are left out."
            : "The branch keeps this thread’s history through its latest saved message."
    }
}

/// The parent's next-session agent fields, copied into a new branch's
/// controller when the user keeps "Same as parent". The backend gives a
/// blank branch its global defaults otherwise.
struct DesignChatAgentSettings: Equatable {
    var runtimeID = ""
    var providerID = ""
    var modelID = ""
    var reasoning = ""
    /// Default effort chosen explicitly: the session then receives `reasoning: null`.
    var reasoningExplicit = false
    var permissionMode = "ask"
    var approveForMe = false

    /// Unknown permission modes fall back to "ask"; Approve for me exists only in ask mode.
    var normalized: DesignChatAgentSettings {
        var copy = self
        if !featureIsPermissionMode(copy.permissionMode) { copy.permissionMode = "ask" }
        copy.approveForMe = copy.permissionMode == "ask" && copy.approveForMe
        return copy
    }
}

enum DesignChatBranchAgent: String, CaseIterable, Identifiable {
    case sameAsParent, defaultAgent
    var id: String { rawValue }
    var title: String { self == .sameAsParent ? "Same as parent" : "Default agent" }
}

enum DesignChatBranchPersistence {
    /// The branch row and its context anchor are saved when it is created.
    /// Agent fields live in the open controller until the first message
    /// starts a session (ensure-session), so an empty branch can lose them.
    static func note(agent: DesignChatBranchAgent, hasQuestion: Bool) -> String {
        if hasQuestion { return "The branch and its context are saved now. Its agent settings take effect when this first message starts." }
        switch agent {
        case .sameAsParent:
            return "The empty branch and its context are saved now. The parent’s agent settings apply when you send its first message; if Michi restarts before that, the branch uses the default agent."
        case .defaultAgent:
            return "The empty branch and its context are saved now. It uses the default agent."
        }
    }
}
