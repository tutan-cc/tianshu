extends Node3D

const MJRules = preload("res://rules.gd")
## 重生2 · 麻将（纯 Godot 3D）
## 规则照搬 mahjong.js：四组一对 / 七对 / 龙七对 / 碰碰胡 / 大吊车 + 碰杠胡优先级

const KINDS := 34
const TW := 34.0
const TD := 44.0
const TH := 19.0
const GAP := 2.0
const RINX := 360.0
const RINY := 300.0
const PER_SIDE := 17

const HAND_W := 52.0
const HAND_H := 74.0
const HAND_STEP := 56.0
const HAND_T := 24.0
const RIVER_S := 50.0
const SIDE_T := 19.0
const HAND_Z := 392.0
const HAND_X := 436.0
const SEAT_NAMES := ["你", "下家", "对家", "上家"]
const TILE_NAMES := ["一万","二万","三万","四万","五万","六万","七万","八万","九万","一筒","二筒","三筒","四筒","五筒","六筒","七筒","八筒","九筒","一条","二条","三条","四条","五条","六条","七条","八条","九条","东风","南风","西风","北风","红中","发财","白板"]
const CLAIM_DELAY := 1.0
const AI_DRAW_DELAY := 1.0
const AI_THINK := 1.3
const STAKE := 2
const CAM_H := 720.0     # 相机高度（越大越俯视）
const CAM_D := 1180.0      # 相机到桌心的水平距离
const CAM_FOV := 43.0
const HAND_TILT := 14.0   # 手牌后仰角度

var wall: Array = []
var hands: Array = [[], [], [], []]
var rivers: Array = [[], [], [], []]
var melds: Array = [[], [], [], []]
var turn := 0
var phase := "discard"
var drawn_index := -1
var game_over := false
var _turn_token := 0
var _queue: Array = []
var _human_pending := {}
var _total_checks := 0
var busy := false
var _claim_choice := ""
var _claim_row: HBoxContainer
var evt_log: Label
var evt_lines: Array = []
var toast: Label
var result_detail: Label
var restart_btn: Button
var auto_pass := false
var auto_peng := false
var _last_discard_seat := -1
var _drop_seat := -1
var _anim_draw := true
var sfx := {}

func _init_sfx() -> void:
	for n in ["peng", "gang", "hu", "draw", "discard"]:
		var p := AudioStreamPlayer.new()
		var s = load("res://sounds/%s.wav" % n)
		if s:
			p.stream = s
		p.volume_db = -6.0
		add_child(p)
		sfx[n] = p

var voice_player: AudioStreamPlayer
var voice_streams := {}
var call_player: AudioStreamPlayer
var call_streams: Array = []

func _init_calls() -> void:
	call_player = AudioStreamPlayer.new()
	call_player.volume_db = -4.0
	add_child(call_player)
	for i in range(34):
		var s = load("res://sounds/calls/%d.wav" % i)
		call_streams.append(s)

func _init_voice() -> void:
	voice_player = AudioStreamPlayer.new()
	voice_player.volume_db = -1.0
	add_child(voice_player)
	for n in ["vo_peng", "vo_gang", "vo_hu", "vo_zimo"]:
		var s = load("res://sounds/%s.wav" % n)
		if s:
			voice_streams[n] = s

func _say(n: String) -> void:
	if call_player:
		call_player.stop()
	if voice_player and voice_streams.has(n):
		voice_player.stream = voice_streams[n]
		voice_player.play()

## 等牌名播报念完，再喊碰/杠/胡
func _say_after(n: String) -> void:
	if call_player and call_player.playing:
		var cb := func(): _say(n)
		call_player.finished.connect(cb, CONNECT_ONE_SHOT)
	else:
		_say(n)

func _announce(kind: int) -> void:
	if call_player == null or kind < 0 or kind >= call_streams.size():
		return
	var s = call_streams[kind]
	if s:
		call_player.stream = s
		call_player.play()

func _play(n: String, vol: float = -6.0) -> void:
	if sfx.has(n):
		sfx[n].volume_db = vol
		sfx[n].play()

var mat_ivory: StandardMaterial3D
var mat_green: StandardMaterial3D
var mat_felt: StandardMaterial3D
var mat_groove: StandardMaterial3D
var mat_plate: StandardMaterial3D
var mat_gold: StandardMaterial3D
var mat_rim: StandardMaterial3D
var mat_back: StandardMaterial3D
var board: Node3D
var cam: Camera3D
var hud: Label
var big: Label


func _ready() -> void:
	_materials()
	_env()
	_init_sfx()
	_init_calls()
	_init_voice()
	_new_game()
	_build()
	_make_hud()
	var args: Array = OS.get_cmdline_args() + OS.get_cmdline_user_args()
	if args.has("--resulttest"):
		_result_test()
		return
	if args.has("--claimtest"):
		_claim_test()
		return
	if args.has("--robtest"):
		_rob_test()
		return
	if args.has("--kongtest"):
		_kong_test()
		return
	if args.has("--rivertest"):
		_river_test()
		return
	if args.has("--labeltest"):
		_label_test()
		return
	if args.has("--aipeng"):
		_ai_peng_test()
		return
	if args.has("--pengtest"):
		_peng_test()
		return
	if args.has("--autopeng"):
		auto_peng = true
		_auto_run()
		return
	if args.has("--fast"):
		Engine.time_scale = 8.0
	if args.has("--auto"):
		auto_pass = true
		_auto_run()
		return
	if args.has("--slowshot"):
		await get_tree().create_timer(18.0).timeout
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png("res://shot.png")
		get_tree().quit()
	if args.has("--shot"):
		await get_tree().create_timer(1.2).timeout
		await RenderingServer.frame_post_draw
		get_viewport().get_texture().get_image().save_png("res://shot.png")
		get_tree().quit()

# ────────────────────────── 局 ──────────────────────────
func _new_game() -> void:
	var all: Array = []
	for k in range(KINDS):
		for c in range(4):
			all.append(k)
	all.shuffle()
	wall = all
	for s in range(4):
		hands[s] = []
		rivers[s] = []
		melds[s] = []
	# 发牌：逆时针 0(你) → 1(下家) → 2(对家) → 3(上家)，每人一张，共 13 轮
	for r in range(13):
		for s in range(4):
			hands[s].append(wall.pop_back())
	hands[0].append(wall.pop_back())
	turn = 0
	phase = "discard"
	_set_state(St.HUMAN_DISCARD)
	drawn_index = hands[0].size() - 1
	_sort_hand(0)
	_anim_draw = true
	game_over = false
	print("DEAL wall=", wall.size())

func _count_in(arr: Array, t: int) -> int:
	var n := 0
	for x in arr:
		if x == t:
			n += 1
	return n

## 理牌：按花色/数字排序，刚摸到的单独放到最右
func _sort_hand(seat: int) -> void:
	if hands[seat].is_empty():
		return
	var drawn := -1
	if seat == 0 and drawn_index >= 0 and drawn_index < hands[seat].size():
		drawn = int(hands[seat][drawn_index])
		hands[seat].remove_at(drawn_index)
	hands[seat].sort()
	if drawn >= 0:
		hands[seat].append(drawn)
		if seat == 0:
			drawn_index = hands[seat].size() - 1
	elif seat == 0:
		drawn_index = -1

func _draw_for(seat: int) -> bool:
	if wall.is_empty():
		_finish("牌墙摸完 · 流局")
		return false
	hands[seat].append(wall.pop_back())
	if seat == 0:
		drawn_index = hands[0].size() - 1
		_sort_hand(0)
	_anim_draw = true
	_play("draw", -16.0)
	return true

# ══════════════════ 回合状态机（不使用 await）══════════════════
# 所有推进由 _process 驱动：AI 摸牌 → AI 出牌 → 停 1 秒 → 碰杠判定 → 下一家
enum St { HUMAN_DISCARD, AI_DRAW, AI_DISCARD, CLAIM_WAIT, HUMAN_CLAIM, OVER }

var st: int = St.HUMAN_DISCARD
var st_deadline := 0.0
var _claim_from := -1
var _claim_tile := -1

func _set_state(s: int, t: float = 0.0) -> void:
	st = s
	st_deadline = Time.get_ticks_msec() * 0.001 + t

func _player_discard(idx: int) -> void:
	if game_over or turn != 0 or st != St.HUMAN_DISCARD:
		return
	if idx < 0 or idx >= hands[0].size():
		return
	var t: int = int(hands[0].pop_at(idx))
	rivers[0].append(t)
	_ev("%s 打 %s" % [SEAT_NAMES[0], TILE_NAMES[t]])
	_last_discard_seat = 0
	_drop_seat = 0
	_play("discard", -8.0)
	_announce(t)
	drawn_index = -1
	_build()
	_enter_claim(0, t)

## 出牌后进入「等待」：停 CLAIM_DELAY 秒，让播报念完、玩家看清是谁打的
func _enter_claim(from_seat: int, tile: int) -> void:
	_claim_from = from_seat
	_claim_tile = tile
	_set_state(St.CLAIM_WAIT, CLAIM_DELAY)

## 兼容旧调用
func _after_discard(from_seat: int, tile: int) -> void:
	_enter_claim(from_seat, tile)

func _resolve_claims() -> void:
	if game_over:
		return
	var from_seat := _claim_from
	var tile := _claim_tile
	if from_seat < 0:
		return

	var probe: Array = hands[0].duplicate()
	probe.append(tile)
	var ev_h: Dictionary = MJRules.evaluate(probe, melds[0])

	# ① 人类能胡
	if from_seat != 0 and not ev_h.is_empty():
		_offer_human(["hu"])
		return

	# ② AI 胡优先于人类碰杠
	for k in range(1, 4):
		var s1 := (from_seat + k) % 4
		if s1 == 0:
			continue
		var pb: Array = hands[s1].duplicate()
		pb.append(tile)
		var ev: Dictionary = MJRules.evaluate(pb, melds[s1])
		if not ev.is_empty():
			hands[s1] = pb
			_win(s1, tile, ev)
			return

	# ③ 人类碰 / 杠
	var opts: Array = []
	if _count_in(hands[0], tile) == 3:
		opts.append("gang")
	if _count_in(hands[0], tile) >= 2:
		opts.append("peng")
	if from_seat != 0 and not opts.is_empty():
		_offer_human(opts)
		return

	# ④ 交给 AI
	_ai_claims()

## 摸完牌后：有补杠/暗杠就询问
func _offer_self_kong(seat: int) -> void:
	var opts: Array = []
	var bg := _bugang_tile(seat)
	var ag := _angang_tile(seat)
	if bg >= 0:
		opts.append("bugang")
	if ag >= 0:
		opts.append("angang")
	if opts.is_empty():
		return
	_human_pending = { "opts": opts, "self": true, "bg": bg, "ag": ag }
	if auto_peng:
		_on_claim(opts[0])
	else:
		_set_state(St.HUMAN_CLAIM)
		_show_claim(opts)

func _offer_human(opts: Array) -> void:
	_human_pending = { "opts": opts }
	if auto_peng:
		_on_claim(opts[0])
	else:
		_set_state(St.HUMAN_CLAIM)
		_show_claim(opts)

func _ai_claims() -> void:
	var from_seat := _claim_from
	var tile := _claim_tile
	# AI 杠
	for k in range(1, 4):
		var s2 := (from_seat + k) % 4
		if s2 == 0:
			continue
		if _count_in(hands[s2], tile) == 3:
			for i in range(3):
				hands[s2].erase(tile)
			melds[s2].append({ "type": "gang", "tiles": [tile, tile, tile, tile] })
			if rivers[from_seat].size() > 0:
				rivers[from_seat].pop_back()
			_play("gang", -4.0)
			_say_after("vo_gang")
			_toast("%s 杠 %s" % [SEAT_NAMES[s2], TILE_NAMES[tile]])
			_ev(">>> %s 杠 %s" % [SEAT_NAMES[s2], TILE_NAMES[tile]])
			_draw_for(s2)
			turn = s2
			phase = "discard"
			_set_state(St.AI_DISCARD, AI_THINK)
			_build()
			return
	# AI 碰
	for k in range(1, 4):
		var s3 := (from_seat + k) % 4
		if s3 == 0:
			continue
		if _count_in(hands[s3], tile) >= 2:
			hands[s3].erase(tile)
			hands[s3].erase(tile)
			melds[s3].append({ "type": "peng", "tiles": [tile, tile, tile] })
			if rivers[from_seat].size() > 0:
				rivers[from_seat].pop_back()
			_play("peng", -4.0)
			_say_after("vo_peng")
			_toast("%s 碰 %s" % [SEAT_NAMES[s3], TILE_NAMES[tile]])
			_ev(">>> %s 碰 %s" % [SEAT_NAMES[s3], TILE_NAMES[tile]])
			turn = s3
			phase = "discard"
			_set_state(St.AI_DISCARD, AI_THINK)
			_build()
			return
	# 没人要 → 下一家
	turn = (from_seat + 1) % 4
	_go_draw()

## 补杠：手上有牌能和已有「碰」凑成 4 张
func _bugang_tile(seat: int) -> int:
	for m in melds[seat]:
		if m["type"] == "peng":
			var t: int = int(m["tiles"][0])
			if _count_in(hands[seat], t) >= 1:
				return t
	return -1

## 暗杠：自己手里凑齐 4 张
func _angang_tile(seat: int) -> int:
	var seen := {}
	for x in hands[seat]:
		var t: int = int(x)
		seen[t] = int(seen.get(t, 0)) + 1
		if int(seen[t]) == 4:
			return t
	return -1

## 执行杠（type: bugang / angang），并从牌尾补一张
func _do_self_kong(seat: int, tile: int, kind: String) -> void:
	# 抢杠：补杠的牌若被别人胡，则杠作废，改判抢杠胡（暗杠不可抢）
	if kind == "bugang":
		if seat != 0:
			var ph: Array = hands[0].duplicate()
			ph.append(tile)
			var eh: Dictionary = MJRules.evaluate(ph, melds[0])
			if not eh.is_empty():
				hands[0] = ph
				_ev(">>> 你 抢杠 %s" % TILE_NAMES[tile])
				_win(0, tile, eh)
				return
		for k in range(1, 4):
			var sr := (seat + k) % 4
			if sr == seat:
				continue
			var pr: Array = hands[sr].duplicate()
			pr.append(tile)
			var er: Dictionary = MJRules.evaluate(pr, melds[sr])
			if not er.is_empty():
				hands[sr] = pr
				_ev(">>> %s 抢杠 %s" % [SEAT_NAMES[sr], TILE_NAMES[tile]])
				_win(sr, tile, er)
				return
	if kind == "bugang":
		for i in range(melds[seat].size()):
			if melds[seat][i]["type"] == "peng" and int(melds[seat][i]["tiles"][0]) == tile:
				melds[seat][i] = { "type": "gang", "tiles": [tile, tile, tile, tile] }
				break
		hands[seat].erase(tile)
	else:
		for i in range(4):
			hands[seat].erase(tile)
		melds[seat].append({ "type": "gang", "tiles": [tile, tile, tile, tile] })
	_say_after("vo_gang")
	_toast("%s %s %s" % [SEAT_NAMES[seat], "补杠" if kind == "bugang" else "暗杠", TILE_NAMES[tile]])
	_ev(">>> %s %s %s" % [SEAT_NAMES[seat], "补杠" if kind == "bugang" else "暗杠", TILE_NAMES[tile]])
	# 从牌尾补一张
	if not wall.is_empty():
		hands[seat].append(wall.pop_front())
		_sort_hand(seat)
	if seat == 0:
		drawn_index = -1
		turn = 0
		phase = "discard"
		_set_state(St.HUMAN_DISCARD)
		_build()
	else:
		turn = seat
		phase = "discard"
		_set_state(St.AI_DISCARD, AI_THINK)
		_build()
func _go_draw() -> void:
	phase = "draw"
	if turn == 0:
		if not _draw_for(0):
			_set_state(St.OVER)
			return
		phase = "discard"
		_set_state(St.HUMAN_DISCARD)
		_build()
		_offer_self_kong(0)
	else:
		_set_state(St.AI_DRAW, AI_DRAW_DELAY)
		_build()

func _do_ai_draw() -> void:
	if not _draw_for(turn):
		_set_state(St.OVER)
		return
	# AI 自己杠：暗杠优先，其次补杠
	var seat := turn
	var ag := _angang_tile(seat)
	var bg := _bugang_tile(seat)
	if (ag >= 0 or bg >= 0) and randf() < 0.8:
		if ag >= 0:
			_do_self_kong(seat, ag, "angang")
		else:
			_do_self_kong(seat, bg, "bugang")
		return
	phase = "discard"
	_set_state(St.AI_DISCARD, AI_THINK)
	_build()

func _do_ai_discard() -> void:
	var seat := turn
	if hands[seat].is_empty():
		return
	var best := 0
	var best_score := 9999
	for i in range(hands[seat].size()):
		var t: int = int(hands[seat][i])
		var c := _count_in(hands[seat], t)
		var sc := c * 10
		if t >= 27:
			sc -= 5
		if t < 27:
			if _count_in(hands[seat], t - 1) > 0 or _count_in(hands[seat], t + 1) > 0:
				sc += 6
		if sc < best_score:
			best_score = sc
			best = i
	var tile: int = int(hands[seat].pop_at(best))
	rivers[seat].append(tile)
	_ev("%s 打 %s" % [SEAT_NAMES[seat], TILE_NAMES[tile]])
	_last_discard_seat = seat
	_drop_seat = seat
	_play("discard", -13.0)
	_announce(tile)
	_build()
	_enter_claim(seat, tile)

func _process(_delta: float) -> void:
	if game_over or st == St.OVER:
		return
	var now := Time.get_ticks_msec() * 0.001
	if now < st_deadline:
		return
	match st:
		St.AI_DRAW:
			_do_ai_draw()
		St.AI_DISCARD:
			_do_ai_discard()
		St.CLAIM_WAIT:
			_resolve_claims()
		_:
			pass
func _ev(msg: String) -> void:
	evt_lines.append(msg)
	if evt_lines.size() > 6:
		evt_lines.pop_front()
	if evt_log:
		evt_log.text = "\n".join(evt_lines)

func _toast(msg: String) -> void:
	if toast == null:
		return
	toast.text = msg
	toast.visible = true
	var tw := create_tween()
	tw.tween_interval(1.6)
	tw.tween_callback(func(): if toast: toast.visible = false)

func _show_result(title: String, detail: String) -> void:
	if big:
		big.text = title
		big.visible = true
	if result_detail:
		result_detail.text = detail
		result_detail.visible = true
	if restart_btn:
		restart_btn.visible = true

func _restart() -> void:
	if big:
		big.visible = false
	if result_detail:
		result_detail.visible = false
	if restart_btn:
		restart_btn.visible = false
	_new_game()
	_build()

func _win(seat: int, tile: int, ev: Dictionary) -> void:
	game_over = true
	_play("hu", 0.0)
	_say("vo_zimo")
	var pay: Dictionary = MJRules.payout(ev["tier"], STAKE)
	var who: String = ["你", "下家", "对家", "上家"][seat]
	_show_result("%s 胡了！" % who, "%s\n每家 %d 张 · 三家共 %d" % [ev["name"], pay["per"], pay["total"]])
	_build()
	print("WIN seat=", seat, " name=", ev["name"], " tile=", tile)

func _finish(msg: String) -> void:
	game_over = true
	_show_result(msg, "")

# ────────────────────────── 场景 ──────────────────────────
func _materials() -> void:
	mat_ivory = StandardMaterial3D.new()
	mat_ivory.albedo_color = Color(0.97, 0.955, 0.905)
	mat_ivory.roughness = 0.55
	mat_green = StandardMaterial3D.new()
	mat_green.albedo_color = Color(0.10, 0.52, 0.28)
	mat_green.roughness = 0.5
	mat_felt = StandardMaterial3D.new()
	mat_felt.albedo_color = Color(0.055, 0.30, 0.285)
	var noise := FastNoiseLite.new()
	noise.frequency = 0.85
	var nt := NoiseTexture2D.new()
	nt.noise = noise
	nt.width = 256
	nt.height = 256
	nt.seamless = true
	mat_felt.albedo_texture = nt
	mat_felt.uv1_scale = Vector3(34, 34, 34)
	mat_felt.roughness = 0.96
	mat_back = StandardMaterial3D.new()
	mat_back.albedo_color = Color(0.10, 0.52, 0.28)
	mat_back.roughness = 0.5
	mat_groove = StandardMaterial3D.new()
	mat_groove.albedo_color = Color(0.30, 0.29, 0.26)
	mat_groove.roughness = 0.9
	mat_plate = StandardMaterial3D.new()
	mat_plate.albedo_color = Color(1.0, 0.985, 0.955)
	mat_plate.roughness = 0.38
	mat_gold = StandardMaterial3D.new()
	mat_gold.albedo_color = Color(0.72, 0.55, 0.20)
	mat_gold.metallic = 0.75
	mat_gold.roughness = 0.32

	mat_rim = StandardMaterial3D.new()
	mat_rim.albedo_color = Color(0.185, 0.105, 0.062)
	mat_rim.roughness = 0.55

func _env() -> void:
	var we := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.04, 0.06, 0.08)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.60, 0.66, 0.72)
	env.ambient_light_energy = 0.66
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.ssao_enabled = true
	env.ssao_radius = 26.0
	env.ssao_intensity = 1.9
	env.ssao_power = 1.6
	env.glow_enabled = true
	env.glow_intensity = 0.35
	env.glow_bloom = 0.08
	env.adjustment_enabled = true
	env.adjustment_contrast = 1.10
	env.adjustment_saturation = 1.06
	we.environment = env
	add_child(we)
	var sun := DirectionalLight3D.new()
	sun.light_energy = 1.15
	sun.rotation_degrees = Vector3(-62, -30, 0)
	sun.shadow_enabled = true
	add_child(sun)
	cam = Camera3D.new()
	cam.position = Vector3(0, CAM_H, CAM_D)
	cam.fov = CAM_FOV
	cam.near = 1.0
	cam.far = 6000.0
	add_child(cam)
	cam.look_at(Vector3(0, 0, 0), Vector3.UP)

func _box(size: Vector3, pos: Vector3, ry: float, m: Material) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	mi.material_override = m
	mi.position = pos
	mi.rotation.y = ry
	board.add_child(mi)
	return mi

func _face_key(kind: int) -> String:
	if kind < 9:
		return "wan_%d" % (kind + 1)
	if kind < 18:
		return "tong_%d" % (kind - 8)
	if kind < 27:
		return "tiao_%d" % (kind - 17)
	var honor := ["feng_dong", "feng_nan", "feng_xi", "feng_bei", "jian_zhong", "jian_fa", "jian_bai"]
	return honor[kind - 27]

func _face_quad(kind: int, pos: Vector3, size: Vector2, rot: Vector3) -> void:
	var q := MeshInstance3D.new()
	var qm := QuadMesh.new()
	qm.size = size
	q.mesh = qm
	var m := StandardMaterial3D.new()
	var tex = load("res://faces/%s.png" % _face_key(kind))
	if tex:
		m.albedo_texture = tex
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.cull_mode = BaseMaterial3D.CULL_DISABLED
	q.material_override = m
	q.position = pos
	q.rotation = rot
	board.add_child(q)

# ────────────────────────── 重建 ──────────────────────────
func _build() -> void:
	if board and is_instance_valid(board):
		board.visible = false
		board.queue_free()
	board = Node3D.new()
	board.name = "Board"
	add_child(board)
	_box(Vector3(1300, 46, 1090), Vector3(0, -24, 0), 0, mat_rim)
	_box(Vector3(1210, 26, 1010), Vector3(0, -13, 0), 0, mat_felt)
# 桌面金边
	_box(Vector3(1150, 2, 3), Vector3(0, 0.6, 468), 0, mat_gold)
	_box(Vector3(1150, 2, 3), Vector3(0, 0.6, -468), 0, mat_gold)
	_box(Vector3(3, 2, 940), Vector3(577, 0.6, 0), 0, mat_gold)
	_box(Vector3(3, 2, 940), Vector3(-577, 0.6, 0), 0, mat_gold)

	_build_wall()
	_build_rivers()
	_build_hand()
	_build_other_hands()
	_build_melds()
	_build_center()
	_build_seats()
	_drop_seat = -1
	_anim_draw = false
	_update_hud()


## 把一个牌的所有零件装进同一个容器，方便整体做补间
func _tile_group(pos: Vector3, ry: float) -> Node3D:
	var root := Node3D.new()
	root.position = pos
	root.rotation.y = ry
	board.add_child(root)
	return root

func _part(root: Node3D, size: Vector3, off: Vector3, m: Material) -> void:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	mi.material_override = m
	mi.position = off
	root.add_child(mi)

func _part_face(root: Node3D, kind: int, off: Vector3, size: Vector2, rot: Vector3) -> void:
	var q := MeshInstance3D.new()
	var qm := QuadMesh.new()
	qm.size = size
	q.mesh = qm
	var m := StandardMaterial3D.new()
	var tex = load("res://faces/%s.png" % _face_key(kind))
	if tex:
		m.albedo_texture = tex
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.cull_mode = BaseMaterial3D.CULL_DISABLED
	# 牌面图 224×312 缩到 ~34px：必须开各向异性 + mipmap，否则糊成一片
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	q.material_override = m
	q.position = off
	q.rotation = rot
	root.add_child(q)

## 立着的牌（手牌）：牌厚 = HAND_T，凹槽和面片贴在正面外侧
func _tile_upright(pos: Vector3, kind: int, sc: float = 1.0) -> Node3D:
	var root := _tile_group(pos, 0.0)
	root.scale = Vector3.ONE * sc
	root.rotation.x = deg_to_rad(-HAND_TILT)
	var T := HAND_T
	var F := T * 0.5                       # 正面所在的 z
	_part(root, Vector3(HAND_W, HAND_H * 0.80, T), Vector3(0, -HAND_H * 0.10, 0), mat_ivory)
	_part(root, Vector3(HAND_W - 1.8, HAND_H * 0.20, T - 1.6), Vector3(0, HAND_H * 0.40, 0), mat_ivory)
	_part(root, Vector3(HAND_W - 3.0, HAND_H - 3.0, 1.2), Vector3(0, 0, F + 0.6), mat_groove)
	_part(root, Vector3(HAND_W - 5.0, HAND_H - 5.0, 1.2), Vector3(0, 0, F + 1.4), mat_plate)
	_part_face(root, kind, Vector3(0, 0, F + 2.1), Vector2(HAND_W - 6.0, HAND_H - 6.0), Vector3.ZERO)
	return root

## 平躺的牌（牌河 / 副露）：牌厚 = SIDE_T，底面贴桌
func _tile_flat(pos: Vector3, ry: float, kind: int, sc: float = 1.0) -> Node3D:
	var root := _tile_group(pos, ry)
	root.scale = Vector3.ONE * sc
	var T := SIDE_T
	_part(root, Vector3(RIVER_S, T, RIVER_S), Vector3(0, T * 0.5, 0), mat_ivory)
	_part(root, Vector3(RIVER_S - 3.0, 1.2, RIVER_S - 3.0), Vector3(0, T + 0.6, 0), mat_groove)
	_part(root, Vector3(RIVER_S - 5.0, 1.2, RIVER_S - 5.0), Vector3(0, T + 1.4, 0), mat_plate)
	_part_face(root, kind, Vector3(0, T + 2.1, 0), Vector2(RIVER_S - 9, RIVER_S - 9), Vector3(-PI * 0.5, 0, 0))
	return root
func _build_wall() -> void:
	var slots: Array = []
	var step := TW + GAP
	var half := (PER_SIDE - 1) * step * 0.5
	for side in ["top", "right", "bottom", "left"]:
		for k in range(PER_SIDE):
			var idx: int = (PER_SIDE - 1 - k) if (side == "bottom" or side == "left") else k
			var off: float = idx * step - half
			var p := Vector3.ZERO
			var ry := 0.0
			if side == "top":
				p = Vector3(off, 0, -(RINY + TD * 0.5))
			elif side == "bottom":
				p = Vector3(off, 0, RINY + TD * 0.5)
			elif side == "left":
				p = Vector3(-(RINX + TD * 0.5), 0, off)
				ry = PI * 0.5
			else:
				p = Vector3(RINX + TD * 0.5, 0, off)
				ry = PI * 0.5
			slots.append({ "pos": p, "ry": ry })
	var remain: int = wall.size()
	var keep: int = int(ceil(remain / 2.0))
	if keep <= 0:
		return
	var use: Array = slots.slice(max(0, slots.size() - keep), slots.size())
	# 余牌为奇数时，破墙那一墩只剩下面一张（上面那张已被摸走）
	for k in range(use.size()):
		var s = use[k]
		var layers := 2
		if remain % 2 == 1 and k == 0:
			layers = 1
		for i in range(layers):
			var y0 := i * (TH + 0.8)
			_box(Vector3(TW, TH, TD), s["pos"] + Vector3(0, y0 + TH * 0.5, 0), s["ry"], mat_ivory)
			_box(Vector3(TW - 0.6, 1.2, TD - 0.6), s["pos"] + Vector3(0, y0 + TH - 0.3, 0), s["ry"], mat_green)

func _river_slot(seat: int, i: int) -> Dictionary:
	var per_row := 6
	var row := i / per_row
	var col := i % per_row
	# 各行从「自己的左前方」起，依次向右；放满 6 张换下一行
	var along := -103.0 + col * 41.0
	var depth := 160.0 + row * 41.0
	var p := Vector3.ZERO
	var ry := 0.0
	match seat:
		0:
			p = Vector3(along, 0, depth)
		2:
			p = Vector3(-along, 0, -depth)
			ry = PI
		1:
			# 下家在右手边
			p = Vector3(depth, 0, -along)
			ry = PI * 0.5
		3:
			# 上家在左手边
			p = Vector3(-depth, 0, along)
			ry = -PI * 0.5
	return { "pos": p, "ry": ry }

func _build_rivers() -> void:
	var rcols := [Color(0.10, 0.17, 0.28), Color(0.11, 0.21, 0.15), Color(0.26, 0.13, 0.12), Color(0.24, 0.21, 0.10)]
	for s in range(4):
		var rm := StandardMaterial3D.new()
		rm.albedo_color = rcols[s]
		rm.roughness = 0.95
		var rp := Vector3.ZERO
		var rs := Vector3(272, 0.8, 84)
		match s:
			0:
				rp = Vector3(0, 0.4, 150)
			2:
				rp = Vector3(0, 0.4, -150)
			1:
				rp = Vector3(-150, 0.4, 0)
				rs = Vector3(84, 0.8, 272)
			3:
				rp = Vector3(150, 0.4, 0)
				rs = Vector3(84, 0.8, 272)
		_box(rs, rp, 0, rm)
	for seat in range(4):
		for i in range(rivers[seat].size()):
			var sl := _river_slot(seat, i)
			var kind: int = int(rivers[seat][i])
			var rf: Node3D = _tile_flat(sl["pos"], sl["ry"], kind, 0.78)
			if seat == _drop_seat and i == rivers[seat].size() - 1:
				rf.position.y += 70.0
				rf.scale = Vector3(0.86, 0.86, 0.86)
				var tw2 := create_tween()
				tw2.set_parallel(true)
				tw2.tween_property(rf, "position:y", sl["pos"].y, 0.22).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)
				tw2.tween_property(rf, "scale", Vector3.ONE, 0.22)

func _hand_x(i: int, n: int) -> float:
	var half := (n - 1) * HAND_STEP * 0.5
	return -half + i * HAND_STEP

func _hand_shift() -> float:
	return 40.0 if not melds[0].is_empty() else 0.0

func _build_hand() -> void:
	var n: int = hands[0].size()
	var shift := _hand_shift()
	for i in range(n):
		var x := _hand_x(i, n) - shift
		var lift := 8.0 if i == drawn_index else 0.0
		var p := Vector3(x, HAND_H * 0.5 + lift, HAND_Z)
		var tn: Node3D = _tile_upright(p, int(hands[0][i]))
		if i == drawn_index and drawn_index >= 0 and _anim_draw:
			tn.position.y -= 46.0
			var tw := create_tween()
			tw.tween_property(tn, "position:y", p.y, 0.28).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)

func _build_other_hands() -> void:
	for seat in [1, 2, 3]:
		var n: int = hands[seat].size()
		for i in range(n):
			var x := _hand_x(i, n)
			match seat:
				2:
					_box(Vector3(HAND_W, HAND_H, HAND_T), Vector3(-x, HAND_H * 0.5, -HAND_Z), 0, mat_ivory)
					_box(Vector3(HAND_W - 3, HAND_H - 3, 1.2), Vector3(-x, HAND_H * 0.5, -HAND_Z + HAND_T * 0.5 + 0.4), 0, mat_back)
				1:
					_box(Vector3(HAND_T, HAND_H, HAND_W), Vector3(HAND_X, HAND_H * 0.5, x), 0, mat_ivory)
					_box(Vector3(1.2, HAND_H - 3, HAND_W - 3), Vector3(HAND_X - HAND_T * 0.5 - 0.4, HAND_H * 0.5, x), 0, mat_back)
				3:
					_box(Vector3(HAND_T, HAND_H, HAND_W), Vector3(-HAND_X, HAND_H * 0.5, -x), 0, mat_ivory)
					_box(Vector3(1.2, HAND_H - 3, HAND_W - 3), Vector3(-HAND_X + HAND_T * 0.5 + 0.4, HAND_H * 0.5, -x), 0, mat_back)

func _build_melds() -> void:
	for seat in range(4):
		var list: Array = melds[seat]
		if list.is_empty():
			continue
		# 锚在各家「右下角」的外圈，新牌往右加、旧牌往左挤（锚点固定 = 右对齐）
		var anchor := Vector3.ZERO
		var dir := Vector3.ZERO
		match seat:
			0:
				anchor = Vector3(470, 0, 468)
				dir = Vector3(-50, 0, 0)
			1:
				anchor = Vector3(500, 0, -430)
				dir = Vector3(0, 0, 50)
			2:
				anchor = Vector3(-470, 0, -468)
				dir = Vector3(50, 0, 0)
			3:
				anchor = Vector3(-500, 0, 430)
				dir = Vector3(0, 0, -50)
		# 摊平成一条，最新的牌放在最右（锚点），旧的依次往左推
		var flat: Array = []
		for m in list:
			for t in m["tiles"]:
				flat.append(int(t))
		var mry := 0.0
		match seat:
			1:
				mry = PI * 0.5
			2:
				mry = PI
			3:
				mry = -PI * 0.5
		var idx := 0.0
		for i in range(flat.size() - 1, -1, -1):
			_tile_flat(anchor + dir * idx, mry, flat[i])
			idx += 1.0
			if (flat.size() - 1 - i) % 3 == 2:
				idx += 0.35
		var lb := Label3D.new()
		lb.text = SEAT_NAMES[seat] + " 副露"
		lb.font_size = 34
		lb.pixel_size = 0.24
		lb.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		lb.no_depth_test = true
		lb.modulate = Color(1.0, 0.88, 0.55)
		lb.position = anchor - dir * (idx * 0.5) + Vector3(0, 30, 0)
		board.add_child(lb)
func _build_center() -> void:
	var cyl := MeshInstance3D.new()
	var cm := CylinderMesh.new()
	cm.top_radius = 56.0
	cm.bottom_radius = 56.0
	cm.height = 6.0
	cyl.mesh = cm
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(0.09, 0.18, 0.14)
	m.roughness = 0.45
	cyl.material_override = m
	cyl.position = Vector3(0, 3, 0)
	board.add_child(cyl)

	var ring := MeshInstance3D.new()
	var tm := TorusMesh.new()
	tm.inner_radius = 74.0
	tm.outer_radius = 84.0
	ring.mesh = tm
	ring.material_override = mat_gold
	ring.position = Vector3(0, 5.5, 0)
	board.add_child(ring)
	# (已在上方 add_child)

## 四家名牌 + 中央剩余张数
func _build_seats() -> void:
	var names := ["你", "下家", "对家", "上家"]
	# 座位 0 下、1 右（下家）、2 上、3 左（上家）—— 逆时针出牌
	var spots := [Vector3(0, 60, 545), Vector3(500, 150, 0), Vector3(0, 150, -470), Vector3(-500, 150, 0)]
	for s in range(4):
		var l := Label3D.new()
		var cnt: int = hands[s].size()
		for m in melds[s]:
			cnt += m["tiles"].size()
		l.text = "%s  %d 张" % [names[s], cnt]
		l.font_size = 48
		l.pixel_size = 0.34
		l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		l.no_depth_test = true
		l.modulate = Color(1, 0.86, 0.45) if s == turn else Color(0.78, 0.86, 0.82)
		l.position = spots[s]
		board.add_child(l)

	var c := Label3D.new()
	c.text = str(wall.size())
	c.font_size = 110
	c.pixel_size = 0.5
	c.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	c.no_depth_test = true
	c.modulate = Color(0.95, 0.93, 0.75)
	c.position = Vector3(0, 18, 0)
	board.add_child(c)

# ────────────────────────── HUD ──────────────────────────
func _make_hud() -> void:
	var layer := CanvasLayer.new()
	add_child(layer)
	hud = Label.new()
	hud.position = Vector2(24, 18)
	hud.add_theme_font_size_override("font_size", 18)
	layer.add_child(hud)
	big = Label.new()
	big.position = Vector2(0, 300)
	big.size = Vector2(1240, 200)
	big.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	big.add_theme_font_size_override("font_size", 40)
	big.visible = false
	layer.add_child(big)

	var bg := ColorRect.new()
	bg.position = Vector2(12, 692)
	bg.size = Vector2(300, 120)
	bg.color = Color(0, 0, 0, 0.45)
	layer.add_child(bg)

	evt_log = Label.new()
	evt_log.position = Vector2(20, 698)
	evt_log.size = Vector2(290, 110)
	evt_log.add_theme_font_size_override("font_size", 15)
	evt_log.modulate = Color(0.85, 0.95, 0.90, 0.85)
	layer.add_child(evt_log)

	toast = Label.new()
	toast.position = Vector2(0, 96)
	toast.size = Vector2(1240, 44)
	toast.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	toast.add_theme_font_size_override("font_size", 26)
	toast.modulate = Color(1, 0.92, 0.55)
	toast.visible = false
	layer.add_child(toast)

	result_detail = Label.new()
	result_detail.position = Vector2(0, 372)
	result_detail.size = Vector2(1240, 60)
	result_detail.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	result_detail.add_theme_font_size_override("font_size", 22)
	result_detail.visible = false
	layer.add_child(result_detail)

	restart_btn = Button.new()
	restart_btn.text = "再来一局"
	restart_btn.custom_minimum_size = Vector2(180, 56)
	restart_btn.position = Vector2(530, 452)
	restart_btn.add_theme_font_size_override("font_size", 22)
	restart_btn.visible = false
	restart_btn.pressed.connect(_restart)
	layer.add_child(restart_btn)

	_claim_row = HBoxContainer.new()
	_claim_row.position = Vector2(420, 700)
	_claim_row.add_theme_constant_override("separation", 14)
	_claim_row.visible = false
	_human_pending = {}
	layer.add_child(_claim_row)
	_update_hud()

func _show_claim(opts: Array) -> void:
	for c in _claim_row.get_children():
		c.queue_free()
	var names := { "hu": "胡", "gang": "杠", "peng": "碰" }
	for o in opts:
		var b := Button.new()
		b.text = names[o]
		b.custom_minimum_size = Vector2(96, 52)
		b.add_theme_font_size_override("font_size", 22)
		b.pressed.connect(_on_claim.bind(o))
		_claim_row.add_child(b)
	var p := Button.new()
	p.text = "过"
	p.custom_minimum_size = Vector2(96, 52)
	p.add_theme_font_size_override("font_size", 22)
	p.pressed.connect(_on_claim.bind("pass"))
	_claim_row.add_child(p)
	_claim_row.visible = true

func _on_claim(kind: String) -> void:
	if _human_pending.is_empty():
		return
	_claim_row.visible = false
	_human_pending = {}
	_apply_human_claim(_claim_from, _claim_tile, kind)

func _apply_human_claim(from_seat: int, tile: int, kind: String) -> void:
	if kind == "bugang":
		_do_self_kong(0, _bugang_tile(0), "bugang")
		return
	if kind == "angang":
		_do_self_kong(0, _angang_tile(0), "angang")
		return
	if kind == "pass" or kind == "":
		_ev("你 过")
		_ai_claims()
		return
	if kind == "hu":
		var probe: Array = hands[0].duplicate()
		probe.append(tile)
		var ev: Dictionary = MJRules.evaluate(probe, melds[0])
		hands[0] = probe
		_win(0, tile, ev)
		return
	if kind == "gang":
		for i in range(3):
			hands[0].erase(tile)
		melds[0].append({ "type": "gang", "tiles": [tile, tile, tile, tile] })
		if rivers[from_seat].size() > 0:
			rivers[from_seat].pop_back()
		_play("gang", 0.0)
		_say_after("vo_gang")
		_toast("%s 杠 %s" % [SEAT_NAMES[0], TILE_NAMES[tile]])
		_ev(">>> 你 杠 %s" % TILE_NAMES[tile])
		_draw_for(0)
		turn = 0
		phase = "discard"
		_set_state(St.HUMAN_DISCARD)
		_build()
		return
	if kind == "peng":
		hands[0].erase(tile)
		hands[0].erase(tile)
		melds[0].append({ "type": "peng", "tiles": [tile, tile, tile] })
		if rivers[from_seat].size() > 0:
			rivers[from_seat].pop_back()
		_play("peng", 0.0)
		_say_after("vo_peng")
		_toast("%s 碰 %s" % [SEAT_NAMES[0], TILE_NAMES[tile]])
		_ev(">>> 你 碰 %s" % TILE_NAMES[tile])
		turn = 0
		phase = "discard"
		_set_state(St.HUMAN_DISCARD)
		_build()
		return
func _hide_claim() -> void:
	if _claim_row:
		_claim_row.visible = false
	_human_pending = {}

func _update_hud() -> void:
	if hud == null:
		return
	var who: String = ["你", "下家", "对家", "上家"][turn]
	var ting := ""
	if turn == 0 and not hands[0].is_empty() and (hands[0].size() + melds[0].size() * 3) % 3 == 1:
		var w: Array = MJRules.waits(hands[0], melds[0])
		if not w.is_empty():
			ting = " · 听 %d 张" % w.size()
	hud.text = "剩 %d 张 · 轮到 %s%s · %s" % [wall.size(), who, ting, "请出牌" if turn == 0 else "等待"]

func _hand_screen_rect(i: int) -> Rect2:
	var n: int = hands[0].size()
	var x := _hand_x(i, n) - _hand_shift()
	var a := cam.unproject_position(Vector3(x - HAND_W * 0.5, 0, HAND_Z))
	var b := cam.unproject_position(Vector3(x + HAND_W * 0.5, HAND_H, HAND_Z))
	return Rect2(min(a.x, b.x), min(a.y, b.y), abs(b.x - a.x), abs(b.y - a.y))

func _input(event: InputEvent) -> void:
	if game_over:
		return
	if not (event is InputEventMouseButton):
		return
	if not event.pressed or event.button_index != MOUSE_BUTTON_LEFT:
		return
	if turn != 0 or phase != "discard":
		return
	for i in range(hands[0].size()):
		if _hand_screen_rect(i).has_point(event.position):
			_player_discard(i)
			return

func _auto_run() -> void:
	auto_pass = true
	var guard := 0
	var limit := 6000 if Engine.time_scale > 1.5 else 6000
	while not game_over and guard < limit:
		guard += 1
		await get_tree().create_timer(0.02).timeout
		if turn == 0 and phase == "discard" and hands[0].size() > 0:
			_player_discard(randi() % hands[0].size())
	var total_disc := 0
	for s4 in range(4):
		total_disc += rivers[s4].size()
	print("AUTO end wall=", wall.size(), " discards=", total_disc)
	for s5 in range(4):
		if melds[s5].size() > 0:
			print("MELDS seat", s5, " = ", melds[s5])
	get_tree().quit()

func _claim_test() -> void:
	var ok := 0
	_new_game()
	_total_checks = 4
	_show_claim(["peng", "gang", "hu"])
	await get_tree().process_frame
	if _claim_row and _claim_row.get_child_count() == 4:
		ok += 1
	print("C1 按钮=", _claim_row.get_child_count())
	for q in range(1, 4):
		hands[q] = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18]
	hands[0] = [5, 5, 0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 28]
	melds[0] = []
	rivers[1] = [5]
	_human_pending = { "opts": ["peng"] }
	_claim_from = 1
	_claim_tile = 5
	_on_claim("peng")
	await get_tree().process_frame
	if melds[0].size() == 1 and melds[0][0]["tiles"] == [5, 5, 5]:
		ok += 1
	print("C2 碰后副露=", melds[0])
	_new_game()
	rivers[1] = [5]
	_human_pending = { "opts": ["peng"] }
	_claim_from = 1
	_claim_tile = 5
	_on_claim("pass")
	await get_tree().process_frame
	if _human_pending.is_empty():
		ok += 1
	print("C3 过=", _human_pending)
	if _claim_row and not _claim_row.visible:
		ok += 1
	print("CLAIMTEST ", ok, "/4")
	get_tree().quit()
func _result_test() -> void:
	var ok := 0
	_show_result("你 胡了！", "碰碰胡\n每家 8 张 · 三家共 24")
	await get_tree().process_frame
	if big and big.visible: ok += 1
	if result_detail and result_detail.visible: ok += 1
	if restart_btn and restart_btn.visible: ok += 1
	print("RESULTTEST ", ok, "/3  big=", big.visible, " detail=", result_detail.visible, " btn=", restart_btn.visible)
	_restart()
	await get_tree().process_frame
	print("RESTART ok hands=", hands[0].size(), " wall=", wall.size(), " big=", big.visible)
	get_tree().quit()

func _peng_test() -> void:
	var ok := 0
	# 用例1：手里两张 5（六万），别人打 5 → 应该碰，且副露必须是三张 5
	_new_game()
	for q in range(1, 4):
		hands[q] = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18]
	hands[0] = [5, 5, 0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 28]
	rivers[1] = [5]
	auto_peng = true
	_after_discard(1, 5)
	_resolve_claims()
	await get_tree().process_frame
	if melds[0].size() == 1:
		ok += 1
	var mt: Array = melds[0][0]["tiles"] if melds[0].size() > 0 else []
	print("T1 副露=", mt, " 手牌=", hands[0].size(), " 手里5=", _count_in(hands[0], 5), " 河1=", rivers[1])
	if mt == [5, 5, 5]:
		ok += 1
	else:
		print("T1 FAIL 副露牌不对")
	if _count_in(hands[0], 5) == 0:
		ok += 1
	else:
		print("T1 FAIL 手牌里还剩 5")

	# 用例2：手里没有 7 的对子，别人打 7 → 不该碰
	_new_game()
	for q in range(1, 4):
		hands[q] = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18]
	hands[0] = [0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 28, 31, 32]
	rivers[2] = [7]
	_after_discard(2, 7)
	_resolve_claims()
	await get_tree().process_frame
	print("T2 副露数=", melds[0].size())
	if melds[0].size() == 0:
		ok += 1
	else:
		print("T2 FAIL 不该碰却碰了: ", melds[0])

	# 用例3：手里只有一张 9，别人打 9 → 不该碰
	_new_game()
	for q in range(1, 4):
		hands[q] = [0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18]
	hands[0] = [9, 1, 2, 10, 11, 18, 19, 20, 27, 28, 31, 32, 33]
	rivers[1] = [9]
	_after_discard(1, 9)
	_resolve_claims()
	await get_tree().process_frame
	print("T3 副露数=", melds[0].size())
	if melds[0].size() == 0:
		ok += 1
	else:
		print("T3 FAIL 单张也碰了")

	print("PENGTEST ", ok, "/5")
	get_tree().quit()

func _ai_peng_test() -> void:
	_new_game()
	hands[0] = [5, 0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 28, 31, 32]
	hands[2] = [5, 5, 3, 4, 12, 13, 21, 22, 29, 30, 33, 6, 7]
	rivers[0] = []
	rivers[2] = []
	melds[2] = []
	_build()
	# 我打出 5（一万？不，5=六万），对家有两张应碰，然后必须由对家出牌
	_player_discard(0)
	await get_tree().create_timer(3.0).timeout
	print("AIPENG melds2=", melds[2].size(), " rivers2=", rivers[2].size(), " turn=", turn)
	if melds[2].size() == 1 and rivers[2].size() >= 1:
		print("AIPENG OK 对家碰后自己出了牌")
	else:
		print("AIPENG FAIL 对家碰后没出牌")
	get_tree().quit()


func _label_test() -> void:
	_new_game()
	melds[2] = [{ "type": "peng", "tiles": [28, 28, 28] }]
	melds[0] = [{ "type": "gang", "tiles": [5, 5, 5, 5] }]
	_build()
	await get_tree().process_frame
	var found := 0
	for c in board.get_children():
		if c is Label3D:
			print("LABEL ", c.text)
			found += 1
	print("LABELTEST found=", found)
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png("res://shot.png")
	get_tree().quit()


func _river_test() -> void:
	_new_game()
	rivers[1] = [5, 5, 5]
	rivers[3] = [8, 8, 8]
	rivers[0] = [0, 0]
	rivers[2] = [9]
	_build()
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png("res://shot.png")
	get_tree().quit()


func _kong_test() -> void:
	_new_game()
	melds[0] = [{ "type": "peng", "tiles": [5, 5, 5] }]
	hands[0] = [5, 0, 1, 2, 9, 10, 11, 18, 19, 20, 27, 28]
	wall = [3, 4, 6, 7, 8, 12]
	auto_peng = true
	_offer_self_kong(0)
	await get_tree().process_frame
	var g: int = melds[0][0]["tiles"].size() if melds[0].size() > 0 else 0
	print("KONG type=", melds[0][0]["type"] if melds[0].size() > 0 else "-", " tiles=", g, " hand=", hands[0].size(), " wall=", wall.size())
	var ok := 0
	if g == 4 and melds[0][0]["type"] == "gang": ok += 1
	if _count_in(hands[0], 5) == 0: ok += 1
	if hands[0].size() == 12: ok += 1
	print("KONGTEST ", ok, "/3")
	get_tree().quit()


func _rob_test() -> void:
	# 场景：你听 5（六万），对家补杠 5 → 应该抢杠胡
	_new_game()
	var ok := 0
	hands[0] = [0, 1, 2, 3, 4, 9, 10, 11, 18, 19, 20, 27, 27]
	melds[0] = []
	melds[2] = [{ "type": "peng", "tiles": [5, 5, 5] }]
	hands[2] = [5, 6, 7, 12, 13, 14, 21, 22, 23, 30, 31, 32, 33]
	_do_self_kong(2, 5, "bugang")
	await get_tree().process_frame
	if game_over: ok += 1
	print("ROB over=", game_over, " meld2=", melds[2], " hand0=", hands[0].size())
	if hands[0].size() == 14: ok += 1
	print("ROBTEST ", ok, "/2")
	get_tree().quit()

