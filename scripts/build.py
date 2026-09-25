#!/usr/bin/env python3
"""Validate data/gen/*.json and merge into docs/words.json for the app."""
import glob
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORDLIST = [w.strip() for w in (ROOT / "data/words.txt").read_text().splitlines() if w.strip()]
WORDSET = {w.lower(): w for w in WORDLIST}
POS = {"n.", "v.", "adj.", "adv.", "prep.", "conj.", "interj.", "pron."}


def check(e, src):
    errs = []
    w = e.get("w", "")
    if w.lower() not in WORDSET:
        errs.append("not in word list")
    if not re.fullmatch(r"\[.+\]", e.get("kk", "")):
        errs.append("kk must be wrapped in []")
    if e.get("tier") not in (1, 2, 3):
        errs.append("tier must be 1/2/3")
    senses = e.get("senses") or []
    if not senses:
        errs.append("no senses")
    for s in senses:
        if s.get("pos") not in POS:
            errs.append(f"bad pos {s.get('pos')!r}")
        if not s.get("en") or not s.get("zh"):
            errs.append("sense missing en/zh")
    ex = e.get("ex") or []
    if not ex:
        errs.append("no example")
    elif not re.search(r"(?<![A-Za-z])" + re.escape(w) + r"(?![A-Za-z])", ex[0]["en"], re.I):
        errs.append("first example must contain the headword exactly (used for cloze)")
    for x in ex:
        if not x.get("en") or not x.get("zh"):
            errs.append("example missing en/zh")
    for k in ("syn", "ant"):
        if not isinstance(e.get(k, []), list):
            errs.append(f"{k} must be a list")
    return [f"{src}: {w}: {m}" for m in errs]


def stamp_service_worker():
    """Set the cache name to a hash of the app files so phones pick up new versions."""
    import hashlib
    h = hashlib.sha1()
    for name in ("index.html", "style.css", "app.js", "words.json", "manifest.webmanifest"):
        h.update((ROOT / "docs" / name).read_bytes())
    sw = ROOT / "docs/sw.js"
    text = re.sub(r"const CACHE = '[^']*';", f"const CACHE = 'satvocab-{h.hexdigest()[:10]}';", sw.read_text())
    sw.write_text(text)


def check_only(paths):
    """Validate the given files without writing anything (safe to run in parallel)."""
    errors, n = [], 0
    for f in paths:
        try:
            data = json.loads(Path(f).read_text())
        except json.JSONDecodeError as ex:
            errors.append(f"{Path(f).name}: invalid JSON: {ex}")
            continue
        for e in data:
            errors += check(e, Path(f).name)
            n += 1
    print("\n".join(errors) if errors else f"OK: {n} entries")
    sys.exit(1 if errors else 0)


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--check":
        check_only(sys.argv[2:])
    entries, errors, seen = [], [], set()
    for f in sorted(glob.glob(str(ROOT / "data/gen/*.json"))):
        for e in json.loads(Path(f).read_text()):
            errors += check(e, Path(f).name)
            key = e.get("w", "").lower()
            if key in seen:
                errors.append(f"{Path(f).name}: {e.get('w')}: duplicate")
            seen.add(key)
            e["w"] = WORDSET.get(key, e.get("w"))
            e.setdefault("syn", [])
            e.setdefault("ant", [])
            entries.append(e)
    if errors:
        print("\n".join(errors))
        sys.exit(1)
    entries.sort(key=lambda e: e["w"].lower())
    out = ROOT / "docs/words.json"
    out.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")))
    stamp_service_worker()
    tiers = {t: sum(e["tier"] == t for e in entries) for t in (1, 2, 3)}
    print(f"{len(entries)}/{len(WORDLIST)} words -> {out.relative_to(ROOT)} "
          f"({out.stat().st_size // 1024} KB), tiers {tiers}")
    missing = len(WORDLIST) - len(entries)
    if missing:
        print(f"{missing} words not generated yet")


if __name__ == "__main__":
    main()
