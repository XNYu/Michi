# Phone access with Tailscale

Open Settings → General → Phone access to use this machine's Michi from your
phone. You can also select a saved remote machine. Chats, agents and files
continue to live on the selected machine.

1. Install [Tailscale](https://tailscale.com/download) on the machine running
   Michi. Michi detects its CLI, including the macOS app. Use **Open Tailscale**
   when the app needs to start. Approve the operating system's VPN permissions.
2. Choose **Connect Tailscale**, then **Continue Tailscale sign-in**. Sign in
   in your browser. Your tailnet administrator may need to approve the device.
3. Choose **Enable phone access**. If requested, choose **Allow Tailscale
   HTTPS** and finish Tailscale's consent page. Michi checks its Serve mapping
   and authenticated HTTPS ingress before displaying the phone link and QR.
4. Install Tailscale on your phone, sign in with the same account, and connect
   its VPN. Scan the QR with your phone camera. Bookmark the URL or add it to
   your home screen. The link stays reusable while phone access is enabled.
5. Keep this computer awake with Michi running. On iPhone, Tailscale's VPN On
   Demand can reconnect automatically. Another active VPN may interrupt it.

Michi uses private **Tailscale Serve**. It does not enable public Funnel.
Only the Tailscale login that owns the host can access this ingress; tagged
hosts are unsupported. On macOS and Linux, a separate Unix socket in an
owner-only directory receives verified identity headers. HTTP and WebSocket
requests retain origin checks, and the backend bearer token stays on the server.
Phone requests cannot enable phone access or publish another machine through a
saved connection.

Windows Tailscale Serve cannot target a Unix socket, so Michi listens on a
separate loopback TCP port. Any local process can connect to such a port, and
Tailscale can also dial loopback for tailnet peers. Michi therefore reads no
request bytes until Windows proves that the connection belongs to the running
`Tailscale` service, or its `tailscaled.exe` child, installed beside the CLI.
Michi checks the exact connection in the TCP table, the service registration,
the parent process and process creation times. Every request must also start
with a random path segment that only Michi's own Serve mapping adds. If any
check fails or Windows does not provide the needed information, Michi refuses
the connection; it never falls back to trusting the header. The phone link
contains only the HTTPS hostname. Another Serve entry that can reach Michi's
ingress stops phone access on every platform. That includes a raw TCP forward,
any loopback spelling, a DNS name on Michi's port, and a Unix socket alias.

Windows isolation between mutually untrusted users on a shared computer is not
yet verified. A local user who can both read the Serve target and make Tailscale
deliver raw traffic to that target could undermine the path-secret boundary.
The configuration audit runs on status polls and cannot exclude a route added
and removed between polls. Do not rely on this implementation for shared-host
isolation until that case has been validated on Windows.

Michi preserves other Serve and Funnel listeners. It chooses a free HTTPS port,
starting with 443, 8443 and 9443. **Turn off** closes Michi's streams and its own
foreground Serve process. It does not reset Serve or disconnect Tailscale.
If another service later claims the port, enabling again may change the URL.

The explicit enabled preference is stored in `<data-dir>/mobile-access.json`
and restored after a restart. A preference without a matching provider stays
off. Losing a verifiable identity or Serve mapping removes the displayed URL
and closes active streams. Changing accounts or making the listener public
stops access and requires enabling it again.

Hosting requires a personal backend with its built Web UI on macOS, Linux or
Windows. Windows hosting needs the official per-machine Tailscale installation
and the built-in Windows PowerShell. Michi does not require administrator rights,
change firewall rules or modify Tailscale's service. Windows hosting has
automated tests with simulated Windows data only. It still needs acceptance on a
real Windows machine. Cloud or session-authenticated deployments cannot host
phone access. Phones can use iOS or Android. Native desktop browser tabs and file
dialogs remain desktop features.

Use `MICHI_TAILSCALE_BIN` to select another installed CLI. On Windows it must
be an absolute local `.exe` path. Without it, Michi uses only
`Program Files\Tailscale\tailscale.exe` and never searches `PATH`. An exported
`MICHI_MOBILE_ACCESS=1` explicitly starts this build's provider on boot. Production
Web UI requests use `/api` on the phone page's own origin; avoid a localhost-only
`VITE_API_URL` when building for phone access.

Automated tests cover setup states, consent, retries, account changes, HTTPS
reachability, owner and origin checks, SSE and WebSocket transport, and the
browser's desktop and narrow-screen setup flow. These checks use CLI fixtures
and mock APIs; a physical-phone connection requires separate acceptance.

References: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve),
[iPhone VPN On Demand](https://tailscale.com/docs/features/client/ios-vpn-on-demand),
[Serve target rules](https://github.com/tailscale/tailscale/blob/main/ipn/serve.go),
[Serve identity headers](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go),
[Windows service process](https://github.com/tailscale/tailscale/blob/main/cmd/tailscaled/tailscaled_windows.go).
