"""Build a small first-screen GLB for slow Pages connections.

The preview reuses the final Draco geometry and only downscales embedded JPEG
textures. The full model remains the final quality source and is loaded in the
background by the standalone renderer.
"""
from pathlib import Path
import hashlib
import io
import json
from PIL import Image

from optimize_glb import chunks, write_glb

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/models/model.glb'
OUT = ROOT / 'public/models/model-preview.glb'
OUT_BIN = ROOT / 'public/models/model-preview.glb.bin'
MANIFEST = ROOT / 'docs/preview-model.json'


def encode_image(name: str, payload: bytes) -> tuple[bytes, dict]:
    image = Image.open(io.BytesIO(payload)).convert('RGB')
    source_size = image.size
    if name.startswith(('art-', 'modern-')):
        target = 256
        role = 'artwork'
    elif name == 'ivory_marble_medallion':
        target = 384
        role = 'medallion color'
    elif name.endswith(('color', 'color_4k')):
        target = 256
        role = 'color'
    else:
        target = 128
        role = 'normal/arm'
    image.thumbnail((target, target), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format='JPEG', quality=72, optimize=True, progressive=True)
    return output.getvalue(), {
        'name': name,
        'role': role,
        'sourceSize': source_size,
        'previewSize': image.size,
        'bytes': len(payload),
        'previewBytes': output.tell(),
    }


def main() -> None:
    if not SOURCE.exists():
        raise FileNotFoundError(SOURCE)
    document, binary = chunks(SOURCE)
    image_by_view = {image['bufferView']: index for index, image in enumerate(document.get('images', []))}
    replacements: dict[int, bytes] = {}
    report: list[dict] = []
    for index, image in enumerate(document.get('images', [])):
        view = document['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        payload = binary[start:start + view['byteLength']]
        encoded, row = encode_image(image.get('name', f'image-{index}'), payload)
        replacements[index] = encoded
        report.append(row)

    output_binary = bytearray()
    for view_index, view in enumerate(document['bufferViews']):
        image_index = image_by_view.get(view_index)
        payload = replacements.get(image_index)
        if payload is None:
            start = view.get('byteOffset', 0)
            payload = binary[start:start + view['byteLength']]
        output_binary += b'\0' * (-len(output_binary) % 4)
        view['byteOffset'] = len(output_binary)
        view['byteLength'] = len(payload)
        output_binary += payload

    for index, image in enumerate(document.get('images', [])):
        image['mimeType'] = 'image/jpeg'
        image['name'] = image.get('name', f'image-{index}') + '_PREVIEW'

    document['buffers'][0]['byteLength'] = len(output_binary)
    write_glb(OUT, document, bytes(output_binary))
    # GitHub Pages gzip-compresses model/gltf-binary on the fly, which breaks
    # byte-range reassembly; the .bin alias is served uncompressed for ranged loads.
    OUT_BIN.write_bytes(OUT.read_bytes())

    check, check_binary = chunks(OUT)
    assert check['buffers'][0]['byteLength'] == len(check_binary)
    for view in check['bufferViews']:
        assert view.get('byteOffset', 0) % 4 == 0
        assert view.get('byteOffset', 0) + view['byteLength'] <= len(check_binary)

    manifest = {
        'source': str(SOURCE.relative_to(ROOT)),
        'preview': str(OUT.relative_to(ROOT)),
        'sourceBytes': SOURCE.stat().st_size,
        'previewBytes': OUT.stat().st_size,
        'previewSha256': hashlib.sha256(OUT.read_bytes()).hexdigest(),
        'previewBin': str(OUT_BIN.relative_to(ROOT)),
        'selection': 'Preview GLB loads the scene first; the full ASTC or portable model then upgrades in the background.',
        'textures': report,
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: manifest[key] for key in ('sourceBytes', 'previewBytes', 'previewSha256')}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
