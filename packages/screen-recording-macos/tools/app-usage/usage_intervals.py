"""Pair an ordered stream of (timestamp, bundle ID, gained focus) events."""


def pair_events(events, counts):
    current = None
    for timestamp, app, gained in events:
        if gained:
            if current and current[0] == app:
                counts['duplicate_open'] += 1
                continue
            if current:
                counts['missing_close'] += 1
                yield current[0], current[1], timestamp, 'inferred_next_open'
            current = (app, timestamp)
        elif current and current[0] == app:
            yield app, current[1], timestamp, 'matched'
            current = None
        else:
            counts['unmatched_close'] += 1
    if current:
        counts['unfinished_open'] += 1
