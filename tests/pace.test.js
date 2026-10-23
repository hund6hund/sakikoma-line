// 区間の目安速度と到着予想の試験。tests/pace.test.html をブラウザで開くと結果が出る。
import { runSectionStats, buildPace, estimateArrival } from '../js/analysis.js';

const results = [];
const test = (name, fn) => { try { fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } };
const eq = (a, b, msg, tol = 0) => {
  const ok = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= tol : a === b;
  if (!ok) throw new Error(`${msg}: 期待 ${b}、実際 ${a}`);
};

const T0 = Date.UTC(2026, 9, 23, 23, 0, 0); // 日本時間 8:00
const P = (stationId, order, sec, type = 'signal', stopSec = 0) => ({ stationId, order, passT: T0 + sec * 1000, stationType: type, stopSec, estimated: false });

test('区間集計：停車中を除いた平均速度と、次の信号で捕まったか', () => {
  const ps = [P('A', 0, 0, 'yard'), P('B', 1, 60, 'signal', 20)];
  const track = [];
  for (let s = 0; s <= 60; s++) track.push({ t: T0 + s * 1000, speed: s < 40 ? 30 / 3.6 : 0, poor: false });
  const st = runSectionStats(ps, track, 3)['A>B'];
  eq(st.moving, 30, '走行中の平均', 0.01);
  eq(st.caught, true, '捕まった');
});

// 3本の運転：A→B（Bは信号）を 25/30/35 km/h、うち25の回だけ捕まる
const mk = (id, v, caught, arrive) => ({
  run: { id, status: 'done', direction: 'down', startTime: T0, arrivalTime: T0 + arrive * 1000 },
  stats: { 'A>B': { moving: v, signal: true, caught }, 'B>C': { moving: 20, signal: false, caught: false } },
  ps: [P('A', 0, 0, 'yard'), P('B', 1, 100), P('C', 2, 200, 'yard')],
});
const rs = [mk('r1', 25, true, 200), mk('r2', 30, false, 210), mk('r3', 35, false, 220)];
const input = (extra = {}) => ({
  runs: rs.map((x) => x.run),
  statsByRun: new Map(rs.map((x) => [x.run.id, structuredClone(x.stats)])),
  passagesByRun: new Map(rs.map((x) => [x.run.id, x.ps])),
  waits: [{ runId: 'r1', sec: 50 }],
  direction: 'down', startTime: T0, bands: [], capKmh: 40, ...extra,
});

test('目安速度：次の信号を通過できたときの速度の中央値', () => {
  eq(buildPace(input()).guide['A>B'], 32.5, 'A>B', 0.01);
});

test('目安速度：信号でない区間はいつもの速度', () => {
  eq(buildPace(input()).guide['B>C'], 20, 'B>C', 0.01);
});

test('目安速度：いつも捕まる信号の手前は遅め（下位25%）', () => {
  const x = input();
  for (const r of rs) x.statsByRun.get(r.run.id)['A>B'] = { ...r.stats['A>B'], caught: true };
  eq(buildPace(x).guide['A>B'], 27.5, 'A>B', 0.01);
});

test('目安速度：上限で頭打ち', () => {
  eq(buildPace(input({ capKmh: 30 })).guide['A>B'], 30, 'A>B', 0.01);
});

test('着予想：通過時刻＋いつもの残り時間＋信号1つ分', () => {
  const pace = buildPace(input());
  // Bの残り：到着200/210/220 − 100 → 中央値110。余裕は待ち50秒
  const t = estimateArrival(pace, { lastPassage: { stationId: 'B', passT: T0 + 120000 }, now: T0 + 150000 });
  eq((t - T0) / 1000, 120 + 110 + 50, '予想', 0.01);
});

test('着予想：今の区間がいつもより遅れていればその分を足す', () => {
  const pace = buildPace(input());
  // B→Cはいつも100秒。B通過から130秒たっても次に着いていなければ30秒遅れ
  const t = estimateArrival(pace, { lastPassage: { stationId: 'B', passT: T0 + 120000 }, now: T0 + 250000 });
  eq((t - T0) / 1000, 120 + 110 + 30 + 50, '予想', 0.01);
});

test('着予想：過去の運転がなければダイヤから', () => {
  const dia = { entries: { A: 0, B: 90, C: 200 } };
  const t = estimateArrival(null, { lastPassage: { stationId: 'B', passT: T0 }, now: T0, dia, terminalId: 'C' });
  eq((t - T0) / 1000, 110 + 40, '予想', 0.01);
});

test('模擬走行の記録は使わない', () => {
  const x = input();
  x.runs = x.runs.map((r) => ({ ...r, sim: true }));
  eq(buildPace(x).runCount, 0, '本数');
});

const ok = results.filter((r) => r[0]).length;
document.getElementById('out').innerHTML =
  `<h2 id="summary">${ok} / ${results.length} 成功</h2>` +
  results.map(([pass, name, msg]) => `<div class="${pass ? 'ok' : 'ng'}">${pass ? '○' : '×'} ${name}${msg ? `<br><small>${msg}</small>` : ''}</div>`).join('');
