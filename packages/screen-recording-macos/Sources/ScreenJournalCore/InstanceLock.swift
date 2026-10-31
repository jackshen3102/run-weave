import Foundation
import Darwin

final class InstanceLock {
    private let fd: Int32
    init(paths: StorePaths, readOnly: Bool = false) throws {
        let url = try paths.file("writer.lock")
        fd = open(url.path, (readOnly ? O_RDONLY : O_CREAT | O_RDWR) | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw journalError("writer_lock_unavailable") }
        guard flock(fd, (readOnly ? LOCK_SH : LOCK_EX) | LOCK_NB) == 0 else {
            close(fd); throw journalError("writer_active: 请先退出 ScreenJournal")
        }
        if !readOnly {
            let owner = Data("\(getpid())\n".utf8)
            guard ftruncate(fd, 0) == 0,
                  owner.withUnsafeBytes({ Darwin.write(fd, $0.baseAddress, $0.count) }) == owner.count,
                  fsync(fd) == 0 else { close(fd); throw journalError("writer_lock_owner_write_failed") }
        }
    }
    deinit { flock(fd, LOCK_UN); close(fd) }
}
