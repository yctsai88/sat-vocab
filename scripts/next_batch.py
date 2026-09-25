#!/usr/bin/env python3
"""Print the next N words (alphabetical) that are not yet in data/gen/*.json."""
import glob
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
n = int(sys.argv[1]) if len(sys.argv) > 1 else 100
done = set()
for f in glob.glob(str(ROOT / "data/gen/*.json")):
    done |= {e["w"].lower() for e in json.loads(Path(f).read_text())}
words = [w.strip() for w in (ROOT / "data/words.txt").read_text().splitlines() if w.strip()]
todo = [w for w in words if w.lower() not in done]
print(f"# remaining {len(todo)}")
print("\n".join(todo[:n]))
