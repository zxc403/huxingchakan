"""Repack a Draco GLB with ASTC 4x4 KTX2 textures, preserving all bufferView indices.
Run with the project-managed Python; toktx is the signed official Khronos release.
The uncompressed model.glb is retained as model.uncompressed.glb for comparison.
"""
from pathlib import Path
import json, struct, shutil, subprocess, io, hashlib
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/models/model.uncompressed.glb'
ORIGINAL = ROOT / 'public/models/model.glb'
OUT = ROOT / 'public/models/model-astc.glb'
WORK = ROOT / 'tools/texture-work'
TOKTX = ROOT / 'tools/ktx/bin/toktx.exe'

def chunks(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from('<4sII', data)
    assert magic == b'glTF' and version == 2 and length == len(data)
    offset, document, binary = 12, None, b''
    while offset < len(data):
        size, kind = struct.unpack_from('<II', data, offset)
        payload = data[offset + 8:offset + 8 + size]
        if kind == 0x4E4F534A: document = json.loads(payload)
        elif kind == 0x004E4942: binary = payload
        offset += 8 + size
    return document, binary

def write_glb(path, document, binary):
    text = json.dumps(document, ensure_ascii=False, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    binary += b'\0' * (-len(binary) % 4)
    payload = struct.pack('<II', len(text), 0x4E4F534A) + text + struct.pack('<II', len(binary), 0x004E4942) + binary
    path.write_bytes(struct.pack('<4sII', b'glTF', 2, 12 + len(payload)) + payload)

def main():
    if not ORIGINAL.exists(): raise FileNotFoundError(ORIGINAL)
    if not SOURCE.exists(): shutil.copy2(ORIGINAL, SOURCE)
    document, binary = chunks(SOURCE)
    WORK.mkdir(parents=True, exist_ok=True)
    replaced, report = {}, []
    for index, image in enumerate(document.get('images', [])):
        view = document['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        source = binary[start:start + view['byteLength']]
        im = Image.open(io.BytesIO(source))
        original_size = im.size
        name = image.get('name', f'image-{index}')
        if name.startswith(('art-', 'modern-')):
            report.append({'name': name, 'sourceSize': original_size, 'encoding': 'JPEG retained'})
            continue
        size = 2048 if name == 'ivory_marble_medallion' else 1024 if name.endswith(('color', 'color_4k')) else 512
        color = name.endswith(('color', 'color_4k')) or name == 'ivory_marble_medallion'
        im = im.convert('RGBA' if im.mode == 'RGBA' else 'RGB')
        im.thumbnail((size, size), Image.Resampling.LANCZOS)
        png = WORK / f'{index:02d}-{name}.png'
        ktx = WORK / f'{index:02d}-{name}.ktx2'
        im.save(png, optimize=True)
        command = [str(TOKTX), '--t2', '--genmipmap', '--threads', '4', '--encode', 'astc', '--astc_blk_d', '4x4', '--astc_quality', 'fast', '--assign_oetf', 'srgb' if color else 'linear', str(ktx), str(png)]
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=150)
        encoded = ktx.read_bytes()
        assert encoded[:12] == bytes.fromhex('AB4B5458203230BB0D0A1A0A'), 'Not KTX2'
        # vkFormat 157/158 are ASTC_4x4_UNORM/SRGB; reject accidental UASTC substitution.
        vk_format = struct.unpack_from('<I', encoded, 12)[0]
        assert vk_format in (157, 158), (name, vk_format)
        replaced[index] = encoded
        report.append({'name': name, 'sourceSize': original_size, 'runtimeSize': im.size, 'encoding': 'ASTC 4x4 + mipmaps', 'transfer': 'sRGB' if color else 'linear', 'vkFormat': vk_format, 'bytes': len(encoded)})
        print(f'{name}: {original_size} -> {im.size}, {len(encoded)} bytes, ASTC4x4', flush=True)
    out_bin = bytearray()
    for i, view in enumerate(document['bufferViews']):
        image_index = next((index for index, image in enumerate(document['images']) if image['bufferView'] == i), None)
        if image_index in replaced:
            payload = replaced[image_index]
        else:
            start = view.get('byteOffset', 0)
            payload = binary[start:start + view['byteLength']]
        out_bin += b'\0' * (-len(out_bin) % 4)
        view['byteOffset'] = len(out_bin)
        view['byteLength'] = len(payload)
        out_bin += payload
    for index, payload in replaced.items():
        image = document['images'][index]
        image['mimeType'] = 'image/ktx2'
        image['name'] = image.get('name', f'image-{index}') + '_ASTC4x4'
    for texture in document.get('textures', []):
        if 'source' in texture and texture['source'] in replaced:
            texture.setdefault('extensions', {})['KHR_texture_basisu'] = {'source': texture.pop('source')}
    for field in ('extensionsUsed', 'extensionsRequired'):
        values = document.setdefault(field, [])
        if 'KHR_texture_basisu' not in values: values.append('KHR_texture_basisu')
    document.setdefault('asset', {})['copyright'] = '3栋51# user project; Poly Haven CC0 textures; see docs/credits.md'
    document['buffers'][0]['byteLength'] = len(out_bin)
    write_glb(OUT, document, bytes(out_bin))
    # ASTC is selected only on supporting devices. Keep model.glb portable for desktops
    # and for the editor, whose GPU capabilities are not exposed to scene code.
    check, check_bin = chunks(OUT)
    assert len(check['bufferViews']) == len(document['bufferViews'])
    assert len(check_bin) == document['buffers'][0]['byteLength']
    for view in check['bufferViews']:
        assert view.get('byteOffset', 0) % 4 == 0
        assert view.get('byteOffset', 0) + view['byteLength'] <= len(check_bin)
    shutil.copy2(SOURCE, ORIGINAL)
    manifest = {
        'source': str(SOURCE.relative_to(ROOT)),
        'portable': str(ORIGINAL.relative_to(ROOT)),
        'astc': str(OUT.relative_to(ROOT)),
        'sourceBytes': SOURCE.stat().st_size,
        'portableBytes': ORIGINAL.stat().st_size,
        'astcBytes': OUT.stat().st_size,
        'astcSha256': hashlib.sha256(OUT.read_bytes()).hexdigest(),
        'selection': 'ASTC 4x4 only when supported; otherwise portable JPEG/PNG textures',
        'textures': report,
    }
    (ROOT / 'docs/texture-optimization.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: manifest[k] for k in ('sourceBytes','portableBytes','astcBytes','astcSha256')}, indent=2), flush=True)

if __name__ == '__main__': main()
