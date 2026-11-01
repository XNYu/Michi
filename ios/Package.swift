// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MichiCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "MichiCore", targets: ["MichiCore"])],
    targets: [
        .target(name: "MichiCore", resources: [.process("Resources")]),
        .executableTarget(name: "MichiContractProbe", dependencies: ["MichiCore"], path: "Validation/Probe"),
        .executableTarget(name: "MichiStreamProbe", dependencies: ["MichiCore"], path: "Validation/StreamProbe"),
        // Compile the real app controllers on the Mac as well, so model
        // regression tests do not require a Simulator debug-service session.
        .target(name: "MichiState", dependencies: ["MichiCore"], path: "Sources/MichiApp",
                exclude: ["Resources", "Design", "App/MichiApp.swift", "Features/NativeHomeScreen.swift", "Features/NativeSearchScreen.swift", "Features/NativePagesHomeScreen.swift", "Features/NativeRichPageBlocks.swift", "Features/NativeScheduledNotifications.swift", "Features/NativeHomeCards.swift", "Features/ExtendedSettingsScreen.swift", "Features/ServiceSettingsScreen.swift", "Features/AgentRunsScreen.swift", "Features/NativeActivityScreen.swift", "Features/NativeAppearanceScreen.swift", "Features/NativeSpacesMetaScreen.swift", "Features/NativeLinkedConversations.swift", "Features/NativeDatabaseLayouts.swift", "Features/DatabaseParityViews.swift", "Features/SpacesParityViews.swift", "Features/FeatureChrome.swift", "Features/SpacesScreen.swift",
                          "Features/FeatureDatabaseScreen.swift", "Features/FeaturePageScreen.swift", "Features/ScheduleScreen.swift",
                          "Features/NativeInlineHomeDocument.swift", "Features/NativeComponentLibraryScreen.swift", "Features/NativeBlockCatalogScreen.swift", "Features/DatabaseOrderingScreen.swift", "Features/DatabaseManagementScreen.swift",
                          "Features/NativeHomeTaskDestination.swift", "Features/NativeMediaPlayer.swift",
                          "Features/NativeComponentSandbox.swift", "Features/NativeComponentHostView.swift",
                          "Features/NativePageComponentContext.swift", "Features/NativeDatabaseBoardDrag.swift",
                          "Features/NativeComponentDatabaseBindingScreen.swift",
                          "Features/NativePageNavigation.swift", "Features/NativeMichiReferences.swift",
                          "Features/DesignPagesHome.swift", "Features/DesignPagesChrome.swift", "Features/DesignSettingsHome.swift", "Features/DesignSettingsKit.swift",
                          "Conversations/ChatComposerControls.swift", "Conversations/NativeMessageSelection.swift", "Conversations/NativeDictationButton.swift",
                          "Features/AgentLibraryScreen.swift", "Features/RuntimeSettingsScreen.swift", "Testing", "Connection/ConnectionScreen.swift", "Connection/ConnectionStore+App.swift", "Connection/NativeQRScanner.swift",
                          "Conversations/ConversationView.swift", "Conversations/ConversationsScreen.swift", "Conversations/WorkspaceLifecycleScreens.swift", "Conversations/WorkspaceOverviewScreen.swift",
                          "Conversations/NativeMermaidDiagrams.swift", "Conversations/NativeMermaidEntityDiagrams.swift", "Conversations/NativeFlowchart.swift", "Conversations/NativeMarkdownTableView.swift", "Conversations/NativeHighlightedCode.swift", "Conversations/NativeWorkspaceGraph.swift",
                          "Conversations/ConversationTools.swift", "Conversations/NativeComposerPanel.swift", "Conversations/NativeHomeDraftScreen.swift", "Conversations/NativeCameraCapture.swift", "Conversations/NativeMarkdown.swift", "Conversations/NativeMathView.swift", "Conversations/NativeHTMLView.swift", "Conversations/NativeArtifactScreen.swift", "Conversations/NativeConversationImage.swift"],
                sources: ["App/MichiStore.swift", "App/WorkspaceLifecycle.swift", "Conversations/ChatController.swift", "Conversations/ComposerState.swift", "Conversations/ComposerContext.swift", "Connection/NativeFailure.swift", "Connection/ConnectionStore.swift", "Features/FeatureSupport.swift", "Features/Models"]),
        .testTarget(name: "MichiCoreTests", dependencies: ["MichiCore"]),
        .testTarget(name: "MichiStateTests", dependencies: ["MichiState", "MichiCore"], path: "AppTests",
                    sources: nil)
    ]
)
