// Renki Mac: a menu bar switch for lending this Mac's adb (and the phone on it)
// to the Renki daemon. It runs the Node agent (renki-mac-node.mjs, bundled in
// Resources) while "Lend this Mac" is on and stops it when it's off, so the
// switch really is the connection. Built by build-app.sh; no Xcode project.

import AppKit
import ServiceManagement

let supportDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Renki")
let configURL = supportDir.appendingPathComponent("mac-node.json")
let caURL = supportDir.appendingPathComponent("ca.pem")
let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Renki/mac-node.log")

enum AgentState {
    case off, connecting(String), connected(String), offline(String), error(String)
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
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
        if enabled { start() }
        render()
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
        let symbol: String
        let tooltip: String
        switch state {
        case .off: symbol = "iphone.slash"; tooltip = "Renki: not lending this Mac"
        case .connecting: symbol = "iphone"; tooltip = "Renki: connecting…"
        case .connected: symbol = activeCalls > 0 ? "iphone.gen3.radiowaves.left.and.right" : "iphone.radiowaves.left.and.right"
            tooltip = activeCalls > 0 ? "Renki is using the phone" : "Renki: lending this Mac"
        case .offline: symbol = "iphone.slash"; tooltip = "Renki: can't reach the daemon"
        case .error: symbol = "exclamationmark.triangle"; tooltip = "Renki: needs attention"
        }
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: tooltip)
        image?.isTemplate = true
        item.button?.image = image
        item.button?.toolTip = tooltip
        // Dim while connecting or offline, so "on but not working" doesn't look like "on".
        switch state {
        case .connecting, .offline: item.button?.appearsDisabled = true
        default: item.button?.appearsDisabled = false
        }
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
    }

    @objc private func openConfig() {
        NSWorkspace.shared.open(configURL)
    }

    @objc private func openLog() {
        if !FileManager.default.fileExists(atPath: logURL.path) { try? Data().write(to: logURL) }
        NSWorkspace.shared.open(logURL)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
