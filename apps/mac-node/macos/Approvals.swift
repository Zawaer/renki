// Homelab approvals on this Mac, natively: when a Renki chat asks the homelab gateway for something
// that needs you (a command, a root command, a time window), this pops up a small window with the
// gateway's own wording, a password field for root commands, and the system Touch ID prompt.
//
// It talks straight to the approval service on the homelab (https://approvals.internal), never
// through Renki: chats run inside Renki, so nothing Renki can do may approve anything. The proof is
// a P-256 key made in this Mac's Secure Enclave: it never leaves the chip, and signs only after
// Touch ID (or the Mac's password). The service checks that signature. See docs/homelab-gateway.md.
//
// Set up once with the link `sudo homelab-gateway --admin enroll mac` prints on the homelab
// (root only, so no chat can start it): menu > Set Up Homelab Approvals…

import AppKit
import CryptoKit
import LocalAuthentication
import Security

let approvalsBase = URL(string: "https://approvals.internal")!
let approverKeyURL = supportDir.appendingPathComponent("approver-key")
let approverInfoURL = supportDir.appendingPathComponent("approver.json")

struct PendingApproval: Decodable {
    let id: String
    let verb: String
    let summary: String
    let expires: Double
}

private struct PendingList: Decodable { let pending: [PendingApproval] }

private struct RequestView: Decodable {
    let state: String
    let challenge: String?
    let password: Bool?
    let pubkey_pkcs1: String?
}

private struct ServiceError: Decodable { let error: String }

func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/** Trusts the homelab's Caddy root (ca.pem, as the Node agent does) besides the system's roots. */
final class HomelabTrust: NSObject, URLSessionDelegate {
    private let anchors: [SecCertificate] = {
        guard let pem = try? String(contentsOf: caURL, encoding: .utf8) else { return [] }
        let body = pem.components(separatedBy: "\n").filter { !$0.hasPrefix("-----") }.joined()
        guard let der = Data(base64Encoded: body), let cert = SecCertificateCreateWithData(nil, der as CFData) else { return [] }
        return [cert]
    }()

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { return completionHandler(.performDefaultHandling, nil) }
        if !anchors.isEmpty {
            SecTrustSetAnchorCertificates(trust, anchors as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, false)
        }
        var err: CFError?
        if SecTrustEvaluateWithError(trust, &err) {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

enum ApprovalFailure: Error, LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let m) = self { return m }; return nil }
}

/** The approval service's API, as this app uses it. Blocking calls: run them off the main thread. */
final class ApprovalService {
    private let session = URLSession(configuration: .ephemeral, delegate: HomelabTrust(), delegateQueue: nil)

    private func call(_ path: String, body: [String: Any]? = nil, timeout: TimeInterval = 8) throws -> Data {
        var req = URLRequest(url: URL(string: path, relativeTo: approvalsBase)!, timeoutInterval: timeout)
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let done = DispatchSemaphore(value: 0)
        var result: Result<(Data, Int), Error> = .failure(ApprovalFailure.message("no answer"))
        session.dataTask(with: req) { data, resp, err in
            if let err { result = .failure(err) } else { result = .success((data ?? Data(), (resp as? HTTPURLResponse)?.statusCode ?? 0)) }
            done.signal()
        }.resume()
        done.wait()
        let (data, status) = try result.get()
        guard (200..<300).contains(status) else {
            let msg = (try? JSONDecoder().decode(ServiceError.self, from: data))?.error ?? "HTTP \(status)"
            throw ApprovalFailure.message(msg)
        }
        return data
    }

    func pending(atDesk: Bool) throws -> [PendingApproval] {
        try JSONDecoder().decode(PendingList.self, from: call("/v1/approvals/pending" + (atDesk ? "?desktop=1" : ""), timeout: 4)).pending
    }

    fileprivate func view(_ id: String) throws -> RequestView {
        try JSONDecoder().decode(RequestView.self, from: call("/v1/web/\(id)"))
    }

    func deny(_ id: String) throws {
        _ = try call("/v1/web/\(id)", body: ["decision": "deny"])
    }

    /** Touch ID happens inside: signing with the Secure Enclave key asks for it. */
    func approve(_ id: String, password: String?, key: SecureEnclave.P256.Signing.PrivateKey, keyID: String) throws {
        let v = try view(id)
        guard v.state == "pending", let challenge = v.challenge else { throw ApprovalFailure.message("This request has closed.") }
        let message = Data("renki-approval-v1\n\(id)\n\(challenge)\napprove".utf8)
        let signature = try key.signature(for: message).derRepresentation
        var body: [String: Any] = ["decision": "approve", "id": keyID, "challenge": challenge, "signature": b64url(signature)]
        if v.password == true {
            guard let password, !password.isEmpty else { throw ApprovalFailure.message("Type your sudo password first.") }
            guard let pkcs1 = v.pubkey_pkcs1.flatMap({ Data(base64Encoded: $0) }) else { throw ApprovalFailure.message("Approve this one on your phone.") }
            body["password"] = try encryptPassword(password, pkcs1: pkcs1)
        }
        _ = try call("/v1/web/\(id)", body: body)
    }

    /** RSA-OAEP (SHA-256) to the key the waiting gateway made for this one request. */
    private func encryptPassword(_ password: String, pkcs1: Data) throws -> String {
        var err: Unmanaged<CFError>?
        let attrs: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeRSA, kSecAttrKeyClass as String: kSecAttrKeyClassPublic]
        guard let pub = SecKeyCreateWithData(pkcs1 as CFData, attrs as CFDictionary, &err),
              let ct = SecKeyCreateEncryptedData(pub, .rsaEncryptionOAEPSHA256, Data(password.utf8) as CFData, &err) else {
            throw ApprovalFailure.message("Couldn't encrypt the password.")
        }
        return (ct as Data).base64EncodedString()
    }

    /** Adding this Mac: a new Secure Enclave key, proven by signing the service's challenge (Touch ID). */
    func enroll(link: String) throws -> (name: String, id: String, key: Data) {
        guard let code = link.split(separator: "#").last.map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines), !code.isEmpty else {
            throw ApprovalFailure.message("Paste the whole link the enroll command printed.")
        }
        let opts = try JSONSerialization.jsonObject(with: call("/v1/enroll/options", body: ["code": code])) as? [String: Any]
        guard let challenge = opts?["challenge"] as? String else { throw ApprovalFailure.message("Unexpected answer from the homelab.") }
        var err: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &err) else {
            throw ApprovalFailure.message("Couldn't set up the key's Touch ID rule.")
        }
        let ctx = LAContext()
        ctx.localizedReason = "set up homelab approvals on this Mac"
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access, authenticationContext: ctx)
        let sig = try key.signature(for: Data(challenge.utf8)).derRepresentation
        let res = try JSONSerialization.jsonObject(with: call("/v1/enroll/native", body: [
            "code": code, "challenge": challenge, "publicKey": b64url(key.publicKey.derRepresentation), "signature": b64url(sig),
        ])) as? [String: Any]
        guard let id = res?["id"] as? String else { throw ApprovalFailure.message("Unexpected answer from the homelab.") }
        return (res?["name"] as? String ?? "mac", id, key.dataRepresentation)
    }
}

/** The approver identity kept on this Mac: the Secure Enclave key's (encrypted, chip-bound) blob and its id. */
enum ApproverStore {
    static var keyID: String? {
        guard let d = try? Data(contentsOf: approverInfoURL), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return nil }
        return o["id"] as? String
    }

    static var isSetUp: Bool { keyID != nil && FileManager.default.fileExists(atPath: approverKeyURL.path) }

    static func save(id: String, name: String, key: Data) throws {
        try FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        try key.write(to: approverKeyURL, options: .atomic)
        try JSONSerialization.data(withJSONObject: ["id": id, "name": name]).write(to: approverInfoURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: approverKeyURL.path)
    }

    static func forget() {
        try? FileManager.default.removeItem(at: approverKeyURL)
        try? FileManager.default.removeItem(at: approverInfoURL)
    }

    /** The key, with Touch ID's prompt saying what it's for. */
    static func key(reason: String) throws -> SecureEnclave.P256.Signing.PrivateKey {
        let ctx = LAContext()
        ctx.localizedReason = reason
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: Data(contentsOf: approverKeyURL), authenticationContext: ctx)
    }
}

/** Seconds since the last keyboard or mouse input: "at the Mac" for holding back the phone's buzz. */
func secondsSinceInput() -> Double {
    CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
}

/**
 * Watches the approval service and shows each waiting request in its own small window. Polls every
 * few seconds while this Mac is set up; reports "at the Mac" (input in the last two minutes) so the
 * gateway holds the phone's notification back for 30 s.
 */
final class ApprovalWatcher {
    private let service = ApprovalService()
    private var timer: Timer?
    private var windows: [String: ApprovalWindow] = [:]
    /** Requests closed with "Not now": not shown again. */
    private var dismissed = Set<String>()
    private var polling = false
    private(set) var lastError: String?

    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        for w in windows.values { w.close() }
        windows = [:]
    }

    private func poll() {
        guard ApproverStore.isSetUp, !polling else { return }
        polling = true
        let atDesk = secondsSinceInput() < 120
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let result = Result { try self.service.pending(atDesk: atDesk) }
            DispatchQueue.main.async {
                self.polling = false
                switch result {
                case .success(let list): self.lastError = nil; self.show(list)
                case .failure(let e): self.lastError = e.localizedDescription
                }
            }
        }
    }

    private func show(_ list: [PendingApproval]) {
        let open = Set(list.map(\.id))
        for (id, w) in windows where !open.contains(id) {
            w.closedElsewhere()
            windows[id] = nil
        }
        dismissed.formIntersection(open)
        for p in list where windows[p.id] == nil && !dismissed.contains(p.id) {
            let w = ApprovalWindow(request: p, service: service) { [weak self] notNow in
                self?.windows[p.id] = nil
                if notNow { self?.dismissed.insert(p.id) }
            }
            windows[p.id] = w
            w.present(offset: CGFloat(windows.count - 1) * 24)
        }
    }
}

/** One request: the command, a password field for root, Deny / Approve (Touch ID). */
final class ApprovalWindow: NSObject, NSWindowDelegate {
    private let request: PendingApproval
    private let service: ApprovalService
    private let onClose: (_ notNow: Bool) -> Void
    private let window: NSWindow
    private let password = NSSecureTextField()
    private let status = NSTextField(labelWithString: "")
    private let approveButton = NSButton(title: "Approve", target: nil, action: nil)
    private let denyButton = NSButton(title: "Deny", target: nil, action: nil)
    private var tick: Timer?
    private var finished = false
    private let root: Bool

    init(request: PendingApproval, service: ApprovalService, onClose: @escaping (_ notNow: Bool) -> Void) {
        self.request = request
        self.service = service
        self.onClose = onClose
        root = request.verb == "sudo"
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 10), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        build()
    }

    /** "Run on the homelab as zawaer:\n<command>" → the command; anything else as it is. */
    private func split() -> (label: String, body: String, isCommand: Bool) {
        let s = request.summary
        guard s.hasPrefix("Run "), let nl = s.firstIndex(of: "\n") else { return ("A Renki chat asks:", s, false) }
        var body = String(s[s.index(after: nl)...])
        if let r = body.range(of: "\n\nEnter your sudo password to approve.") { body.removeSubrange(r) }
        return (root ? "Runs as root on the homelab" : "Runs on the homelab", body, true)
    }

    private func build() {
        window.title = root ? "Root command on the homelab" : "Approve on the homelab?"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let (labelText, body, isCommand) = split()
        let label = NSTextField(labelWithString: labelText)
        label.font = .systemFont(ofSize: 12, weight: .semibold)
        label.textColor = root ? .systemOrange : .secondaryLabelColor

        let text = NSTextView()
        text.string = body
        text.isEditable = false
        text.isSelectable = true
        text.font = isCommand ? .monospacedSystemFont(ofSize: 12, weight: .regular) : .systemFont(ofSize: 13)
        text.textContainerInset = NSSize(width: 8, height: 8)
        text.drawsBackground = false
        text.isVerticallyResizable = true
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        let scroll = NSScrollView()
        scroll.documentView = text
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false).count + body.count / 70
        scroll.heightAnchor.constraint(equalToConstant: CGFloat(min(220, max(56, lines * 16 + 20)))).isActive = true

        password.placeholderString = "Your sudo password"
        password.isHidden = !root
        password.target = self
        password.action = #selector(approve)

        status.textColor = .secondaryLabelColor
        status.font = .systemFont(ofSize: 11)
        status.lineBreakMode = .byWordWrapping
        status.maximumNumberOfLines = 3

        approveButton.target = self
        approveButton.action = #selector(approve)
        approveButton.keyEquivalent = "\r"
        approveButton.bezelColor = .controlAccentColor
        denyButton.target = self
        denyButton.action = #selector(deny)
        let notNow = NSButton(title: "Not Now", target: self, action: #selector(later))
        notNow.keyEquivalent = "\u{1b}"
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [notNow, spacer, denyButton, approveButton])
        buttons.spacing = 8

        let stack = NSStackView(views: [label, scroll, password, status, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)
        stack.translatesAutoresizingMaskIntoConstraints = false
        for v in [scroll, password, status, buttons] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -36).isActive = true
        }
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            content.widthAnchor.constraint(equalToConstant: 520),
        ])
        window.contentView = content
        updateClock()
    }

    func present(offset: CGFloat) {
        window.center()
        if offset > 0 { window.setFrameOrigin(NSPoint(x: window.frame.minX + offset, y: window.frame.minY - offset)) }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if root { window.makeFirstResponder(password) }
        NSSound(named: "Glass")?.play()
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateClock() }
    }

    private func updateClock() {
        guard !finished else { return }
        let left = max(0, Int(request.expires - Date().timeIntervalSince1970))
        if left == 0 { return finish("Ran out of time; it was denied.", after: 2) }
        status.stringValue = "A Renki chat asked for this. \(left / 60):\(String(format: "%02d", left % 60)) left, then it is denied."
    }

    private func setBusy(_ busy: Bool, _ text: String? = nil) {
        approveButton.isEnabled = !busy
        denyButton.isEnabled = !busy
        password.isEnabled = !busy
        if let text { status.stringValue = text }
    }

    @objc private func approve() {
        guard !finished else { return }
        if root && password.stringValue.isEmpty {
            status.stringValue = "Type your sudo password first."
            return
        }
        guard let keyID = ApproverStore.keyID else { return finish("This Mac isn't set up to approve anymore.", after: 3) }
        let pw = root ? password.stringValue : nil
        setBusy(true, "Waiting for Touch ID…")
        let id = request.id, svc = service
        let reason = root ? "approve a root command on the homelab" : "approve a command on the homelab"
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Result { try svc.approve(id, password: pw, key: ApproverStore.key(reason: reason), keyID: keyID) }
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success: self.password.stringValue = ""; self.finish("Approved.", after: 0.7)
                case .failure(let e):
                    let cancelled = (e as NSError).code == LAError.userCancel.rawValue || (e as NSError).code == -128
                    self.setBusy(false, cancelled ? "Touch ID was cancelled. Try again." : e.localizedDescription)
                }
            }
        }
    }

    @objc private func deny() {
        guard !finished else { return }
        setBusy(true, "Denying…")
        let id = request.id, svc = service
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Result { try svc.deny(id) }
            DispatchQueue.main.async {
                switch result {
                case .success: self?.finish("Denied.", after: 0.7)
                case .failure(let e): self?.setBusy(false, e.localizedDescription)
                }
            }
        }
    }

    @objc private func later() {
        finished = true
        tick?.invalidate()
        window.close()
        onClose(true)
    }

    /** Answered on another device, or gone: just go. */
    func closedElsewhere() {
        guard !finished else { return }
        finish("Answered elsewhere.", after: 0.8, notify: false)
    }

    func close() {
        finished = true
        tick?.invalidate()
        window.close()
    }

    private func finish(_ text: String, after: TimeInterval, notify: Bool = true) {
        finished = true
        tick?.invalidate()
        password.stringValue = ""
        setBusy(true, text)
        DispatchQueue.main.asyncAfter(deadline: .now() + after) { [weak self] in
            self?.window.close()
            if notify { self?.onClose(false) }
        }
    }

    func windowWillClose(_ notification: Notification) {
        if !finished {
            finished = true
            tick?.invalidate()
            onClose(true)
        }
    }
}

/** Menu > Set Up Homelab Approvals…: paste the enroll link, then Touch ID once. */
func runApprovalSetup(_ done: @escaping (String) -> Void) {
    let alert = NSAlert()
    alert.messageText = "Approve homelab requests on this Mac"
    alert.informativeText = "On the homelab, run:\n\nsudo homelab-gateway --admin enroll mac\n\nand paste the link it prints here. You'll confirm with Touch ID once."
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
    field.placeholderString = "https://approvals.internal/enroll#…"
    alert.accessoryView = field
    alert.addButton(withTitle: "Set Up")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    alert.window.initialFirstResponder = field
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let link = field.stringValue
    DispatchQueue.global(qos: .userInitiated).async {
        let result = Result { try ApprovalService().enroll(link: link) }
        DispatchQueue.main.async {
            switch result {
            case .success(let r):
                do {
                    try ApproverStore.save(id: r.id, name: r.name, key: r.key)
                    done("This Mac now approves homelab requests with Touch ID.")
                } catch {
                    done("Set up on the homelab, but couldn't save the key here: \(error.localizedDescription)")
                }
            case .failure(let e):
                done("Couldn't set up approvals: \(e.localizedDescription)")
            }
        }
    }
}
