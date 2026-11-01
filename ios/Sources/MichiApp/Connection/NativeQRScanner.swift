import AVFoundation
import SwiftUI
import UIKit
import MichiCore

enum ConnectionScanEvent: Equatable {
    case scanned(ConnectionAddress.Parsed)
    case rejected(ConnectionAddress.Failure)
    case cancelled
    case unavailable(ConnectionCameraAvailability)
}

#if DEBUG
enum ConnectionScanInjection {
    static func event(from arguments: [String]) -> ConnectionScanEvent? {
        if arguments.contains("--connection-scan-unavailable") {
            return .unavailable(.noCamera)
        }
        let prefix = "--connection-scan-payload="
        guard let raw = arguments.first(where: { $0.hasPrefix(prefix) }) else { return nil }
        let payload = String(raw.dropFirst(prefix.count))
        switch ConnectionAddress.parse(payload, mode: .scan) {
        case .success(let parsed):
            return .scanned(parsed)
        case .failure(let failure):
            return .rejected(failure)
        }
    }
}
#endif

struct NativeQRScanner: UIViewControllerRepresentable {
    var onEvent: (ConnectionScanEvent) -> Void

    func makeUIViewController(context: Context) -> ConnectionQRScannerController {
        let controller = ConnectionQRScannerController()
        controller.onEvent = onEvent
        return controller
    }

    func updateUIViewController(_ controller: ConnectionQRScannerController, context: Context) {
        controller.onEvent = onEvent
    }

    static func availability(
        status: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video),
        hasCamera: Bool = AVCaptureDevice.default(for: .video) != nil,
        supportsQR: Bool = true
    ) -> ConnectionCameraAvailability {
        ConnectionCameraAvailability.classify(
            authorized: status == .authorized,
            denied: status == .denied,
            restricted: status == .restricted,
            notDetermined: status == .notDetermined,
            hasCamera: hasCamera,
            supportsQR: supportsQR
        )
    }
}

final class ConnectionQRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onEvent: ((ConnectionScanEvent) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "app.michi.ios.qr-session")
    private let preview = AVCaptureVideoPreviewLayer()
    private var scan = ConnectionScanSession()
    private var lifecycle = ConnectionCaptureLifecycle()
    private var finished = false
    private var observers: [NSObjectProtocol] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        preview.session = session
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        navigationItem.title = "Scan Phone access"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(cancel)
        )
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = "connection-scan-cancel"
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.handleBackground() })
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.handleForeground() })
        observers.append(NotificationCenter.default.addObserver(
            forName: .AVCaptureSessionWasInterrupted, object: session, queue: .main
        ) { [weak self] _ in self?.handleInterruption() })
        observers.append(NotificationCenter.default.addObserver(
            forName: .AVCaptureSessionInterruptionEnded, object: session, queue: .main
        ) { [weak self] _ in self?.handleInterruptionEnded() })
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        lifecycle.appear()
        evaluateCamera()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        lifecycle.disappear()
        stopSession()
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        let capture = session
        let queue = sessionQueue
        queue.async { if capture.isRunning { capture.stopRunning() } }
    }

    private func evaluateCamera() {
        guard lifecycle.desiredVisible, lifecycle.phase != .dismissed else { return }
        let availability = NativeQRScanner.availability()
        if availability.shouldRequestAccess {
            _ = lifecycle.applyAvailability(availability)
            AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    guard self.lifecycle.desiredVisible, self.lifecycle.phase != .dismissed else { return }
                    self.evaluateCamera()
                }
            }
            return
        }
        if let failure = lifecycle.applyAvailability(availability) {
            emit(.unavailable(failure))
            return
        }
        if lifecycle.shouldRunSession {
            startSession()
        }
    }

    private func startSession() {
        guard lifecycle.desiredVisible, lifecycle.shouldRunSession else { return }
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.session.beginConfiguration()
            self.session.sessionPreset = .high
            if self.session.inputs.isEmpty {
                guard let device = AVCaptureDevice.default(for: .video),
                      let input = try? AVCaptureDeviceInput(device: device),
                      self.session.canAddInput(input) else {
                    self.session.commitConfiguration()
                    DispatchQueue.main.async { self.emit(.unavailable(.unavailable)) }
                    return
                }
                self.session.addInput(input)
            }
            if self.session.outputs.isEmpty {
                let output = AVCaptureMetadataOutput()
                guard self.session.canAddOutput(output) else {
                    self.session.commitConfiguration()
                    DispatchQueue.main.async { self.emit(.unavailable(.unavailable)) }
                    return
                }
                self.session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: self.sessionQueue)
                guard output.availableMetadataObjectTypes.contains(.qr) else {
                    self.session.removeOutput(output)
                    self.session.commitConfiguration()
                    DispatchQueue.main.async { self.emit(.unavailable(.noQR)) }
                    return
                }
                output.metadataObjectTypes = [.qr]
            } else if let output = self.session.outputs.compactMap({ $0 as? AVCaptureMetadataOutput }).first,
                      !output.availableMetadataObjectTypes.contains(.qr) {
                self.session.commitConfiguration()
                DispatchQueue.main.async { self.emit(.unavailable(.noQR)) }
                return
            }
            self.session.commitConfiguration()
            DispatchQueue.main.async {
                guard self.lifecycle.desiredVisible, self.lifecycle.shouldRunSession else { return }
                self.sessionQueue.async {
                    if !self.session.isRunning { self.session.startRunning() }
                    DispatchQueue.main.async {
                        guard self.lifecycle.desiredVisible, self.lifecycle.shouldRunSession else {
                            self.stopSession()
                            return
                        }
                        if self.session.isRunning {
                            self.lifecycle.markRunning()
                        } else {
                            self.emit(.unavailable(.unavailable))
                        }
                    }
                }
            }
        }
    }

    private func stopSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func handleBackground() {
        lifecycle.enterBackground()
        stopSession()
    }

    private func handleForeground() {
        lifecycle.enterForeground()
        if lifecycle.shouldRunSession { startSession() }
    }

    private func handleInterruption() {
        lifecycle.interrupt()
        stopSession()
    }

    private func handleInterruptionEnded() {
        lifecycle.endInterruption()
        if lifecycle.shouldRunSession { startSession() }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        for object in metadataObjects {
            guard let code = object as? AVMetadataMachineReadableCodeObject,
                  code.type == .qr,
                  let payload = code.stringValue else { continue }
            guard let result = scan.handle(payload) else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.lifecycle.desiredVisible, self.lifecycle.phase != .dismissed else { return }
                switch result {
                case .success(let parsed):
                    self.lifecycle.dismiss()
                    self.stopSession()
                    self.emit(.scanned(parsed))
                case .failure(let failure):
                    self.emit(.rejected(failure))
                }
            }
            return
        }
    }

    @objc private func cancel() {
        lifecycle.dismiss()
        stopSession()
        emit(.cancelled)
    }

    private func emit(_ event: ConnectionScanEvent) {
        if finished { return }
        if case .rejected = event {
            onEvent?(event)
            return
        }
        finished = true
        onEvent?(event)
    }
}

struct ConnectionQRScannerScreen: View {
    var onEvent: (ConnectionScanEvent) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.michiTokens) private var tokens
    @State private var guidance: ConnectionCameraAvailability?

    var body: some View {
        NavigationStack {
            Group {
                if let guidance, !guidance.canStartSession, !guidance.shouldRequestAccess {
                    fallback(guidance)
                } else {
                    scanner
                }
            }
            .navigationTitle("Scan Phone access")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(tokens.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Scan Phone access")
                        .font(MichiFont.rowTitle)
                        .foregroundStyle(tokens.fg)
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        onEvent(.cancelled)
                        dismiss()
                    }
                    .accessibilityIdentifier("connection-scan-cancel")
                }
            }
            #if DEBUG
            .onAppear { injectIfNeeded() }
            #endif
        }
    }

    private var scanner: some View {
        NativeQRScanner { event in
            if case .unavailable(let availability) = event {
                guidance = availability
                return
            }
            onEvent(event)
            if case .rejected = event { return }
            dismiss()
        }
        .ignoresSafeArea()
    }

    private func fallback(_ availability: ConnectionCameraAvailability) -> some View {
        VStack(spacing: 16) {
            Text(availability.message)
                .font(MichiFont.rowSecondary)
                .foregroundStyle(tokens.mid)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button("Enter address instead") {
                onEvent(.cancelled)
                dismiss()
            }
            .font(MichiFont.sans(size: 15, relativeTo: .body, weight: .semibold))
            .foregroundStyle(tokens.accent)
            .accessibilityIdentifier("connection-scan-manual")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(tokens.bg)
    }

    #if DEBUG
    private func injectIfNeeded() {
        guard let event = ConnectionScanInjection.event(from: ProcessInfo.processInfo.arguments) else { return }
        if case .unavailable(let availability) = event {
            guidance = availability
            return
        }
        onEvent(event)
        if case .rejected = event { return }
        dismiss()
    }
    #endif
}
