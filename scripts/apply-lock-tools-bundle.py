#!/usr/bin/env python3
import json, pathlib, sys
bundle = json.load(open(sys.argv[1]))
for path, content in bundle.items():
    p = pathlib.Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    print("wrote", path, len(content))
