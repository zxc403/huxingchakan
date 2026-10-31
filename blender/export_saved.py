import bpy,json,time,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from build import model_objects,triangle_count,optimize_static,export_glb
started=time.time()
print('OPTIMIZE saved scene',flush=True)
optimize_static()
objects=[o for o in model_objects() if o.type=='MESH' or (o.type=='EMPTY' and o.name.startswith('EDIT_'))]
arm=bpy.data.objects['CharacterRig']; avatar=bpy.data.objects['Character_SkinnedMesh']
stats={'objects_after_batch':len(objects),'building_triangles':triangle_count(objects),
       'collision_triangles':triangle_count(list(bpy.data.collections['COLLISION'].objects)),
       'avatar_triangles':triangle_count([avatar])}
assert stats['building_triangles']<=2_000_000,stats
export_glb(ROOT/'public'/'models'/'model.glb',objects,animations=False,draco=True)
export_glb(ROOT/'public'/'models'/'collision.glb',list(bpy.data.collections['COLLISION'].objects),draco=False,materials=False)
export_glb(ROOT/'public'/'models'/'character.glb',[arm,avatar],animations=True,draco=False)
stats['seconds']=round(time.time()-started,2)
stats['files']={p.name:p.stat().st_size for p in (ROOT/'public'/'models').glob('*.glb')}
(ROOT/'docs'/'export-stats.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf-8')
print('EXPORT_VERIFIED',json.dumps(stats,ensure_ascii=False),flush=True)
