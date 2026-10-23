// 判定エンジンの試験。tests/engine.test.html をブラウザで開くと結果が出る。
import { RunEngine, replay } from '../js/engine.js';
import { computeKm, DEFAULT_SETTINGS, M_PER_DEG } from '../js/util.js';

const LAT0 = 35.65;
const LON0 = 139.7;
const at = (y, x = 0) => ({ lat: LAT0 + y / M_PER_DEG, lon: LON0 + x / (M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180)) });

// 北へ一直線の路線：0m 起点、500m 信号、1000m 信号、1500m 標識、2000m 終点
const stations = computeKm([
  { id: 'A', seq: 0, name: '起点', type: 'yard', ...at(0), kmMode: 'cum', kmValue: 0 },
  { id: 'B', seq: 1, name: '信号B', type: 'signal', ...at(500), kmMode: 'cum', kmValue: 0.5 },
  { id: 'C', seq: 2, name: '信号C', type: 'signal', ...at(1000), kmMode: 'cum', kmValue: 1.0 },
  { id: 'D', seq: 3, name: '標識D', type: 'marker', ...at(1500), kmMode: 'cum', kmValue: 1.5 },
  { id: 'E', seq: 4, name: '終点', type: 'yard', ...at(2000), kmMode: 'cum', kmValue: 2.0 },
]);

const T0 = Date.UTC(2026, 9, 12, 0, 0, 0);

/** 区間ごとの動きから1秒ごとの測位を作る */
function makeTrack(script, { dir = 1, start = 0 } = {}) {
  const out = [];
  let t = 0;
  let y = start;
  for (const step of script) {
    if (step.move) {
      const v = step.v;
      const n = Math.round(Math.abs(step.move) / v);
      for (let i = 0; i < n; i++) {
        t += 1;
        y += dir * v;
        out.push({ t: T0 + t * 1000, ...at(y, step.x ?? 0), acc: step.acc ?? 5, speedRaw: v });
      }
    } else if (step.stay) {
      for (let i = 0; i < step.stay; i++) {
        t += 1;
        out.push({ t: T0 + t * 1000, ...at(y + (step.jitter ? ((i % 3) - 1) * step.jitter : 0)), acc: 5, speedRaw: 0.1 });
      }
    } else if (step.offset) {
      y += dir * step.offset;
    }
  }
  return out;
}

function run(track, { direction = 'down', settings = {} } = {}) {
  const ev = { passages: new Map(), stops: [], arrive: null, warnings: [] };
  const eng = new RunEngine({
    run: { id: 'r', direction, startTime: T0 },
    stations,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    on: {
      passage: (p) => ev.passages.set(p.id, { ...p }),
      stop: (s) => ev.stops.push(s),
      arrive: (t) => (ev.arrive = t),
      warning: (w) => ev.warnings.push(w),
    },
  });
  for (const p of track) eng.feed(p);
  if (!eng.arrived) eng.finish(track[track.length - 1].t);
  ev.list = [...ev.passages.values()].sort((a, b) => a.passT - b.passT);
  ev.by = (id) => ev.list.find((p) => p.stationId === id);
  ev.eng = eng;
  return ev;
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
}
function eq(a, b, msg, tol = 0) {
  const ok = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= tol : a === b;
  if (!ok) throw new Error(`${msg}: 期待 ${b}、実際 ${a}`);
}
const sec = (t) => (t - T0) / 1000;

// ---------------------------------------------------------------
test('高速通過：線形補間で秒未満の通過時刻を出す', () => {
  // y = -5 + 10(t-3) → 信号B(500m) は t=53.5 に通過。測位点は中心から5mずれている
  const ev = run(makeTrack([{ stay: 3 }, { offset: -5 }, { move: 2100, v: 10 }, { stay: 40 }]));
  eq(sec(ev.by('B').passT), 50.5 + 3, '信号Bの通過時刻', 0.05);
  eq(sec(ev.by('C').passT), 100.5 + 3, '信号Cの通過時刻', 0.05);
  eq(ev.by('B').estimated, false, '推定ではない');
});

test('垂線の足：横にずれた経路でも中心の真横の時刻', () => {
  const ev = run(makeTrack([{ stay: 3 }, { offset: 3 }, { move: 2000, v: 8, x: 12 }, { stay: 40 }]));
  // y = 3 + 8t, 500m は t = 62.125
  eq(sec(ev.by('B').passT), 62.125 + 3, '信号Bの通過時刻', 0.05);
  eq(ev.by('B').minDist, 12, '中心からの距離', 0.5);
});

test('信号での停車20秒 → 停車フラグ', () => {
  const ev = run(makeTrack([{ stay: 3 }, { move: 490, v: 7 }, { stay: 20 }, { move: 1510, v: 7 }, { stay: 40 }]));
  const s = ev.stops.find((x) => x.stationId === 'B');
  if (!s) throw new Error('信号Bの停車がない');
  eq(s.sec, 20, '停車秒', 0.01);
  eq(s.flag, true, '停車フラグ');
  eq(ev.by('B').stopFlag, true, '通過の停車フラグ');
  eq(ev.by('C').stopFlag, false, '信号Cは停車なし');
});

test('短い停車（5秒）も記録、フラグなし', () => {
  const ev = run(makeTrack([{ stay: 3 }, { move: 1001, v: 7 }, { stay: 5 }, { move: 1000, v: 7 }, { stay: 40 }]));
  const s = ev.stops.find((x) => x.stationId === 'C');
  if (!s) throw new Error('信号Cの停車がない');
  eq(s.sec, 5, '停車秒', 0.01);
  eq(s.flag, false, 'フラグなし');
});

test('起点で発車前に立っているあいだは停車として記録しない', () => {
  const ev = run(makeTrack([{ stay: 30 }, { move: 2000, v: 8 }, { stay: 40 }]));
  eq(ev.stops.length, 0, '停車記録の数');
  eq(sec(ev.by('A').passT) < 31, true, '起点の通過がある');
});

test('区間（構外）の停車は駅IDなし、区間IDあり', () => {
  const ev = run(makeTrack([{ stay: 3 }, { move: 700, v: 7 }, { stay: 12 }, { move: 1300, v: 7 }, { stay: 40 }]));
  const s = ev.stops[0];
  eq(s.stationId, null, '駅ID');
  eq(s.sectionId, 'B-C', '区間ID');
});

test('標識での停車は区間の停車として扱う', () => {
  const ev = run(makeTrack([{ stay: 3 }, { move: 1498, v: 7 }, { stay: 10 }, { move: 502, v: 7 }, { stay: 40 }]));
  const s = ev.stops[0];
  eq(s.stationId, null, '駅ID');
  eq(s.sectionId, 'C-D', '区間ID');
});

test('到着：終点で30秒停車 → 到着時刻は停車開始', () => {
  const tr = makeTrack([{ stay: 3 }, { move: 1995, v: 7 }, { stay: 45 }]);
  const ev = run(tr);
  if (ev.arrive == null) throw new Error('到着していない');
  eq(ev.eng.arrivalT, ev.arrive, '到着時刻');
  // 1995/7 = 285 測位 → 最後の移動は t=288、停車開始は t=289
  eq(sec(ev.arrive), 289, '到着時刻', 0.01);
  eq(ev.by('E').exitT, null, '終点は出ていない');
  eq(ev.by('E').passT, ev.arrive, '終点の通過時刻＝到着時刻');
  eq(ev.list.length, 5, '通過駅数');
});

test('到着：終点構内で短く止まってから動き、また止まった場合は最初の停車開始', () => {
  const ev = run(makeTrack([{ stay: 3 }, { move: 1981, v: 7 }, { stay: 5 }, { move: 14, v: 7 }, { stay: 40 }]));
  // 1981/7 = 283 → 停車開始 t=287
  eq(sec(ev.arrive), 287, '到着時刻', 0.01);
});

test('測位の欠落で円の中を測らなかった駅は推定', () => {
  const tr = makeTrack([{ stay: 3 }, { move: 2000, v: 8 }, { stay: 40 }]);
  // 信号C（1000m）の前後 ±80m を精度不良にする
  for (const p of tr) {
    const y = (p.lat - LAT0) * M_PER_DEG;
    if (Math.abs(y - 1000) < 80) p.acc = 120;
  }
  const ev = run(tr);
  const c = ev.by('C');
  if (!c) throw new Error('信号Cの通過がない');
  eq(c.estimated, true, '推定フラグ');
  eq(sec(c.passT), 125 + 3, '推定通過時刻', 0.1);
});

test('境界での揺らぎ：出てすぐ戻っても通過は1件', () => {
  // 信号B(500m)の円に入り（539m）、出て（553m）、1秒後に戻る（539m）
  const ev = run(makeTrack([{ stay: 3 }, { move: 539, v: 7 }, { move: 14, v: 14 }, { offset: -21 }, { move: 1463, v: 7 }, { stay: 40 }]));
  const bs = ev.list.filter((p) => p.stationId === 'B');
  eq(bs.length, 1, '信号Bの通過件数');
});

test('上り：逆向きに走ると順序どおり、警告なし', () => {
  const tr = makeTrack([{ stay: 3 }, { move: 2000, v: 8 }, { stay: 40 }], { dir: -1, start: 2000 });
  const ev = run(tr, { direction: 'up' });
  eq(ev.list.map((p) => p.stationId).join(''), 'EDCBA', '通過順');
  eq(ev.warnings.length, 0, '警告');
  if (ev.arrive == null) throw new Error('到着していない');
});

test('行先と逆向きに走ると警告', () => {
  const tr = makeTrack([{ stay: 3 }, { move: 2000, v: 8 }, { stay: 40 }], { dir: -1, start: 2000 });
  const ev = run(tr, { direction: 'down' });
  eq(ev.warnings.length > 0, true, '警告がある');
});

test('精度不良の測位は判定に使わない', () => {
  const tr = makeTrack([{ stay: 3 }, { move: 2000, v: 8 }, { stay: 40 }]);
  tr.splice(20, 0, { t: tr[19].t + 500, ...at(1000), acc: 80, speedRaw: 8 });
  const ev = run(tr);
  eq(ev.by('C').estimated, false, '信号Cは実測');
  eq(sec(ev.by('C').passT), 125 + 3, '信号Cの通過時刻', 0.1);
});

test('speed がない端末：前後の位置から速度を計算', () => {
  const tr = makeTrack([{ stay: 3 }, { move: 490, v: 7 }, { stay: 20 }, { move: 1510, v: 7 }, { stay: 40 }]);
  for (const p of tr) p.speedRaw = null;
  const ev = run(tr);
  const s = ev.stops.find((x) => x.stationId === 'B');
  if (!s) throw new Error('停車がない');
  eq(s.sec, 20, '停車秒', 1.01);
});

test('再生の決定性：同じ軌跡からは同じ結果', () => {
  const tr = makeTrack([{ stay: 3 }, { move: 490, v: 7 }, { stay: 20 }, { move: 1510, v: 7 }, { stay: 40 }]);
  const a = run(tr);
  const b = run(tr);
  eq(JSON.stringify(a.list), JSON.stringify(b.list), '通過');
  eq(JSON.stringify(a.stops), JSON.stringify(b.stops), '停車');
});

test('一時停止：進行中の停車は捨て、再開後も走り出すまでの停車は記録しない', () => {
  // 区間の途中（700m）で止まり、10秒後に一時停止、測位なしで5分、再開後20秒立ってから走り出す
  const tr = makeTrack([{ stay: 3 }, { move: 700, v: 7 }, { stay: 10 }]);
  const pauseT = tr[tr.length - 1].t + 500;
  const after = makeTrack([{ stay: 20 }, { move: 1300, v: 7 }, { stay: 40 }], { start: 700 })
    .map((p) => ({ ...p, t: p.t + (pauseT - T0) + 300000 }));
  const ev = { stops: [] };
  const eng = new RunEngine({
    run: { id: 'r', direction: 'down', startTime: T0 },
    stations, settings: { ...DEFAULT_SETTINGS },
    on: { stop: (s) => ev.stops.push(s) },
  });
  replay(eng, [...tr, ...after], [{ start: pauseT, end: after[0].t - 1000 }]);
  eq(ev.stops.filter((s) => s.stationId == null).length, 0, '区間の停車の記録数');
  eq(eng.arrived, true, '到着');
});

// ---------------------------------------------------------------
const ok = results.filter((r) => r[0]).length;
document.getElementById('out').innerHTML =
  `<h2 id="summary">${ok} / ${results.length} 成功</h2>` +
  results.map(([pass, name, msg]) => `<div class="${pass ? 'ok' : 'ng'}">${pass ? '○' : '×'} ${name}${msg ? `<br><small>${msg}</small>` : ''}</div>`).join('');
