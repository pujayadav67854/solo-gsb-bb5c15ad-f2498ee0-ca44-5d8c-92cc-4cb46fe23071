'use strict';

/**
 * 区域限员（capacity zones）引擎用例：
 *  - 超员时间段：圆心严格在区内人数超过上限的连续区间（区间、人数、名单）；
 *  - 贴边 / 瞬时触及 / 零宽高区域不计；跨关键帧停留合并；同一人只计一次；
 *  - 同刻进出一并处理：换手不产生零长度段，名单变化即分段；
 *  - 全程峰值人数只计有正持续时间的状态；
 *  - normalizeCapacityZones 规整（缺省 id/name、尺寸钳非负、上限正整数）；
 *  - analyzeScene 装配及旧场景（无 capacityZones）兼容；
 *  - 与稠密采样在随机轨迹上逐点一致（实现本身解析，无帧抽样）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../public/core.js');

const T = 12;
// 限员区：开内部 (40,60)×(40,60)
const ZONE = { id: 'z1', x: 40, y: 40, width: 20, height: 20, capacity: 1 };

function approx(actual, expected, tol = 1e-7, label) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label || '值'} 期望 ${expected}，实际 ${actual}`
  );
}

function zone(over) {
  return Object.assign({}, ZONE, over || {});
}

function analyze(zoneRaw, performers) {
  const z = core.normalizeCapacityZones([zoneRaw])[0];
  return core.analyzeCapacityZone(z, performers, T);
}

test('超员段：静止者 + 两人同时横穿，区间/人数/名单/峰值正确', () => {
  const r = analyze(zone(), [
    { id: 'a', name: 'A', radius: 5, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] },
    { id: 'b', name: 'B', radius: 5, keys: [{ t: 0, x: 50, y: 50 }] },
    { id: 'c', name: 'C', radius: 5, keys: [{ t: 0, x: 50, y: 0 }, { t: 10, x: 50, y: 100 }] }
  ]);
  // B 全程在区；A、C 同在 t∈[4,6] 横穿 -> 超员 [4,6] 共 3 人
  assert.equal(r.overcrowded, true);
  assert.equal(r.segments.length, 1);
  approx(r.segments[0].start, 4, 1e-9, '超员起点');
  approx(r.segments[0].end, 6, 1e-9, '超员终点');
  assert.equal(r.segments[0].count, 3);
  assert.deepEqual(r.segments[0].performerIds, ['b', 'a', 'c']);
  assert.deepEqual(r.segments[0].performerNames, ['B', 'A', 'C']);
  approx(r.firstOverflow, 4, 1e-9);
  assert.equal(r.peakCount, 3);
  approx(r.peakStart, 4, 1e-9);
  approx(r.peakEnd, 6, 1e-9);
  assert.deepEqual(r.peakNames, ['B', 'A', 'C']);
});

test('未超员：上限等于峰值时无超员段，峰值仍正确', () => {
  const r = analyze(zone({ capacity: 2 }), [
    { id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] },
    { id: 'b', name: 'B', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ]);
  assert.equal(r.overcrowded, false);
  assert.deepEqual(r.segments, []);
  assert.equal(r.firstOverflow, null);
  assert.equal(r.peakCount, 2, 't∈[4,6] 两人在区');
});

test('贴边不计：沿边界 y=40 滑行全程不入内', () => {
  const r = analyze(zone(), [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 40 }, { t: 10, x: 100, y: 40 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 200, y: 200 }] }
  ]);
  assert.equal(r.overcrowded, false);
  assert.equal(r.peakCount, 0);
  assert.equal(r.peakStart, null);
});

test('瞬时触角不计：对角线仅触及角点 (60,60) 一个时刻', () => {
  const r = analyze(zone(), [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 120 }, { t: 12, x: 120, y: 0 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 200, y: 200 }] }
  ]);
  assert.equal(r.overcrowded, false);
  assert.equal(r.peakCount, 0, '角点瞬时相触不构成正持续停留');
});

test('零宽/零高区域没有内部，永不统计', () => {
  const performers = [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ];
  [zone({ width: 0 }), zone({ height: 0 }), zone({ width: 0, height: 0 })].forEach((z) => {
    const r = analyze(z, performers);
    assert.equal(r.overcrowded, false);
    assert.equal(r.peakCount, 0);
    assert.deepEqual(r.segments, []);
  });
});

test('跨关键帧的连续停留合并为一段（同一人只计一次）', () => {
  // 共线三帧，t=5 关键帧位于区内：停留应为单个 [4,6]，而非两段
  const r = analyze(zone(), [
    { id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 5, x: 50, y: 50 }, { t: 10, x: 100, y: 50 }] },
    { id: 'b', name: 'B', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ]);
  assert.equal(r.segments.length, 1);
  approx(r.segments[0].start, 4, 1e-9);
  approx(r.segments[0].end, 6, 1e-9);
  assert.equal(r.segments[0].count, 2, '同一人同一时刻只计一次');
});

test('往返两次进入：同一人两段停留各自超员，名单不重复计', () => {
  // A 折返横穿：t∈[2,3] 与 t∈[7,8] 两次在区；B 全程在区
  const r = analyze(zone(), [
    { id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 5, x: 100, y: 50 }, { t: 10, x: 0, y: 50 }] },
    { id: 'b', name: 'B', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ]);
  assert.equal(r.segments.length, 2);
  approx(r.segments[0].start, 2, 1e-9);
  approx(r.segments[0].end, 3, 1e-9);
  approx(r.segments[1].start, 7, 1e-9);
  approx(r.segments[1].end, 8, 1e-9);
  r.segments.forEach((seg) => {
    assert.equal(seg.count, 2);
    assert.deepEqual(seg.performerIds, ['b', 'a']);
  });
  assert.equal(r.peakCount, 2);
});

test('同刻进出一并处理：换手不产生零长度段，名单变化即分段，峰值不叠加', () => {
  // C 全程在区；A 停留 [0,2.4]，B 停留 [2.4,3.2]（t=2.4 同刻换手）
  const performers = [
    { id: 'c', name: 'C', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] },
    { id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 50, y: 50 }, { t: 2, x: 50, y: 50 }, { t: 4, x: 0, y: 50 }] },
    { id: 'b', name: 'B', radius: 0, keys: [{ t: 0, x: 30, y: 50 }, { t: 2, x: 30, y: 50 }, { t: 4, x: 80, y: 50 }] }
  ];
  const r = analyze(zone(), performers);
  assert.equal(r.segments.length, 2, '名单变化即分段');
  approx(r.segments[0].start, 0, 1e-9);
  approx(r.segments[0].end, 2.4, 1e-9);
  assert.deepEqual(r.segments[0].performerIds, ['c', 'a']);
  approx(r.segments[1].start, 2.4, 1e-9);
  approx(r.segments[1].end, 3.2, 1e-9);
  assert.deepEqual(r.segments[1].performerIds, ['c', 'b']);
  r.segments.forEach((seg) => {
    assert.ok(seg.end - seg.start > 1e-6, '不生成零长度超员段');
    assert.equal(seg.count, 2);
  });
  // t=2.4 的瞬时交接态 {C,A,B} 没有正持续时间，峰值不得计为 3
  assert.equal(r.peakCount, 2);
});

test('峰值只计有正持续时间的状态：纯换手场景峰值为 1', () => {
  // A 停留 [0,2.4]、B 停留 [2.4,3.2]，任何正持续区间都只有 1 人
  const r = analyze(zone(), [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 50, y: 50 }, { t: 2, x: 50, y: 50 }, { t: 4, x: 0, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 30, y: 50 }, { t: 2, x: 30, y: 50 }, { t: 4, x: 80, y: 50 }] }
  ]);
  assert.equal(r.overcrowded, false);
  assert.equal(r.peakCount, 1, '瞬时交接不算两人同时在区');
  approx(r.peakStart, 0, 1e-9);
  approx(r.peakEnd, 2.4, 1e-9);
});

test('normalizeCapacityZones：缺省 id/name、尺寸钳非负、上限必须为正整数', () => {
  const list = core.normalizeCapacityZones([
    { x: 1, y: 2, width: 30, height: 40, capacity: 3 },
    { id: 'keep', name: 'VIP 区', x: 0, y: 0, width: -5, height: -6, capacity: 2.9 },
    { x: 0, y: 0, width: 10, height: 10, capacity: 0 },
    { x: 0, y: 0, width: 10, height: 10, capacity: 0.5 },
    { x: 0, y: 0, width: 10, height: 10, capacity: -2 },
    { x: 0, y: 0, width: 10, height: 10, capacity: 'abc' },
    null,
    'junk'
  ]);
  assert.equal(list.length, 2, '上限非正整数/非法项被丢弃');
  assert.ok(list[0].id, '缺省 id 自动生成');
  assert.equal(list[0].name, '限员区 1');
  assert.equal(list[0].capacity, 3);
  assert.equal(list[1].id, 'keep', '显式 id 保留');
  assert.equal(list[1].name, 'VIP 区');
  assert.equal(list[1].width, 0, '负宽钳为 0');
  assert.equal(list[1].height, 0, '负高钳为 0');
  assert.equal(list[1].capacity, 2, '小数上限向下取整');
  assert.deepEqual(core.normalizeCapacityZones(undefined), []);
  assert.deepEqual(core.normalizeCapacityZones('nope'), []);
});

test('analyzeScene：capacityResults 装配及旧场景（无 capacityZones）兼容', () => {
  const withZones = core.analyzeScene({
    duration: T,
    performers: [
      { id: 'a', name: 'A', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] },
      { id: 'b', name: 'B', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
    ],
    capacityZones: [{ x: 40, y: 40, width: 20, height: 20, capacity: 1 }]
  });
  assert.equal(withZones.capacityZones.length, 1);
  assert.equal(withZones.capacityZones[0].name, '限员区 1');
  assert.equal(withZones.capacityResults.length, 1);
  assert.equal(withZones.capacityResults[0].overcrowded, true);
  approx(withZones.capacityResults[0].segments[0].start, 4, 1e-9);

  const legacy = core.analyzeScene({
    duration: T,
    performers: [
      { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 0 }] },
      { id: 'b', radius: 0, keys: [{ t: 0, x: 5, y: 5 }] }
    ]
  });
  assert.deepEqual(legacy.capacityZones, []);
  assert.deepEqual(legacy.capacityResults, []);
});

test('isZoneOvercrowded：段内为真、段外为假', () => {
  const r = analyze(zone(), [
    { id: 'a', radius: 0, keys: [{ t: 0, x: 0, y: 50 }, { t: 10, x: 100, y: 50 }] },
    { id: 'b', radius: 0, keys: [{ t: 0, x: 50, y: 50 }] }
  ]);
  assert.equal(core.isZoneOvercrowded(r, 5), true);
  assert.equal(core.isZoneOvercrowded(r, 4), true, '含进入端点');
  assert.equal(core.isZoneOvercrowded(r, 6), true, '含离开端点');
  assert.equal(core.isZoneOvercrowded(r, 3.9), false);
  assert.equal(core.isZoneOvercrowded(r, 6.2), false);
  assert.equal(core.isZoneOvercrowded(null, 5), false);
});

test('超员分析：与稠密采样在随机分段轨迹 / 区域 / 上限上逐点一致（实现解析）', () => {
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(20260927);
  function rc() { return Math.round(rnd() * 120) - 10; }

  for (let trial = 0; trial < 40; trial++) {
    const mkPerformer = (idx) => {
      const nk = 1 + Math.floor(rnd() * 3);
      const keys = [];
      for (let i = 0; i <= nk; i++) {
        keys.push({
          t: Math.round((T * i) / nk * 10) / 10,
          x: rc() + 40,
          y: rc() + 40
        });
      }
      return { id: 'p' + idx, name: 'P' + idx, radius: Math.round(rnd() * 10), keys };
    };
    const performers = [mkPerformer(0), mkPerformer(1), mkPerformer(2)];
    const zraw = {
      id: 'z',
      x: rc() + 20,
      y: rc() + 20,
      width: 20 + rnd() * 80,
      height: 20 + rnd() * 80,
      capacity: 1 + Math.floor(rnd() * 3)
    };
    const z = core.normalizeCapacityZones([zraw])[0];
    const r = core.analyzeCapacityZone(z, performers, T);
    const X1 = z.x + z.width;
    const Y1 = z.y + z.height;

    function insideAt(p, t) {
      const s = core.stateAt(p.keys, t, p.radius);
      return s.x > z.x && s.x < X1 && s.y > z.y && s.y < Y1;
    }
    function truthCount(t) {
      return performers.filter((p) => insideAt(p, t)).length;
    }

    // 超员段边界（采样时避开，边界时刻的严格内外由解析定义）
    const bounds = [];
    r.segments.forEach((seg) => { bounds.push(seg.start, seg.end); });

    for (let i = 0; i <= 4000; i++) {
      const t = (T * i) / 4000;
      if (bounds.some((b) => Math.abs(t - b) < 1e-4)) continue;
      const expect = truthCount(t) > z.capacity;
      const actual = core.isZoneOvercrowded(r, t);
      assert.equal(actual, expect, `trial${trial} t=${t} 超员状态不一致`);
    }

    // 每段：正持续、人数与名单和段中点直接统计一致
    r.segments.forEach((seg, i) => {
      assert.ok(seg.end - seg.start > 1e-7, `trial${trial} 段 ${i} 零长度`);
      const mid = (seg.start + seg.end) / 2;
      assert.equal(seg.count, truthCount(mid), `trial${trial} 段 ${i} 人数`);
      const names = performers.filter((p) => insideAt(p, mid)).map((p) => p.name).sort();
      assert.deepEqual(seg.performerNames.slice().sort(), names, `trial${trial} 段 ${i} 名单`);
      assert.ok(seg.count > z.capacity, `trial${trial} 段 ${i} 人数超过上限`);
    });

    // 峰值：与首个峰值区间中点的直接统计一致，且不小于任何采样点
    let maxSample = 0;
    for (let i = 0; i <= 400; i++) {
      maxSample = Math.max(maxSample, truthCount((T * i) / 400));
    }
    if (r.peakCount > 0) {
      assert.equal(r.peakCount, truthCount((r.peakStart + r.peakEnd) / 2), `trial${trial} 峰值区间人数`);
      assert.ok(r.peakEnd - r.peakStart > 1e-7, `trial${trial} 峰值区间有正持续时间`);
    } else {
      assert.equal(r.peakStart, null);
    }
    assert.ok(r.peakCount >= maxSample - 0, `trial${trial} 峰值不小于采样最大人数`);
  }
});
