// 運転台の時速計（アナログ指針＋数字）。数字は瞬時に切り替え、指針は滑らかに動かす。

const MAX = 50; // 目盛りの最大 km/h
const A0 = 135; // 0 km/h の角度（度、右が0で時計回り）
const SWEEP = 270;
const C = 100;

const ang = (v) => A0 + (SWEEP * Math.max(0, Math.min(MAX, v))) / MAX;
const pt = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
};
function arc(v0, v1, r) {
  const [x0, y0] = pt(ang(v0), r);
  const [x1, y1] = pt(ang(v1), r);
  const large = ang(v1) - ang(v0) > 180 ? 1 : 0;
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

/** capKmh 以上を赤帯で示した時速計の SVG */
export function gaugeSvg(capKmh) {
  let ticks = '';
  for (let v = 0; v <= MAX; v += 5) {
    const major = v % 10 === 0;
    const [x0, y0] = pt(ang(v), major ? 74 : 80);
    const [x1, y1] = pt(ang(v), 88);
    ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="${major ? 'tk-major' : 'tk'}"/>`;
    if (major) {
      const [tx, ty] = pt(ang(v), 60);
      ticks += `<text x="${tx.toFixed(1)}" y="${(ty + 5).toFixed(1)}" class="tk-num">${v}</text>`;
    }
  }
  const cap = Math.min(MAX, capKmh);
  return `<svg viewBox="-6 -6 212 192" class="gauge" role="img" aria-label="時速計">
    <path d="${arc(0, MAX, 92)}" class="g-rim"/>
    ${cap < MAX ? `<path d="${arc(cap, MAX, 92)}" class="g-red"/>` : ''}
    ${ticks}
    <polygon id="gReq" points="0,0" class="g-req"/>
    <line id="gNeedle" x1="${C}" y1="${C}" x2="${C}" y2="${C}" class="g-needle"/>
    <circle cx="${C}" cy="${C}" r="6" class="g-hub"/>
    <text id="gNum" x="${C}" y="152" class="g-num">--</text>
    <text x="${C}" y="172" class="g-unit">km/h</text>
  </svg>`;
}

// 指針はGPSの更新（約1秒ごと）で跳ばないよう、目標値へ指数的に近づけて動かす。数字は即時に切り替える。
const TAU = 0.5; // 指針が新しい値の約63%まで動く秒数
const anim = new WeakMap(); // root -> { cur, target, raf, last }

function drawNeedle(needle, v) {
  const [x, y] = pt(ang(v), 78);
  needle.setAttribute('x2', x.toFixed(1));
  needle.setAttribute('y2', y.toFixed(1));
}

/** 指針・数字・必要時速の目印を更新する（kmh / req が null なら非表示） */
export function setGauge(root, kmh, req) {
  const needle = root.querySelector('#gNeedle');
  const num = root.querySelector('#gNum');
  const mark = root.querySelector('#gReq');
  if (!needle) return;
  let a = anim.get(root);
  if (!a) {
    a = { cur: kmh ?? 0, target: kmh ?? 0, raf: 0, last: 0 };
    anim.set(root, a);
    drawNeedle(needle, a.cur);
  }
  if (kmh == null) {
    cancelAnimationFrame(a.raf);
    a.raf = 0;
    a.cur = a.target = 0;
    needle.style.visibility = 'hidden';
  } else {
    needle.style.visibility = 'visible';
    a.target = Math.max(0, Math.min(MAX, kmh));
    // 画面が裏に回っていたあいだの描画予約が残っていたら取り直す
    if (a.raf && performance.now() - a.last > 300) {
      cancelAnimationFrame(a.raf);
      a.raf = 0;
    }
    if (!a.raf && a.cur !== a.target) {
      a.last = performance.now();
      const step = (now) => {
        const dt = Math.min(0.2, (now - a.last) / 1000);
        a.last = now;
        a.cur += (a.target - a.cur) * (1 - Math.exp(-dt / TAU));
        if (Math.abs(a.target - a.cur) < 0.05) a.cur = a.target;
        drawNeedle(needle, a.cur);
        a.raf = a.cur !== a.target && needle.isConnected ? requestAnimationFrame(step) : 0;
      };
      a.raf = requestAnimationFrame(step);
    }
  }
  const s = kmh == null ? '--' : String(Math.round(kmh));
  if (num.textContent !== s) num.textContent = s;
  if (req == null) {
    mark.style.visibility = 'hidden';
  } else {
    const ra = ang(req);
    const tip = pt(ra, 94);
    const l = pt(ra - 4, 104);
    const r = pt(ra + 4, 104);
    mark.setAttribute('points', [tip, l, r].map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '));
    mark.style.visibility = 'visible';
  }
}
