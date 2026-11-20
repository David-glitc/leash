#!/usr/bin/env python3
"""Mutation testing for the Leash contracts.

Breaks the contracts one small change at a time (a deleted check, a flipped comparison, a swapped operator, ...) in an
isolated copy of the repo, runs the whole Foundry suite for each break, and reports which breaks the tests caught.
A surviving mutant is either an equivalent change (no behaviour difference) or a gap in the tests; every survivor is listed.

    python3 tools/mutate.py                         # all contracts
    python3 tools/mutate.py src/LeashGuardV2.sol    # one file
    python3 tools/mutate.py --limit 20              # quick sample

Writes reports/mutation.json. The repo itself is never modified.
"""
import json, os, re, shutil, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FILES = ["src/LeashGuard.sol", "src/LeashGuardV2.sol", "src/adapters/UniV2Adapter.sol", "src/adapters/WrapAdapter.sol", "src/adapters/Erc4626Adapter.sol"]

SKIP = re.compile(r"^\s*(//|/\*|\*|pragma|import|event |error |interface |contract |struct |function .*;\s*$|\}|\{|$)")

def line_mutants(line: str):
    """Yield (operator, mutated_line) for one source line."""
    s = line
    st = s.strip()
    # 1. delete a whole one-line guard: `if (...) revert X();`
    if re.match(r"^\s*if \(.*\) revert \w+(\(.*\))?;\s*$", s):
        yield "delete-check", ""
    # 2. delete state-clearing and event statements
    if re.match(r"^\s*delete .*;\s*$", s): yield "delete-clear", ""
    if re.match(r"^\s*emit .*;\s*$", s): yield "delete-emit", ""
    # 3. flip comparisons (one occurrence per mutant)
    for op, new in ((" >= ", " > "), (" > ", " >= "), (" <= ", " < "), (" < ", " <= "), (" == ", " != "), (" != ", " == ")):
        if op in s and not st.startswith("for"):
            for m in re.finditer(re.escape(op), s):
                yield f"cmp{op.strip()}->{new.strip()}", s[:m.start()] + new + s[m.end():]
                break
    # 4. negation removal
    m = re.search(r"if \(!", s)
    if m: yield "drop-not", s[:m.start()] + "if (" + s[m.end():]
    # 5. logical operators
    if " || " in s and "revert" in s: yield "or->and", s.replace(" || ", " && ", 1)
    if " && " in s and "revert" in s: yield "and->or", s.replace(" && ", " || ", 1)
    # 6. arithmetic
    for a, b in ((" + ", " - "), (" - ", " + "), (" * ", " / "), (" / ", " * ")):
        if a in s and "//" not in s.split(a)[0] and not st.startswith(("function", "return abi", "for")) and "abi.encode" not in s:
            yield f"arith{a.strip()}->{b.strip()}", s.replace(a, b, 1)
    # 7. booleans in assignments
    m = re.search(r"= (true|false);", s)
    if m: yield "bool-flip", s[:m.start()] + "= " + ("false" if m.group(1) == "true" else "true") + ";" + s[m.end():]
    # 8. numeric constants
    m = re.search(r"\b(MAX_ITEMS|DAY|RATE_ONE)\b\s*=\s*([0-9e]+)( days)?;", s)
    if m and "constant" in s:
        yield "const-off-by-one", re.sub(r"=\s*([0-9]+)", lambda x: "= " + str(int(x.group(1)) + 1), s, 1) if m.group(2).isdigit() else s.replace("1e18", "1e17")
    # 9. remove a modifier
    if "nonReentrant" in s and "function" in s: yield "drop-nonReentrant", s.replace(" nonReentrant", "", 1)

def split_comment(line: str):
    i = line.find("//")
    return (line, "") if i < 0 else (line[:i].rstrip(), " " + line[i:])

def mutants(path: Path):
    lines = path.read_text().split("\n")
    in_block = False
    for i, line in enumerate(lines):
        if "/*" in line and "*/" not in line: in_block = True
        if in_block:
            if "*/" in line: in_block = False
            continue
        if SKIP.match(line) and not re.match(r"^\s*(delete|emit) ", line): continue
        seen = set()
        code, comment = split_comment(line)
        for op, new in line_mutants(code):
            if new == code or (op, new) in seen: continue
            seen.add((op, new))
            yield i, op, line, new + comment if new else ""

def run_tests(work: Path, timeout=240):
    t = time.time()
    try:
        env = dict(os.environ, FOUNDRY_INVARIANT_RUNS="32", FOUNDRY_INVARIANT_DEPTH="40")  # lighter invariant runs: a mutant only has to be caught once
        p = subprocess.run(["forge", "test", "-q", "--fail-fast"], cwd=work, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return "killed", "timeout", time.time() - t
    out = p.stdout + p.stderr
    if "Compiler run failed" in out or "Error (" in out and p.returncode != 0 and "FAIL" not in out and "Failing tests" not in out:
        return "invalid", "did not compile", time.time() - t
    return ("survived" if p.returncode == 0 else "killed"), "", time.time() - t

def main():
    args = sys.argv[1:]
    limit = None
    if "--limit" in args:
        i = args.index("--limit"); limit = int(args[i + 1]); del args[i:i + 2]
    files = args or DEFAULT_FILES
    work = Path(tempfile.mkdtemp(prefix="leash-mutation-"))
    for d in ("src", "test"): shutil.copytree(ROOT / d, work / d)
    shutil.copy(ROOT / "foundry.toml", work / "foundry.toml")
    (work / "lib").symlink_to(ROOT / "lib")
    base, _, secs = run_tests(work)
    if base != "survived":
        print("the unmodified contracts do not pass their own tests; aborting"); sys.exit(2)
    print(f"baseline passes ({secs:.0f}s). mutating {len(files)} file(s) in {work}\n", flush=True)
    results, n = [], 0
    for f in files:
        original = (work / f).read_text()
        lines = original.split("\n")
        for i, op, old, new in mutants(ROOT / f):
            if limit and n >= limit: break
            n += 1
            mutated = lines[:]; mutated[i] = new
            (work / f).write_text("\n".join(mutated))
            status, why, took = run_tests(work)
            (work / f).write_text(original)
            results.append({"file": f, "line": i + 1, "operator": op, "before": old.strip(), "after": new.strip(), "status": status, "note": why})
            print(f"{status.upper():9} {f}:{i+1:<4} {op:<22} {took:4.0f}s", flush=True)
    valid = [r for r in results if r["status"] != "invalid"]
    killed = [r for r in valid if r["status"] == "killed"]
    survivors = [r for r in valid if r["status"] == "survived"]
    summary = {"total": len(results), "invalid": len(results) - len(valid), "valid": len(valid), "killed": len(killed), "survived": len(survivors),
               "kill_rate": round(100 * len(killed) / len(valid), 1) if valid else None}
    (ROOT / "reports").mkdir(exist_ok=True)
    (ROOT / "reports" / "mutation.json").write_text(json.dumps({"summary": summary, "survivors": survivors, "results": results}, indent=2))
    print(f"\n{summary['killed']} of {summary['valid']} valid mutants killed ({summary['kill_rate']}%), {summary['survived']} survived, {summary['invalid']} did not compile.")
    for r in survivors: print(f"  SURVIVED {r['file']}:{r['line']} [{r['operator']}]  {r['before']}   ->   {r['after']}")
    shutil.rmtree(work, ignore_errors=True)

if __name__ == "__main__":
    main()
