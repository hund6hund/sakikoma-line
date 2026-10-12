// 通過・到着の鈴の音。ATC の現示変化ベルを手本に、音声ファイルを使わず Web Audio で合成する。
// 手本の録音（約1秒）を解析した倍音と減衰をもとにしている：
//   6908 Hz  打った瞬間に最も強く、0.2秒ほどで消える金属的な成分
//   4990 Hz  中くらいの速さで減衰
//   3318 Hz  響きの本体。わずかに異なる2つの周波数で約3 Hzのうなりを出す
//   1908 Hz  弱い低い成分（同じくうなりあり）
// 余韻は手本（約1秒）より短く、0.5秒ほどで消えるようにしてある。
// ブラウザは操作なしに音を出せないので、運転開始のボタン操作で unlock() する。

let ctx = null;

export function unlock() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

// [周波数 Hz, 振幅, 減衰の時定数 秒]
const PARTIALS = [
  [6908, 0.9, 0.035],
  [6908, 0.2, 0.13],
  [4990, 0.22, 0.12],
  [3318, 0.55, 0.04],
  [3318, 0.12, 0.15],
  [3317.5, 0.024, 0.3],
  [3320.5, 0.024, 0.3],
  [1908.5, 0.012, 0.25],
  [1912.2, 0.012, 0.25],
];

/** 鈴を1回打つ。out は出力先のノード（試験では OfflineAudioContext を渡す） */
export function strike(ac, out, t0, vol) {
  for (const [f, a, tau] of PARTIALS) {
    const osc = ac.createOscillator();
    const amp = ac.createGain();
    osc.frequency.value = f;
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(a * vol, t0 + 0.002);
    amp.gain.setTargetAtTime(0, t0 + 0.002, tau);
    osc.connect(amp).connect(out);
    osc.start(t0);
    osc.stop(t0 + 0.002 + tau * 6);
  }
  // 打撃のごく短い雑音
  const n = Math.round(ac.sampleRate * 0.02);
  const buf = ac.createBuffer(1, n, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (n / 4));
  const src = ac.createBufferSource();
  const hp = ac.createBiquadFilter();
  const g = ac.createGain();
  src.buffer = buf;
  hp.type = 'highpass';
  hp.frequency.value = 2000;
  g.gain.value = 0.05 * vol;
  src.connect(hp).connect(g).connect(out);
  src.start(t0);
}

/**
 * kind: 'pass'（駅の通過、1回）/ 'arrive'（到着、0.2秒間隔で2回）
 * volume: 0〜100（0 で鳴らさない）
 */
export function chime(kind, volume) {
  if (!ctx || !(volume > 0)) return;
  if (ctx.state === 'suspended') ctx.resume();
  const v = Math.min(1, volume / 100) * 0.48; // 音量100で振幅の山が約0.9（音割れしない）
  const t = ctx.currentTime + 0.02;
  strike(ctx, ctx.destination, t, v);
  if (kind === 'arrive') strike(ctx, ctx.destination, t + 0.2, v);
}
