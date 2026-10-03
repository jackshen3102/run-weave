# Remote Desktop iOS

- Independent iOS 15 Swift package. Do not import Runweave app, Backend, Electron or terminal controllers.
- Host identity, presentation identity and connection generation invalidate every asynchronous callback.
- Hidden, inactive and stopped sessions must stop network reception, decoding and retries, clear video, and release inputs.
- Credentials use this package's own Keychain service; ordinary target metadata contains a credential reference only.
- Native UI acceptance uses agent-device and the existing shared simulator pool. Package compilation is not UI acceptance.
- Do not add unit tests.
