// Append-only tmux pipe consumer. Coordinate with the Backend's descriptor lock
// so checking the consumed offset and truncating cannot discard a concurrent write.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static int lock_output(int fd, int acquire) {
  int result;
  do {
#ifdef __APPLE__
    result = flock(fd, acquire ? LOCK_EX : LOCK_UN);
#else
    // Match fs-native-extensions: open-file-description locks on Linux.
    struct flock lock = {.l_type = acquire ? F_WRLCK : F_UNLCK,
                        .l_whence = SEEK_SET, .l_start = 0, .l_len = 0};
    result = fcntl(fd, acquire ? F_OFD_SETLKW : F_OFD_SETLK, &lock);
#endif
  } while (result < 0 && errno == EINTR);
  return result;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts("runweave-tmux-output-writer 1");
    return 0;
  }
  if (argc != 2) return 2;
  int fd = open(argv[1], O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0600);
  if (fd < 0) { perror("tmux output open"); return 1; }
  struct stat info;
  if (fstat(fd, &info) || !S_ISREG(info.st_mode) || info.st_uid != getuid()) {
    fprintf(stderr, "tmux output must be an owned regular file\n");
    close(fd);
    return 1;
  }
  char buffer[65536];
  int status = 0;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count == 0) break;
    if (count < 0 || lock_output(fd, 1) < 0) { status = 1; break; }
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(fd, buffer + offset, (size_t)(count - offset));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) { status = 1; break; }
      offset += written;
    }
    if (lock_output(fd, 0) < 0) status = 1;
    if (status) break;
  }
  if (status) perror("tmux output copy");
  if (close(fd)) status = 1;
  return status;
}
