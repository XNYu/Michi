# Connect an iPhone to desktop Michi

Michi for iOS connects to a running desktop backend. It does not wake or remotely start the computer. Keep the computer awake, with Michi and Tailscale running.

1. Install Tailscale on both devices and sign in with the same account.
2. On the computer, open **Settings → Connections → Phone access**. Enable access and finish any HTTPS setup requested by Tailscale. Wait for Michi to show a connected HTTPS address and QR code.
3. In the iOS app, choose **Scan QR code**, scan that code, check the destination, and confirm. Manual HTTPS address entry is available when the camera cannot be used. Scanning with the system Camera app opens the web client instead.
4. After connecting, the saved computer can be selected again. Enable **Reconnect on launch** for that computer if desired. Disconnecting or removing it suppresses automatic reconnect; connecting never resends a chat message.

The QR contains only the HTTPS address. It contains neither a bearer credential nor an invitation granting access to another account. Tailscale permissions, the signed-in identity, and Michi's owner check still apply. Phone access uses private Serve, not public Funnel.

## Windows lifetime

In an installed Windows app, **Settings → Background** offers two optional settings:

- **Keep Michi in the system tray** keeps the app and its backend running after the last window closes. Use the tray's **Show Michi** or **Quit** commands.
- **Open Michi when I sign in** registers login startup only after an explicit setting change. Hidden startup requires a working tray; otherwise the window opens visibly. Disabling startup in Windows Settings is respected on subsequent launches.

Without these settings, closing the app ends the app-owned backend. They do not keep a computer awake, run before login, or install a Windows service. macOS retains its separate optional background service.

## Connection requirements and errors

Windows Phone access uses a loopback ingress that verifies its TCP peer against the running Tailscale Windows service before parsing requests. A per-run Serve path segment and the verified user header are also required. The normal desktop API is never exposed as an unauthenticated phone endpoint. If Windows cannot provide the required connection/service information, hosting stays unavailable; there is no header-only fallback.

Changing accounts, disabling Phone access, a failed trust check, or a conflicting route to the private ingress revokes existing phone streams. Fix the reported condition and explicitly retry when appropriate. Do not add a raw TCP forward or enable Funnel to work around an error.

A separately configured direct HTTPS server can use its own bearer credential. The iOS client stores that credential in Keychain for the saved destination and sends it on the initial health check as well as later authenticated requests. It does not transfer browser cookies or follow cross-origin authentication redirects. Ordinary LAN HTTP addresses are unsupported.

## Validation limits

Automated tests cover address validation, cancellation, credential isolation, Windows connection-proof decisions, request and stream rejection, and tray/startup behavior through injected adapters. macOS simulator and mock tests do not establish real Windows or iPhone compatibility.

Before relying on Windows-to-iPhone access, test on an installed Windows build and physical iPhone: standard-user service verification, actual QR scanning and camera denial, Tailscale HTTPS, a full streaming chat and reconnect, tray restoration, explicit quit, logout/login, startup disabled in Windows Settings, and loss/change of the Tailscale account. Windows verification must fail closed if the service cannot be identified.

See [the iOS build instructions](../ios/README.md) for local iOS development.
