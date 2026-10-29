// Claude IDE for macOS: the IDE in windows of its own, with a Dock icon and
// menus, instead of in a browser.
//
// The IDE is served by claude-ide, the same standalone executable as on other
// systems, which sits next to this program in Contents/MacOS. The app runs it
// with --mac-app, which starts the server (or finds the one already running)
// and prints its address, and shows that address in WebKit. As elsewhere,
// closing the last window or quitting the app leaves the Claude sessions running
// in the server, which quits once they've ended. Quit in the IDE (the power
// button) stops the server, and its windows close.
//
// scripts/build-mac-app.mjs builds the app.

import AppKit
import UserNotifications
import WebKit

let appName = "Claude IDE"
let logFile = "~/Library/Caches/claude-ide/claude-ide.log"
let background = NSColor(srgbRed: 0x1a / 255.0, green: 0x1a / 255.0, blue: 0x1e / 255.0, alpha: 1)

@main
@MainActor
enum Main {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

struct LaunchError: Error {
    let message: String
}

// MARK: - App

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var windows: [IDEWindow] = []
    private var launches: [ServerLaunch] = []
    private var waiting: [(Result<URL, LaunchError>) -> Void] = []
    /// The server's address, while a window is showing it.
    private var address: URL?
    /// What the IDE's pages see as Notification.permission.
    var notificationPermission = "default"

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = makeMainMenu()
        // Set before launching finishes, so the click on a notification that
        // launched the app reaches it.
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        updateNotificationPermission()
        if windows.isEmpty { openWindow() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // Clicking the Dock icon, or opening the app while it's running.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if hasVisibleWindows { return true }
        if let minimized = windows.first(where: { $0.window.isMiniaturized }) {
            minimized.window.deminiaturize(nil)
        } else {
            openWindow()
        }
        return false
    }

    @objc func newWindow(_ sender: Any?) {
        openWindow()
    }

    @objc func openWebsite(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://github.com/goathollow/claude-ide")!)
    }

    func openWindow(session: String? = nil) {
        let previous = windows.last?.window
        let w = IDEWindow(app: self, session: session)
        windows.append(w)
        w.show(after: previous)
        withServer { [weak w] result in
            switch result {
            case .success(let url): w?.load(url)
            case .failure(let error): w?.fail(error.message)
            }
        }
    }

    func windowClosed(_ w: IDEWindow) {
        windows.removeAll { $0 === w }
        if !windows.contains(where: { $0.isShowingIDE }) { address = nil }
    }

    /// Calls back with the server's address, starting the server unless a
    /// window is already showing it.
    private func withServer(_ done: @escaping (Result<URL, LaunchError>) -> Void) {
        if let address, windows.contains(where: { $0.isShowingIDE }) { return done(.success(address)) }
        waiting.append(done)
        if waiting.count > 1 { return }
        let launch = ServerLaunch()
        launches.append(launch)
        launch.onExit = { [weak self, weak launch] in self?.launches.removeAll { $0 === launch } }
        launch.start { [weak self] result in
            guard let self else { return }
            if case .success(let url) = result { self.address = url }
            let callbacks = self.waiting
            self.waiting = []
            for callback in callbacks { callback(result) }
        }
    }

    // MARK: Notifications

    func updateNotificationPermission() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            DispatchQueue.main.async {
                switch status {
                case .authorized, .provisional: self.notificationPermission = "granted"
                case .denied: self.notificationPermission = "denied"
                default: self.notificationPermission = "default"
                }
            }
        }
    }

    func requestNotificationPermission(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { granted, _ in
            DispatchQueue.main.async {
                self.notificationPermission = granted ? "granted" : "denied"
                done(self.notificationPermission)
            }
        }
    }

    // A page asks for notifications only while it's out of sight, so show
    // them even while the app is active.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let windowID = info["window"] as? String
        let id = info["id"] as? String ?? ""
        let tag = info["tag"] as? String ?? ""
        DispatchQueue.main.async { self.notificationClicked(windowID: windowID, id: id, tag: tag) }
        completionHandler()
    }

    private func notificationClicked(windowID: String?, id: String, tag: String) {
        NSApp.activate(ignoringOtherApps: true)
        if let w = windows.first(where: { $0.id == windowID }) {
            w.bringForward()
            w.notificationClicked(id)
            return
        }
        // The window that showed it has closed. The IDE tags its notifications
        // with the session they're about, so open that session.
        let session = tag.range(of: #"^[\w-]+$"#, options: .regularExpression) != nil ? tag : nil
        if let w = windows.first {
            w.bringForward()
            if let session { w.open(session: session) }
        } else {
            openWindow(session: session)
        }
    }

    // MARK: Menus

    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            return item
        }
        @discardableResult
        func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            for item in items { menu.addItem(item) }
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = menu
            main.addItem(top)
            return menu
        }

        menu(appName, [
            item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("File", [
            item("New Window", #selector(AppDelegate.newWindow(_:)), "n"),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        // WebKit only gets the clipboard and undo shortcuts through these.
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        let zoomIn = item("Zoom In", #selector(IDEWindow.zoomIn(_:)), "+")
        // Also on Command-=, the same key without Shift.
        let zoomInUnshifted = item("Zoom In", #selector(IDEWindow.zoomIn(_:)), "=")
        zoomInUnshifted.isHidden = true
        zoomInUnshifted.allowsKeyEquivalentWhenHidden = true
        menu("View", [
            item("Reload", #selector(IDEWindow.reloadPage(_:)), "r"),
            .separator(),
            item("Actual Size", #selector(IDEWindow.actualSize(_:)), "0"),
            zoomIn,
            zoomInUnshifted,
            item("Zoom Out", #selector(IDEWindow.zoomOut(_:)), "-"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        NSApp.windowsMenu = menu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        NSApp.helpMenu = menu("Help", [
            item("\(appName) on GitHub", #selector(AppDelegate.openWebsite(_:))),
        ])
        return main
    }
}

// MARK: - Server

/// One run of claude-ide --mac-app, which starts the IDE's server, or finds the
/// one already running, and prints its address.
@MainActor
final class ServerLaunch {
    private let process = Process()
    private var output = ""
    private var errors = ""
    private var completion: ((Result<URL, LaunchError>) -> Void)?
    var onExit: (() -> Void)?

    func start(_ completion: @escaping (Result<URL, LaunchError>) -> Void) {
        self.completion = completion
        guard let exe = Bundle.main.url(forAuxiliaryExecutable: "claude-ide") else {
            return finish(.failure(LaunchError(message: "This copy of \(appName) is missing a file. Install it again.")))
        }
        process.executableURL = exe
        process.arguments = ["--mac-app"]
        process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        process.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        process.standardOutput = out
        process.standardError = err
        // Read for as long as the server runs, so it never waits on a full pipe.
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async { self?.received(data, isError: false) }
        }
        err.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            DispatchQueue.main.async { self?.received(data, isError: true) }
        }
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            // Let the last of its output arrive first.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self?.exited(status) }
        }
        do {
            try process.run()
        } catch {
            return finish(.failure(LaunchError(message: "Couldn't run claude-ide: \(error.localizedDescription)")))
        }
        // The first run of a new version unpacks it, which takes a few seconds.
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            self?.finish(.failure(LaunchError(message: "\(appName) took too long to start.")))
        }
    }

    private func received(_ data: Data, isError: Bool) {
        let text = String(decoding: data, as: UTF8.self)
        if isError {
            errors = String((errors + text).suffix(4000))
        } else if completion != nil {
            output += text
            // "Claude IDE running at http://localhost:4477" once it's listening,
            // or "Claude IDE is already running at ..." when another copy is.
            if let range = output.range(of: #"https?://\S+(?=\r?\n)"#, options: .regularExpression),
               let url = URL(string: String(output[range])) {
                finish(.success(url))
            }
        }
    }

    private func exited(_ status: Int32) {
        // Node ends an uncaught error's report with its version, so prefer the
        // line naming the error.
        let lines = errors.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let reason = lines.first { $0.range(of: #"^\w*Error\b"#, options: .regularExpression) != nil }
            ?? lines.last { !$0.hasPrefix("Node.js v") }
        finish(.failure(LaunchError(message: reason ?? "claude-ide stopped with exit status \(status).")))
        onExit?()
    }

    private func finish(_ result: Result<URL, LaunchError>) {
        guard let completion else { return }
        self.completion = nil
        output = ""
        completion(result)
    }
}

// MARK: - Windows

@MainActor
final class IDEWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let id = UUID().uuidString
    let window: NSWindow
    private let webView: WKWebView
    private weak var app: AppDelegate?
    /// The server's address, once this window has loaded the IDE from it.
    private var address: URL?
    /// The session to open when the IDE loads.
    private var session: String?
    private var titleObservation: NSKeyValueObservation?

    var isShowingIDE: Bool { address != nil }

    private static let zoomLevels: [CGFloat] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

    init(app: AppDelegate, session: String?) {
        self.app = app
        self.session = session
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // A window that's out of sight keeps getting live updates, and can
        // notify, as a background browser tab would.
        if #available(macOS 14.0, *) { config.preferences.inactiveSchedulingPolicy = .throttle }
        webView = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.underPageBackgroundColor = background
        // Lets Safari's Web Inspector (Develop menu) inspect the IDE.
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        let zoom = UserDefaults.standard.double(forKey: "zoom")
        webView.pageZoom = zoom > 0 ? CGFloat(zoom) : 1
        webView.configuration.userContentController.add(self, name: "claudeIde")
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.updateTitle() }
        }

        window.title = appName
        window.contentView = webView
        window.backgroundColor = background
        // Dark like the IDE's default theme, until the IDE says which it uses.
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 640, height: 400)
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.tabbingMode = .disallowed
        window.delegate = self

        webView.loadHTMLString(Self.page("Starting \(appName)…"), baseURL: nil)
    }

    func show(after previous: NSWindow?) {
        if let previous {
            window.setFrame(previous.frame.offsetBy(dx: 26, dy: -26), display: false)
        } else {
            window.center()
            if window.setFrameAutosaveName("IDE") { window.setFrameUsingName("IDE") }
        }
        bringForward()
    }

    func bringForward() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func load(_ url: URL) {
        address = url
        var target = url
        // The IDE opens the session named in its address (main.js).
        if let session, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.fragment = "session=\(session)"
            target = components.url ?? url
        }
        session = nil
        installBridge()
        webView.load(URLRequest(url: target))
    }

    /// Opens a session, reloading the IDE to do it.
    func open(session: String) {
        self.session = session
        if let address { load(address) }
    }

    func fail(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "\(appName) couldn't start"
        alert.informativeText = "\(message)\n\nThere may be more in \(logFile)."
        alert.beginSheetModal(for: window) { [weak self] _ in self?.window.close() }
    }

    private func updateTitle() {
        let title = webView.title ?? ""
        window.title = title.isEmpty ? appName : title
    }

    private func isIDE(_ url: URL) -> Bool {
        guard let address else { return false }
        return url.scheme == address.scheme && url.host == address.host && url.port == address.port
    }

    private static func page(_ text: String) -> String {
        """
        <!doctype html><meta charset="utf-8"><style>
        html { color-scheme: dark; }
        body { margin: 0; height: 100vh; display: grid; place-items: center; background: #1a1a1e; color: #a0a0ac; font: 13px -apple-system, sans-serif; }
        </style><p>\(text)</p>
        """
    }

    // MARK: The page's side

    /// Gives the IDE's pages what a browser would: window.close(), which pages
    /// may otherwise only call on windows they opened, and desktop
    /// notifications, which WebKit leaves to the app. It also reports the IDE's
    /// theme, which the window's title bar follows.
    private func installBridge() {
        let permission = app?.notificationPermission ?? "default"
        let source = """
        (() => {
          const post = message => window.webkit.messageHandlers.claudeIde.postMessage(message);
          window.close = () => post({ close: true });

          let permission = '\(permission)', next = 0;
          const shown = new Map(), requests = new Map();
          class Notification {
            static get permission() { return permission; }
            static requestPermission() {
              const id = ++next;
              return new Promise(resolve => { requests.set(id, resolve); post({ requestPermission: id }); });
            }
            constructor(title, options = {}) {
              this.id = String(++next);
              this.tag = String(options.tag || '');
              this.onclick = null;
              shown.set(this.id, this);
              post({ notify: { id: this.id, title: String(title), body: String(options.body || ''), tag: this.tag } });
            }
            close() {
              shown.delete(this.id);
              post({ closeNotification: this.tag || this.id });
            }
          }
          window.Notification = Notification;
          window.__claudeIde = {
            permission(id, value) { permission = value; requests.get(id)?.(value); requests.delete(id); },
            clicked(id) { const n = shown.get(id); if (n && n.onclick) n.onclick(new Event('click')); },
          };

          // This can run before the page has an <html> element to watch.
          const theme = () => post({ theme: document.documentElement?.dataset.theme || 'dark' });
          new MutationObserver(theme).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme'] });
          theme();
        })();
        """
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = webView.url, isIDE(url),
              let body = message.body as? [String: Any] else { return }
        if body["close"] != nil {
            DispatchQueue.main.async { self.window.close() }
        }
        if let theme = body["theme"] as? String {
            window.appearance = NSAppearance(named: theme == "light" ? .aqua : .darkAqua)
        }
        if let info = body["notify"] as? [String: Any] {
            showNotification(info)
        }
        if let key = body["closeNotification"] as? String {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [key])
        }
        if let request = body["requestPermission"] as? Int {
            app?.requestNotificationPermission { [weak self] value in
                self?.installBridge()
                self?.webView.evaluateJavaScript("window.__claudeIde.permission(\(request), '\(value)')", completionHandler: nil)
            }
        }
    }

    private func showNotification(_ info: [String: Any]) {
        guard app?.notificationPermission == "granted", let id = info["id"] as? String else { return }
        let tag = info["tag"] as? String ?? ""
        let content = UNMutableNotificationContent()
        content.title = info["title"] as? String ?? appName
        content.body = info["body"] as? String ?? ""
        content.userInfo = ["window": self.id, "id": id, "tag": tag]
        // As on the web, a notification replaces the last one with the same tag.
        let request = UNNotificationRequest(identifier: tag.isEmpty ? id : tag, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }

    func notificationClicked(_ id: String) {
        webView.evaluateJavaScript("window.__claudeIde.clicked(\(Self.jsString(id)))", completionHandler: nil)
    }

    private static func jsString(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let array = data.map { String(decoding: $0, as: UTF8.self) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    // MARK: WebKit

    // Links to anything but the IDE open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if navigationAction.targetFrame?.isMainFrame == false || url.scheme == "about" || isIDE(url) {
            return decisionHandler(.allow)
        }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        // Navigations this window cancelled, or replaced with another.
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
        address = nil
        webView.loadHTMLString(Self.page("\(appName) isn't responding. Close this window and open \(appName) again."), baseURL: nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webViewDidClose(_ webView: WKWebView) {
        window.close()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    // MARK: Menu commands

    @objc func reloadPage(_ sender: Any?) {
        webView.reload()
    }

    @objc func zoomIn(_ sender: Any?) {
        setZoom(Self.zoomLevels.first { $0 > webView.pageZoom + 0.001 } ?? webView.pageZoom)
    }

    @objc func zoomOut(_ sender: Any?) {
        setZoom(Self.zoomLevels.last { $0 < webView.pageZoom - 0.001 } ?? webView.pageZoom)
    }

    @objc func actualSize(_ sender: Any?) {
        setZoom(1)
    }

    private func setZoom(_ zoom: CGFloat) {
        webView.pageZoom = zoom
        UserDefaults.standard.set(Double(zoom), forKey: "zoom")
    }

    // MARK: Window

    func windowWillClose(_ notification: Notification) {
        titleObservation = nil
        // Unload the IDE right away, so the server sees the window close.
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "claudeIde")
        webView.loadHTMLString("", baseURL: nil)
        app?.windowClosed(self)
    }
}
