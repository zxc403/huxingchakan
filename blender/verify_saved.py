import bpy,json,sys
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from build import triangle_count
bpy.context.view_layer.update()
depsgraph=bpy.context.evaluated_depsgraph_get()
points=[]
for obj in bpy.data.collections['SHELL'].objects:
    if obj.type!='MESH': continue
    evaluated=obj.evaluated_get(depsgraph)
    points.extend([evaluated.matrix_world@Vector(corner) for corner in evaluated.bound_box])
minimum=[min(p[i] for p in points) for i in range(3)]
maximum=[max(p[i] for p in points) for i in range(3)]
dimensions=[round(maximum[i]-minimum[i],4) for i in range(3)]
themes={}
for floor in range(1,7):
    counts={'leather':0,'ivory_fabric':0,'medallion':0,'structural_slabs':0,'objects':0}
    for obj in bpy.data.collections[f'F{floor:02d}'].objects:
        counts['objects']+=1
        if 'StructuralSlab' in obj.name: counts['structural_slabs']+=1
        if obj.type=='MESH':
            names=[m.name for m in obj.data.materials if m]
            counts['leather']+=any('BlackLeather' in n for n in names)
            counts['ivory_fabric']+=any('IvoryFabric' in n for n in names)
            counts['medallion']+=any('FloralMarbleInlay' in n for n in names)
    themes[f'F{floor:02d}']=counts
avatar=bpy.data.objects['Character_SkinnedMesh']
report={'outer_shell_dimensions_m':dimensions,'outer_min':minimum,'outer_max':maximum,'themes':themes,
        'avatar_bones':len(bpy.data.objects['CharacterRig'].data.bones),'avatar_triangles':triangle_count([avatar]),
        'actions':[a.name for a in bpy.data.actions],'material_count':len(bpy.data.materials)}
assert abs(dimensions[0]-17.2)<=0.03,dimensions
assert abs(dimensions[1]-14.9)<=0.03,dimensions
for floor in range(2,6):
    assert themes[f'F{floor:02d}']['leather']>0,themes
    assert themes[f'F{floor:02d}']['medallion']==0,themes
assert themes['F06']['ivory_fabric']>0 and themes['F06']['medallion']>0,themes
assert set(report['actions'])=={'idle','walk','run','jump'},report['actions']
assert report['avatar_bones']==22 and report['avatar_triangles']<20000
(ROOT/'docs'/'verification-blend.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print('VERIFIED',json.dumps(report,ensure_ascii=False),flush=True)
