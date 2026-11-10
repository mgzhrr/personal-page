/* Personal site behaviour: ASCII ripple background, nav, fades, footer year. No dependencies. */

/* ==========================================================================
   ASCII ripple tuning. Change these to taste.
   ========================================================================== */
const RIPPLE = {
  speed: 0.55,          // how hard a cell is pulled toward its neighbours' average (wave speed)
  damping: 0.045,       // velocity lost per simulation step
  viscosity: 0.4,       // softens sharp wavelets (blends height toward the neighbour average)
  sensitivity: 2.2,     // how strongly height maps to brightness
  slopeGain: 1.0,       // how strongly slope adds brightness
  refraction: 4,        // how far letters shift with slope, in text cells per unit slope
  scramble: 1.0,        // how readily disturbed cells swap to ramp glyphs
  scrambleSpeed: 90,    // ms between glyph reshuffles inside a ripple
  dither: 0.5,          // 0 = hard edge on the disturbed area, 1 = very grainy edge

  stepMs: 1000 / 30,    // fixed simulation step (30 steps per second, independent of frame rate)
  simPerRow: 3,         // simulation cells per text row (2 on devices with < 4 cores)
  trailRadius: 16, trailStrength: 0.3,   // pointer trail, px and height units
  clickRadius: 26, clickStrength: 1.2,   // click / tap drop
  idleMinMs: 3500, idleMaxMs: 9000,      // gap between faint random drops when idle
  idleRadius: 12, idleStrength: 0.12,
  edgeMode: "absorb",   // "absorb" = sponge layer soaks up waves at the viewport edge; "reflect" = bounce
  edgeCells: 10,        // sponge width in simulation cells

  bg: "#2b2b2b",          // dark gray ground (keep in sync with .ripple-vignette in styles.css)
  ramp: " ·.,:;-~=+*%#@",
  font: 'ui-monospace, "JetBrains Mono", "Courier New", monospace',
  // The passage tiled across the background
  passage: "hey, i'm max. student, dev, larper. i build roblox games: graffiti dash, sell internet, merge a tree. " +
           "built and sold my first web page in 2025. next up: ai and data science. ",
};

(function () {
  "use strict";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ==========================================================================
     ASCII ripple background
     A height-field wave simulation on a grid finer than the text; each text
     cell samples it to bend, tint and scramble its letter.
     ========================================================================== */
  function startRipple() {
    const canvas = document.getElementById("ripple");
    const ctx = canvas && canvas.getContext("2d");
    if (!ctx) return; // no canvas support: bands stay plain dark
    document.documentElement.classList.add("has-ripple");

    const R = RIPPLE;
    const simPerRow = (navigator.hardwareConcurrency || 4) < 4 ? 2 : R.simPerRow;
    const rampLast = R.ramp.length - 1;

    // Colour lookup: index 0..2*TONES, TONES = resting. Below = trough, above = crest. Grayscale only.
    const TONES = 12;
    const tone = [];
    for (let k = -TONES; k <= TONES; k++) {
      const t = Math.abs(k) / TONES;
      const to = k > 0 ? [255, 255, 255, 1] : [220, 220, 220, 0.95]; // crest #ffffff, trough near-white #dcdcdc
      const c = (i) => Math.round(10 + (to[i] - 10) * t);              // resting #0a0a0a
      tone.push(`rgba(${c(0)},${c(1)},${c(2)},${(0.6 + (to[3] - 0.6) * t).toFixed(3)})`);
    }

    // Grid state, rebuilt on resize
    let W, H, dpr, fontPx, cellW, rowH, cols, rows, sim, sw, sh;
    let h, hPrev, v, sponge, simRowMax, glyphs, rowWasActive;

    function build() {
      dpr = Math.min(window.devicePixelRatio || 1, 2); // shortcut: DPR capped at 2 for fill cost; raise for 3x phones if text looks soft
      W = window.innerWidth; H = window.innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      fontPx = W < 640 ? 11 : 14;
      ctx.font = `${fontPx}px ${R.font}`;
      ctx.textBaseline = "top";
      cellW = ctx.measureText("M").width;
      rowH = Math.round(fontPx * 1.25);
      cols = Math.ceil(W / cellW) + 1;
      rows = Math.ceil(H / rowH) + 1;

      sim = rowH / simPerRow;
      sw = Math.ceil(W / sim) + 2; sh = Math.ceil(H / sim) + 2;
      h = new Float32Array(sw * sh); hPrev = new Float32Array(sw * sh); v = new Float32Array(sw * sh);
      simRowMax = new Float32Array(sh);
      rowWasActive = new Uint8Array(rows);

      // Sponge: 1 in the interior, ramps down toward the edges so waves die there instead of bouncing
      sponge = new Float32Array(sw * sh).fill(1);
      if (R.edgeMode === "absorb") {
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          const d = Math.min(x, y, sw - 1 - x, sh - 1 - y);
          if (d < R.edgeCells) { const e = 1 - d / R.edgeCells; sponge[y * sw + x] = 1 - 0.18 * e * e; }
        }
      }

      // Resting text: the passage repeated and wrapped row by row
      glyphs = [];
      let p = 0;
      for (let r = 0; r < rows; r++) {
        let line = "";
        for (let c = 0; c < cols; c++) { line += R.passage[p % R.passage.length]; p++; }
        glyphs.push(line);
      }

      ctx.fillStyle = R.bg;
      ctx.fillRect(0, 0, W, H);
      for (let r = 0; r < rows; r++) drawRow(r, 1, 0, true);
    }

    // Stable per-cell noise (no per-frame randomness, so glyphs never flicker)
    function hash(a, b) {
      let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
      x = Math.imul(x ^ (x >>> 13), 1274126177);
      return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
    }

    /* ---------- Simulation: one fixed step ---------- */
    function step() {
      const k = R.speed, keep = 1 - R.damping, visc = R.viscosity * 0.1;
      simRowMax.fill(0);
      for (let y = 0; y < sh; y++) {
        const up = (y > 0 ? y - 1 : y) * sw, dn = (y < sh - 1 ? y + 1 : y) * sw, row = y * sw;
        let m = 0;
        for (let x = 0; x < sw; x++) {
          const i = row + x;
          const c = h[i];
          const avg = (h[row + (x > 0 ? x - 1 : x)] + h[row + (x < sw - 1 ? x + 1 : x)] + h[up + x] + h[dn + x]) * 0.25;
          let vel = (v[i] + (avg - c) * k) * keep;   // pull toward neighbours, then damp
          let nh = c + vel + (avg - c) * visc;       // integrate, with viscosity smoothing
          const s = sponge[i]; vel *= s; nh *= s;    // edge absorption
          v[i] = vel; hPrev[i] = nh;                 // hPrev is the write buffer, swapped below
          const a = Math.abs(nh) + Math.abs(vel); if (a > m) m = a;
        }
        simRowMax[y] = m;
      }
      const t = h; h = hPrev; hPrev = t; // h = new heights, hPrev = previous step (for interpolation)
    }

    /* ---------- Input: push the surface down in a soft disc ---------- */
    function inject(px, py, radius, strength) {
      const r = radius / sim, cx = px / sim + 1, cy = py / sim + 1;
      const x0 = Math.max(1, Math.floor(cx - r)), x1 = Math.min(sw - 2, Math.ceil(cx + r));
      const y0 = Math.max(1, Math.floor(cy - r)), y1 = Math.min(sh - 2, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d < 1) { const f = Math.cos(d * Math.PI / 2); h[y * sw + x] -= strength * f * f; }
      }
    }

    /* ---------- Rendering ---------- */
    // Interpolated height at a simulation cell, between the last two steps
    let alpha = 1;
    function hAt(x, y) {
      x = x < 0 ? 0 : x >= sw ? sw - 1 : x; y = y < 0 ? 0 : y >= sh ? sh - 1 : y;
      const i = y * sw + x;
      return hPrev[i] + (h[i] - hPrev[i]) * alpha;
    }

    function drawRow(r, a, tick, calm) {
      alpha = a;
      const y = r * rowH;
      ctx.fillStyle = R.bg;
      ctx.fillRect(0, y, W, rowH);
      const line = glyphs[r];
      const sy = Math.floor((y + rowH / 2) / sim) + 1;
      let lastStyle = -1;
      for (let c = 0; c < cols; c++) {
        const x = c * cellW;
        let ch = line[c], ti = TONES, dx = 0, dy = 0;
        if (!calm) {
          const sx = Math.floor((x + cellW / 2) / sim) + 1;
          const hh = hAt(sx, sy);
          // slope over ~one text row, so it is comparable to height
          const gx = (hAt(sx + 1, sy) - hAt(sx - 1, sy)) * simPerRow * 0.5;
          const gy = (hAt(sx, sy + 1) - hAt(sx, sy - 1)) * simPerRow * 0.5;
          const slope = Math.abs(gx) + Math.abs(gy);
          // Light from the top left: slopes facing it brighten, the others darken
          const b = hh * R.sensitivity - (gx + gy) * R.slopeGain;
          ti = TONES + Math.max(-TONES, Math.min(TONES, Math.round(b * TONES)));
          // Refraction: letters slide along the slope
          dx = Math.max(-0.45, Math.min(0.45, gx * R.refraction)) * cellW;
          dy = Math.max(-0.3, Math.min(0.3, gy * R.refraction)) * rowH;
          // Scramble: past a dithered threshold, show a ramp glyph for the disturbance level
          const act = (Math.abs(hh) * R.sensitivity + slope * R.slopeGain) * R.scramble;
          const thresh = 0.14 * (1 + R.dither * (hash(c, r) - 0.5) * 2);
          if (act > thresh) {
            const lvl = Math.min(1, (act - thresh) / 0.7);
            const n = hash(c * 7 + tick, r * 13 + tick);       // reshuffles only every scrambleSpeed ms
            const jitter = n < 0.2 ? -1 : n > 0.8 ? 1 : 0;
            ch = R.ramp[Math.max(1, Math.min(rampLast, 1 + Math.round(lvl * (rampLast - 1)) + jitter))];
            // Ripple glyphs are always white or near-white: at least 85% of the way to the crest/trough tone
            const mag = Math.max(Math.abs(ti - TONES), Math.round(TONES * (0.85 + 0.15 * lvl)));
            ti = TONES + (b < 0 ? -mag : mag);
          }
        }
        if (ti !== lastStyle) { ctx.fillStyle = tone[ti]; lastStyle = ti; }
        ctx.fillText(ch, x + dx, y + dy);
      }
    }

    function draw(a, now) {
      const tick = Math.floor(now / R.scrambleSpeed);
      const ACTIVE = 0.003;
      for (let r = 0; r < rows; r++) {
        // A text row is live if any simulation row under it (or its neighbours) moves
        const s0 = Math.max(0, Math.floor(((r - 1) * rowH) / sim)), s1 = Math.min(sh - 1, Math.ceil(((r + 2) * rowH) / sim) + 1);
        let live = false;
        for (let s = s0; s <= s1 && !live; s++) if (simRowMax[s] > ACTIVE) live = true;
        if (live) { drawRow(r, a, tick, false); rowWasActive[r] = 1; }
        else if (rowWasActive[r]) { drawRow(r, 1, tick, true); rowWasActive[r] = 0; } // settle back to rest once
        // else: row and its neighbours at rest, nothing to redraw
      }
    }

    build();
    let resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(build, 150);
    });

    // Reduced motion: the static text block only, no water, no loop
    if (reduceMotion) return;

    /* ---------- Pointer: trail on move, stronger drop on press ---------- */
    let lastX = null, lastY = null, lastT = 0;
    window.addEventListener("pointermove", function (e) {
      const x = e.clientX, y = e.clientY, t = e.timeStamp;
      if (lastX !== null && t - lastT < 120) {
        const dist = Math.hypot(x - lastX, y - lastY);
        const speed = dist / Math.max(1, t - lastT);                 // px per ms
        const gain = Math.max(0.35, Math.min(2, 0.35 + speed * 0.6)); // faster = stronger
        const spacing = R.trailRadius * 0.5;
        const n = Math.min(24, Math.ceil(dist / spacing));
        for (let i = 1; i <= n; i++) {
          const f = i / n;
          inject(lastX + (x - lastX) * f, lastY + (y - lastY) * f, R.trailRadius, R.trailStrength * gain * 0.5);
        }
      }
      lastX = x; lastY = y; lastT = t;
    }, { passive: true });
    window.addEventListener("pointerdown", function (e) {
      inject(e.clientX, e.clientY, R.clickRadius, R.clickStrength);
      lastX = e.clientX; lastY = e.clientY; lastT = e.timeStamp;
    }, { passive: true });

    /* ---------- Loop: fixed-step simulation, rAF rendering, paused when hidden ---------- */
    let raf = 0, last = 0, acc = 0;
    let nextIdle = performance.now() + R.idleMinMs;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      acc += Math.min(now - last, 250); // cap catch-up after a stall
      last = now;
      if (now > nextIdle) {             // occasional faint drop so the surface never looks dead
        inject(Math.random() * W, Math.random() * H, R.idleRadius, R.idleStrength);
        nextIdle = now + R.idleMinMs + Math.random() * (R.idleMaxMs - R.idleMinMs);
      }
      while (acc >= R.stepMs) { step(); acc -= R.stepMs; }
      draw(acc / R.stepMs, now);
    }
    // Run only while the tab is visible AND the hero is on screen (the effect lives only behind the hero)
    let heroVisible = true;
    function update() {
      cancelAnimationFrame(raf); raf = 0;
      if (!document.hidden && heroVisible) { last = performance.now(); acc = 0; raf = requestAnimationFrame(frame); }
    }
    document.addEventListener("visibilitychange", update);
    new IntersectionObserver(function (entries) { heroVisible = entries[0].isIntersecting; update(); })
      .observe(document.querySelector(".hero"));
    update();
  }
  startRipple();

  /* ---------- Nav shadow once the page is scrolled ---------- */
  const nav = document.getElementById("nav");
  new IntersectionObserver(function (entries) {
    nav.classList.toggle("is-scrolled", !entries[0].isIntersecting);
  }).observe(document.getElementById("nav-sentinel"));

  /* ---------- Hamburger under 640px ---------- */
  const toggle = document.querySelector(".nav__toggle");
  const links = document.getElementById("nav-links");
  function setMenu(open) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.querySelector(".visually-hidden").textContent = open ? "Close menu" : "Menu";
    links.classList.toggle("is-open", open);
  }
  toggle.addEventListener("click", function () { setMenu(toggle.getAttribute("aria-expanded") !== "true"); });
  links.addEventListener("click", function (e) { if (e.target.closest("a")) setMenu(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && links.classList.contains("is-open")) { setMenu(false); toggle.focus(); }
  });

  /* ---------- Fade-up on scroll (CSS disables it under reduced motion) ---------- */
  const fades = document.querySelectorAll(".fade");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    fades.forEach(function (el) { el.classList.add("is-in"); });
  } else {
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add("is-in"); io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    fades.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Profile photo: show initials if img/profile.webp is missing ---------- */
  const photo = document.querySelector(".hero__photo img");
  function hidePhoto() { photo.style.visibility = "hidden"; }
  if (photo.complete && photo.naturalWidth === 0) hidePhoto();
  else photo.addEventListener("error", hidePhoto);

  /* ---------- Footer year ---------- */
  document.getElementById("year").textContent = new Date().getFullYear();
})();
