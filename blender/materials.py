import bpy
from .config import TEXTURE_DIR


def principled(mat):
    return next(node for node in mat.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')


def input_socket(node, name):
    for socket in node.inputs:
        if socket.identifier == name or socket.name == name:
            return socket
    return None


def set_input(node, name, value):
    socket = input_socket(node, name)
    if socket is not None:
        socket.default_value = value


def base_material(name, color, roughness=0.5, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color[:3], color[3] if len(color) > 3 else 1)
    bsdf = principled(mat)
    set_input(bsdf, 'Base Color', mat.diffuse_color)
    set_input(bsdf, 'Roughness', roughness)
    set_input(bsdf, 'Metallic', metallic)
    return mat, bsdf


def image_node(mat, filename, non_color=False):
    image = bpy.data.images.load(str(TEXTURE_DIR / filename), check_existing=True)
    if non_color:
        image.colorspace_settings.name = 'Non-Color'
    if not image.packed_file:
        image.pack()
    node = mat.node_tree.nodes.new('ShaderNodeTexImage')
    node.image = image
    node.label = filename
    return node


def occlusion_group():
    group = bpy.data.node_groups.get('glTF Material Output')
    if group is None:
        group = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        group.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    return group


def pbr_material(name, stem, roughness=0.5, coat=0.0, sheen=0.0, normal_strength=0.65, color_4k=False):
    mat, bsdf = base_material(name, (1, 1, 1, 1), roughness)
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    color = image_node(mat, f'{stem}_color{"_4k" if color_4k else ""}.jpg')
    normal = image_node(mat, f'{stem}_normal.jpg', True)
    arm = image_node(mat, f'{stem}_arm.jpg', True)
    links.new(color.outputs['Color'], input_socket(bsdf, 'Base Color'))
    normal_map = nodes.new('ShaderNodeNormalMap')
    normal_map.inputs['Strength'].default_value = normal_strength
    links.new(normal.outputs['Color'], normal_map.inputs['Color'])
    links.new(normal_map.outputs['Normal'], input_socket(bsdf, 'Normal'))
    separate = nodes.new('ShaderNodeSeparateColor')
    separate.mode = 'RGB'
    links.new(arm.outputs['Color'], separate.inputs['Color'])
    links.new(separate.outputs['Green'], input_socket(bsdf, 'Roughness'))
    links.new(separate.outputs['Blue'], input_socket(bsdf, 'Metallic'))
    occlusion = nodes.new('ShaderNodeGroup')
    occlusion.node_tree = occlusion_group()
    links.new(separate.outputs['Red'], occlusion.inputs['Occlusion'])
    set_input(bsdf, 'Coat Weight', coat)
    set_input(bsdf, 'Coat Roughness', 0.24)
    set_input(bsdf, 'Sheen Weight', sheen)
    color.location = (-650, 350)
    arm.location = (-650, 0)
    normal.location = (-650, -350)
    separate.location = (-380, 0)
    normal_map.location = (-350, -300)
    return mat


def create_materials():
    mats = {}
    # Latest owner correction: polished ivory marble floors, not wood flooring.
    mats['floor'] = pbr_material('米白抛光大理石地面_PolishedIvoryMarble', 'ivory_marble_floor', 0.15, coat=0.42, normal_strength=0.22)
    set_input(principled(mats['floor']),'Coat Roughness',0.12)
    mats['medallion'] = pbr_material('卷草金花大理石拼花_FloralMarbleInlay', 'ivory_marble_floor', 0.15, coat=0.42, normal_strength=0.22)
    medallion_image = bpy.data.images.load(str(TEXTURE_DIR/'ivory_marble_medallion.jpg'),check_existing=True)
    medallion_image.pack()
    for node in mats['medallion'].node_tree.nodes:
        if node.type=='TEX_IMAGE' and node.label=='ivory_marble_floor_color.jpg':
            node.image = medallion_image
            node.label = 'ivory_marble_medallion.jpg'
    set_input(principled(mats['medallion']),'Coat Roughness',0.12)
    mats['wood'] = pbr_material('黑胡桃木家具_BlackWalnut', 'black_walnut', 0.42, coat=0.10)
    mats['fabric'] = pbr_material('奶白布艺_IvoryFabric', 'ivory_fabric', 0.88, sheen=0.32, normal_strength=0.5)
    mats['leather'] = pbr_material('GTA黑色皮革_BlackLeather', 'black_leather', 0.36, coat=0.12, normal_strength=0.28)
    mats['marble'] = pbr_material('浅灰大理石_LightMarble', 'light_marble', 0.15, coat=0.2, normal_strength=0.35)
    mats['paving'] = pbr_material('室外石材铺装_StonePaving', 'stone_paving', 0.8, normal_strength=0.7)
    mats['plaster'] = pbr_material('白色乳胶漆_WhitePlaster4K', 'white_plaster', 0.82, normal_strength=0.18, color_4k=True)
    simple = {
        'white': ('美式护墙板_WarmWhite', (0.91, 0.895, 0.86, 1), 0.55, 0),
        'cream': ('卧室浅米色_WarmCream', (0.76, 0.70, 0.60, 1), 0.82, 0),
        'wall_ext': ('外墙暖白石材_Exterior', (0.64, 0.61, 0.54, 1), 0.78, 0),
        'metal': ('深灰金属_WindowMetal', (0.055, 0.065, 0.07, 1), 0.28, 0.75),
        'black': ('黑色细金属_BlackMetal', (0.025, 0.025, 0.028, 1), 0.32, 0.72),
        'gold': ('拉丝黄铜_BrushedBrass', (0.52, 0.32, 0.11, 1), 0.28, 0.82),
        'linen': ('米色床品_Linen', (0.73, 0.67, 0.56, 1), 0.92, 0),
        'throw': ('焦糖色搭毯_CaramelThrow', (0.28, 0.11, 0.055, 1), 0.9, 0),
        'pillow': ('灰粉抱枕_DustyRose', (0.47, 0.31, 0.29, 1), 0.9, 0),
        'headboard': ('深棕软包床头_Headboard', (0.11, 0.075, 0.06, 1), 0.88, 0),
        'quartz': ('灰色石英石_Quartz', (0.32, 0.34, 0.35, 1), 0.24, 0),
        'screen': ('电视屏幕_Television', (0.008, 0.012, 0.018, 1), 0.12, 0.15),
        'rug': ('米色羊毛地毯_WoolRug', (0.60, 0.54, 0.44, 1), 0.96, 0),
        'leaf': ('绿植深绿_Leaf', (0.055, 0.20, 0.065, 1), 0.78, 0),
        'leaf_light': ('绿植浅绿_LeafLight', (0.12, 0.29, 0.08, 1), 0.75, 0),
        'flower': ('浅粉花艺_BlushFlower', (0.83, 0.49, 0.52, 1), 0.75, 0),
        'flower_white': ('白花艺_WhiteFlower', (0.92, 0.89, 0.82, 1), 0.78, 0),
        'soil': ('种植土_Soil', (0.075, 0.05, 0.028, 1), 1.0, 0),
        'grass': ('草坪_Grass', (0.16, 0.25, 0.09, 1), 0.98, 0),
        'concrete': ('结构混凝土_Concrete', (0.40, 0.41, 0.40, 1), 0.92, 0),
        'roof': ('屋顶防水_Roof', (0.18, 0.20, 0.21, 1), 0.9, 0),
        'water': ('洁具陶瓷_Ceramic', (0.91, 0.92, 0.90, 1), 0.18, 0),
        'mirror': ('镜面_Mirror', (0.65, 0.72, 0.75, 1), 0.04, 1),
        'lacquer': ('GTA黑色烤漆_BlackLacquer', (0.018,0.022,0.026,1),0.23,0.05),
        'modern_white': ('GTA白色烤漆_WhiteLacquer', (0.82,0.83,0.80,1),0.24,0),
        'gray_fabric': ('GTA灰色布艺_GrayFabric', (0.30,0.32,0.32,1),0.86,0),
        'chrome': ('GTA镀铬金属_Chrome', (0.52,0.56,0.58,1),0.18,0.92),
        'roller': ('GTA黑色卷帘_BlackRoller', (0.025,0.028,0.030,1),0.78,0),
    }
    for key, (name, color, rough, metal) in simple.items():
        mats[key] = base_material(name, color, rough, metal)[0]
    mats['glass'], glass = base_material('低反玻璃_WindowGlass', (0.72, 0.84, 0.88, 0.24), 0.08, 0)
    set_input(glass, 'Transmission Weight', 0.72)
    set_input(glass, 'IOR', 1.45)
    if hasattr(mats['glass'], 'surface_render_method'):
        mats['glass'].surface_render_method = 'DITHERED'
    mats['sheer'], sheer = base_material('奶白纱帘_SheerCurtain', (0.91, 0.87, 0.77, 0.38), 0.94)
    set_input(sheer, 'Sheen Weight', 0.4)
    if hasattr(mats['sheer'], 'surface_render_method'):
        mats['sheer'].surface_render_method = 'DITHERED'
    mats['crystal'], crystal = base_material('水晶玻璃_Crystal', (0.91, 0.96, 1.0, 0.5), 0.06)
    set_input(crystal, 'Transmission Weight', 0.85)
    set_input(crystal, 'IOR', 1.52)
    mats['emit'], emit = base_material('3000K暖光灯带_WarmEmission', (1.0, 0.68, 0.32, 1), 0.35)
    set_input(emit, 'Emission Color', (1.0, 0.60, 0.25, 1))
    set_input(emit, 'Emission Strength', 3.0)
    mats['light'], light = base_material('筒灯发光面_Downlight', (1.0, 0.87, 0.62, 1), 0.4)
    set_input(light, 'Emission Color', (1.0, 0.72, 0.40, 1))
    set_input(light, 'Emission Strength', 4.0)
    return mats


def artwork_material(name, path):
    mat, bsdf = base_material(name, (1, 1, 1, 1), 0.65)
    image = bpy.data.images.load(str(path), check_existing=True)
    image.pack()
    node = mat.node_tree.nodes.new('ShaderNodeTexImage')
    node.image = image
    mat.node_tree.links.new(node.outputs['Color'], input_socket(bsdf, 'Base Color'))
    return mat
