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

/**
 * capKmh 以上を赤帯で示した時速計の SVG。
 * 文字盤の面、目盛りの帯、5 km/h ごとの目盛り（10ごとに太く数字付き）、
 * 中央下に速度の数字窓（指針はその下を通る）、目安速度はマゼンタの楔（航空機の計器でいう目標速度の印）で示す。
 */
export function gaugeSvg(capKmh) {
  let ticks = '';
  for (let v = 0; v <= MAX; v += 5) {
    const major = v % 10 === 0;
    const [x0, y0] = pt(ang(v), major ? 70 : 77);
    const [x1, y1] = pt(ang(v), 86);
    ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="${major ? 'tk-major' : 'tk'}"/>`;
    if (major) {
      const [tx, ty] = pt(ang(v), 57);
      ticks += `<text x="${tx.toFixed(1)}" y="${(ty + 5).toFixed(1)}" class="tk-num">${v}</text>`;
    }
  }
  const cap = Math.min(MAX, capKmh);
  return `<svg viewBox="-3 -3 206 206" class="gauge" role="img" aria-label="時速計">
    <circle cx="${C}" cy="${C}" r="99" class="g-face"/>
    <path d="${arc(0, MAX, 90)}" class="g-rim"/>
    ${cap < MAX ? `<path d="${arc(cap, MAX, 90)}" class="g-red"/>` : ''}
    ${ticks}
    <polygon id="gReq" points="0,0" class="g-req"/>
    <line id="gNeedle" x1="${C}" y1="${C}" x2="${C}" y2="${C}" class="g-needle"/>
    <circle cx="${C}" cy="${C}" r="8" class="g-hub"/>
    <circle cx="${C}" cy="${C}" r="3" class="g-hub-in"/>
    <rect x="${C - 24}" y="128" width="48" height="30" rx="5" class="g-box"/>
    <text id="gNum" x="${C}" y="151" class="g-num">--</text>
    <text x="${C}" y="172" class="g-unit">km/h</text>
  </svg>`;
}

// 指針はGPSの更新（約1秒ごと）で跳ばないよう、目標値へ指数的に近づけて動かす。数字は即時に切り替える。
const TAU = 0.5; // 指針が新しい値の約63%まで動く秒数
const anim = new WeakMap(); // root -> { cur, target, raf, last }

function drawNeedle(needle, v) {
  const [x, y] = pt(ang(v), 82);
  const [tx, ty] = pt(ang(v) + 180, 14); // 針の尾
  needle.setAttribute('x1', tx.toFixed(1));
  needle.setAttribute('y1', ty.toFixed(1));
  needle.setAttribute('x2', x.toFixed(1));
  needle.setAttribute('y2', y.toFixed(1));
}

/** 指針・数字・区間の目安速度の印を更新する（kmh / req が null なら非表示） */
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
    // 目盛りの帯にかかる細い楔。先端を帯の内側の縁（指針の先のすぐ外）に合わせ、目盛りは覆わない
    const ra = ang(req);
    const pts = [pt(ra, 84), pt(ra - 4, 101), pt(ra + 4, 101)];
    mark.setAttribute('points', pts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '));
    mark.style.visibility = 'visible';
  }
}
