#!/usr/bin/env python3
"""Compare explicitly matched, inspected PNG states; never align, resize or mask."""
import argparse
import hashlib
import html
import json
import re
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

Image.MAX_IMAGE_PIXELS = 16_000_000
STATE_FIELDS = ("page", "theme", "fixtureDigest", "viewport", "deviceScaleFactor",
                "locale", "zoom", "scroll", "selection", "responseState")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def capture(base, entry, output, label):
    if not isinstance(entry, dict) or entry.get("inspected") is not True:
        raise ValueError(f"{label}: screenshot has not been inspected")
    for key in ("product", "version", "capturedAt", "file"):
        if not isinstance(entry.get(key), str) or not entry[key].strip():
            raise ValueError(f"{label}: missing {key}")
    state = entry.get("state")
    if not isinstance(state, dict) or any(key not in state for key in STATE_FIELDS):
        raise ValueError(f"{label}: incomplete same-state metadata")
    viewport = state["viewport"]
    if (not isinstance(viewport, list) or len(viewport) != 2 or
            any(type(v) is not int or v <= 0 for v in viewport) or
            not isinstance(state["deviceScaleFactor"], (int, float)) or
            not math.isfinite(state["deviceScaleFactor"]) or state["deviceScaleFactor"] <= 0 or
            not isinstance(state["fixtureDigest"], str) or
            not re.fullmatch(r"[a-f0-9]{64}", state["fixtureDigest"])):
        raise ValueError(f"{label}: invalid viewport, DPR or fixture digest")
    source = (base / entry["file"]).resolve()
    if not source.is_file() or source.stat().st_size > 64 * 1024 * 1024:
        raise ValueError(f"{label}: missing PNG or file exceeds 64MiB")
    with Image.open(source) as original:
        if original.format != "PNG" or original.width * original.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError(f"{label}: expected bounded PNG")
        original.load()
        image = original.convert("RGBA")
    original_size = list(image.size)
    crop = entry.get("contentCrop")
    if crop is not None:
        if (not isinstance(crop, list) or len(crop) != 4 or
                any(type(v) is not int for v in crop) or
                not (0 <= crop[0] < crop[2] <= image.width and 0 <= crop[1] < crop[3] <= image.height)):
            raise ValueError(f"{label}: invalid explicit contentCrop")
        image = image.crop(crop)
    image.save(output / f"{label}.png")
    return image, {"product": entry["product"], "version": entry["version"],
                   "capturedAt": entry["capturedAt"], "sourceSHA256": digest(source),
                   "originalSize": original_size, "contentCrop": crop,
                   "comparedSize": list(image.size), "state": state}


def compare_pair(base, output, pair):
    result = {"id": pair["id"], "status": "blocked"}
    target = output / pair["id"]
    target.mkdir()
    try:
        left, ref = capture(base, pair.get("reference"), target, "reference")
        right, actual = capture(base, pair.get("workbench"), target, "workbench")
        result.update(reference=ref, workbench=actual)
        if ref["product"] == actual["product"]:
            raise ValueError("reference and workbench product identities must differ")
        if ref["state"] != actual["state"]:
            raise ValueError("same-state metadata differs; not a valid pixel comparison")
        if left.size != right.size:
            raise ValueError("content dimensions differ; resizing/alignment is not permitted")
        delta = ImageChops.difference(left, right)
        channels = delta.split()
        maximum = channels[0]
        for channel in channels[1:]:
            maximum = ImageChops.lighter(maximum, channel)
        histogram = maximum.histogram()
        total = left.width * left.height
        changed = total - histogram[0]
        binary = maximum.point(lambda value: 255 if value else 0)
        heatmap = Image.new("RGB", left.size, "#151515")
        heatmap.paste("#ff3366", mask=binary)
        heatmap.save(target / "difference.png")
        Image.blend(left, right, 0.5).save(target / "overlay.png")
        result.update(status="exact" if changed == 0 else "different",
                      comparedPixels=total, changedPixels=changed,
                      changedFraction=changed / total,
                      meanAbsoluteChannelError=sum(ImageStat.Stat(delta).mean) / 4,
                      maxChannelError=max(i for i, count in enumerate(histogram) if count),
                      changedBounds=maximum.getbbox(),
                      interpretation="Exact RGBA comparison, no tolerance, masks, resizing or alignment")
    except (ValueError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        result["reason"] = str(error)
    return result


def build_report(manifest, output):
    manifest = Path(manifest).resolve()
    if manifest.stat().st_size > 1024 * 1024:
        raise ValueError("manifest exceeds 1MiB")
    data = json.loads(manifest.read_text(encoding="utf-8"))
    pairs = data.get("pairs")
    if data.get("version") != 1 or not isinstance(pairs, list) or not 1 <= len(pairs) <= 100:
        raise ValueError("expected version 1 and 1..100 pairs")
    ids = [p.get("id") if isinstance(p, dict) else None for p in pairs]
    if any(not isinstance(i, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}", i) for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("pair IDs must be unique safe filenames")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    results = [compare_pair(manifest.parent, output, pair) for pair in pairs]
    status = "blocked" if any(r["status"] == "blocked" for r in results) else (
        "different" if any(r["status"] == "different" for r in results) else "exact")
    report = {"version": 1, "status": status, "manifestSHA256": digest(manifest),
              "limits": "Screenshot geometry/color comparison only; not behavior or accessibility certification. Explicit crops exclude only the recorded source region; whole-window equality is not inferred.",
              "pairs": results}
    (output / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    sections = []
    for result in results:
        identity = result["id"]
        details = html.escape(json.dumps(result, indent=2, ensure_ascii=False))
        images = "".join(f'<figure><figcaption>{name}</figcaption><img src="{identity}/{name}.png" alt="{identity} {name}"></figure>'
                         for name in ("reference", "workbench", "difference", "overlay")
                         if (output / identity / f"{name}.png").is_file())
        sections.append(f'<section><h2>{identity}: {result["status"]}</h2><div>{images}</div><pre>{details}</pre></section>')
    page = '<!doctype html><meta charset="utf-8"><title>Same-state pixel evidence</title><style>body{font:14px system-ui;margin:24px;background:#fafafa;color:#111}section{margin:24px 0}section div{display:flex;flex-wrap:wrap}figure{margin:8px;max-width:46%}img{max-width:100%;border:1px solid #aaa}pre{white-space:pre-wrap}</style>'
    page += f'<h1>Same-state pixel evidence: {status}</h1><p>{html.escape(report["limits"])}</p>' + "".join(sections)
    (output / "report.html").write_text(page, encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("output", help="New output directory; existing directories are never overwritten")
    args = parser.parse_args()
    try:
        report = build_report(args.manifest, args.output)
        print(json.dumps({"status": report["status"], "pairs": len(report["pairs"]), "report": str(Path(args.output) / "report.html")}))
        raise SystemExit({"exact": 0, "different": 1, "blocked": 2}[report["status"]])
    except (ValueError, OSError) as error:
        parser.exit(2, str(error) + "\n")
