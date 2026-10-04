import CoreGraphics
import RunweaveRemoteDesktopProtocol

extension RemoteDisplay {
    func validatedGeometry() throws -> RemoteDisplayGeometry {
        let logical = logicalBounds, content = contentRect
        let geometry = RemoteDisplayGeometry(displayID: displayID, revision: revision,
            logicalBounds: CGRect(x: logical.x, y: logical.y, width: logical.width, height: logical.height),
            pixelSize: CGSize(width: pixelWidth, height: pixelHeight),
            contentRect: CGRect(x: content.x, y: content.y, width: content.width, height: content.height))
        guard geometry.isValid, pixelWidth <= 8192, pixelHeight <= 8192 else {
            throw RemoteTransportError.invalidMessage
        }
        return geometry
    }
}
