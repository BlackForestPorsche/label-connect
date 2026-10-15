import pathlib, re, subprocess

patch = pathlib.Path("tmp/first-unlock/p1.patch")
text = patch.read_text()
bad = "\n }\n \n   function publish(session) {"
good = "\n   }\n \n   function publish(session) {"
assert bad in text
patch.write_text(text.replace(bad, good))
subprocess.check_call(["git", "apply", "--whitespace=nowarn", str(patch)])

p = pathlib.Path("test/desk-lock-unlock-gaps.test.mjs")
lines = p.read_text().split("\n")
start = next(i for i, l in enumerate(lines) if l.startswith("const root ="))
gap = next(i for i, l in enumerate(lines) if l.startswith("const GAP"))
world = "\n".join(lines[start:gap])
helper = (
    'import fs from "node:fs";\nimport path from "node:path";\nimport vm from "node:vm";\n'
    'import { fileURLToPath } from "node:url";\n\n'
    + world.replace(
        "const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));",
        "const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));",
    )
    .replace('const GATE = "bf_shop_gate";', 'export const GATE = "bf_shop_gate";')
    .replace("function makeWorld()", "export function makeWorld()")
    .rstrip()
    + "\n"
)
pathlib.Path("test/helpers").mkdir(exist_ok=True)
pathlib.Path("test/helpers/desk-world.mjs").write_text(helper)
head = "\n".join(lines[:start])
body = head + '\nimport { GATE, makeWorld } from "./helpers/desk-world.mjs";\n\n' + "\n".join(lines[gap:])
body = re.sub(r'^import (fs|path|vm) from "node:(fs|path|vm)";\n', "", body, flags=re.M)
body = body.replace('import { fileURLToPath } from "node:url";\n', "")
i = body.index('test("/unlock because the gate ran out is expiry')
body = body[:i] + pathlib.Path("tmp/first-unlock/last-test.txt").read_text()
p.write_text(body)
