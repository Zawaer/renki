// Renki Mac: a switch for lending this Mac (its adb, the phone on it, and build
// jobs) to the Renki daemon. It runs the Node agent (renki-mac-node.mjs,
// bundled in Resources) while "Lend this Mac" is on and stops it when it's off,
// so the switch really is the connection. Lives in the menu bar, which can be
// hidden (Cmd-drag it out, or the window's checkbox); opening the app again,
// from Raycast or Finder, shows a small window with the same controls.
// Built by build-app.sh; no Xcode project.

import AppKit
import ServiceManagement

let supportDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Renki")
let configURL = supportDir.appendingPathComponent("mac-node.json")
let caURL = supportDir.appendingPathComponent("ca.pem")
let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Renki/mac-node.log")

/**
 * Renki's mark (assets-src/mark.svg): one and a half turns of a spiral, radii
 * 18/28/38 on a 100-unit grid, 13 wide with round ends. Drawn here rather than
 * shipped as a picture, so the menu bar icon and the app icon come from one
 * place. `rect` receives the mark's ink, centred (its ink is x 15.5...94.5,
 * y 5.5...94.5 in SVG terms, so not the viewBox's centre).
 */
func renkiMarkPath(in rect: NSRect) -> NSBezierPath {
    let scale = min(rect.width / 79, rect.height / 89)
    let ox = rect.midX - 55 * scale, oy = rect.midY - 50 * scale
    let p = NSBezierPath()
    func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: ox + x * scale, y: oy + (100 - y) * scale) }
    p.move(to: pt(50, 32))
    p.appendArc(withCenter: pt(50, 50), radius: 18 * scale, startAngle: 90, endAngle: -90, clockwise: true)
    p.appendArc(withCenter: pt(50, 40), radius: 28 * scale, startAngle: 270, endAngle: 90, clockwise: true)
    p.appendArc(withCenter: pt(50, 50), radius: 38 * scale, startAngle: 90, endAngle: -90, clockwise: true)
    p.lineWidth = 13 * scale
    p.lineCapStyle = .round
    return p
}

/** The menu bar icon: the mark as a template image, with a dot while the phone or a build is in use. */
func menuBarImage(busy: Bool) -> NSImage {
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { r in
        NSColor.black.setStroke()
        renkiMarkPath(in: r.insetBy(dx: 1.5, dy: 1)).stroke()
        if busy {
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: r.maxX - 5, y: r.minY, width: 5, height: 5)).fill()
        }
        return true
    }
    img.isTemplate = true
    return img
}

/** The app icon at `px` pixels: the amber tile of docs/logo.svg on the macOS icon grid. */
func appIconPNG(px: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px)
    let tile = NSRect(x: s * 100 / 1024, y: s * 100 / 1024, width: s * 824 / 1024, height: s * 824 / 1024)
    NSColor(srgbRed: 0xec / 255, green: 0x9d / 255, blue: 0x53 / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: tile, xRadius: tile.width * 0.2237, yRadius: tile.width * 0.2237).fill()
    // logo.svg's ink box: 272.7 x 307.2 of a 512 tile.
    let ink = NSRect(x: 0, y: 0, width: tile.width * 272.7 / 512, height: tile.height * 307.2 / 512)
    NSColor(srgbRed: 0x2f / 255, green: 0x10 / 255, blue: 0, alpha: 1).setStroke()
    renkiMarkPath(in: ink.offsetBy(dx: tile.midX - ink.width / 2, dy: tile.midY - ink.height / 2)).stroke()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

enum AgentState {
    case off, connecting(String), connected(String), offline(String), error(String)
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
    private var window: NSWindow?
    private var visibilityObservation: NSKeyValueObservation?
    private let statusLabel = NSTextField(labelWithString: "")
    private let lastLabel = NSTextField(labelWithString: "")
    private let lendBox = NSButton(checkboxWithTitle: "Lend this Mac to Renki", target: nil, action: nil)
    private let menuBarBox = NSButton(checkboxWithTitle: "Show in menu bar", target: nil, action: nil)
    private let loginBox = NSButton(checkboxWithTitle: "Open at login", target: nil, action: nil)
    private var process: Process?
    private var state: AgentState = .off
    private var activeCalls = 0
    private var lastCall: (verb: String, ok: Bool, at: Date)?
    private var lastStderr = ""
    private var restartWork: DispatchWorkItem?
    private var stdoutBuffer = Data()

    private var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: "lending") }
        set { UserDefaults.standard.set(newValue, forKey: "lending") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        menu.delegate = self
        item.menu = menu
        // Cmd-drag takes it out of the menu bar; the window's checkbox brings it back.
        item.autosaveName = "RenkiMac"
        item.behavior = .removalAllowed
        visibilityObservation = item.observe(\.isVisible) { [weak self] _, _ in
            DispatchQueue.main.async { self?.refreshWindow() }
        }
        if enabled { start() }
        render()
        // Hidden from the menu bar: opening the app is the only way in, so show the window.
        if !item.isVisible { showWindow() }
    }

    /** Opened again (Raycast, Finder, Spotlight) while running: show the window. */
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        stop()
    }

    // MARK: agent process

    private func nodePath() -> String? {
        let candidates = [Bundle.main.object(forInfoDictionaryKey: "RenkiNodePath") as? String,
                          "/opt/homebrew/bin/node", "/usr/local/bin/node"].compactMap { $0 }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private func start() {
        restartWork?.cancel()
        guard process == nil else { return }
        guard FileManager.default.fileExists(atPath: configURL.path) else {
            state = .error("Not set up yet. Run apps/mac-node/macos/setup.sh.")
            return render()
        }
        guard let node = nodePath(), let script = Bundle.main.path(forResource: "renki-mac-node", ofType: "mjs") else {
            state = .error("Node.js or the agent script is missing.")
            return render()
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        if FileManager.default.fileExists(atPath: caURL.path) { env["NODE_EXTRA_CA_CERTS"] = caURL.path }
        p.environment = env

        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            DispatchQueue.main.async { self?.consume(stdout: data) }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            Self.appendLog(data)
            if let s = String(data: data, encoding: .utf8) {
                DispatchQueue.main.async { self?.lastStderr = s.trimmingCharacters(in: .whitespacesAndNewlines) }
            }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.exited(proc) }
        }
        do {
            try p.run()
            process = p
            state = .connecting("Starting…")
        } catch {
            state = .error("Couldn't start the agent: \(error.localizedDescription)")
        }
        render()
    }

    private func stop() {
        restartWork?.cancel()
        guard let p = process else { return }
        process = nil
        p.terminationHandler = nil
        p.terminate()
        activeCalls = 0
        state = .off
        render()
    }

    private func exited(_ p: Process) {
        guard process === p else { return }
        process = nil
        activeCalls = 0
        let reason = lastStderr.split(separator: "\n").last.map(String.init) ?? "exit \(p.terminationStatus)"
        state = .error("Agent stopped: \(reason)")
        render()
        // Still switched on: try again shortly (a config fix, node upgrade…).
        if enabled {
            let work = DispatchWorkItem { [weak self] in self?.start() }
            restartWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
        }
    }

    private func consume(stdout data: Data) {
        stdoutBuffer.append(data)
        while let nl = stdoutBuffer.firstIndex(of: 0x0A) {
            let line = stdoutBuffer.subdata(in: stdoutBuffer.startIndex..<nl)
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...nl)
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if let s = obj["state"] as? String {
                let detail = obj["detail"] as? String ?? ""
                switch s {
                case "connected": state = .connected(detail)
                case "connecting": state = .connecting(detail)
                case "offline": state = .offline(detail)
                default: state = .error(detail)
                }
            } else if let verb = obj["call"] as? String {
                if obj["phase"] as? String == "start" {
                    activeCalls += 1
                } else {
                    activeCalls = max(0, activeCalls - 1)
                    lastCall = (verb, obj["ok"] as? Bool ?? false, Date())
                }
            }
        }
        render()
    }

    private static func appendLog(_ data: Data) {
        if let h = try? FileHandle(forWritingTo: logURL) {
            h.seekToEndOfFile()
            h.write(data)
            try? h.close()
        } else {
            try? data.write(to: logURL)
        }
    }

    // MARK: UI

    private func render() {
        let tooltip: String
        switch state {
        case .off: tooltip = "Renki: not lending this Mac"
        case .connecting: tooltip = "Renki: connecting…"
        case .connected: tooltip = activeCalls > 0 ? "Renki is using this Mac" : "Renki: lending this Mac"
        case .offline: tooltip = "Renki: can't reach the daemon"
        case .error: tooltip = "Renki: needs attention"
        }
        item.button?.image = menuBarImage(busy: activeCalls > 0)
        item.button?.toolTip = tooltip
        // Dim unless it's actually lending, so "on but not working" doesn't look like "on".
        if case .connected = state { item.button?.appearsDisabled = false } else { item.button?.appearsDisabled = true }
        refreshWindow()
    }

    private func statusLine() -> String {
        switch state {
        case .off: return "Off: Renki can't reach this Mac"
        case .connecting(let d): return "Connecting… \(d)"
        case .connected(let d): return activeCalls > 0 ? "In use now (\(d))" : "Lending: \(d)"
        case .offline(let d): return "Offline: \(d)"
        case .error(let d): return d
        }
    }

    private func lastLine() -> String {
        guard let c = lastCall else { return "" }
        let ago = RelativeDateTimeFormatter().localizedString(for: c.at, relativeTo: Date())
        return "Last: \(c.verb)\(c.ok ? "" : " (failed)"), \(ago)"
    }

    // MARK: window

    private func showWindow() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 10), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Renki Mac"
            w.isReleasedWhenClosed = false
            w.delegate = self
            for (box, sel) in [(lendBox, #selector(toggleLending)), (menuBarBox, #selector(toggleMenuBar)), (loginBox, #selector(toggleLogin))] {
                box.target = self
                box.action = sel
            }
            statusLabel.font = .systemFont(ofSize: 13, weight: .medium)
            statusLabel.lineBreakMode = .byTruncatingTail
            lastLabel.textColor = .secondaryLabelColor
            lastLabel.font = .systemFont(ofSize: 11)
            let icon = NSImageView(image: NSImage(data: appIconPNG(px: 128) ?? Data()) ?? NSImage())
            icon.widthAnchor.constraint(equalToConstant: 40).isActive = true
            icon.heightAnchor.constraint(equalToConstant: 40).isActive = true
            let text = NSStackView(views: [statusLabel, lastLabel])
            text.orientation = .vertical
            text.alignment = .leading
            text.spacing = 2
            let header = NSStackView(views: [icon, text])
            header.spacing = 10
            let buttons = NSStackView(views: [
                NSButton(title: "Edit Settings…", target: self, action: #selector(openConfig)),
                NSButton(title: "Show Log", target: self, action: #selector(openLog)),
                NSButton(title: "Quit", target: NSApp, action: #selector(NSApplication.terminate(_:))),
            ])
            buttons.spacing = 8
            let stack = NSStackView(views: [header, lendBox, menuBarBox, loginBox, buttons])
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 10
            stack.edgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)
            stack.setCustomSpacing(16, after: header)
            stack.setCustomSpacing(16, after: loginBox)
            stack.translatesAutoresizingMaskIntoConstraints = false
            let content = NSView()
            content.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                stack.topAnchor.constraint(equalTo: content.topAnchor),
                stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
                content.widthAnchor.constraint(equalToConstant: 340),
            ])
            w.contentView = content
            w.center()
            window = w
        }
        refreshWindow()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    private func refreshWindow() {
        guard let w = window else { return }
        statusLabel.stringValue = statusLine()
        lastLabel.stringValue = lastLine()
        lastLabel.isHidden = lastCall == nil
        lendBox.state = enabled ? .on : .off
        menuBarBox.state = item.isVisible ? .on : .off
        loginBox.state = SMAppService.mainApp.status == .enabled ? .on : .off
        w.layoutIfNeeded()
    }

    @objc private func toggleMenuBar() {
        item.isVisible.toggle()
        refreshWindow()
    }

    @objc private func showWindowFromMenu() {
        showWindow()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let line: String
        switch state {
        case .off: line = "Off: Renki can't reach this Mac"
        case .connecting(let d): line = "Connecting… \(d)"
        case .connected(let d): line = activeCalls > 0 ? "Using the phone now (\(d))" : "Lending: \(d)"
        case .offline(let d): line = "Offline: \(d)"
        case .error(let d): line = d
        }
        menu.addItem(disabled(line))
        if let c = lastCall {
            let ago = RelativeDateTimeFormatter().localizedString(for: c.at, relativeTo: Date())
            menu.addItem(disabled("Last: \(c.verb)\(c.ok ? "" : " (failed)"), \(ago)"))
        }
        menu.addItem(.separator())

        menu.addItem(action("Open Window…", #selector(showWindowFromMenu)))
        menu.addItem(.separator())
        let lend = NSMenuItem(title: "Lend this Mac to Renki", action: #selector(toggleLending), keyEquivalent: "l")
        lend.state = enabled ? .on : .off
        lend.target = self
        menu.addItem(lend)
        menu.addItem(.separator())

        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        login.target = self
        menu.addItem(login)
        menu.addItem(action("Edit Settings…", #selector(openConfig)))
        menu.addItem(action("Show Log", #selector(openLog)))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Renki Mac", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    private func action(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: "")
        i.target = self
        return i
    }

    @objc private func toggleLending() {
        enabled.toggle()
        if enabled { start() } else { stop() }
        refreshWindow()
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change Open at Login"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
        refreshWindow()
    }

    @objc private func openConfig() {
        NSWorkspace.shared.open(configURL)
    }

    @objc private func openLog() {
        if !FileManager.default.fileExists(atPath: logURL.path) { try? Data().write(to: logURL) }
        NSWorkspace.shared.open(logURL)
    }
}

// build-app.sh: `RenkiMac --write-iconset <dir>` writes the app icon's PNGs for iconutil.
if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--write-iconset" {
    let dir = URL(fileURLWithPath: CommandLine.arguments[2])
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for pt in [16, 32, 128, 256, 512] {
        for scale in [1, 2] {
            let name = scale == 1 ? "icon_\(pt)x\(pt).png" : "icon_\(pt)x\(pt)@2x.png"
            try? appIconPNG(px: pt * scale)?.write(to: dir.appendingPathComponent(name))
        }
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
