import SwiftUI
import Combine
import WebKit
import MichiCore

/// Isolated WKWebView runner. The outer document is native-owned; user source
/// is only posted into the worker after the wrapper handshake. Every load gets
/// a fresh nonce, and messages carrying another nonce are dropped before they
/// reach the model. Model state is never mutated inside a SwiftUI update: the
/// coordinator drains and reloads on the next main-queue turn.
struct NativeComponentSandbox: UIViewRepresentable {
    @ObservedObject var model: NativeComponentRuntimeModel

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.allowsInlineMediaPlayback = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.suppressesIncrementalRendering = true
        configuration.userContentController.add(context.coordinator.proxy, name: ComponentSandbox.messageHandlerName)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = false
        view.allowsLinkPreview = false
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        context.coordinator.attach(view, model: model)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.attach(uiView, model: model)
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.teardown(uiView)
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let proxy = MessageProxy()
        private weak var model: NativeComponentRuntimeModel?
        private weak var webView: WKWebView?
        private var loadedChannel: String?
        private var nonce = ""
        private var expectingMainLoad = false
        private var syncScheduled = false
        private var subscription: AnyCancellable?

        override init() {
            super.init()
            proxy.owner = self
        }

        func attach(_ view: WKWebView, model next: NativeComponentRuntimeModel) {
            webView = view
            if model !== next {
                model = next
                loadedChannel = nil
                subscription = next.outboxSignal.sink { [weak self] in self?.scheduleSync() }
            }
            scheduleSync()
        }

        func scheduleSync() {
            guard !syncScheduled else { return }
            syncScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.syncScheduled = false
                self.sync()
            }
        }

        private func sync() {
            guard let model, let webView else { return }
            for message in model.drainOutbox(channel: loadedChannel) { post(message, to: webView) }
            guard let target = model.sandboxChannel(loaded: loadedChannel) else { return }
            if let loadedChannel, ComponentSandbox.sameID(loadedChannel, target) { return }
            load(target, in: webView, model: model)
        }

        private func load(_ channel: String, in webView: WKWebView, model: NativeComponentRuntimeModel) {
            guard let html = try? ComponentSandbox.bundledHTML() else {
                loadedChannel = nil
                model.sandboxFailed(channel: channel, message: ComponentSandbox.DocumentError.missing.errorDescription
                                    ?? "The bundled component sandbox document could not be loaded.")
                return
            }
            nonce = ComponentSandbox.makeDocumentNonce()
            loadedChannel = channel
            expectingMainLoad = true
            webView.loadHTMLString(ComponentSandbox.outerDocument(sandboxHTML: html, nonce: nonce), baseURL: nil)
        }

        private func post(_ message: JSONValue, to webView: WKWebView) {
            webView.callAsyncJavaScript(
                ComponentSandbox.hostPostScript,
                arguments: ["nonce": nonce, "payload": ComponentSandbox.any(from: message)],
                in: nil,
                in: .page
            ) { _ in }
        }

        func receive(_ body: Any) {
            guard let model, let channel = loadedChannel, !nonce.isEmpty,
                  let envelope = ComponentSandbox.json(fromAny: body),
                  let message = ComponentSandbox.parseEnvelope(envelope, nonce: nonce) else { return }
            model.handleSandboxMessage(message, channel: channel, document: nonce)
        }

        func teardown(_ view: WKWebView) {
            view.stopLoading()
            view.configuration.userContentController.removeScriptMessageHandler(forName: ComponentSandbox.messageHandlerName)
            view.navigationDelegate = nil
            view.uiDelegate = nil
            subscription?.cancel()
            subscription = nil
            loadedChannel = nil
            nonce = ""
            webView = nil
        }

        private func documentFailed(_ message: String) {
            guard let model, let channel = loadedChannel else { return }
            loadedChannel = nil
            nonce = ""
            let failed = channel
            DispatchQueue.main.async { model.sandboxFailed(channel: failed, message: message) }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
            let url = navigationAction.request.url
            guard let frame = navigationAction.targetFrame else { return .cancel }
            if frame.isMainFrame {
                guard expectingMainLoad, url == nil || url?.absoluteString == "about:blank" else { return .cancel }
                expectingMainLoad = false
                return .allow
            }
            return url?.scheme == "about" ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async -> WKNavigationResponsePolicy {
            let scheme = navigationResponse.response.url?.scheme
            if scheme == nil || scheme == "about" { return .allow }
            return .cancel
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            navigationFailed(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            navigationFailed(error)
        }

        /// Loading the next session's document cancels the previous load; that
        /// cancellation is not a failure of the new document.
        private func navigationFailed(_ error: Error) {
            let failure = error as NSError
            if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
            documentFailed("The component sandbox could not load: \(failure.localizedDescription)")
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            documentFailed("The component sandbox stopped unexpectedly. Use Restart to run it again.")
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            nil
        }

        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    final class MessageProxy: NSObject, WKScriptMessageHandler {
        weak var owner: Coordinator?
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == ComponentSandbox.messageHandlerName, message.frameInfo.isMainFrame else { return }
            owner?.receive(message.body)
        }
    }
}
