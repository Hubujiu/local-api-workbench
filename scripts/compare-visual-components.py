#!/usr/bin/env python3
"""Pinned, same-coordinate component crops over the strict same-state comparator."""
import argparse
import copy
import importlib.util
import json
import math
import re
from pathlib import Path
from PIL import Image

spec = importlib.util.spec_from_file_location('strict_visual', Path(__file__).with_name('compare-visual-states.py'))
strict = importlib.util.module_from_spec(spec)
spec.loader.exec_module(strict)


def rectangle(value, size):
    if (not isinstance(value, list) or len(value) != 4 or any(type(x) is not int for x in value)
            or not (0 <= value[0] < value[2] <= size[0] and 0 <= value[1] < value[3] <= size[1])):
        raise ValueError('Invalid explicit pixel rectangle')
    return value


def pinned_source(base, entry):
    if not isinstance(entry, dict):
        raise ValueError('Missing capture pair')
    expected = entry.get('sha256')
    if not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected):
        raise ValueError('Independent immutable capture SHA256 required')
    source = (base / entry['file']).resolve()
    if source.stat().st_size > 64 * 1024 * 1024 or strict.digest(source) != expected:
        raise ValueError('Capture digest mismatch or size limit')
    state = entry['state']
    viewport, scale = state['viewport'], state['deviceScaleFactor']
    if (not isinstance(viewport, list) or len(viewport) != 2 or any(type(x) is not int or x <= 0 for x in viewport)
            or type(scale) not in (int, float) or not math.isfinite(scale) or scale <= 0):
        raise ValueError('Invalid original viewport/DPR')
    size = [x * scale for x in viewport]
    if any(not float(x).is_integer() for x in size):
        raise ValueError('Nonintegral screenshot dimensions')
    # Explicit metadata for a screenshot already cropped for privacy; never infer viewport from its file size.
    region = rectangle(entry.get('sourceViewportCrop', [0, 0, *map(int, size)]), size)
    with Image.open(source) as image:
        if image.format != 'PNG' or image.width * image.height > strict.Image.MAX_IMAGE_PIXELS:
            raise ValueError('Bounded PNG required')
        if list(image.size) != [region[2]-region[0], region[3]-region[1]]:
            raise ValueError('PNG dimensions disagree with original viewport/crop metadata')
    if 'contentCrop' in entry:
        raise ValueError('Use sourceViewportCrop, not a hidden second contentCrop')
    return source, region


def build_report(manifest, output):
    manifest, output = Path(manifest).resolve(), Path(output).resolve()
    if manifest.stat().st_size > 1024 * 1024:
        raise ValueError('Manifest exceeds 1MiB')
    data = json.loads(manifest.read_text())
    if not isinstance(data, dict):
        raise ValueError('Manifest must be an object')
    components = data.get('components')
    if data.get('version') != 1 or not isinstance(components, list) or not 1 <= len(components) <= 100:
        raise ValueError('Expected version 1 and 1..100 required components')
    ids = [c.get('id') if isinstance(c, dict) else None for c in components]
    if any(not isinstance(i, str) or not re.fullmatch('[a-z0-9][a-z0-9_-]{0,79}', i) for i in ids) or len(set(ids)) != len(ids):
        raise ValueError('Unique safe component IDs required')
    output.mkdir(parents=True, exist_ok=False)
    derived, details = [], []
    for component in components:
        pair = {'id': component['id'], 'reference': None, 'workbench': None}
        detail = {'id': component['id'], 'region': component.get('region')}
        try:
            ref, actual = component.get('reference'), component.get('workbench')
            if not isinstance(ref, dict) or not isinstance(actual, dict) or ref.get('state') != actual.get('state'):
                raise ValueError('Missing pair or mismatched full fixture/state metadata')
            sources = [pinned_source(manifest.parent, entry) for entry in (ref, actual)]
            if sources[0][1] != sources[1][1]:
                raise ValueError('Source viewport crops differ; alignment prohibited')
            available = sources[0][1]
            region = rectangle(component.get('region'), available[2:])
            if region[0] < available[0] or region[1] < available[1]:
                raise ValueError('Component lies outside captured viewport crop')
            for key, entry, (source, _) in zip(('reference', 'workbench'), (ref, actual), sources):
                pair[key] = copy.deepcopy(entry)
                pair[key]['file'] = str(source)
                pair[key]['contentCrop'] = [region[0]-available[0], region[1]-available[1], region[2]-available[0], region[3]-available[1]]
        except (ValueError, OSError, KeyError, TypeError, Image.DecompressionBombError) as error:
            pair['reference'] = pair['workbench'] = None
            detail['blockedReason'] = str(error)
        derived.append(pair)
        details.append(detail)
    generated = output / 'derived-pairs.json'
    generated.write_text(json.dumps({'version': 1, 'pairs': derived}, indent=2))
    result = strict.build_report(generated, output / 'comparison')
    report = {'version': 1, 'status': result['status'], 'scope': 'Only explicitly listed components; never whole-screen or behavior acceptance',
              'sourceManifestSHA256': strict.digest(manifest), 'components': details, 'comparison': result}
    (output / 'component-report.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest')
    parser.add_argument('output')
    args = parser.parse_args()
    try:
        report = build_report(args.manifest, args.output)
        print(json.dumps({'status': report['status'], 'report': str(Path(args.output) / 'component-report.json')}))
        raise SystemExit({'exact': 0, 'different': 1, 'blocked': 2}[report['status']])
    except (ValueError, OSError) as error:
        parser.exit(2, str(error) + '\n')
