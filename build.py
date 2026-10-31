"""3栋51# parametric building, interior and avatar pipeline.
Run: blender --background --factory-startup --python-exit-code 1 --python build.py
Optional arguments after `--`: --no-render --no-export
"""
from pathlib import Path
import sys
import json
import math
import time
import argparse
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from blender.config import MODEL_DIR, DOCS_DIR, PREVIEW_DIR, FLOOR_Z
from blender.materials import create_materials
from blender.building import build_building
from blender.furniture import build_standard_interior
from blender.modern import build_modern_interior
from blender.character import build_character
from blender import geometry as g


def parse_args():
    argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument('--no-render', action='store_true')
    parser.add_argument('--no-export', action='store_true')
    return parser.parse_args(argv)


def duplicate_theme_floor(source_floor,target_floor,source_objects,source_colliders):
    target = g.collection(f'F{target_floor:02d}')
    dz = (target_floor-source_floor)*3.0
    mapping = {}
    for obj in source_objects:
        copy = obj.copy()
        if obj.data:
            # Modifier application during static batching must never alter the editable source mesh.
            copy.data = obj.data.copy()
        copy.name = obj.name.replace(f'EDIT_F{source_floor:02d}',f'F{target_floor:02d}').replace(f'F{source_floor:02d}',f'F{target_floor:02d}')
        target.objects.link(copy)
        mapping[obj] = copy
    for obj,copy in mapping.items():
        copy.parent = mapping.get(obj.parent)
        if obj.parent is None:
            copy.location.z += dz
    for obj in source_colliders:
        copy = obj.copy()
        copy.data = obj.data
        copy.name = obj.name.replace(f'F{source_floor:02d}',f'F{target_floor:02d}')
        bpy.data.collections['COLLISION'].objects.link(copy)
        copy.location.z += dz


def point_at(obj, target):
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()


def camera(name, location, target, lens=28):
    data = bpy.data.cameras.new(name)
    obj = bpy.data.objects.new(name,data)
    g.collection('CAMERAS').objects.link(obj)
    obj.location = location
    data.lens = lens
    data.clip_start = 0.05
    data.clip_end = 300
    point_at(obj,target)
    return obj


def area(name, location, target, energy, size, color=(1.0,0.83,0.64)):
    data = bpy.data.lights.new(name,'AREA')
    data.energy = energy
    data.shape = 'DISK'
    data.size = size
    data.color = color
    obj = bpy.data.objects.new(name,data)
    g.collection('LIGHTS').objects.link(obj)
    obj.location = location
    point_at(obj,target)
    return obj


def setup_presentation():
    scene = bpy.context.scene
    world = bpy.data.worlds.new('Warm_Daylight')
    world.use_nodes = True
    background = next(n for n in world.node_tree.nodes if n.type=='BACKGROUND')
    background.inputs['Color'].default_value = (0.72,0.82,1.0,1)
    background.inputs['Strength'].default_value = 0.42
    scene.world = world
    sun_data = bpy.data.lights.new('Sun','SUN')
    sun_data.energy = 2.2
    sun_data.angle = math.radians(12)
    sun = bpy.data.objects.new('Sun',sun_data)
    g.collection('LIGHTS').objects.link(sun)
    sun.rotation_euler = (math.radians(28),math.radians(-24),math.radians(-28))
    area('South_Softbox',(0,-12,16),(0,0,7),2400,12,(1.0,0.88,0.72))
    area('F06_Left_Living_Warm',(-1.4,-5.2,18.25),(-1.4,-5.2,15.6),180,3.0)
    area('F06_Right_Living_Warm',(2.7,-5.2,18.25),(2.7,-5.2,15.6),180,3.0)
    area('F06_Left_Dining_Warm',(-3.2,-0.2,18.2),(-3.2,-0.2,15.6),130,2.4)
    area('F05_Left_Living',(-1.4,-5.2,15.25),(-1.4,-5.2,12.6),150,3.0,(0.92,0.95,1.0))
    cameras = {
        'exterior': camera('CAM_Exterior',(24,-30,22),(0,0,8.2),43),
        'american': camera('CAM_American6F',(-1.25,-7.05,17.30),(-1.10,-4.70,16.65),18),
        'modern': camera('CAM_Modern5F',(-1.25,-7.05,14.30),(-1.10,-4.70,13.65),18),
        'dining': camera('CAM_Dining6F',(-4.65,-2.20,17.25),(-2.8,0.15,16.75),22),
    }
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 960
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    return cameras


def render_previews(cameras):
    scene = bpy.context.scene
    for name in ('exterior','american','modern','dining'):
        scene.camera = cameras[name]
        scene.render.filepath = str(PREVIEW_DIR / f'{name}.png')
        bpy.ops.render.render(write_still=True)
        print(f'PREVIEW {scene.render.filepath}',flush=True)


def is_descendant_of_edit(obj):
    parent = obj.parent
    while parent:
        if parent.name.startswith('EDIT_'):
            return True
        parent = parent.parent
    return False


def model_objects():
    excluded = {'COLLISION','CHARACTER','LIGHTS','CAMERAS'}
    result = []
    for col in bpy.data.collections:
        if col.name in excluded:
            continue
        for obj in col.objects:
            if obj.type in {'MESH','EMPTY','CURVE'}:
                result.append(obj)
    return result


def optimize_static():
    groups = {}
    for obj in model_objects():
        if obj.type not in {'MESH','CURVE'} or is_descendant_of_edit(obj):
            continue
        if not obj.users_collection or not obj.data:
            continue
        col = obj.users_collection[0].name
        materials = tuple(mat.name if mat else 'None' for mat in obj.data.materials)
        if len(materials) != 1:
            continue
        groups.setdefault((col,materials[0]),[]).append(obj)
    for (col,mat),objects in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in objects:
            if obj.parent:
                matrix = obj.matrix_world.copy()
                obj.parent = None
                obj.matrix_world = matrix
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects)>1:
            bpy.ops.object.convert(target='MESH')
            bpy.ops.object.join()
            bpy.context.object.name = f'BATCH_{col}_{mat}'
        else:
            bpy.ops.object.convert(target='MESH')
            objects[0].name = f'STATIC_{col}_{mat}'
    # Remove only non-editable empty assembly roots after their children were batched.
    for obj in list(model_objects()):
        if obj.type=='EMPTY' and not obj.name.startswith('EDIT_') and not obj.children:
            bpy.data.objects.remove(obj,do_unlink=True)


def triangle_count(objects):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for obj in objects:
        if obj.type!='MESH':
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        if mesh:
            mesh.calc_loop_triangles()
            total += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return total


def select_only(objects):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def export_glb(filepath, objects, animations=False, draco=True, materials=True):
    select_only(objects)
    kwargs = dict(
        filepath=str(filepath),export_format='GLB',use_selection=True,
        export_apply=True,export_animations=animations,export_yup=True,
        export_extras=True,export_cameras=False,export_lights=False,
        export_draco_mesh_compression_enable=draco,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_shared_accessors=True,
        export_materials='EXPORT' if materials else 'NONE',
    )
    if animations:
        kwargs.update(export_animation_mode='ACTIONS',export_frame_range=False,
                      export_force_sampling=True,export_anim_slide_to_zero=True,
                      export_optimize_animation_size=True,export_skins=True,
                      export_influence_nb=4,export_rest_position_armature=True)
    bpy.ops.export_scene.gltf(**kwargs)
    print(f'EXPORT {filepath} {filepath.stat().st_size}',flush=True)


def main():
    args = parse_args()
    started = time.time()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.length_unit = 'METERS'
    scene.unit_settings.scale_length = 1.0
    materials = create_materials()
    print('BUILD structure',flush=True)
    build_building(materials)
    print('BUILD GTA modern theme F05',flush=True)
    modern_before=set(bpy.data.collections['F05'].objects)
    modern_collision_before=set(bpy.data.collections['COLLISION'].objects)
    build_modern_interior(5,materials)
    modern_objects=[o for o in bpy.data.collections['F05'].objects if o not in modern_before]
    modern_colliders=[o for o in bpy.data.collections['COLLISION'].objects if o not in modern_collision_before]
    for floor in range(2,5):
        print(f'COPY GTA theme F{floor:02d}',flush=True)
        duplicate_theme_floor(5,floor,modern_objects,modern_colliders)
    print('BUILD American luxury theme F06',flush=True)
    build_standard_interior(6,materials)
    print('BUILD avatar',flush=True)
    arm,avatar = build_character()
    arm.location = (0,-10.5,0)
    cameras = setup_presentation()
    scene['project'] = '3栋51# 建筑漫游'
    scene['style'] = '6F美式轻奢+大理石拼花；5F及2F-4F为GTA黑白灰现代主题'
    scene['source_plan'] = '3栋51号方案图.pdf'
    scene['outer_dimensions_m'] = [17.2,14.9]
    blend_path = ROOT / 'building-51.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path),compress=True)
    if not args.no_render:
        print('RENDER previews',flush=True)
        render_previews(cameras)
    stats = {
        'project':'3栋51#','blender':bpy.app.version_string,
        'outer_dimensions_m':[17.2,14.9],'floor_z':FLOOR_Z,
        'objects_before_batch':len(model_objects()),
        'materials':[m.name for m in bpy.data.materials],
        'avatar_bones':len(arm.data.bones),
        'avatar_triangles':triangle_count([avatar]),
        'avatar_actions':[a.name for a in bpy.data.actions],
    }
    if not args.no_export:
        print('OPTIMIZE static batches',flush=True)
        optimize_static()
        export_objects = [o for o in model_objects() if o.type=='MESH' or (o.type=='EMPTY' and o.name.startswith('EDIT_'))]
        stats['objects_after_batch'] = len(export_objects)
        stats['building_triangles'] = triangle_count(export_objects)
        stats['collision_triangles'] = triangle_count(list(bpy.data.collections['COLLISION'].objects))
        export_glb(MODEL_DIR/'model.glb',export_objects,animations=False,draco=True)
        export_glb(MODEL_DIR/'collision.glb',list(bpy.data.collections['COLLISION'].objects),draco=False,materials=False)
        export_glb(MODEL_DIR/'character.glb',[arm,avatar],animations=True,draco=False)
    stats['build_seconds'] = round(time.time()-started,2)
    stats['files'] = {p.name:p.stat().st_size for p in [blend_path,MODEL_DIR/'model.glb',MODEL_DIR/'collision.glb',MODEL_DIR/'character.glb'] if p.exists()}
    (DOCS_DIR/'model-stats.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf-8')
    print('DONE',json.dumps(stats,ensure_ascii=False),flush=True)


if __name__ == '__main__':
    main()
