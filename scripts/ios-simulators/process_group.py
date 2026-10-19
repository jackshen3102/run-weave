"""Read-only proof that an exited command's group ID now belongs to a new leader."""
import subprocess


def recycled_group(pgid, recorded_start):
    if not recorded_start:
        return False
    try:
        result = subprocess.run(
            ["ps", "-ww", "-axo", "pid=,ppid=,pgid=,lstart="],
            text=True, capture_output=True, timeout=5)
        if result.returncode:
            return False
        processes = {}
        for line in result.stdout.splitlines():
            fields = line.split(None, 3)
            if len(fields) == 4:
                processes[int(fields[0])] = (int(fields[1]), int(fields[2]), fields[3].strip())
        leader = processes.get(pgid)
        if not leader or leader[1] != pgid or not leader[2] or leader[2] == recorded_start:
            return False
        # Every current member must descend from the new leader. An old orphan,
        # incomplete inventory or changed parentage remains blocked.
        for pid, (_, group, _) in processes.items():
            if group != pgid:
                continue
            seen = set()
            while pid != pgid:
                if pid in seen or pid not in processes:
                    return False
                seen.add(pid)
                pid = processes[pid][0]
        check = subprocess.run(["ps", "-p", str(pgid), "-o", "lstart="],
                               text=True, capture_output=True, timeout=5)
        return check.returncode == 0 and check.stdout.strip() == leader[2]
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False
