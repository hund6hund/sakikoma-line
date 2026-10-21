// 通過・到着の鈴の音。ATC の現示変化ベルを手本に、音声ファイルを使わず Web Audio で合成する。
// 手本の録音（約1秒）を解析した倍音と減衰をもとにしている：
//   6908 Hz  打った瞬間に最も強く、0.2秒ほどで消える金属的な成分
//   4990 Hz  中くらいの速さで減衰
//   3318 Hz  響きの本体。わずかに異なる2つの周波数で約3 Hzのうなりを出す
//   1908 Hz  弱い低い成分（同じくうなりあり）
// 余韻は手本（約1秒）より短く、0.5秒ほどで消えるようにしてある。
// ブラウザは操作なしに音を出せないので、運転開始のボタン操作で unlock() する。
// 画面の消灯・アプリの切り替え・通話などで音声が止まる（suspended / interrupted）ことがあるので、
// 鳴らす前と、画面に触れたとき・画面が戻ったときに再開を試みる。

let ctx = null;

function wake() {
  if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
}

export function unlock() {
  try {
    if (!ctx || ctx.state === 'closed') ctx = new (window.AudioContext || window.webkitAudioContext)();
    wake();
  } catch {
    ctx = null;
  }
}

/** 音声を作り直す（「データ」タブのリセット）。ボタン操作の中で呼ぶこと */
export function reset() {
  try {
    ctx?.close().catch(() => {});
  } catch { /* 閉じられなくても作り直す */ }
  ctx = null;
  unlock();
}

/** 状態：'running'（鳴らせる）/ 'suspended' / 'interrupted' / 'none'（未準備） */
export function soundState() {
  return ctx ? ctx.state : 'none';
}

/** 画面が戻ったときなど、操作なしで再開を試みる（新しくは作らない） */
export function resume() {
  wake();
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

// ---------------- 音声ファイル方式 ----------------
// 端末によっては Web Audio の出力だけが届かないことがあるので、同じ鈴を
// OfflineAudioContext（スピーカーを使わない描画）で WAV にして <audio> で鳴らす方式も用意する。

function encodeWav(x, sr) {
  const b = new ArrayBuffer(44 + x.length * 2);
  const d = new DataView(b);
  const str = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  d.setUint32(4, 36 + x.length * 2, true);
  str(8, 'WAVEfmt ');
  d.setUint32(16, 16, true);
  d.setUint16(20, 1, true);
  d.setUint16(22, 1, true);
  d.setUint32(24, sr, true);
  d.setUint32(28, sr * 2, true);
  d.setUint16(32, 2, true);
  d.setUint16(34, 16, true);
  str(36, 'data');
  d.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return b;
}

const fileUrl = {};
function renderFile(kind) {
  return (fileUrl[kind] ||= (async () => {
    const sr = 44100;
    const oc = new OfflineAudioContext(1, Math.round(sr * (kind === 'arrive' ? 1.2 : 1.0)), sr);
    strike(oc, oc.destination, 0.01, 0.48);
    if (kind === 'arrive') strike(oc, oc.destination, 0.21, 0.48);
    const buf = await oc.startRendering();
    return URL.createObjectURL(new Blob([encodeWav(buf.getChannelData(0), sr)], { type: 'audio/wav' }));
  })());
}

/** 起動時に呼んで、鳴らすときに待たないようにしておく */
export function prepareFiles() {
  renderFile('pass').catch(() => {});
  renderFile('arrive').catch(() => {});
}

const fileEl = {};
async function playFile(kind, volume) {
  const url = await renderFile(kind);
  const el = (fileEl[kind] ||= new Audio(url));
  el.volume = Math.min(1, volume / 100);
  el.currentTime = 0;
  await el.play();
}

// ---------------- 鳴らす ----------------
let method = 'webaudio'; // 'webaudio' | 'file'
export function setMethod(m) {
  method = m === 'file' ? 'file' : 'webaudio';
}

/**
 * kind: 'pass'（駅の通過、1回）/ 'arrive'（到着、0.2秒間隔で2回）
 * volume: 0〜100（0 で鳴らさない）
 * how: 方式を指定するとき（診断用）。省略すると設定の方式。
 * 戻り値の Promise は、鳴らす処理がどこまで進んだかの説明で解決する（診断の表示用）。
 */
export async function chime(kind, volume, how = method) {
  if (!(volume > 0)) return '音量0のため鳴らしていません';
  if (how === 'file') {
    try {
      await playFile(kind, volume);
      return '音声ファイル方式：再生を開始しました';
    } catch (e) {
      return `音声ファイル方式：再生できませんでした（${e.name}: ${e.message}）`;
    }
  }
  if (!ctx || ctx.state === 'closed') return 'Web Audio：未準備（運転開始かリセットで準備されます）';
  wake();
  const v = Math.min(1, volume / 100) * 0.48; // 音量100で振幅の山が約0.9（音割れしない）
  const t = ctx.currentTime + 0.02;
  strike(ctx, ctx.destination, t, v);
  if (kind === 'arrive') strike(ctx, ctx.destination, t + 0.2, v);
  return `Web Audio：鳴らしました（状態 ${ctx.state}）`;
}

/**
 * 診断：新しい Web Audio で単純な音（880 Hz、0.6秒）を鳴らし、
 * 時計が進んでいるか（＝音が実際に出力へ流れているか）を調べる。ボタン操作の中で呼ぶこと。
 */
export async function beepTest() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return 'この端末では Web Audio が使えません';
  const ac = new AC();
  await ac.resume().catch(() => {});
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.frequency.value = 880;
  g.gain.setValueAtTime(0.3, ac.currentTime);
  g.gain.setTargetAtTime(0, ac.currentTime + 0.5, 0.05);
  osc.connect(g).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + 0.8);
  await new Promise((r) => setTimeout(r, 500));
  const info = [
    `状態 ${ac.state}`,
    `時計の進み ${((ac.currentTime - t0) * 1000).toFixed(0)} ms／0.5秒`,
    `標本化 ${ac.sampleRate} Hz`,
    ac.baseLatency != null ? `遅延 ${(ac.baseLatency * 1000).toFixed(0)}+${((ac.outputLatency || 0) * 1000).toFixed(0)} ms` : '',
  ].filter(Boolean).join('、');
  setTimeout(() => ac.close().catch(() => {}), 1000);
  return `単純な音（Web Audio）：${info}`;
}
