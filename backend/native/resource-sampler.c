// Backend-only process inspection. No application control.
#include <libproc.h>
#include <sys/resource.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdint.h>
#include <sys/sysctl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>

// Keep argv boundaries: ps command output cannot distinguish option values from prompts.
// Emit only executable + argc arguments, never the environment following them.
static int process_argv(const char *value) {
  char *end = NULL;
  long parsed = strtol(value, &end, 10);
  if (!end || *end || parsed <= 0 || parsed > INT_MAX) return 2;
  int pid = (int)parsed;
  struct proc_bsdinfo info = {0};
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)
      || info.pbi_uid != getuid()) return 1;
  int size_mib[] = {CTL_KERN, KERN_ARGMAX};
  int capacity = 0;
  size_t size = sizeof(capacity);
  if (sysctl(size_mib, 2, &capacity, &size, NULL, 0) || capacity <= 0
      || capacity > 4 * 1024 * 1024) return 1;
  char *buffer = malloc((size_t)capacity);
  if (!buffer) return 1;
  size = (size_t)capacity;
  int mib[] = {CTL_KERN, KERN_PROCARGS2, pid};
  if (sysctl(mib, 3, buffer, &size, NULL, 0) || size < sizeof(int)) {
    free(buffer); return 1;
  }
  int count = 0;
  memcpy(&count, buffer, sizeof(count));
  char *cursor = buffer + sizeof(count), *limit = buffer + size;
  char *executable = cursor;
  char *zero = memchr(cursor, 0, (size_t)(limit - cursor));
  if (count <= 0 || !zero) { free(buffer); return 1; }
  size_t executable_size = (size_t)(zero - cursor + 1);
  cursor = zero + 1;
  while (cursor < limit && !*cursor) cursor++;
  char *arguments = cursor;
  for (int i = 0; i < count; i++) {
    zero = memchr(cursor, 0, (size_t)(limit - cursor));
    if (!zero) { free(buffer); return 1; }
    cursor = zero + 1;
  }
  fwrite(executable, 1, executable_size, stdout);
  fwrite(arguments, 1, (size_t)(cursor - arguments), stdout);
  free(buffer);
  return ferror(stdout) ? 1 : 0;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--process-argv") == 0) return process_argv(argv[2]);
  if (argc != 1) return 2;
  int pids[4096] = {0};
  int total = proc_listallpids(NULL, 0);
  int count = proc_listallpids(pids, sizeof(pids));
  if (total <= 0 || count <= 0) return 1;
  if (count > 4096) count = 4096;
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS) return 1;
  // rusage CPU times and start identity are mach absolute ticks, not nanoseconds.
  printf("clock\t%llu\t%d\t%d\n", (unsigned long long)mach_absolute_time(), timebase.numer, timebase.denom);
  printf("coverage\t%d\t%d\n", total, count);
  for (int i = 0; i < count; i++) {
    if (pids[i] <= 0) continue;
    struct rusage_info_v0 usage = {0};
    if (proc_pid_rusage(pids[i], RUSAGE_INFO_V0, (rusage_info_t *)&usage) != 0) continue;
    printf("%d\t%llu\t%llu\t%llu\t%llu\n", pids[i],
      (unsigned long long)usage.ri_proc_start_abstime,
      (unsigned long long)usage.ri_user_time,
      (unsigned long long)usage.ri_system_time,
      (unsigned long long)usage.ri_pkg_idle_wkups);
  }
  return 0;
}
