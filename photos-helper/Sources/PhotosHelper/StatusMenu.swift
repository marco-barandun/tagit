import AppKit

/// The helper's only UI once running as a background app: a small menu bar
/// icon, never a window. The previous design (a floating status window that
/// re-appeared and grabbed focus every time state changed — album picked,
/// token adopted, …) was exactly the "disturbing, overlaying the screen"
/// behavior reported. A status item never steals focus and never sits on
/// top of anything; it just waits in the menu bar until clicked.
final class StatusMenuController: NSObject {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private var currentToken = ""
    private let onQuit: () -> Void

    init(onQuit: @escaping () -> Void) {
        self.onQuit = onQuit
        super.init()
        if let button = item.button {
            let image = NSImage(systemSymbolName: "leaf.fill", accessibilityDescription: "tagit Photos Helper")
            image?.isTemplate = true
            button.image = image
        }
        update(mode: "starting…", album: "", token: "", autoPaired: false)
    }

    func update(mode: String, album: String, token: String, autoPaired: Bool) {
        currentToken = token
        let menu = NSMenu()
        menu.addItem(disabledItem("tagit Photos Helper"))
        menu.addItem(.separator())
        menu.addItem(disabledItem("Mode: \(mode)"))
        menu.addItem(disabledItem("Album: \(album.isEmpty ? "none yet — choose one in tagit" : album)"))
        if !autoPaired, !token.isEmpty {
            menu.addItem(.separator())
            let copy = NSMenuItem(title: "Copy Pairing Code", action: #selector(copyToken), keyEquivalent: "")
            copy.target = self
            menu.addItem(copy)
        }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Helper", action: #selector(quitClicked), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        entry.isEnabled = false
        return entry
    }

    @objc private func copyToken() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(currentToken, forType: .string)
    }

    @objc private func quitClicked() { onQuit() }
}
