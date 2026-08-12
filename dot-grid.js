/*!
 * dot-grid.js — canvas dotted background with aurora / starry motion
 * Ambee — Design-ambee
 *
 * Usage: add data-dot-grid to any sized element.
 *   data-dot-size, data-dot-gap, data-dot-gap-mobile, data-dot-opacity,
 *   data-dot-shape, data-dot-fade, data-dot-color,
 *   data-dot-aurora (comma-separated hex), data-dot-motion (shimmer|aurora),
 *   data-dot-speed, data-dot-scale, data-dot-vary,
 *   data-dot-hover, data-dot-grow, data-dot-ease,
 *   data-dot-mobile (on|static|off)
 *
 * Re-init after a page transition: DotGrid.init(scope)
 */
/* =========================================================================
   dot-grid.js — canvas dotted background
   ========================================================================= */
(function () {
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FINE = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var MAXDPR = 2;   // iPhones report 3 — the third pixel buys nothing on a dot

  function dprNow() { return Math.min(window.devicePixelRatio || 1, MAXDPR); }
  function isMobile() { return window.matchMedia('(max-width: 767px)').matches; }

  var MASKS = {
    none:   '',
    center: 'radial-gradient(ellipse at center, #000 0%, #000 42%, transparent 78%)',
    edges:  'radial-gradient(ellipse at center, transparent 18%, #000 72%)',
    top:    'linear-gradient(to bottom, #000 0%, transparent 92%)',
    bottom: 'linear-gradient(to top, #000 0%, transparent 92%)'
  };

  function hexToRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* Dots are bucketed into BANDS colour steps so the whole grid draws in
     BANDS fills instead of one fill per dot. 28 is past the point where
     banding is visible on a dot grid. */
  var BANDS = 28;

  /* sine LUT — shimmer evaluates a sine per dot per frame, and at a few
     thousand dots the table is measurably cheaper than Math.sin */
  var SIN = new Float32Array(1024);
  for (var _i = 0; _i < 1024; _i++) SIN[_i] = Math.sin((_i / 1024) * Math.PI * 2);
  function fsin(x) { return SIN[((x * 162.9746617) | 0) & 1023]; }

  function buildRamp(stops, alpha) {
    var ramp = [], n = stops.length - 1;
    for (var k = 0; k < BANDS; k++) {
      var seg = (k / (BANDS - 1)) * n;
      var i = Math.min(n - 1, Math.floor(seg));
      var f = seg - i;
      var a = stops[i], b = stops[i + 1];
      ramp.push('rgba(' +
        Math.round(a[0] + (b[0] - a[0]) * f) + ',' +
        Math.round(a[1] + (b[1] - a[1]) * f) + ',' +
        Math.round(a[2] + (b[2] - a[2]) * f) + ',' + alpha + ')');
    }
    return ramp;
  }

  function DotGrid(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.mouse = { x: -9999, y: -9999, on: 0 };
    this.raf = null;

    var s = this.canvas.style;
    s.position = 'absolute';
    s.inset = '0';
    s.width = '100%';
    s.height = '100%';
    s.display = 'block';
    s.pointerEvents = 'none';

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.insertBefore(this.canvas, host.firstChild);

    this.read();
    this.bind();
    this.resize();
    host.__dotGrid = this;
  }

  DotGrid.prototype.read = function () {
    var d = this.host.dataset;
    this.size    = parseFloat(d.dotSize) || 1.5;
    this.gap     = Math.max(2, parseFloat(isMobile() && d.dotGapMobile ? d.dotGapMobile : d.dotGap) || 22);

    /* data-dot-mobile: on (default) | static (draw once, no loop) | off */
    var mob = d.dotMobile || 'on';
    this.off = isMobile() && mob === 'off';
    this.freeze = isMobile() && mob === 'static';
    this.color   = d.dotColor || '#ffffff';
    this.opacity = d.dotOpacity != null ? parseFloat(d.dotOpacity) : 0.35;
    this.shape   = d.dotShape === 'square' ? 'square' : 'circle';
    this.rgb     = hexToRgb(this.color);

    /* aurora field — comma-separated hex list drives dot colour */
    var list = (d.dotAurora || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    this.aurora = list.length >= 2 ? list.map(hexToRgb) : null;
    this.motion = d.dotMotion === 'shimmer' ? 'shimmer' : 'aurora';
    this.ramp   = this.aurora ? buildRamp(this.aurora, this.opacity) : null;
    this.speed  = (REDUCED || this.freeze) ? 0 : (d.dotSpeed != null ? parseFloat(d.dotSpeed) : 1);
    this.scale  = d.dotScale != null ? parseFloat(d.dotScale) : 1;
    this.vary   = d.dotVary != null ? parseFloat(d.dotVary) : 0;   // 0 = every dot identical
    if (this.time == null) this.time = Math.random() * 40;   // desync instances
    if (this.age == null) this.age = 0;

    /* shimmer: each colour gets a brightness ladder, so dots can twinkle
       in luminance as well as size while still batching into few fills */
    this.palette = null;
    this.starBands = 10;
    if (this.aurora && this.motion === 'shimmer') {
      var AB = this.starBands, op = this.opacity;
      this.palette = this.aurora.map(function (c) {
        var arr = [];
        for (var q = 0; q < AB; q++) {
          arr.push('rgba(' + c.join(',') + ',' +
            (op * (0.14 + 0.86 * (q / (AB - 1)))).toFixed(3) + ')');
        }
        return arr;
      });
    }

    /* hover swell — same model as the aurora grid */
    this.hover = parseFloat(d.dotHover) || 0;              // radius in px, 0 = off
    this.grow  = d.dotGrow != null ? parseFloat(d.dotGrow) : 0.6;   // extra size at centre
    this.ease  = d.dotEase != null ? parseFloat(d.dotEase) : 0.12;  // lerp factor
    if (REDUCED || !FINE) this.hover = 0;

    var mask = MASKS[d.dotFade] || '';
    this.canvas.style.maskImage = mask;
    this.canvas.style.webkitMaskImage = mask;
  };

  DotGrid.prototype.bind = function () {
    var self = this;

    this._queue = function () {
      if (self._pending) return;
      self._pending = requestAnimationFrame(function () {
        self._pending = null;
        self.resize();
      });
    };

    if (window.ResizeObserver) {
      this.ro = new ResizeObserver(this._queue);
      this.ro.observe(this.host);
    }

    this._dpr = dprNow();
    this._mob = isMobile();
    this._onZoom = function () {
      var changed = false;
      var dpr = dprNow();
      if (dpr !== self._dpr) { self._dpr = dpr; changed = true; }
      if (isMobile() !== self._mob) {          // crossed the mobile breakpoint
        self._mob = isMobile();
        self.read();                            // pick up data-dot-gap-mobile
        changed = true;
      }
      if (changed) self._queue();
    };
    window.addEventListener('resize', this._onZoom);

    /* don't burn frames on a section nobody is looking at */
    this.visible = true;
    if (window.IntersectionObserver) {
      this.io = new IntersectionObserver(function (entries) {
          self.visible = entries[0].isIntersecting;
          if (self.visible) { self.lastT = null; self.loop(); }
        }, { rootMargin: '120px' });
      this.io.observe(this.host);
    }

    if (this.hover > 0) {
      /* listen on window, not the host — the canvas is pointer-events:none
         and content layered above the grid would otherwise swallow moves */
      this.p = { x: -9999, y: -9999, tx: -9999, ty: -9999, s: 0, ts: 0 };

      this._onMove = function (e) {
        var r = self.host.getBoundingClientRect();
        var x = e.clientX - r.left;
        var y = e.clientY - r.top;
        var inside = x >= 0 && y >= 0 && x <= r.width && y <= r.height;
        var p = self.p;

        /* with more than one grid on the page, every pointer move would
           otherwise wake all of them for a frame. Skip instances that are
           already settled and not being pointed at. */
        if (!inside && p.s === 0 && p.ts === 0) return;

        p.tx = x; p.ty = y;
        if (p.s === 0 && inside) { p.x = x; p.y = y; }  // enter at the cursor, don't sweep in
        p.ts = inside ? 1 : 0;
        self.loop();
      };
      this._onBlur = function () { self.p.ts = 0; self.loop(); };

      window.addEventListener('pointermove', this._onMove, { passive: true });
      window.addEventListener('blur', this._onBlur);
    }
  };

  DotGrid.prototype.resize = function () {
    /* off on mobile: release the backing store rather than just hiding it,
       so there is no canvas memory held for a grid nobody will see */
    if (this.off) {
      this.canvas.style.display = 'none';
      if (this.canvas.width) { this.canvas.width = 0; this.canvas.height = 0; }
      this.w = 0;
      return;
    }
    this.canvas.style.display = 'block';

    var dpr = dprNow();
    var w = this.host.clientWidth;
    var h = this.host.clientHeight;
    if (!w || !h) return;

    /* A host under 24px in either axis is almost always a layout mistake
       rather than a design choice — usually the attribute landed on an
       unstyled div in normal flow instead of a sized, positioned box. */
    if ((w < 24 || h < 24) && !this._warned) {
      this._warned = true;
      if (window.console && console.warn) {
        console.warn('[dot-grid] host measures ' + w + 'x' + h +
          ' — the canvas will match. Give this element a size (position:absolute; inset:0 ' +
          'on a position:relative parent is typical).', this.host);
      }
    }

    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* cache dot coordinates — the aurora field is evaluated per row and
       per column, not per dot, so these get reused every frame */
    var oldNx = this.cols ? this.cols.length : -1;
    var oldNy = this.rows ? this.rows.length : -1;
    this.cols = [];
    this.rows = [];
    for (var x = this.gap / 2; x < w + this.gap; x += this.gap) this.cols.push(x);
    for (var y = this.gap / 2; y < h + this.gap; y += this.gap) this.rows.push(y);

    this.pattern = (this.hover || this.aurora) ? null : this.buildPattern();

    /* Only reseed when the dot count actually changed. Mobile browsers fire
       resize constantly as the address bar collapses; reseeding there would
       reshuffle every colour and replay the entrance mid-scroll. */
    if (!this.seed || this.cols.length !== oldNx || this.rows.length !== oldNy) {
      this.seedShimmer();
    }

    this.draw();
    if (this.aurora && (this.speed || this.motion === 'shimmer')) this.loop();
  };

  /* Colour, size ceiling and twinkle rates are assigned per dot once, so
     all three colours are interleaved across the whole grid from frame
     one. Two sine rates per dot at unrelated frequencies keep the
     twinkle from looking like it loops. */
  DotGrid.prototype.seedShimmer = function () {
    if (this.motion !== 'shimmer' || !this.palette) { this.seed = null; return; }

    var nx = this.cols.length, ny = this.rows.length, n = nx * ny;
    var pal = new Uint8Array(n), amp = new Float32Array(n);
    var s1 = new Float32Array(n), s2 = new Float32Array(n);
    var p1 = new Float32Array(n), p2 = new Float32Array(n);
    var fade = new Float32Array(n);
    var np = this.palette.length;

    for (var k = 0; k < n; k++) {
      pal[k]  = (Math.random() * np) | 0;      // colour is random, not positional
      amp[k]  = 0.45 + Math.random() * 0.55;
      s1[k]   = 0.10 + Math.random() * 0.30;   // slow base drift
      s2[k]   = 0.31 + Math.random() * 0.47;   // faster overlay
      p1[k]   = Math.random();
      p2[k]   = Math.random();
      fade[k] = Math.random();                 // scattered entry, not radial
    }
    this.seed = { pal: pal, amp: amp, s1: s1, s2: s2, p1: p1, p2: p2, fade: fade };
  };

  /* one tile, repeated — the whole grid is a single fill */
  DotGrid.prototype.buildPattern = function () {
    var dpr = this.dpr;
    var tile = Math.max(1, Math.round(this.gap * dpr));
    var t = document.createElement('canvas');
    t.width = tile; t.height = tile;
    var tx = t.getContext('2d');

    tx.fillStyle = 'rgba(' + this.rgb.join(',') + ',' + this.opacity + ')';
    var r = (this.size * dpr) / 2;
    var c = tile / 2;

    if (this.shape === 'square') {
      tx.fillRect(c - r, c - r, r * 2, r * 2);
    } else {
      tx.beginPath();
      tx.arc(c, c, r, 0, Math.PI * 2);
      tx.fill();
    }

    var p = this.ctx.createPattern(t, 'repeat');
    if (p.setTransform && window.DOMMatrix) p.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
    return p;
  };

  DotGrid.prototype.draw = function () {
    var ctx = this.ctx;
    if (!this.w) return;
    ctx.clearRect(0, 0, this.w, this.h);

    /* static grid: one repeating fill, no per-dot cost */
    if (!this.hover && !this.aurora) {
      if (this.pattern) {
        ctx.fillStyle = this.pattern;
        ctx.fillRect(0, 0, this.w, this.h);
      }
      return;
    }

    var cols = this.cols, rows = this.rows;
    var nx = cols.length, ny = rows.length;
    var r = this.size / 2, grow = this.grow, R = this.hover;
    var square = this.shape === 'square';
    var p = this.p, s = p ? p.s : 0;
    var px = p ? p.x : -9999, py = p ? p.y : -9999;
    var live = R && s > 0.002;
    var i, j, k;

    /* ---- shimmer: random colour per dot, twinkling in place ---- */
    if (this.motion === 'shimmer' && this.seed) {
      var sd = this.seed, np = this.palette.length, AB = this.starBands;
      var paths = new Array(np * AB);
      for (i = 0; i < np * AB; i++) paths[i] = new Path2D();
      var tt = this.time, age = this.age, vary = this.vary;

      for (j = 0, k = 0; j < ny; j++) {
        var yy = rows[j];
        for (i = 0; i < nx; i++, k++) {
          /* scattered fade-in — every colour lands together, no rings */
          var inn = age * 1.6 - sd.fade[k] * 0.8;
          if (inn <= 0) continue;
          if (inn > 1) inn = 1;

          /* two unrelated rates summed, then smoothstepped so dots
             linger dim and swell to bright rather than pulsing evenly */
          var b = 0.62 * (0.5 + 0.5 * fsin(tt * sd.s1[k] + sd.p1[k])) +
                  0.38 * (0.5 + 0.5 * fsin(tt * sd.s2[k] + sd.p2[k]));
          b = b * b * (3 - 2 * b);

          /* radius is constant unless data-dot-vary is raised — the
             twinkle lives in brightness, and the fade-in fades rather
             than scales, so nothing changes size on load */
          var rad2 = vary
            ? r * (1 - vary + vary * sd.amp[k] * (0.5 + 0.5 * b))
            : r;

          if (live) {
            var hx = cols[i] - px, hy = yy - py;
            var hd2 = hx * hx + hy * hy;
            if (hd2 < R * R) {
              var hf = 1 - Math.sqrt(hd2) / R;
              hf = hf * hf * (3 - 2 * hf);
              rad2 *= 1 + grow * hf * s;
            }
          }
          if (rad2 < 0.04) continue;

          var bi = (b * (AB - 1) * inn + 0.5) | 0;
          var pt = paths[sd.pal[k] * AB + bi];
          if (square) {
            pt.rect(cols[i] - rad2, yy - rad2, rad2 * 2, rad2 * 2);
          } else {
            pt.moveTo(cols[i] + rad2, yy);
            pt.arc(cols[i], yy, rad2, 0, Math.PI * 2);
          }
        }
      }
      for (i = 0; i < np; i++) {
        for (j = 0; j < AB; j++) {
          ctx.fillStyle = this.palette[i][j];
          ctx.fill(paths[i * AB + j]);
        }
      }
      return;
    }

    /* ---- aurora field ----------------------------------------------
       Three drifting sine layers. The diagonal layer is expanded with
       sin(a+b) = sin a·cos b + cos a·sin b so every trig call happens
       once per row or column, never per dot. */
    var AX, AY, DXs, DXc, DYs, DYc;
    if (this.aurora) {
      var t = this.time, sc = 0.001 * this.scale;
      var k1 = 4.2 * sc, k2 = 6.1 * sc, k3 = 3.3 * sc;
      AX = new Float32Array(nx); DXs = new Float32Array(nx); DXc = new Float32Array(nx);
      AY = new Float32Array(ny); DYs = new Float32Array(ny); DYc = new Float32Array(ny);
      for (i = 0; i < nx; i++) {
        AX[i] = Math.sin(cols[i] * k1 + t * 0.42);
        var a = cols[i] * k3 + t * 0.55;
        DXs[i] = Math.sin(a); DXc[i] = Math.cos(a);
      }
      for (j = 0; j < ny; j++) {
        AY[j] = Math.sin(rows[j] * k2 - t * 0.31);
        var b = rows[j] * k3;
        DYs[j] = Math.sin(b); DYc[j] = Math.cos(b);
      }
    }

    /* ---- build one path per colour band ---- */
    var bands = null, flat = null;
    if (this.aurora) {
      bands = new Array(BANDS);
      for (i = 0; i < BANDS; i++) bands[i] = new Path2D();
    } else {
      flat = new Path2D();
    }

    for (j = 0; j < ny; j++) {
      var y = rows[j];
      for (i = 0; i < nx; i++) {
        var x = cols[i];

        var rad = r;
        if (live) {
          var dx = x - px, dy = y - py;
          var d2 = dx * dx + dy * dy;
          if (d2 < R * R) {
            var f = 1 - Math.sqrt(d2) / R;
            f = f * f * (3 - 2 * f);          // smoothstep falloff
            rad = r * (1 + grow * f * s);     // size only — colour untouched
          }
        }

        var path;
        if (bands) {
          var v = AX[i] + AY[j] + (DXs[i] * DYc[j] + DXc[i] * DYs[j]);
          var u = v * 0.1667 + 0.5;           // [-3,3] → [0,1]
          var k = (u * (BANDS - 1) + 0.5) | 0;
          path = bands[k < 0 ? 0 : (k >= BANDS ? BANDS - 1 : k)];
        } else {
          path = flat;
        }

        if (square) {
          path.rect(x - rad, y - rad, rad * 2, rad * 2);
        } else {
          path.moveTo(x + rad, y);
          path.arc(x, y, rad, 0, Math.PI * 2);
        }
      }
    }

    if (bands) {
      for (i = 0; i < BANDS; i++) {
        ctx.fillStyle = this.ramp[i];
        ctx.fill(bands[i]);
      }
    } else {
      ctx.fillStyle = 'rgba(' + this.rgb.join(',') + ',' + this.opacity + ')';
      ctx.fill(flat);
    }
  };

  DotGrid.prototype.tick = function (now) {
    this.raf = null;

    if (this.lastT == null) this.lastT = now;
    var dt = Math.min(0.05, (now - this.lastT) / 1000);   // clamp tab-switch jumps
    this.lastT = now;
    if (this.aurora && this.speed) this.time += dt * this.speed;
    this.age += dt;

    var revealing = this.motion === 'shimmer' && this.age < 2.2;

    var moving = false;
    var p = this.p;
    if (p) {
      var e = this.ease;
      p.x += (p.tx - p.x) * e;
      p.y += (p.ty - p.y) * e;
      p.s += (p.ts - p.s) * e;
      moving = Math.abs(p.tx - p.x) > 0.3 ||
               Math.abs(p.ty - p.y) > 0.3 ||
               Math.abs(p.ts - p.s) > 0.003;
      if (!moving && p.ts === 0) p.s = 0;
    }

    this.draw();

    if ((this.aurora && this.speed && this.visible) || moving || (revealing && this.visible)) {
      this.loop();
    } else {
      this.lastT = null;   // next start resumes cleanly
    }
  };

  DotGrid.prototype.loop = function () {
    if (this.raf || this.off) return;
    var self = this;
    this.raf = requestAnimationFrame(function (now) { self.tick(now); });
  };

  DotGrid.prototype.refresh = function () {
    this.read();
    this.resize();
  };

  DotGrid.prototype.destroy = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this._pending) cancelAnimationFrame(this._pending);
    if (this.ro) this.ro.disconnect();
    if (this.io) this.io.disconnect();
    window.removeEventListener('resize', this._onZoom);
    if (this._onMove) {
      window.removeEventListener('pointermove', this._onMove);
      window.removeEventListener('blur', this._onBlur);
    }
    this.canvas.remove();
    delete this.host.__dotGrid;
  };

  function initAll(scope) {
    (scope || document).querySelectorAll('[data-dot-grid]').forEach(function (el) {
      if (!el.__dotGrid) new DotGrid(el);
    });
  }

  window.DotGrid = { init: initAll, Class: DotGrid };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initAll(); });
  } else {
    initAll();
  }
})();
