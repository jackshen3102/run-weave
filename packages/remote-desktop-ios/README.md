# Runweave Remote Desktop iOS

Independent iOS 15 / Swift 5 package. `RunweaveRemoteDesktop` depends only on the sibling `RunweaveRemoteDesktopProtocol` and Apple frameworks. It does not import Runweave business controllers, Backend or Electron.

The host owns navigation, analytics masking, target metadata and presentation lifetime:

```swift
let credentials = RemoteCredentialStore()
let paired = try await RemotePairingClient(credentials: credentials).pair(
    target: configuredTarget, code: macLocalCode, deviceName: "My iPhone"
)
// Save only paired metadata. The returned ID is the actual Mac identity.
let session = RemoteDesktopSession(credentials: credentials)
session.connect(target: paired, context: RemoteSessionContext(
    targetID: paired.id, generation: generation, presentationID: UUID()
))
RemoteDesktopView(session: session, maskTextEntry: { field in
    // Apply the host analytics SDK's masking modifier to this exact input field.
    field
})
// On hide, close, background, logout or target change:
session.setPresentationActive(false)
```

`RemoteDesktopView` does not start or reconnect on appearance, and does not dismiss host navigation. Returning from the background requires explicit `connect` with a fresh presentation ID. Reconnect attempts while the presentation remains active use a new wire session and decoder; input is never replayed. Dismantling the native surface also stops the session. `stop` is idempotent, synchronously queues best-effort input release and stops network, decoder and retry work; the Host's heartbeat lease remains the final release guarantee.

Before pairing, explicitly compare `certificateFingerprint` with the certificate SHA256 displayed locally on the Mac. The endpoint may change but the pin and Host identity do not follow an IP address. First pairing requires the Mac's short-lived code and local approval. `credentialsReference` refers to this package's separate, non-synchronizing device-only Keychain service. `RemoteCredentialStore.forget(target:)` removes this device's local credential; remove the paired device on the Mac to revoke its authorization at the Host. No token belongs in UserDefaults, metadata, URLs or diagnostics.

The native surface owns a dedicated UIView whose backing layer is `AVSampleBufferDisplayLayer`; the outer view retains gestures and the cursor. The video UIView uses the same aspect-fit/zoom `videoRect` as input mapping. Attachment, enqueue and clearing happen on MainActor. iOS 17+ routes queue readiness, enqueue, flush, status, error and flush requirement exclusively through `sampleBufferRenderer`; iOS 15/16 retains the direct layer API. Display readiness and protection remain properties of the backing display layer. Each connection owns a decoder and every callback checks target, generation, presentation and attempt identity. H.264 Annex-B input is decoded through VideoToolbox; compressed dependency gaps, format changes or overload discard the old chain and request an SPS/PPS IDR. At most three decode/delivery operations are pending; decoded presentation frames may be dropped when the display layer is not ready. Enqueue alone never enables control: iOS 17.4+ waits for `isReadyForDisplay` and its official change notification, with a nonempty surface attached to a window and unobscured output. iOS 15–17.3 has no first-image API; the compatibility path waits asynchronously for the renderer's actual `.rendering` status under the same surface checks. Statistics label that older signal explicitly. Neither API measures physical pixel scanout. Renderer failure releases inputs, clears the failed image and requests recovery.

The display ingress watchdog detects three seconds of continuous refusal only while valid decoded frames continue to arrive with gaps of at most one second and the renderer still refuses data. An idle or static desktop is not declared failed merely because no frames arrive. A stall immediately disables control, clears queued input, releases held input, resets the decoder epoch and removes the old image. Each explicit presentation ID permits at most one recovery, with a monotonic five-second deadline. Flush completion checks connection, presentation, layer owner and display epoch; any input send already in progress drains and is followed by another release before new input is permitted. Recovery requires a fresh decoded submission and the same actual readiness/visibility gate. Timeout, a second sustained stall or a network interruption during recovery stops with an explicit failure instead of automatically retrying indefinitely. The legacy iOS 15/16 clearing API has no completion notification; its compatibility callback runs after the clearing call returns, and still requires a fresh submission and rendering state. These checks establish ingress progress, not physical pixel scanout.

For an explicitly authorized negative-case check, a **Debug simulator** launch may include `--remote-renderer-legacy-probe`. The flag is read only inside `#if DEBUG && targetEnvironment(simulator)` and defaults to false; Release builds and physical devices cannot enable it. It selects the legacy queue API consistently for readiness, enqueue, flush, status and errors. An orange **模拟器负例验证 · Legacy 显示入口** banner and the **连接统计 → 显示入口 API** row identify the probe. Capture protection remains enabled. This probe is not the default or a production rendering route.

Touch controls support relative trackpad and direct click, one-finger tap, double tap, two-finger right click, stationary long-press drag, two-finger remote scroll, pinch zoom (1–3×) and three-finger viewport pan. Direct gestures reject black bars; drag beyond the content clamps to its edge and remains releasable. The Host's display ID, geometry revision, logical bounds, encoded pixel size and content rectangle determine the mapping. Rotation resets zoom and uses the current viewport dimensions. Relative cursor edge-follow keeps all corners reachable when zoomed.

The keyboard panel submits complete system-composed text, including Chinese and emoji, with **发送**; it never converts text through a QWERTY table or the clipboard. Esc, Tab, arrows, Return, Backspace and modifier combinations are separate key down/up events. Modifier buttons apply to the next explicit shortcut; A/C/V/X/Z buttons provide common positional shortcuts. Hardware special keys and shortcuts use HID-to-Mac virtual keys, while printable characters use iOS-resolved text. Use the text field for composed IME text; positional shortcuts remain layout-dependent. Opening the text field releases any remote held keys and yields hardware focus to iOS.

The video layer enables `preventsCapture`; the host must additionally mask the entire remote presentation, text entry and pairing UI in its analytics SDK. Inject `maskTextEntry` to apply that SDK's modifier to the actual text field, without adding an analytics dependency to this package. This flag does not establish that a third-party analytics replay is correctly masked. No frame or input text is included in the statistics.

Statistics distinguish received, decoded and display-layer-submitted frames, drops, recoveries, VideoToolbox decode callback duration, and local ping/pong network RTT. Display diagnostics expose the selected ingress API, data acceptance, ingress recovery state/count, actual ready/status, last error domain/code only, flush requirement, window attachment, layer/viewport sizes, protection flags, decoded pixel format and IOSurface backing. At most once per second, a fixed 16×16 grid samples the decoded 420v Y plane and retains only its minimum, mean and maximum. These are raw 8-bit values (nominal video luma range 16–235), not normalized brightness or a complete-image measurement. No individual samples, images or media payloads are stored or sent to logs/analytics; diagnostics contain no input, identity or credentials. Decode and RTT percentiles retain the latest 256 samples and expose total/window counts. Published statistics refresh at most twice per second. They do not measure input-to-screen latency. `hardwareDecoder` reads the actual VideoToolbox property on iOS 17+; it is `nil` (unknown) on iOS 15/16, where that public property is unavailable.

The **连接统计** button opens a collapsed-by-default, scrollable inline panel with those actual counters, queue depth/capacity/maximum, hardware result, sample counts and p50/p95 values. Video remains visible while the panel is open. Text entry and the statistics panel are mutually exclusive to preserve the video viewport on a phone.

Build without booting or allocating a simulator:

```bash
cd packages/remote-desktop-ios
xcodebuild -scheme RunweaveRemoteDesktop \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/runweave-remote-ios-build \
  CODE_SIGNING_ALLOWED=NO build
```

This compiles arm64 and x86_64 for iOS 15. It does not establish UI, LAN, permission, physical hardware decoder, power, latency or analytics acceptance. The existing App and shared simulator/device workflow own those checks. No unit test files were added.

## Sources and API availability

- Mirador `4cc5c0faddcf4ed87599fbd7cba96e5d9bd4285d`: `clients/Mirador/Sources/H264Decoder.swift` is adapted for Annex-B splitting and CoreMedia format/sample construction; `InputCaptureView.swift` informs the gesture structure, relative cursor and aspect mapping in `RemoteNativeSurface.swift`. `clients/Mirador/Sources/VideoSurface.swift` is adapted there for a dedicated UIView whose `layerClass` is `AVSampleBufferDisplayLayer`; local changes retain gestures/cursor in the outer view and use the current `videoRect` mapping. `RemoteSession.swift`, `VideoClient.swift`, `InputClient.swift` and `InputState.swift` were read as integration references. Other local changes add real VideoToolbox decode, bounds, generation and owner isolation, IDR recovery, explicit geometry, TLS and a separate Keychain. The upstream MIT copyright and license are retained in [ThirdParty/Mirador-LICENSE.txt](ThirdParty/Mirador-LICENSE.txt).
- MacRemote `274901a7d25aead9d58d557ba859b71d031ffe84`: `iPhoneRemote/Networking/RemoteConnection.swift`, `Keyboard/KeyboardInputSession.swift` and `Gestures/TrackpadSurface.swift` were read for pairing, IME and interaction comparison. Its crypto implementation and code were not imported.
- No third-party Swift dependency was copied into this client package; the sibling protocol package owns framed TLS.
- The unchanged Mirador MIT text is also copied as a SwiftPM resource from `Sources/RunweaveRemoteDesktop/Resources/Mirador-LICENSE.txt`, so the final App includes it in this package's resource bundle. The repository's original source-license file is retained.
- [Apple AVSampleBufferDisplayLayer](https://developer.apple.com/documentation/avfoundation/avsamplebufferdisplaylayer) and the Xcode 26.5 SDK headers confirm direct layer enqueue/flush/readiness is available on iOS 15/16. [Apple sampleBufferRenderer](https://developer.apple.com/documentation/avfoundation/avsamplebufferdisplaylayer/samplebufferrenderer) is available on iOS 17+ and used there without mixing the old layer queue API; the latter is deprecated from iOS 18. [VTDecompressionSession](https://developer.apple.com/documentation/videotoolbox/vtdecompressionsession) output-handler decode is available since iOS 9. The hardware selection/property constants are guarded at iOS 17. The App's minimum version remains unchanged.
