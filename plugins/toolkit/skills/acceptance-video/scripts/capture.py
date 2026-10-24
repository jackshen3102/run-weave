#!/usr/bin/env python3
"""Compatibility path; canonical implementation lives in the acceptance skill."""
from pathlib import Path
import runpy
import sys
sys.dont_write_bytecode = True
script = Path(__file__).resolve().parents[2] / 'acceptance' / 'scripts' / 'capture.py'
sys.path.insert(0, str(script.parent))
runpy.run_path(str(script), run_name='__main__')
