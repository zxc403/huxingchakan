import bpy,json,struct,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from build import triangle_count

def glb_json(path):
    data=path.read_bytes()
    magic,version,length=struct.unpack_from('<4sII',data,0)
    assert magic==b'glTF' and version==2 and length==len(data)
    chunk_length,chunk_type=struct.unpack_from('<II',data,12)
    assert chunk_type==0x4E4F534A
    return json.loads(data[20:20+chunk_length])

def reset():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)

def inspect(path):
    reset()
    before=set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    objects=[obj for obj in bpy.data.objects if obj not in before]
    meshes=[obj for obj in objects if obj.type=='MESH']
    arms=[obj for obj in objects if obj.type=='ARMATURE']
    document=glb_json(path)
    return {
        'file_bytes':path.stat().st_size,
        'objects':len(objects),
        'mesh_objects':len(meshes),
        'triangles':triangle_count(meshes),
        'materials':len(document.get('materials',[])),
        'images':len(document.get('images',[])),
        'extensions_used':document.get('extensionsUsed',[]),
        'extensions_required':document.get('extensionsRequired',[]),
        'bones':sum(len(arm.data.bones) for arm in arms),
        'actions':sorted(action.name for action in bpy.data.actions),
        'animations':[clip.get('name','') for clip in document.get('animations',[])],
        'unresolved_external_images':[image for image in document.get('images',[]) if 'uri' in image and 'bufferView' not in image],
    }

report={}
for name in ('model','collision','character'):
    print('REIMPORT',name,flush=True)
    report[name]=inspect(ROOT/'public'/'models'/f'{name}.glb')
    print(json.dumps(report[name],ensure_ascii=False),flush=True)
assert report['model']['triangles']<=2_000_000
assert report['model']['materials']>0 and report['model']['images']>0
assert not report['model']['unresolved_external_images']
assert report['collision']['triangles']>0
assert report['character']['bones']==22
assert set(report['character']['animations'])=={'idle','walk','run','jump'}
(ROOT/'docs'/'verification-glb.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('GLB_REIMPORT_VERIFIED',flush=True)
