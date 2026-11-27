/* Builds a whitebox scene, camera animation and optional object-distance matte from validated JSON. */
export const PREVIZ_TEMPLATE_PY = `import json, math, os, sys, bpy
from mathutils import Quaternion, Vector
def parse_spec():
    argv = sys.argv
    if "--" not in argv or argv.index("--") + 1 >= len(argv):
        raise RuntimeError("Missing spec path after --")
    with open(argv[argv.index("--") + 1], "r", encoding="utf-8") as fh:
        return json.load(fh)
def hex_to_rgba(c, d=(0.82, 0.84, 0.88, 1.0)):
    if not isinstance(c, str) or not c.startswith("#") or len(c) != 7: return d
    try: return (int(c[1:3],16)/255.0, int(c[3:5],16)/255.0, int(c[5:7],16)/255.0, 1.0)
    except ValueError: return d
def make_mat(name, rgba):
    m = bpy.data.materials.new(name=name); m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        if "Roughness" in bsdf.inputs: bsdf.inputs["Roughness"].default_value = 0.72
    m.diffuse_color = rgba; return m
def assign_mat(obj, m):
    if obj.data.materials: obj.data.materials[0] = m
    else: obj.data.materials.append(m)
def limb(parent, mat, r, length, loc, rot=(0.0,0.0,0.0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=length, location=loc, rotation=rot)
    o = bpy.context.active_object; assign_mat(o, mat); o.parent = parent; return o
def add_standin(item, frames):
    pos = item.get("position", [0.0,0.0,0.0]); epos = item.get("endPos", pos)
    h = float(item.get("height", 1.72)); yaw = float(item.get("facingDeg", 0.0)); eyaw = float(item.get("endFacingDeg", yaw))
    pose = item.get("pose", "stand")
    mat = make_mat("S_" + item.get("id","c"), hex_to_rgba(item.get("color"), (0.86,0.88,0.92,1.0)))
    acc = make_mat("N_" + item.get("id","c"), (0.20,0.52,0.78,1.0))
    root = bpy.data.objects.new("Char_" + item.get("id","c"), None); bpy.context.collection.objects.link(root)
    crouch_drop = -h * 0.22 if pose == "crouch" else (-h * 0.28 if pose == "sit" else 0.0)
    leg_len = h * 0.46; torso_len = h * 0.34; hr = h * 0.105
    hip_z = max(0.25 * h, leg_len + crouch_drop)
    bpy.ops.mesh.primitive_cylinder_add(radius=h*0.13, depth=torso_len, location=(0, 0, hip_z + torso_len*0.5))
    t = bpy.context.active_object; assign_mat(t, mat); t.parent = root
    bpy.ops.mesh.primitive_uv_sphere_add(radius=hr, location=(0, 0, hip_z + torso_len + hr*1.05))
    hd = bpy.context.active_object; assign_mat(hd, mat); hd.parent = root
    bpy.ops.mesh.primitive_cone_add(radius1=hr*0.32, depth=hr*0.75, location=(0, hr*1.08, hip_z + torso_len + hr*1.05), rotation=(-math.pi/2,0,0))
    ns = bpy.context.active_object; assign_mat(ns, acc); ns.parent = root
    arm_len = h * 0.34; sh_z = hip_z + torso_len * 0.88; sh_x = h * 0.18
    la_pitch = math.radians(-35) if pose in ("walk","run") else (math.radians(-78) if pose == "point" else math.radians(-8))
    ra_pitch = math.radians(35) if pose in ("walk","run") else (math.radians(-85) if pose == "point" else math.radians(8))
    limb(root, mat, h*0.042, arm_len, (-sh_x, 0, sh_z - arm_len*0.42), (la_pitch, 0, math.radians(8)))
    limb(root, mat, h*0.042, arm_len, (sh_x, 0.08 if pose=="point" else 0, sh_z - (0.1 if pose=="point" else arm_len*0.42)), (ra_pitch, 0, math.radians(-8)))
    ll_pitch = math.radians(26) if pose == "walk" else (math.radians(42) if pose == "run" else (math.radians(-70) if pose == "sit" else 0.0))
    rl_pitch = -ll_pitch if pose in ("walk","run") else ll_pitch
    limb(root, mat, h*0.055, leg_len, (-h*0.08, 0, hip_z*0.5), (ll_pitch, 0, 0))
    limb(root, mat, h*0.055, leg_len, (h*0.08, 0, hip_z*0.5), (rl_pitch, 0, 0))
    root.location = (float(pos[0]), float(pos[1]), float(pos[2]))
    root.rotation_euler = (0.0, 0.0, math.radians(yaw))
    if frames > 1 and (epos != pos or eyaw != yaw):
        root.keyframe_insert(data_path="location", frame=1)
        root.keyframe_insert(data_path="rotation_euler", frame=1)
        root.location = (float(epos[0]), float(epos[1]), float(epos[2]))
        root.rotation_euler = (0.0, 0.0, math.radians(eyaw))
        root.keyframe_insert(data_path="location", frame=frames)
        root.keyframe_insert(data_path="rotation_euler", frame=frames)
        root.location = (float(pos[0]), float(pos[1]), float(pos[2]))
        root.rotation_euler = (0.0, 0.0, math.radians(yaw))
    return root
def add_prop(item, frames):
    k = item.get("kind","box"); pos = item.get("position",[0.0,0.0,0.0]); epos = item.get("endPos", pos)
    sc = item.get("scale",[1.0,1.0,1.0]); yaw = float(item.get("facingDeg",0.0))
    mat = make_mat("P_" + item.get("id","p"), hex_to_rgba(item.get("color"), (0.74,0.77,0.82,1.0)))
    z_off = 0.0 if k=="plane" else float(sc[2])*0.5
    loc = (float(pos[0]), float(pos[1]), float(pos[2]) + z_off)
    if k=="cylinder": bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1.0, location=loc)
    elif k=="sphere": bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=loc)
    elif k=="plane": bpy.ops.mesh.primitive_plane_add(size=1.0, location=loc)
    else: bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    o = bpy.context.active_object; o.scale = (float(sc[0]),float(sc[1]),float(sc[2])); o.rotation_euler = (0.0,0.0,math.radians(yaw)); assign_mat(o, mat)
    if frames > 1 and epos != pos:
        o.keyframe_insert(data_path="location", frame=1)
        o.location = (float(epos[0]), float(epos[1]), float(epos[2]) + z_off)
        o.keyframe_insert(data_path="location", frame=frames)
        o.location = loc
    return o
def setup_lights(preset):
    def add_l(name, lt, loc, e, rot=(0,0,0), sz=3.0, col=(1.0,1.0,1.0)):
        d = bpy.data.lights.new(name=name, type=lt); d.energy = e; d.color = col
        if lt=="AREA": d.size = sz
        o = bpy.data.objects.new(name=name, object_data=d); bpy.context.collection.objects.link(o); o.location = loc; o.rotation_euler = rot
    if preset=="daylight":
        add_l("Sun","SUN",(6,-6,10),4.0,(math.radians(45),math.radians(15),math.radians(35)),col=(1.0,0.98,0.94))
        add_l("Sky","AREA",(-5,-4,6),120.0,(math.radians(55),0,math.radians(-35)),6.0,col=(0.82,0.90,1.0))
    elif preset=="noir_rim":
        add_l("Rim","AREA",(0,6,4.5),520.0,(math.radians(-55),0,math.radians(180)),2.5,col=(0.95,0.97,1.0))
        add_l("KeyLow","AREA",(3.5,-3.5,2.2),110.0,(math.radians(72),0,math.radians(45)),2.0,col=(1.0,0.92,0.82))
    elif preset=="neon_night":
        add_l("CyanKey","AREA",(-4.5,-3.5,3.2),360.0,(math.radians(65),0,math.radians(-42)),3.2,col=(0.22,0.86,1.0))
        add_l("MagentaRim","AREA",(4.5,3.5,3.6),380.0,(math.radians(-60),0,math.radians(138)),3.2,col=(1.0,0.24,0.68))
    elif preset=="golden_hour":
        add_l("GoldenSun","SUN",(8,-4,3.5),4.5,(math.radians(72),math.radians(10),math.radians(60)),col=(1.0,0.74,0.42))
        add_l("CoolFill","AREA",(-5,-4,5),130.0,(math.radians(55),0,math.radians(-35)),6.0,col=(0.68,0.80,1.0))
    else:
        add_l("Key","AREA",(5,-5,6),380.0,(math.radians(52),0,math.radians(42)),4.0)
        add_l("Fill","AREA",(-6,-4,4),160.0,(math.radians(60),0,math.radians(-48)),5.0)
        add_l("Rim","AREA",(0,6,5),220.0,(math.radians(-50),0,math.radians(180)),4.0)
def render_depth_pass(sc, cam_pos, ground_obj, out_path):
    sc.frame_set(1)
    old_engine = sc.render.engine; sc.render.engine = "BLENDER_WORKBENCH"
    old_light = sc.display.shading.light; old_color = sc.display.shading.color_type; old_shadows = sc.display.shading.show_shadows
    old_bg = tuple(sc.world.color)
    meshes = [o for o in sc.objects if o.type == "MESH"]
    dists = []
    for o in meshes:
        if o == ground_obj: continue
        mw = o.matrix_world.translation
        d = math.sqrt((mw.x - cam_pos[0])**2 + (mw.y - cam_pos[1])**2 + (mw.z - cam_pos[2])**2)
        dists.append((o, d))
    near = max(0.5, min([d for _, d in dists], default=2.0) - 0.8)
    far = max(near + 3.0, max([d for _, d in dists], default=8.0) + 2.5)
    for o, d in dists:
        v = max(0.14, min(0.96, 1.0 - (d - near) / (far - near)))
        o.color = (v, v, v, 1.0)
    ground_obj.color = (0.09, 0.09, 0.09, 1.0)
    sc.world.color = (0.02, 0.02, 0.02)
    sc.display.shading.light = "FLAT"; sc.display.shading.color_type = "OBJECT"; sc.display.shading.show_shadows = False
    sc.frame_set(1); sc.render.filepath = out_path; bpy.ops.render.render(write_still=True)
    sc.display.shading.light = old_light; sc.display.shading.color_type = old_color; sc.display.shading.show_shadows = old_shadows
    sc.world.color = old_bg; sc.render.engine = old_engine
def main():
    spec = parse_spec(); out_dir = spec["outputDir"]; os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True); sc = bpy.context.scene
    w = bpy.data.worlds.new("PrevizWorld"); sc.world = w; w.color = hex_to_rgba(spec.get("background"),(0.14,0.16,0.20,1.0))[:3]
    try: sc.render.engine = spec.get("engine","BLENDER_WORKBENCH")
    except Exception: sc.render.engine = "BLENDER_WORKBENCH"
    if sc.render.engine == "BLENDER_WORKBENCH":
        sc.display.shading.light = "STUDIO"; sc.display.shading.color_type = "MATERIAL"; sc.display.shading.show_shadows = True
    bpy.ops.mesh.primitive_plane_add(size=40.0, location=(0,0,0)); ground_obj = bpy.context.active_object
    assign_mat(ground_obj, make_mat("Ground",(0.28,0.30,0.34,1.0)))
    setup_lights(spec.get("lighting","three_point"))
    frames = max(1, int(spec.get("frames",1))); sc.frame_start = 1; sc.frame_end = frames
    for obj in spec.get("objects",[]):
        if obj.get("kind")=="character": add_standin(obj, frames)
        else: add_prop(obj, frames)
    cs = spec.get("camera",{}); cd = bpy.data.cameras.new("Cam"); cd.lens = float(cs.get("lensMm",35.0))
    if cs.get("fStop") is not None:
        cd.dof.use_dof = True; cd.dof.aperture_fstop = float(cs["fStop"])
        if cs.get("focusDistance") is not None: cd.dof.focus_distance = float(cs["focusDistance"])
    co = bpy.data.objects.new("Cam", cd); bpy.context.collection.objects.link(co); sc.camera = co
    sp = cs["startPos"]; ep = cs["endPos"]; st = cs["startTarget"]; et = cs["endTarget"]
    roll = Quaternion((0,0,1), math.radians(cs.get("rollDeg",0.0)))
    sc.render.fps = int(spec["fps"]); sc.render.resolution_x = int(spec["width"]); sc.render.resolution_y = int(spec["height"])
    sc.render.resolution_percentage = 100; sc.render.image_settings.file_format = "PNG"
    co.rotation_mode = "QUATERNION"
    def place_camera(pos, target, frame):
        co.location = pos
        co.rotation_quaternion = (Vector(target) - Vector(pos)).to_track_quat("-Z", "Y") @ roll
        co.keyframe_insert(data_path="location", frame=frame)
        co.keyframe_insert(data_path="rotation_quaternion", frame=frame)
    place_camera(sp, st, 1)
    if frames > 1: place_camera(ep, et, frames)
    mode = spec.get("output","both"); kp = os.path.join(out_dir,"keyframe.png"); dp = os.path.join(out_dir,"depth.png")
    if mode in ("video","both") and frames > 1:
        fd = os.path.join(out_dir,"frames"); os.makedirs(fd, exist_ok=True); sc.render.filepath = os.path.join(fd,"frame_")
        bpy.ops.render.render(animation=True)
        f1 = os.path.join(fd,"frame_0001.png")
        if os.path.exists(f1):
            with open(f1,"rb") as a, open(kp,"wb") as b: b.write(a.read())
    else:
        sc.frame_set(1); sc.render.filepath = kp; bpy.ops.render.render(write_still=True)
    if spec.get("emitDepth", True): render_depth_pass(sc, sp, ground_obj, dp)
if __name__ == "__main__": main()
`;
