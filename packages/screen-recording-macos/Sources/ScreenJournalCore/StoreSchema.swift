import Foundation

let storeSchema = """
CREATE TABLE device(id TEXT PRIMARY KEY, created REAL NOT NULL);
CREATE TABLE sessions(id TEXT PRIMARY KEY, started REAL NOT NULL, ended REAL, clean INTEGER NOT NULL DEFAULT 0);
CREATE TABLE segments(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('writing','ready','deleting','unavailable')),
 started REAL NOT NULL, ended REAL NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, display_id INTEGER NOT NULL,
 frames INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, failure TEXT);
CREATE TABLE captures(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL,
 segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE, frame_index INTEGER NOT NULL, captured_ms INTEGER NOT NULL,
 timezone_offset INTEGER NOT NULL, display_id INTEGER NOT NULL, application_id TEXT, idle_seconds REAL, privacy_placeholder INTEGER NOT NULL,
 UNIQUE(segment_id,frame_index), UNIQUE(session_id,sequence));
CREATE INDEX captures_time ON captures(captured_ms);
CREATE INDEX segments_time ON segments(started);
CREATE TABLE state_events(id INTEGER PRIMARY KEY, started REAL NOT NULL, ended REAL NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL, affected INTEGER NOT NULL);
PRAGMA user_version=1;
"""
