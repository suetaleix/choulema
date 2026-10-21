"""Check the actual deployment environment without writing to the database."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from v7_release import preflight

if __name__ == '__main__':
    report = preflight()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report['ok'] else 1)
