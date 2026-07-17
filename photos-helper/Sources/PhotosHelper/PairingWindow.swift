import SwiftUI
import AppKit

/// The helper's one visible window when launched as a real app (double-click
/// or the tagitphotos:// link from tagit's page) — there's no terminal to
/// print into, so this is where the status (and, for manual launches, the
/// pairing code) lives. Quitting this window is the equivalent of Control-C
/// in terminal mode: it ends the process, and with it, access.
struct PairingView: View {
    let mode: String
    let album: String
    let token: String
    let port: UInt16
    /// True when tagit launched us with a pair secret in the URL — pairing
    /// then happens automatically and no code needs to be shown or copied.
    let autoPaired: Bool
    let onQuit: () -> Void

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("tagit Photos Helper").font(.title2).bold()
            VStack(alignment: .leading, spacing: 2) {
                Text("Mode: \(mode)").font(.callout).foregroundStyle(.secondary)
                Text("Album: \(album)").font(.callout).foregroundStyle(.secondary)
            }
            Divider()
            if autoPaired {
                Text("Launched from tagit — connected automatically, no code needed. Head back to the tagit tab; everything else happens there.")
                    .font(.callout)
            } else {
                Text("Pairing code — paste this into tagit's \u{201c}Connect to Photos\u{201d} dialog (or use its Launch button next time to skip this step):")
                    .font(.callout)
                Text(token)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            HStack {
                if !autoPaired {
                    Button(copied ? "Copied!" : "Copy Code") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(token, forType: .string)
                        copied = true
                    }
                    .keyboardShortcut("c", modifiers: .command)
                }
                Spacer()
                Button("Quit Helper", role: .destructive, action: onQuit)
                    .keyboardShortcut("q", modifiers: .command)
            }
            Text("Listening on http://127.0.0.1:\(port) — only reachable from this Mac. Quitting (or an hour of inactivity) ends access immediately.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 420)
    }
}

final class PairingWindowController: NSWindowController, NSWindowDelegate {
    private let onQuit: () -> Void
    private var quietClose = false

    init(mode: String, album: String, token: String, port: UInt16, autoPaired: Bool, onQuit: @escaping () -> Void) {
        self.onQuit = onQuit
        let view = PairingView(mode: mode, album: album, token: token, port: port, autoPaired: autoPaired, onQuit: onQuit)
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hosting)
        window.title = "tagit Photos Helper"
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("unavailable") }

    /// Close without quitting the app — used when replacing this window with
    /// an updated one (album chosen, token adopted), where windowWillClose
    /// firing onQuit would wrongly kill the helper mid-handoff.
    func closeQuietly() {
        quietClose = true
        close()
    }

    // Closing the window (the red button) is as final as Quit — there is no
    // "hidden but still running" state for this helper.
    func windowWillClose(_ notification: Notification) {
        if !quietClose { onQuit() }
    }
}
