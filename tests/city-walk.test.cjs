const test = require("node:test");
const assert = require("node:assert/strict");
const { navigation, isFree } = require("../city-walk.js");

test("城市寻路绕过楼体并抵达指定街道位置", () => {
  const obstacles = [{ x: 0, z: 0, w: 2, d: 2 }];
  const start = { x: -2, z: 0 }, goal = { x: 2, z: 0 };
  const route = navigation(obstacles)(start, goal);
  assert.ok(route.length > 1);
  assert.deepEqual(route.at(-1), goal);
  let prev = start;
  for (const next of route) {
    for (let i = 0; i <= 100; i++) {
      const x = prev.x + (next.x - prev.x) * i / 100;
      const z = prev.z + (next.z - prev.z) * i / 100;
      assert.ok(isFree(x, z, obstacles), "路径不会穿过建筑物");
    }
    prev = next;
  }
});

test("点击楼体时落在楼外，角色也不可走出街区边界", () => {
  const obstacles = [{ x: 0, z: 0, w: 2, d: 2 }];
  const route = navigation(obstacles)({ x: -2, z: 0 }, { x: 0, z: 0 });
  assert.ok(route.length > 0);
  assert.ok(isFree(route.at(-1).x, route.at(-1).z, obstacles));
  assert.equal(isFree(20, 0, obstacles), false);
});
