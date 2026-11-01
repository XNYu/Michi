import SwiftUI
import MichiCore

extension View {
    func nativeDatabaseBoardCardDrag(
        item: DatabaseOrderingDragItem,
        group: DatabaseOrderingGroup,
        enabled: Bool,
        rejection: @escaping (DatabaseOrderingDragItem) -> String?,
        onDrop: @escaping (DatabaseOrderingDragItem, NativeDatabaseBoardDropAction) -> Void
    ) -> some View {
        modifier(NativeDatabaseBoardCardDragModifier(
            item: item, group: group, enabled: enabled, rejection: rejection, onDrop: onDrop
        ))
    }

    func nativeDatabaseBoardColumnDrop(
        group: DatabaseOrderingGroup,
        enabled: Bool,
        rejection: @escaping (DatabaseOrderingDragItem) -> String?,
        onDrop: @escaping (DatabaseOrderingDragItem, NativeDatabaseBoardDropAction) -> Void
    ) -> some View {
        modifier(NativeDatabaseBoardColumnDropModifier(
            group: group, enabled: enabled, rejection: rejection, onDrop: onDrop
        ))
    }
}

private struct NativeDatabaseBoardCardDragModifier: ViewModifier {
    let item: DatabaseOrderingDragItem
    let group: DatabaseOrderingGroup
    let enabled: Bool
    let rejection: (DatabaseOrderingDragItem) -> String?
    let onDrop: (DatabaseOrderingDragItem, NativeDatabaseBoardDropAction) -> Void

    func body(content: Content) -> some View {
        if enabled {
            content
                .draggable(item)
                .dropDestination(for: DatabaseOrderingDragItem.self) { items, _ in
                    guard items.count == 1, let dropped = items.first,
                          NativeDatabaseBoardDrop.accepts(rejection(dropped)),
                          let action = NativeDatabaseBoardDrop.action(item: dropped, group: group, ontoRowID: item.id)
                    else { return false }
                    onDrop(dropped, action)
                    return true
                }
        } else {
            content
        }
    }
}

private struct NativeDatabaseBoardColumnDropModifier: ViewModifier {
    let group: DatabaseOrderingGroup
    let enabled: Bool
    let rejection: (DatabaseOrderingDragItem) -> String?
    let onDrop: (DatabaseOrderingDragItem, NativeDatabaseBoardDropAction) -> Void

    func body(content: Content) -> some View {
        if enabled {
            content.dropDestination(for: DatabaseOrderingDragItem.self) { items, _ in
                guard items.count == 1, let dropped = items.first,
                      NativeDatabaseBoardDrop.accepts(rejection(dropped)),
                      let action = NativeDatabaseBoardDrop.action(item: dropped, group: group, ontoRowID: nil)
                else { return false }
                onDrop(dropped, action)
                return true
            }
        } else {
            content
        }
    }
}
