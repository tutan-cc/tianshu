import bpy, os, math
from mathutils import Vector
folder=r'D:\早餐游戏3D'
out=r'C:\Users\chris\Desktop\重生2-原型\dist\model-audit'
os.makedirs(out,exist_ok=True)
for filename in sorted(os.listdir(folder)):
 if not filename.endswith('.glb'):continue
 bpy.ops.wm.read_factory_settings(use_empty=True)
 bpy.ops.import_scene.gltf(filepath=os.path.join(folder,filename))
 meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
 points=[o.matrix_world@Vector(c) for o in meshes for c in o.bound_box]
 lo=Vector([min(p[i] for p in points) for i in range(3)]);hi=Vector([max(p[i] for p in points) for i in range(3)])
 center=(lo+hi)/2;size=max(hi-lo)
 bpy.ops.object.camera_add(location=center+Vector((size*1.3,-size*2,size*.7)))
 cam=bpy.context.object;cam.rotation_euler=(center-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=size*1.3
 scene=bpy.context.scene;scene.camera=cam;scene.render.engine='CYCLES';scene.cycles.samples=8
 scene.world=bpy.data.worlds.new('AuditWorld');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.65,.65,.65,1)
 bpy.ops.object.light_add(type='AREA',location=center+Vector((size,-size,size*2)));bpy.context.object.data.energy=400;bpy.context.object.data.shape='DISK';bpy.context.object.data.size=size*2
 scene.render.resolution_x=320;scene.render.resolution_y=320;scene.render.resolution_percentage=100
 scene.render.filepath=os.path.join(out,filename+'.png');bpy.ops.render.render(write_still=True)
 print('AUDIT',filename,hi-lo,flush=True)
