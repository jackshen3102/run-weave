import Foundation

public enum APIError: Error, LocalizedError {
  case invalidURL
  case http(Int)
  case invalidResponse
  case credentialsUnavailable
  case offline
  case writeRequiresRetry
  case loginRejected
  case tunnelAuthenticationRequired
  case diagnosticStorageUnavailable
  case keychain(OSStatus)

  public var errorDescription: String? {
    switch self {
    case .invalidURL: return "请输入有效的 HTTP 或 HTTPS 后端地址"
    case .http(401): return "登录已失效，请重新登录"
    case .http(403): return "没有访问权限"
    case .http(404): return "资源不存在或已被删除"
    case .http(let status): return "服务请求失败（HTTP \(status)）"
    case .invalidResponse: return "服务端响应格式无效"
    case .credentialsUnavailable: return "请先登录此连接"
    case .offline: return "本地电脑暂时不可用，恢复连接后请重新操作"
    case .writeRequiresRetry: return "登录已刷新，本次操作未重发，请重新操作"
    case .loginRejected: return "用户名或密码不正确"
    case .tunnelAuthenticationRequired: return "连接入口需要隧道认证，请检查接入配置"
    case .diagnosticStorageUnavailable: return "持久日志不可用，未完成清理；请先导出当前可读记录"
    case .keychain(let code): return "安全凭据存储失败（\(code)）"
    }
  }
}

func displayError(_ error: Error) -> String {
  if let api = error as? APIError { return api.localizedDescription }
  if let url = error as? URLError {
    switch url.code {
    case .timedOut: return "连接超时，请检查电脑和网络"
    case .serverCertificateUntrusted, .serverCertificateHasBadDate,
      .serverCertificateHasUnknownRoot, .secureConnectionFailed:
      return "TLS 连接失败，请检查服务器证书"
    default: return "无法连接电脑，请检查网络、局域网权限和服务地址"
    }
  }
  return error.localizedDescription
}

func displayInputError(_ error: Error) -> String {
  let uncertain: Bool
  switch error {
  case is URLError, APIError.invalidResponse: uncertain = true
  case APIError.http(let status): uncertain = status >= 500
  default: uncertain = false
  }
  guard uncertain else { return displayError(error) }
  return "发送结果未确认，草稿已保留。请先核对终端结果，再决定是否重新发送。\n" + displayError(error)
}
