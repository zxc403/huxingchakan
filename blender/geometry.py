import bpy
import math
from mathutils import Vector

_COLLECTIONS = {}


def collection(name):
    if name not in _COLLECTIONS:
        col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
        if col.name not in bpy.context.scene.collection.children:
            bpy.context.scene.collection.children.link(col)
        _COLLECTIONS[name] = col
    return _COLLECTIONS[name]


def link(obj, col):
    target = collection(col) if isinstance(col, str) else col
    for old in list(obj.users_collection):
        old.objects.unlink(obj)
    target.objects.link(obj)
    return obj


def mesh_object(name, vertices, faces, mat, col, uv_scale=1.0):
    mesh = bpy.data.meshes.new(f'{name}_Mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    collection(col).objects.link(obj)
    if mat:
        mesh.materials.append(mat)
    uv = mesh.uv_layers.new(name='UVMap')
    for poly in mesh.polygons:
        normal = poly.normal
        for loop_index in poly.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            if abs(normal.z) >= max(abs(normal.x), abs(normal.y)):
                u, v = co.x / uv_scale, co.y / uv_scale
            elif abs(normal.y) >= abs(normal.x):
                u, v = co.x / uv_scale, co.z / uv_scale
            else:
                u, v = co.y / uv_scale, co.z / uv_scale
            uv.data[loop_index].uv = (u, v)
    return obj


def bevel(obj, amount, segments=2):
    if amount <= 0:
        return obj
    mod = obj.modifiers.new('Soft_Edges', 'BEVEL')
    mod.width = amount
    mod.segments = segments
    mod.limit_method = 'ANGLE'
    mod.harden_normals = True
    normal = obj.modifiers.new('Weighted_Normals', 'WEIGHTED_NORMAL')
    normal.keep_sharp = True
    normal.weight = 40
    return obj


def box(name, loc, dims, mat, col, bevel_width=0, rotation=None, collider=False, uv_scale=1.0):
    x, y, z = [v / 2 for v in dims]
    vertices = [(-x,-y,-z), (x,-y,-z), (x,y,-z), (-x,y,-z),
                (-x,-y,z), (x,-y,z), (x,y,z), (-x,y,z)]
    faces = [(0,3,2,1), (4,5,6,7), (0,1,5,4), (1,2,6,5), (2,3,7,6), (3,0,4,7)]
    obj = mesh_object(name, vertices, faces, mat, col, uv_scale)
    obj.location = loc
    if rotation:
        obj.rotation_euler = rotation
    if bevel_width:
        bevel(obj, bevel_width, 3 if bevel_width >= 0.05 else 2)
    if collider:
        collision_box(name, loc, dims, rotation)
    return obj


def collision_box(name, loc, dims, rotation=None):
    obj = box(f'COL_{name}', loc, dims, None, 'COLLISION', rotation=rotation)
    obj.hide_render = True
    obj.display_type = 'WIRE'
    obj['collision'] = True
    return obj


def cylinder(name, loc, radius, depth, mat, col, vertices=20, rotation=None, bevel_width=0):
    verts = []
    for z in (-depth / 2, depth / 2):
        verts.extend([(radius * math.cos(i * math.tau / vertices), radius * math.sin(i * math.tau / vertices), z) for i in range(vertices)])
    faces = []
    for i in range(vertices):
        j = (i + 1) % vertices
        faces.append((i, j, j + vertices, i + vertices))
    faces.extend([tuple(reversed(range(vertices))), tuple(range(vertices, vertices * 2))])
    obj = mesh_object(name, verts, faces, mat, col, uv_scale=max(radius * 2, 0.2))
    obj.location = loc
    if rotation:
        obj.rotation_euler = rotation
    for poly in obj.data.polygons[:-2]:
        poly.use_smooth = True
    if bevel_width:
        bevel(obj, bevel_width, 2)
    return obj


def cylinder_between(name, start, end, radius, mat, col, vertices=12):
    a, b = Vector(start), Vector(end)
    delta = b - a
    obj = cylinder(name, (a + b) / 2, radius, delta.length, mat, col, vertices)
    obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()
    return obj


def sphere(name, loc, scale, mat, col, segments=16, rings=8):
    # Data API only: avoids a dependency-graph update for every decorative sphere.
    vertices = [(0,0,1)]
    for j in range(1,rings):
        theta = math.pi*j/rings
        for i in range(segments):
            phi = math.tau*i/segments
            vertices.append((math.sin(theta)*math.cos(phi),math.sin(theta)*math.sin(phi),math.cos(theta)))
    bottom = len(vertices)
    vertices.append((0,0,-1))
    faces = []
    for i in range(segments):
        faces.append((0,1+i,1+(i+1)%segments))
    for j in range(rings-2):
        for i in range(segments):
            a = 1+j*segments+i
            b = 1+j*segments+(i+1)%segments
            faces.append((a,a+segments,b+segments,b))
    base = 1+(rings-2)*segments
    for i in range(segments):
        faces.append((bottom,base+(i+1)%segments,base+i))
    obj = mesh_object(name,vertices,faces,mat,col,uv_scale=1)
    obj.location = loc
    obj.scale = scale
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def ico(name, loc, scale, mat, col, subdivisions=1):
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm,subdivisions=subdivisions,radius=1.0)
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    vertices = [tuple(v.co) for v in bm.verts]
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    obj = mesh_object(name,vertices,faces,mat,col,uv_scale=1)
    obj.location = loc
    obj.scale = scale
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def torus(name, loc, major, minor, mat, col, rotation=None, major_segments=32, minor_segments=8):
    vertices,faces = [],[]
    for i in range(major_segments):
        u = math.tau*i/major_segments
        for j in range(minor_segments):
            v = math.tau*j/minor_segments
            r = major+minor*math.cos(v)
            vertices.append((r*math.cos(u),r*math.sin(u),minor*math.sin(v)))
    for i in range(major_segments):
        for j in range(minor_segments):
            a = i*minor_segments+j
            b = ((i+1)%major_segments)*minor_segments+j
            c = ((i+1)%major_segments)*minor_segments+(j+1)%minor_segments
            d = i*minor_segments+(j+1)%minor_segments
            faces.append((a,b,c,d))
    obj = mesh_object(name,vertices,faces,mat,col,uv_scale=1)
    obj.location = loc
    if rotation:
        obj.rotation_euler = rotation
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def wall(name, p1, p2, z, height, thickness, mat, col, openings=None, collision=True):
    """Axis-aligned wall with true openings. Opening: (t, width, bottom, opening_height)."""
    a, b = Vector(p1), Vector(p2)
    delta = b - a
    length = delta.length
    if length < 0.001:
        return []
    direction = delta.normalized()
    angle = math.atan2(direction.y, direction.x)
    center = (a + b) / 2
    objects = []

    def piece(label, t0, t1, bottom, top):
        if t1 - t0 < 0.002 or top - bottom < 0.002:
            return
        mid = a + delta * ((t0 + t1) / 2)
        loc = (mid.x, mid.y, z + (bottom + top) / 2)
        dims = ((t1 - t0) * length, thickness, top - bottom)
        obj = box(f'{name}_{label}', loc, dims, mat, col, rotation=(0, 0, angle))
        objects.append(obj)
        if collision:
            collision_box(f'{name}_{label}', loc, dims, (0, 0, angle))

    cursor = 0.0
    for index, (t, width, bottom, opening_height) in enumerate(sorted(openings or [], key=lambda item: item[0])):
        half = width / length / 2
        start, end = max(0, t - half), min(1, t + half)
        piece(f'P{index}', cursor, start, 0, height)
        piece(f'Sill{index}', start, end, 0, bottom)
        piece(f'Lintel{index}', start, end, bottom + opening_height, height)
        cursor = end
    piece('End', cursor, 1, 0, height)
    return objects


def curtain(name, center, width, height, mat, col, rotation=0, waves=6, segments=20):
    verts, faces = [], []
    rows = 6
    for j in range(rows + 1):
        v = j / rows
        for i in range(segments + 1):
            u = i / segments
            x = (u - 0.5) * width
            y = math.sin(u * math.tau * waves) * 0.045 * (0.7 + 0.3 * v)
            z = (v - 0.5) * height + math.sin(u * math.tau * 2) * 0.018 * (1 - v)
            verts.append((x, y, z))
    for j in range(rows):
        for i in range(segments):
            a = j * (segments + 1) + i
            faces.append((a, a + 1, a + segments + 2, a + segments + 1))
    obj = mesh_object(name, verts, faces, mat, col, uv_scale=1)
    obj.location = center
    obj.rotation_euler.z = rotation
    for poly in obj.data.polygons:
        poly.use_smooth = True
    solid = obj.modifiers.new('Curtain_Thickness', 'SOLIDIFY')
    solid.thickness = 0.003
    return obj


def textured_quad(name, center, width, depth, mat, col, rotation=0):
    obj = mesh_object(name,[(-width/2,-depth/2,0),(width/2,-depth/2,0),
                           (width/2,depth/2,0),(-width/2,depth/2,0)],[(0,1,2,3)],mat,col)
    uv = obj.data.uv_layers.active
    for loop,coord in zip(uv.data,[(0,0),(1,0),(1,1),(0,1)]):
        loop.uv = coord
    obj.location = center
    obj.rotation_euler.z = rotation
    return obj
