import bpy,sys,argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
p=argparse.ArgumentParser(); p.add_argument('--views',nargs='+',default=['exterior','american','modern','dining']); p.add_argument('--samples',type=int,default=32); p.add_argument('--width',type=int,default=1280)
a=p.parse_args(argv)
cameras={'exterior':'CAM_Exterior','american':'CAM_American6F','modern':'CAM_Modern5F','dining':'CAM_Dining6F'}
scene=bpy.context.scene
scene.render.engine='CYCLES'; scene.cycles.samples=a.samples; scene.cycles.use_denoising=True
scene.render.resolution_x=a.width; scene.render.resolution_y=round(a.width*.75); scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
for view in a.views:
    scene.camera=bpy.data.objects[cameras[view]]
    scene.render.filepath=str(ROOT/'docs'/'previews'/f'{view}.png')
    bpy.ops.render.render(write_still=True)
    print('RENDERED',scene.render.filepath,flush=True)
