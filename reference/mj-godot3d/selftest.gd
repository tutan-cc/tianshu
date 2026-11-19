extends SceneTree
## 规则自检：跑几个已知牌型，确认 evaluate / waits 与 mahjong.js 一致

const R = preload("res://rules.gd")

func _initialize() -> void:
	var fails := 0

	# 1) 111m 123m 456m 123p 99p → 小胡
	var a: Array = [0,0,0, 1,2,3, 4,5,6, 9,10,11, 17,17]
	var ra: Dictionary = R.evaluate(a, [])
	print("T1 小胡 ? ", ra)
	if ra.is_empty() or ra["tier"] != "small":
		fails += 1

	# 2) 七对
	var b: Array = [0,0,1,1,2,2,3,3,4,4,5,5,6,6]
	var rb: Dictionary = R.evaluate(b, [])
	print("T2 七对 ? ", rb)
	if rb.is_empty() or rb["tier"] != "bigger":
		fails += 1

	# 3) 龙七对（有一个四张）
	var c: Array = [0,0,0,0,1,1,2,2,3,3,4,4,5,5]
	var rc: Dictionary = R.evaluate(c, [])
	print("T3 龙七对 ? ", rc)
	if rc.is_empty() or rc["tier"] != "biggest":
		fails += 1

	# 4) 碰碰胡：111m 222m 333p 444p 99p（无副露）
	var d: Array = [0,0,0, 1,1,1, 11,11,11, 12,12,12, 17,17]
	var rd: Dictionary = R.evaluate(d, [])
	print("T4 碰碰胡 ? ", rd)
	if rd.is_empty() or rd["tier"] != "big":
		fails += 1

	# 5) 不成牌
	var e: Array = [0,1,3,4,6,7,9,10,12,13,15,16,27,28]
	var re: Dictionary = R.evaluate(e, [])
	print("T5 非成牌 ? ", re)
	if not re.is_empty():
		fails += 1

	# 6) 带副露：碰了 1m（3 张），暗手 11 张 + 摸 1 张 = 14 总
	var melds: Array = [{ "type": "peng", "tiles": [0,0,0] }]
	var f: Array = [1,2,3, 9,10,11, 12,13,14, 17,17]
	var rf: Dictionary = R.evaluate(f, melds)
	print("T6 带碰胡 ? ", rf)
	if rf.is_empty() or rf["tier"] != "small":
		fails += 1

	# 7) 听牌：13 张 111m 123m 456m 123p 9p，听 9p
	var g: Array = [0,0,0, 1,2,3, 4,5,6, 9,10,11, 17]
	var w: Array = R.waits(g, [])
	print("T7 听牌 ? ", w)
	if not w.has(17):
		fails += 1

	# 8) 赔付
	var pay: Dictionary = R.payout("bigger", 2)
	print("T8 七对赔付 ? ", pay)
	if pay["total"] != 8 * 2 * 3:
		fails += 1

	print("SELFTEST fails=", fails)
	quit(0 if fails == 0 else 1)
