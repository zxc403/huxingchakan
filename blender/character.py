import bpy
import math
from . import geometry as g
from .materials import base_material


BONES = {
    'root': ((0,0,0),(0,0,0.16),None),
    'pelvis': ((0,0,0.84),(0,0,1.00),'root'),
    'spine': ((0,0,1.00),(0,0,1.25),'pelvis'),
    'chest': ((0,0,1.25),(0,0,1.45),'spine'),
    'neck': ((0,0,1.45),(0,0,1.55),'chest'),
    'head': ((0,0,1.55),(0,0,1.78),'neck'),
}
for side,sign in [('L',-1),('R',1)]:
    BONES[f'shoulder.{side}'] = ((sign*0.12,0,1.42),(sign*0.25,0,1.42),'chest')
    BONES[f'upper_arm.{side}'] = ((sign*0.25,0,1.42),(sign*0.34,0,1.14),f'shoulder.{side}')
    BONES[f'forearm.{side}'] = ((sign*0.34,0,1.14),(sign*0.35,0,0.90),f'upper_arm.{side}')
    BONES[f'hand.{side}'] = ((sign*0.35,0,0.90),(sign*0.36,0,0.80),f'forearm.{side}')
    BONES[f'thigh.{side}'] = ((sign*0.11,0,0.93),(sign*0.12,0,0.52),'pelvis')
    BONES[f'shin.{side}'] = ((sign*0.12,0,0.52),(sign*0.12,0,0.14),f'thigh.{side}')
    BONES[f'foot.{side}'] = ((sign*0.12,0,0.14),(sign*0.12,-0.17,0.08),f'shin.{side}')
    BONES[f'toe.{side}'] = ((sign*0.12,-0.17,0.08),(sign*0.12,-0.28,0.08),f'foot.{side}')


def weight_part(obj, bone, blend_bone=None):
    group = obj.vertex_groups.new(name=bone)
    group.add(list(range(len(obj.data.vertices))), 1.0, 'REPLACE')
    if blend_bone:
        other = obj.vertex_groups.new(name=blend_bone)
        zs = [v.co.z for v in obj.data.vertices]
        low,high = min(zs),max(zs)
        for v in obj.data.vertices:
            t = (v.co.z-low)/max(high-low,1e-6)
            if t > 0.72:
                blend = (t-0.72)/0.28*0.5
                group.add([v.index],1-blend,'REPLACE')
                other.add([v.index],blend,'REPLACE')


def build_character():
    col = 'CHARACTER'
    hoodie = base_material('人物深灰连帽卫衣_Hoodie',(0.035,0.043,0.052,1),0.88)[0]
    pants = base_material('人物深色长裤_Pants',(0.025,0.030,0.038,1),0.90)[0]
    skin = base_material('人物肤色_Skin',(0.48,0.28,0.18,1),0.72)[0]
    shoe = base_material('人物运动鞋_Sneakers',(0.12,0.13,0.15,1),0.70)[0]
    sole = base_material('人物鞋底_Soles',(0.55,0.56,0.54,1),0.82)[0]
    parts = []
    def add(obj,bone,blend=None):
        weight_part(obj,bone,blend)
        parts.append(obj)
        return obj
    add(g.box('Char_Torso',(0,0,1.22),(0.46,0.29,0.52),hoodie,col,0.10),'spine','chest')
    add(g.sphere('Char_Hem',(0,0,0.98),(0.24,0.16,0.12),hoodie,col),'pelvis')
    add(g.sphere('Char_Hood',(0,0.075,1.52),(0.23,0.19,0.25),hoodie,col,20,12),'head')
    add(g.sphere('Char_Head',(0,-0.045,1.65),(0.155,0.135,0.185),skin,col,20,12),'head')
    add(g.sphere('Char_Nose',(0,-0.173,1.65),(0.032,0.040,0.040),skin,col,12,8),'head')
    add(g.torus('Char_HoodRim',(0,-0.095,1.54),0.17,0.035,hoodie,col,(math.pi/2,0,0),24,8),'head')
    for side,sign in [('L',-1),('R',1)]:
        add(g.sphere(f'Char_Shoulder{side}',(sign*0.24,0,1.40),(0.13,0.14,0.14),hoodie,col),f'upper_arm.{side}')
        upper = g.cylinder_between(f'Char_UpperArm{side}',(sign*0.26,0,1.39),(sign*0.34,0,1.14),0.095,hoodie,col,16)
        add(upper,f'upper_arm.{side}',f'forearm.{side}')
        add(g.sphere(f'Char_Elbow{side}',(sign*0.34,0,1.14),(0.10,0.10,0.10),hoodie,col),f'forearm.{side}')
        lower = g.cylinder_between(f'Char_Forearm{side}',(sign*0.34,0,1.14),(sign*0.35,0,0.91),0.082,hoodie,col,16)
        add(lower,f'forearm.{side}',f'hand.{side}')
        add(g.sphere(f'Char_Hand{side}',(sign*0.355,-0.005,0.845),(0.065,0.052,0.10),skin,col),f'hand.{side}')
        add(g.sphere(f'Char_Hip{side}',(sign*0.11,0,0.91),(0.13,0.14,0.14),pants,col),f'thigh.{side}')
        thigh = g.cylinder_between(f'Char_Thigh{side}',(sign*0.11,0,0.92),(sign*0.12,0,0.52),0.11,pants,col,16)
        add(thigh,f'thigh.{side}',f'shin.{side}')
        add(g.sphere(f'Char_Knee{side}',(sign*0.12,0,0.52),(0.105,0.105,0.11),pants,col),f'shin.{side}')
        shin = g.cylinder_between(f'Char_Shin{side}',(sign*0.12,0,0.52),(sign*0.12,0,0.15),0.088,pants,col,16)
        add(shin,f'shin.{side}',f'foot.{side}')
        add(g.box(f'Char_Shoe{side}',(sign*0.12,-0.075,0.105),(0.19,0.34,0.16),shoe,col,0.055),f'foot.{side}')
        add(g.box(f'Char_Sole{side}',(sign*0.12,-0.08,0.035),(0.195,0.35,0.055),sole,col,0.025),f'foot.{side}')
    arm_data = bpy.data.armatures.new('CharacterRig_22Bones')
    arm = bpy.data.objects.new('CharacterRig',arm_data)
    g.collection(col).objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name,(head,tail,parent) in BONES.items():
        bone = arm_data.edit_bones.new(name)
        bone.head,bone.tail = head,tail
        if parent:
            bone.parent = arm_data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.select_set(False)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.convert(target='MESH')
    bpy.ops.object.join()
    mesh = bpy.context.object
    mesh.name = 'Character_SkinnedMesh'
    mesh.parent = arm
    modifier = mesh.modifiers.new('CharacterSkin','ARMATURE')
    modifier.object = arm
    modifier.use_deform_preserve_volume = True
    for poly in mesh.data.polygons:
        if len(poly.vertices) <= 4:
            poly.use_smooth = True
    create_actions(arm)
    arm['bone_count'] = len(BONES)
    mesh['asset_role'] = 'third_person_avatar'
    return arm,mesh


def create_actions(arm):
    arm.animation_data_create()
    for pose_bone in arm.pose.bones:
        pose_bone.rotation_mode = 'XYZ'
    actions = []
    specs = [('idle',49,24),('walk',33,24),('run',25,24),('jump',49,24)]
    for name,frames,fps in specs:
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        arm.animation_data.action = action
        for frame in range(1,frames+1):
            t = (frame-1)/(frames-1)
            phase = t*math.tau
            for bone in arm.pose.bones:
                bone.rotation_euler = (0,0,0)
                bone.location = (0,0,0)
            if name == 'idle':
                arm.pose.bones['chest'].rotation_euler.x = 0.018*math.sin(phase)
                arm.pose.bones['head'].rotation_euler.y = 0.035*math.sin(phase*0.5)
                for side,sign in [('L',1),('R',-1)]:
                    arm.pose.bones[f'upper_arm.{side}'].rotation_euler.x = 0.025*math.sin(phase)*sign
            elif name in ('walk','run'):
                amplitude = 0.55 if name=='walk' else 0.82
                arm.pose.bones['pelvis'].location.y = (0.025 if name=='walk' else 0.05)*abs(math.cos(phase))
                arm.pose.bones['chest'].rotation_euler.y = 0.06*math.sin(phase)
                for side,sign in [('L',1),('R',-1)]:
                    swing = math.sin(phase)*sign
                    arm.pose.bones[f'thigh.{side}'].rotation_euler.x = amplitude*swing
                    arm.pose.bones[f'shin.{side}'].rotation_euler.x = max(0,-swing)*(0.72 if name=='walk' else 1.05)
                    arm.pose.bones[f'foot.{side}'].rotation_euler.x = -0.18*swing
                    arm.pose.bones[f'upper_arm.{side}'].rotation_euler.x = -amplitude*0.75*swing
                    arm.pose.bones[f'forearm.{side}'].rotation_euler.x = 0.25+0.15*max(0,swing)
            else:
                jump = math.sin(math.pi*t)
                arm.pose.bones['root'].location.y = 0.58*jump
                arm.pose.bones['chest'].rotation_euler.x = -0.15*jump
                for side in ('L','R'):
                    arm.pose.bones[f'thigh.{side}'].rotation_euler.x = 0.65*jump
                    arm.pose.bones[f'shin.{side}'].rotation_euler.x = -0.85*jump
                    arm.pose.bones[f'upper_arm.{side}'].rotation_euler.x = -0.65*jump
            for bone in arm.pose.bones:
                bone.keyframe_insert(data_path='rotation_euler',frame=frame,group=bone.name)
                bone.keyframe_insert(data_path='location',frame=frame,group=bone.name)
        actions.append(action)
    arm.animation_data.action = actions[0]
    bpy.context.scene.render.fps = 24
    bpy.context.scene.frame_set(1)
