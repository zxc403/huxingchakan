"""Split runtime GLBs into parallel-download part files for the Pages build.

GitHub Pages throttles a single large request to roughly modem speeds, while
several concurrent requests each get their own share. Each part is a plain
static file, so Content-Encoding (gzip) is applied per part and transparently
undone by the browser, unlike byte-range slices of an on-the-fly-compressed
response, which reassemble into garbage.

For every source model this writes `<name>.part-NN` chunks plus a
`<name>.parts.json` manifest with part paths, byte sizes and the SHA-256 of the
reassembled model. Reassembly is verified against the source bytes.
"""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / 'public/models'
# Smaller models are the critical path, so they get relatively more parts.
PLAN = {
    'model-preview.glb': 4,
    'character.glb': 1,
    'collision.glb': 2,
    'model-astc.glb': 8,
    'model.glb': 8,
}


def split_model(name: str, part_count: int) -> dict:
    source = MODELS_DIR / name
    payload = source.read_bytes()
    total = len(payload)
    part_count = max(1, min(part_count, total))
    base = total // part_count
    remainder = total % part_count
    manifest = {
        'model': f'models/{name}',
        'bytes': total,
        'sha256': hashlib.sha256(payload).hexdigest(),
        'parts': [],
        'partBytes': [],
    }
    offset = 0
    for index in range(part_count):
        size = base + (1 if index < remainder else 0)
        part_name = f'{name}.part-{index:02d}'
        part_path = MODELS_DIR / part_name
        part_path.write_bytes(payload[offset:offset + size])
        manifest['parts'].append(f'models/{part_name}')
        manifest['partBytes'].append(size)
        offset += size
    assert offset == total
    # Drop stale parts if the count shrank.
    stale = sorted(MODELS_DIR.glob(f'{name}.part-*'))
    for path in stale:
        if f'models/{path.name}' not in manifest['parts']:
            path.unlink()
    # Verify reassembly byte for byte.
    rebuilt = b''.join((MODELS_DIR / Path(p).name).read_bytes() for p in manifest['parts'])
    assert rebuilt == payload, f'reassembly mismatch for {name}'
    manifest_path = MODELS_DIR / f'{name}.parts.json'
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return {
        'model': name,
        'bytes': total,
        'parts': part_count,
        'partSizeMin': min(manifest['partBytes']),
        'partSizeMax': max(manifest['partBytes']),
        'sha256': manifest['sha256'],
    }


def main() -> None:
    summary = [split_model(name, count) for name, count in PLAN.items()]
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
