# Michi for iOS

Native SwiftUI/UIKit client for a running Michi backend. Requires iOS 17 or later. It does not start or wake a remote computer.

## Connect

On the computer, open Michi and enable **Settings → Connections → Phone access**. Sign in to Tailscale on both devices using the same account and complete any requested Tailscale HTTPS setup. Keep the computer awake and its Michi process running.

In the iOS app, scan the computer's Phone access QR or paste its HTTPS address. Confirm the destination before connecting. QR codes contain an address, not a bearer token. A saved computer can be selected again; automatic reconnection is optional and does not replay writes. When camera access is unavailable, use manual entry.

Windows hosting verifies the local Tailscale service peer before accepting its stamped user identity. If the platform cannot establish that trust, hosting fails closed. Windows background/tray mode and login startup are separate opt-in desktop preferences. macOS uses its existing optional background service.

The client does not import browser cookies or browser sign-in sessions. A separately configured direct HTTPS server can use its own bearer credential; credentials are stored in Keychain and scoped to the saved destination. Do not put credentials in URLs or QR codes. Ordinary LAN HTTP URLs are not supported.

## Build and test

Open `Michi.xcodeproj`, select the `Michi` scheme and an iPhone simulator. The project uses a local Swift package and SwiftMath 1.7.3 from its public repository. Device builds require a signing team and provisioning available to the builder; choose your own team when building a personal copy. No signing certificate or private key is included.

Run core and app-model regression tests from this directory:

```sh
swift test
```

The Xcode scheme also includes app and UI test targets. Simulator tests do not verify physical camera scanning, Windows service identity queries, system login startup, Tailscale account/network behavior or real-device local-network permissions. Validate those on an actual Windows computer and iPhone before relying on them.

Production app code is in `Sources/MichiApp`; transport and parsers are in `Sources/MichiCore`. `Sources/MichiApp/Design` contains the app's native design system. DEBUG preview fixtures are fictional and are not evidence of a live backend connection.

## Third-party notices

Bundled Geist fonts use the SIL Open Font License in `Sources/MichiApp/Resources/OFL-Geist.txt`. SwiftMath and math font notices are in `Sources/MichiApp/Resources/SwiftMath-Notices.txt`.
