#!/usr/bin/env python3
"""Extract a structured inventory of the normative domain model in docs/domain/.

The model is Markdown written to a deliberate shape (entity anchors, one row per
field, enums spelled out, invariants bold at definition) precisely so a machine can
read it. This script does that reading, so that a drift check compares code against
facts rather than against a recollection of 3,000 lines of prose.

Usage:
    model_inventory.py --check                 model-internal consistency, exit 1 on ERROR
    model_inventory.py --json                  full inventory as JSON (diff this against code)
    model_inventory.py --entity Proposal       one entity's fields, types, Req, prefix
    model_inventory.py --find entitlement      where a term is defined and used
    model_inventory.py --events                every event: catalogued, promised, reacted to
    model_inventory.py --invariants            every INV: where defined, where cited

Options:
    --dir PATH      domain directory (default: docs/domain relative to the repo root)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import defaultdict

ANCHOR_RE = re.compile(r"<!--\s*entity:\s*([A-Za-z0-9_]+)\s*-->")
BACKTICK_RE = re.compile(r"`([^`]+)`")
INV_DEF_RE = re.compile(r"\*\*(INV-\d{2}-\d+)\*\*")
INV_ANY_RE = re.compile(r"\bINV-\d{2}-\d+\b")
ENUM_RE = re.compile(r"enum\(([^)]*)\)")
PREFIX_RE = re.compile(r"prefix\s+`([a-z_]+_)`")
EVENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$")
TRANSITION_RE = re.compile(r"^\s*(\[\*\]|[A-Za-z_][A-Za-z0-9_]*)\s*-->\s*(\[\*\]|[A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(.*))?$")
FILE_NUM_RE = re.compile(r"^(\d{2})-")


# --------------------------------------------------------------------------- parsing


def repo_root() -> str:
    """Anchor on the script's own location first, so it works from any cwd."""
    here = os.path.dirname(os.path.abspath(__file__))
    for start in (here, os.getcwd()):
        try:
            out = subprocess.run(
                ["git", "-C", start, "rev-parse", "--show-toplevel"],
                capture_output=True, text=True, check=True,
            )
            root = out.stdout.strip()
            if root and os.path.isdir(os.path.join(root, "docs", "domain")):
                return root
        except Exception:
            continue
    return os.getcwd()


def domain_files(directory: str) -> list[str]:
    names = sorted(n for n in os.listdir(directory) if n.endswith(".md"))
    return [os.path.join(directory, n) for n in names]


def split_row(line: str) -> list[str]:
    cells = line.strip().strip("|").split("|")
    return [c.strip() for c in cells]


def is_separator(cells: list[str]) -> bool:
    return bool(cells) and all(set(c) <= set("-: ") and c for c in cells)


def parse_entities(path: str, lines: list[str]) -> list[dict]:
    """Every `<!-- entity: X -->` anchor and the field table that follows it."""
    entities = []
    in_fence = False
    for i, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        # An anchor quoted inside backticks is documentation about the convention
        # (13-open-questions.md R7), not an anchor for a real entity.
        m = ANCHOR_RE.search(BACKTICK_RE.sub("", line))
        if not m:
            continue
        j = i + 1
        while j < len(lines) and not lines[j].lstrip().startswith("|"):
            if lines[j].strip():  # anchor not immediately followed by a table
                break
            j += 1
        fields, section = [], None
        header_seen = False
        while j < len(lines) and lines[j].lstrip().startswith("|"):
            cells = split_row(lines[j])
            j += 1
            if is_separator(cells):
                continue
            if not header_seen:
                header_seen = True
                if cells and cells[0].lower() in ("field", "name"):
                    continue
            names = BACKTICK_RE.findall(cells[0]) if cells else []
            rest = cells[1:] if len(cells) > 1 else []
            if not names:
                label = cells[0].strip("* ") if cells else ""
                if label and not any(c for c in rest[:2]):
                    section = label
                continue
            type_cell = rest[0] if len(rest) > 0 else ""
            req_cell = rest[1] if len(rest) > 1 else ""
            notes = rest[2] if len(rest) > 2 else ""
            types = BACKTICK_RE.findall(type_cell) or ([type_cell] if type_cell else [""])
            reqs = [r.strip() for r in req_cell.split("/")] if req_cell else [""]
            if len(reqs) != len(names):
                reqs = [req_cell.strip()] * len(names)
            for k, name in enumerate(names):
                ftype = types[k] if len(types) == len(names) else types[0]
                enum_members: list[str] | None = None
                em = ENUM_RE.search(ftype)
                if em:
                    raw = em.group(1).strip()
                    enum_members = (
                        None if raw in ("...", "") else [x.strip() for x in raw.split(",") if x.strip()]
                    )
                pm = PREFIX_RE.search(notes)
                fields.append({
                    "name": name,
                    "type": ftype,
                    "req": reqs[k],
                    "section": section,
                    "enum_members": enum_members,
                    "enum_elided": bool(em) and enum_members is None,
                    "id_prefix": pm.group(1) if pm else None,
                    "invariants": sorted(set(INV_ANY_RE.findall(notes))),
                    "notes": notes,
                })
        entities.append({
            "name": m.group(1),
            "file": os.path.basename(path),
            "line": i + 1,
            "fields": fields,
        })
    return entities


def section_body(lines: list[str], heading: str) -> list[str]:
    """Lines under a `## heading`, up to the next heading of the same or higher level."""
    out, capturing, level = [], False, 2
    for line in lines:
        if line.startswith("#"):
            hashes = len(line) - len(line.lstrip("#"))
            title = line.lstrip("# ").strip().lower()
            if capturing and hashes <= level:
                break
            if title == heading.lower():
                capturing, level = True, hashes
                continue
        if capturing:
            out.append(line)
    return out


def parse_events_from(lines: list[str]) -> list[str]:
    found = []
    for line in lines:
        for tok in BACKTICK_RE.findall(line):
            for part in tok.split(" / "):
                part = part.strip()
                if EVENT_NAME_RE.match(part):
                    found.append(part)
    return found


def parse_state_diagrams(lines: list[str]) -> list[dict]:
    diagrams, block, in_block = [], [], False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            if in_block:
                if any("stateDiagram" in b for b in block):
                    diagrams.append(block)
                block, in_block = [], False
            else:
                in_block = True
                block = []
            continue
        if in_block:
            block.append(stripped)
    parsed = []
    for block in diagrams:
        states, transitions = set(), []
        for line in block:
            m = TRANSITION_RE.match(line)
            if not m:
                continue
            src, dst, label = m.group(1), m.group(2), (m.group(3) or "").strip()
            transitions.append({"from": src, "to": dst, "trigger": label})
            for s in (src, dst):
                if s != "[*]":
                    states.add(s)
        if transitions:
            parsed.append({
                "states": sorted(states),
                "transitions": transitions,
            })
    return parsed


def build_inventory(directory: str) -> dict:
    inv = {
        "dir": directory,
        "files": [],
        "entities": [],
        "invariants": {},
        "events": {"catalogue": [], "promised": {}, "reacted": []},
        "state_machines": {},
        "erd_nodes": [],
        "glossary": [],
    }
    for path in domain_files(directory):
        base = os.path.basename(path)
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
        inv["files"].append(base)

        if base != "README.md":
            inv["entities"].extend(parse_entities(path, lines))

        for n, line in enumerate(lines, 1):
            for name in INV_DEF_RE.findall(line):
                rec = inv["invariants"].setdefault(name, {"defined": [], "cited": []})
                rec["defined"].append(f"{base}:{n}")
            for name in INV_ANY_RE.findall(INV_DEF_RE.sub("", line)):
                rec = inv["invariants"].setdefault(name, {"defined": [], "cited": []})
                rec["cited"].append(f"{base}:{n}")

        if base.startswith("10-"):
            inv["events"]["catalogue"] = sorted(set(
                parse_events_from(section_body(lines, "Catalogue"))
            ))
            inv["events"]["reacted"] = sorted(set(
                parse_events_from(section_body(lines, "Reaction map"))
            ))
        emitted = parse_events_from(section_body(lines, "Emitted events"))
        if emitted:
            inv["events"]["promised"][base] = sorted(set(emitted))

        machines = parse_state_diagrams(lines)
        if machines and base != "README.md":
            inv["state_machines"][base] = machines

        if base.startswith("00-"):
            for line in lines:
                m = re.match(r"^\s*([A-Z][A-Z_0-9]+)\s+\|\|--", line)
                if m:
                    inv["erd_nodes"].append(m.group(1))
                m2 = re.match(r"^\s*([A-Z][A-Z_0-9]+)\s+\}o--", line)
                if m2:
                    inv["erd_nodes"].append(m2.group(1))
                for m3 in re.finditer(r"(?:--o\{|--\|\||--o\|)\s+([A-Z][A-Z_0-9]+)\s*:", line):
                    inv["erd_nodes"].append(m3.group(1))
        if base.startswith("12-"):
            for line in lines:
                if line.startswith("|") and "**" in line:
                    cells = split_row(line)
                    term = cells[0].strip("* ")
                    if term:
                        inv["glossary"].append(term.strip("`"))
    inv["erd_nodes"] = sorted(set(inv["erd_nodes"]))
    return inv


# --------------------------------------------------------------------------- checks


def normalise(name: str) -> str:
    return name.replace("_", "").lower()


def check(inv: dict) -> list[tuple[str, str]]:
    findings: list[tuple[str, str]] = []

    def add(level: str, msg: str) -> None:
        findings.append((level, msg))

    # Entity anchors must be unique and must carry a table.
    seen: dict[str, str] = {}
    for e in inv["entities"]:
        where = f"{e['file']}:{e['line']}"
        if e["name"] in seen:
            add("ERROR", f"entity `{e['name']}` anchored twice: {seen[e['name']]} and {where} "
                         f"— every anchor must map to exactly one entity")
        seen[e["name"]] = where
        if not e["fields"]:
            add("ERROR", f"entity `{e['name']}` ({where}) has an anchor but no field table")

    # id prefixes must be unique across the model.
    prefixes: dict[str, str] = {}
    for e in inv["entities"]:
        for f in e["fields"]:
            if f["id_prefix"]:
                other = prefixes.get(f["id_prefix"])
                if other and other != e["name"]:
                    add("WARN", f"id prefix `{f['id_prefix']}` used by both `{other}` and "
                                f"`{e['name']}` — prefixes are how an id is read aloud, "
                                f"so sharing one makes them ambiguous")
                prefixes[f["id_prefix"]] = e["name"]

    # Invariants: cited but never defined, defined in the wrong file, defined twice.
    for name, rec in sorted(inv["invariants"].items()):
        if not rec["defined"]:
            add("ERROR", f"{name} is cited ({', '.join(rec['cited'][:3])}) but never defined "
                         f"— a citation that leads nowhere cannot be tested against")
        elif len(rec["defined"]) > 1:
            add("WARN", f"{name} is defined more than once: {', '.join(rec['defined'])}")
        for loc in rec["defined"]:
            file_num = FILE_NUM_RE.match(loc)
            inv_num = name.split("-")[1]
            if file_num and file_num.group(1) != inv_num:
                add("ERROR", f"{name} is defined in {loc} — invariants are numbered per file, "
                             f"so it belongs in {inv_num}-*.md or should be renumbered")
    # Note: an invariant defined but never cited elsewhere in the docs is normal — most
    # invariants are standalone rules. Whether it is *enforced and tested* is a code-side
    # question, which is why that check lives in the drift procedure, not here.

    # Events: promised in a context file but missing from the catalogue, and vice versa.
    catalogue = set(inv["events"]["catalogue"])
    promised: dict[str, list[str]] = defaultdict(list)
    for base, events in inv["events"]["promised"].items():
        for ev in events:
            promised[ev].append(base)
    for ev, files in sorted(promised.items()):
        if ev not in catalogue:
            add("ERROR", f"`{ev}` is promised in {', '.join(files)} but is not in the "
                         f"catalogue in 10-domain-events.md — the catalogue is the published "
                         f"contract, so an uncatalogued event cannot be subscribed to")
    for ev in sorted(inv["events"]["reacted"]):
        if ev not in catalogue:
            add("ERROR", f"`{ev}` appears in the reaction map but not in the catalogue")
    for ev in sorted(catalogue - set(promised)):
        add("INFO", f"`{ev}` is catalogued but no context file lists it under "
                    f"'Emitted events' — check which context is responsible for raising it")

    # Event naming rules (10-domain-events.md, 'Naming rules').
    for ev in sorted(catalogue | set(promised)):
        if not EVENT_NAME_RE.match(ev) or ev.count(".") != 1:
            add("ERROR", f"`{ev}` does not match `<noun>.<past-tense-verb>`")

    # States: declared in a status enum but unreachable in the diagram, or vice versa.
    for base, machines in sorted(inv["state_machines"].items()):
        diagram_states = {s for m in machines for s in m["states"]}
        for m in machines:
            incoming = {t["to"] for t in m["transitions"]}
            for s in m["states"]:
                if s not in incoming:
                    add("ERROR", f"{base}: state `{s}` has no incoming transition — a state "
                                 f"nothing reaches is either dead or a missing edge")
        enum_states: dict[str, set[str]] = {}
        for e in inv["entities"]:
            if e["file"] != base:
                continue
            for f in e["fields"]:
                if f["name"] in ("status", "state") and f["enum_members"]:
                    enum_states[f"{e['name']}.{f['name']}"] = set(f["enum_members"])
        for label, members in sorted(enum_states.items()):
            missing = members - diagram_states
            if missing and len(enum_states) == 1:
                add("WARN", f"{base}: `{label}` allows {sorted(missing)} but the state diagram "
                            f"does not draw them — an undrawn transition does not exist")
        if enum_states:
            all_members = set().union(*enum_states.values())
            extra = diagram_states - all_members
            if extra:
                add("INFO", f"{base}: the state diagram draws {sorted(extra)} which no status "
                            f"enum in this file allows — fine if that state is derived rather "
                            f"than stored (Entitlement is), a gap if it was meant to be a field")

    # Master ERD nodes should correspond to entity anchors.
    anchors = {normalise(e["name"]) for e in inv["entities"]}
    for node in inv["erd_nodes"]:
        if normalise(node) not in anchors:
            add("INFO", f"master ERD in 00-overview.md names `{node}` but no "
                        f"`<!-- entity: -->` anchor defines it")

    # Enum members left elided cannot be diffed against code.
    for e in inv["entities"]:
        for f in e["fields"]:
            if f["enum_elided"]:
                add("WARN", f"`{e['name']}.{f['name']}` is typed `enum(...)` — members are not "
                            f"written out, so no checker can tell if code adds or drops one")
    return findings


# --------------------------------------------------------------------------- output


def print_check(findings: list[tuple[str, str]]) -> int:
    order = {"ERROR": 0, "WARN": 1, "INFO": 2}
    findings = sorted(findings, key=lambda f: order[f[0]])
    counts = defaultdict(int)
    for level, _ in findings:
        counts[level] += 1
    current = None
    for level, msg in findings:
        if level != current:
            print(f"\n{level}")
            print("-" * len(level))
            current = level
        print(f"  {msg}")
    print(
        f"\n{counts['ERROR']} error(s), {counts['WARN']} warning(s), "
        f"{counts['INFO']} note(s)"
    )
    return 1 if counts["ERROR"] else 0


def print_entity(inv: dict, name: str) -> int:
    matches = [e for e in inv["entities"] if e["name"].lower() == name.lower()]
    if not matches:
        near = [e["name"] for e in inv["entities"] if name.lower() in e["name"].lower()]
        print(f"no entity anchored as `{name}`." + (f" did you mean: {', '.join(near)}" if near else ""))
        return 1
    for e in matches:
        print(f"# {e['name']}  ({e['file']}:{e['line']})\n")
        width = max(len(f["name"]) for f in e["fields"]) if e["fields"] else 0
        for f in e["fields"]:
            extra = []
            if f["enum_members"]:
                extra.append("one of: " + ", ".join(f["enum_members"]))
            if f["id_prefix"]:
                extra.append(f"prefix {f['id_prefix']}")
            if f["invariants"]:
                extra.append(", ".join(f["invariants"]))
            tail = ("  — " + "; ".join(extra)) if extra else ""
            print(f"  {f['name']:<{width}}  {f['req']:<3} {f['type']}{tail}")
    return 0


def print_events(inv: dict) -> int:
    catalogue = set(inv["events"]["catalogue"])
    promised: dict[str, list[str]] = defaultdict(list)
    for base, events in inv["events"]["promised"].items():
        for ev in events:
            promised[ev].append(base)
    reacted = set(inv["events"]["reacted"])
    for ev in sorted(catalogue | set(promised)):
        flags = []
        if ev not in catalogue:
            flags.append("NOT CATALOGUED")
        if ev in reacted:
            flags.append("has reaction")
        src = ", ".join(promised.get(ev, [])) or "catalogue only"
        print(f"  {ev:<38} {src}{('  [' + '; '.join(flags) + ']') if flags else ''}")
    print(f"\n{len(catalogue)} catalogued, {len(promised)} promised by a context, "
          f"{len(reacted)} with an internal reaction")
    return 0


def print_invariants(inv: dict) -> int:
    for name, rec in sorted(inv["invariants"].items()):
        where = rec["defined"][0] if rec["defined"] else "UNDEFINED"
        print(f"  {name:<12} defined {where:<28} cited {len(rec['cited'])}x")
    return 0


def print_find(inv: dict, term: str, directory: str) -> int:
    t = term.lower()
    hits = False
    for e in inv["entities"]:
        if t in e["name"].lower():
            print(f"  entity   `{e['name']}`  {e['file']}:{e['line']}")
            hits = True
        for f in e["fields"]:
            if t in f["name"].lower():
                print(f"  field    `{e['name']}.{f['name']}`  {f['req']} {f['type']}  ({e['file']})")
                hits = True
    for ev in sorted(set(inv["events"]["catalogue"])):
        if t in ev:
            print(f"  event    `{ev}`  10-domain-events.md")
            hits = True
    for g in inv["glossary"]:
        if t in g.lower():
            print(f"  glossary {g}  12-glossary.md")
            hits = True
    for path in domain_files(directory):
        with open(path, encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                if line.startswith("#") and t in line.lower():
                    print(f"  heading  {line.strip()}  {os.path.basename(path)}:{n}")
                    hits = True
    if not hits:
        print(f"  nothing in the model mentions '{term}' — that absence is itself a finding")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=None, help="domain directory (default: <repo>/docs/domain)")
    ap.add_argument("--check", action="store_true", help="model-internal consistency check")
    ap.add_argument("--json", action="store_true", help="dump the full inventory as JSON")
    ap.add_argument("--entity", help="show one entity's fields")
    ap.add_argument("--find", help="locate a term in the model")
    ap.add_argument("--events", action="store_true", help="list every event and where it lives")
    ap.add_argument("--invariants", action="store_true", help="list every invariant")
    args = ap.parse_args()

    directory = args.dir or os.path.join(repo_root(), "docs", "domain")
    if not os.path.isdir(directory):
        print(f"no domain directory at {directory}", file=sys.stderr)
        return 2

    inv = build_inventory(directory)

    if args.json:
        print(json.dumps(inv, indent=2))
        return 0
    if args.entity:
        return print_entity(inv, args.entity)
    if args.find:
        return print_find(inv, args.find, directory)
    if args.events:
        return print_events(inv)
    if args.invariants:
        return print_invariants(inv)
    if args.check:
        return print_check(check(inv))

    print(f"{len(inv['entities'])} entities, {len(inv['invariants'])} invariants, "
          f"{len(inv['events']['catalogue'])} catalogued events, "
          f"{len(inv['state_machines'])} files with state machines")
    print("run with --check, --json, --entity, --find, --events or --invariants")
    return 0


if __name__ == "__main__":
    try:
        import signal

        signal.signal(signal.SIGPIPE, signal.SIG_DFL)  # allow piping into `head`
    except (ImportError, AttributeError, ValueError):
        pass
    sys.exit(main())
