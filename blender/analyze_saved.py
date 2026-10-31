import bpy,sys,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from build import model_objects,triangle_count,optimize_static
optimize_static()
bpy.context.view_layer.update()
rows=[]
for obj in model_objects():
    if obj.type!='MESH':
        continue
    count=triangle_count([obj])
    rows.append({'name':obj.name,'triangles':count,'vertices':len(obj.data.vertices),'polygons':len(obj.data.polygons),'modifiers':[(m.type,m.name) for m in obj.modifiers]})
rows.sort(key=lambda row:row['triangles'],reverse=True)
report={'total':sum(row['triangles'] for row in rows),'objects':len(rows),'top':rows[:60]}
(ROOT/'docs'/'triangle-analysis.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2),flush=True)
