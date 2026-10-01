// Backend-only public libproc counters. No application control or private APIs.
#include <libproc.h>
#include <sys/resource.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdint.h>

int main(void) {
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
