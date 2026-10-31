import bpy,sys,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from build import triangle_count
obj=bpy.data.objects['EDIT_F05_LeftModernSofa_LowBase']
print('OBJECT',obj.name,'DIMS',tuple(obj.dimensions),'SCALE',tuple(obj.scale),'BASE',len(obj.data.vertices),len(obj.data.polygons),flush=True)
for mod in obj.modifiers:
    print('MODIFIER',mod.name,mod.type,flush=True)
    for prop in mod.bl_rna.properties:
        if prop.is_readonly or prop.identifier in {'rna_type'}:
            continue
        try:
            value=getattr(mod,prop.identifier)
            if not hasattr(value,'bl_rna'):
                print(prop.identifier,repr(value),flush=True)
        except Exception:
            pass
print('COUNT_BOTH',triangle_count([obj]),flush=True)
obj.modifiers['Weighted_Normals'].show_viewport=False
bpy.context.view_layer.update()
print('COUNT_BEVEL',triangle_count([obj]),flush=True)
obj.modifiers['Soft_Edges'].show_viewport=False
bpy.context.view_layer.update()
print('COUNT_NONE',triangle_count([obj]),flush=True)
obj.modifiers['Soft_Edges'].show_viewport=True
obj.modifiers['Weighted_Normals'].show_viewport=True
obj.modifiers['Soft_Edges'].segments=1
bpy.context.view_layer.update()
print('COUNT_SEGMENT1',triangle_count([obj]),flush=True)
