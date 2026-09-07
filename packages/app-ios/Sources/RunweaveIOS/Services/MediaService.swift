import Foundation

struct UploadedImage: Decodable { let filePath: String }
struct TranscribedVoice: Decodable { let text: String }
struct VoiceClip {
  let data: Data
  let durationMilliseconds: Int
}

extension APIClient {
  func uploadImage(terminalID: String, data: Data, mimeType: String) async throws -> String {
    let value: UploadedImage = try await authorized(
      "/api/terminal/session/\(Self.pathComponent(terminalID))/clipboard-image", method: "POST",
      body: ["mimeType": mimeType, "dataBase64": data.base64EncodedString()],
      retryUnauthorized: false)
    guard !value.filePath.isEmpty, !value.filePath.contains("\0") else {
      throw APIError.invalidResponse
    }
    return value.filePath
  }

  func transcribe(_ clip: VoiceClip) async throws -> String {
    let value: TranscribedVoice = try await authorized(
      "/api/voice/transcribe", method: "POST",
      body: [
        "mimeType": "audio/wav", "audioBase64": clip.data.base64EncodedString(),
        "sampleRateHz": 24000, "durationMs": clip.durationMilliseconds,
      ], retryUnauthorized: false)
    return value.text
  }
}
