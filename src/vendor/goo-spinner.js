/*
  <goo-spinner> — a gooey, jelly-physics loading spinner. No dependencies.

  Usage:
    <script src="goo-spinner.js"></script>
    <goo-spinner size="48" color="#5b8def"></goo-spinner>

  Attributes (all optional):
    size    px, the square box size            (default 48)
    color   any CSS color, or "currentColor"   (default #5b8def)
    count   number of satellites               (default 5)
    speed   animation rate multiplier          (default 1)
    jiggle  0..1 softness / wobble of the gel   (default 0.5)
    core    px, center blob diameter           (default size*0.2)
    blob    px, satellite diameter             (default size*0.15)
    motion  auto | reduced | full              (default auto)

  motion="auto" follows the OS prefers-reduced-motion setting (live — toggling
  the OS preference updates running instances). "reduced" freezes the gel at a
  static rest pose (no rAF, zero oscillation); "full" always animates.

  The element reflects its live state onto a `data-motion-state` host attribute:
    running — physics loop active (full motion)
    reduced — frozen by prefers-reduced-motion (gel can't carry activity)
    paused  — deliberately parked via speed<=0 (idle, not a reduced-motion freeze)
  Light-DOM CSS keys reduced-motion-safe "still working" cues off this attribute,
  since the spinner's own motion is gone under [data-motion-state="reduced"].

  It inherits text color when you set color="currentColor", respects
  prefers-reduced-motion, and is fully self-contained (shadow DOM + its own
  SVG goo filter, so multiple instances never collide).
*/
(function () {
  if (customElements.get('goo-spinner')) return;

  class GooSpinner extends HTMLElement {
    // `speed` IS observed (unlike the geometry attrs) so a consumer's
    // setAttribute('speed', …) is heard — critical for the drawer dot, which parks
    // via speed<=0 when idle and must WAKE when speed flips back to >0. It's handled
    // specially in attributeChangedCallback (no _build, just re-evaluate park state).
    static get observedAttributes() { return ['size', 'color', 'count', 'core', 'blob', 'motion', 'speed']; }

    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      // Live OS reduced-motion: re-evaluate motion mode when the setting toggles.
      this._mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (this._mq && !this._mqHandler) {
        this._mqHandler = () => this._applyMotion();
        if (this._mq.addEventListener) this._mq.addEventListener('change', this._mqHandler);
        else if (this._mq.addListener) this._mq.addListener(this._mqHandler);
      }
      this._build();
      this._applyMotion();
    }
    disconnectedCallback() {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this._mq && this._mqHandler) {
        if (this._mq.removeEventListener) this._mq.removeEventListener('change', this._mqHandler);
        else if (this._mq.removeListener) this._mq.removeListener(this._mqHandler);
      }
      this._mqHandler = null;
      this._mq = null;
    }
    attributeChangedCallback(name) {
      if (!this.shadowRoot || !this.isConnected) return;
      // `speed` is a live physics knob, not geometry — NEVER _build() for it (that
      // rebuilds the shadow DOM and restarts the spin animation, breaking the
      // "physics never restart across phase swaps" invariant). Just re-evaluate the
      // park/unpark state so speed>0 wakes a gel that a prior speed<=0 parked (the
      // park itself happens in _tick; the unpark needs this observer to fire).
      if (name === 'speed') { this._applyMotion(); return; }
      this._build();
      this._applyMotion();
    }

    _num(a, d) { const v = parseFloat(this.getAttribute(a)); return isFinite(v) ? v : d; }

    // Resolve whether physics should run. `motion` attribute forces a mode:
    //   full   — always animate
    //   reduced — never animate (static settled gel)
    //   auto (default) — follow the OS prefers-reduced-motion setting
    _wantsReducedMotion() {
      const mode = (this.getAttribute('motion') || 'auto').toLowerCase();
      if (mode === 'full') return false;
      if (mode === 'reduced') return true;
      return !!(this._mq && this._mq.matches);
    }

    // Start or stop the rAF loop to match the current motion preference. Idempotent.
    _applyMotion() {
      if (!this.isConnected) return;
      if (this._wantsReducedMotion()) {
        // Stop any running loop and freeze the gel at its rest pose.
        this._running = false;
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
        this._renderRest();
        // Reflect the resolved state onto the host so light-DOM CSS can supply a
        // reduced-motion-safe "still working" cue (a slow stepped pulse) when the
        // jelly physics are frozen — the gel can't carry activity here. The drawer
        // dot keys its stepped-pulse rule off [data-motion-state="reduced"]. This is
        // a NON-observed attribute, so writing it never re-fires attributeChangedCallback.
        this._setMotionState('reduced');
      } else if (!this._running) {
        this._running = true;
        this._setMotionState('running');
        this._raf = requestAnimationFrame(this._tick);
      }
    }

    // Reflect the live motion resolution onto the host element (idempotent — only
    // touches the DOM when the value actually changes). `data-motion-state` is the
    // single coordination hook between the JS physics gate and light-DOM CSS.
    _setMotionState(s) {
      if (this._motionState === s) return;
      this._motionState = s;
      this.setAttribute('data-motion-state', s);
    }

    // Paint the blobs once at the settled rest state (x = mid, no squash) — a calm,
    // perfectly still ring of gel that still reads as a spinner without any oscillation.
    _renderRest() {
      const size = this._size, n = this._n;
      if (!size || !this._blobs) return;
      const mid = (0.12 + 0.27) / 2;
      for (let i = 0; i < n; i++) {
        const el = this._blobs[i];
        if (!el) continue;
        const rN = mid * size;
        el.style.transform = 'translate(-50%,-50%) rotate(' + el._rot + 'deg) translateY(' + (-rN).toFixed(2) + 'px) scale(1,1)';
      }
    }

    _build() {
      const size = this._num('size', 48);
      const n = Math.max(2, Math.round(this._num('count', 5)));
      const core = this._num('core', size * 0.2);
      const blob = this._num('blob', size * 0.15);
      const colAttr = this.getAttribute('color');
      const fill = !colAttr ? '#5b8def' : colAttr;
      const fid = 'gs' + (this._id || (this._id = Math.random().toString(36).slice(2, 8)));
      const std = (size * 0.045).toFixed(2);

      this._size = size; this._n = n;

      let sats = '';
      for (let i = 0; i < n; i++) sats += '<span class="s" style="width:' + blob + 'px;height:' + blob + 'px"></span>';

      this.shadowRoot.innerHTML =
        '<style>' +
        ':host{display:inline-block;width:' + size + 'px;height:' + size + 'px;line-height:0}' +
        '.wrap{position:relative;width:100%;height:100%;filter:url(#' + fid + ')}' +
        '.ring{position:absolute;inset:0;animation:gs-rot calc(3.4s / var(--gs-spd,1)) linear infinite}' +
        '.core,.s{position:absolute;top:50%;left:50%;border-radius:50%;background:' + fill + '}' +
        '.core{width:' + core + 'px;height:' + core + 'px;transform:translate(-50%,-50%)}' +
        '@keyframes gs-rot{to{transform:rotate(360deg)}}' +
        '@media (prefers-reduced-motion: reduce){.ring{animation:none}}' +
        '</style>' +
        '<svg width="0" height="0" style="position:absolute"><defs>' +
        '<filter id="' + fid + '"><feGaussianBlur in="SourceGraphic" stdDeviation="' + std + '" result="b"/>' +
        '<feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -13"/></filter>' +
        '</defs></svg>' +
        '<div class="wrap"><span class="core"></span><div class="ring">' + sats + '</div></div>';

      this._ring = this.shadowRoot.querySelector('.ring');
      this._blobs = Array.prototype.slice.call(this.shadowRoot.querySelectorAll('.s'));
      this._blobs.forEach(function (el, i) { el._rot = 360 / n * i; });
      this._x = null; this._v = 0;
    }

    _tick = () => {
      if (!this._running) return;
      const t = performance.now();
      const size = this._size, n = this._n;
      const jiggle = Math.max(0, Math.min(1, this._num('jiggle', 0.5)));
      const speed = this._num('speed', 1);

      // speed<=0 parks the gel: stop the rAF loop and paint one settled rest frame.
      // `speed` is not observed, so a consumer's setAttribute('speed','0') lands here.
      // This is a deliberate IDLE park (e.g. the drawer dot at rest), distinct from a
      // reduced-motion freeze — mark it 'paused' so CSS doesn't mistake it for the
      // reduced-motion "still working" case and apply the stepped pulse.
      if (speed <= 0) {
        this._running = false;
        if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
        this._setMotionState('paused');
        this._renderRest();
        return;
      }

      // Floor the ring-rotation rate so calc(3.4s / var(--gs-spd)) never divides by zero.
      if (this._ring) this._ring.style.setProperty('--gs-spd', Math.max(speed, 0.001));

      // physics in fractions of `size`, then scaled — so motion is size-independent
      const lo = 0.12, hi = 0.27, mid = (lo + hi) / 2, amp = (hi - lo) / 2;
      const K = 0.16, C = 0.40 - jiggle * 0.33;                 // lower damping = more jelly
      const tgt = mid + amp * Math.sin(t * (2 * Math.PI / 2400) * speed); // air-pressure pulse
      if (this._x == null) { this._x = tgt; this._v = 0; }
      this._v += (tgt - this._x) * K - this._v * C;
      this._x += this._v;
      const x = this._x, v = this._v;
      const baseSy = 1 + Math.max(-0.42, Math.min(0.42, v * 22));    // velocity squash
      const wob = amp * 0.6 * jiggle;

      for (let i = 0; i < n; i++) {
        const el = this._blobs[i];
        if (!el) continue;
        const rN = (x + wob * Math.sin(t * 0.009 + i * 1.35)) * size;
        const syN = baseSy + 0.09 * Math.sin(t * 0.012 + i * 2.1) * jiggle;
        const sxN = 1 - (syN - 1) * 0.65;
        el.style.transform = 'translate(-50%,-50%) rotate(' + el._rot + 'deg) translateY(' + (-rN).toFixed(2) + 'px) scale(' + sxN.toFixed(3) + ',' + syN.toFixed(3) + ')';
      }
      this._raf = requestAnimationFrame(this._tick);
    };
  }

  customElements.define('goo-spinner', GooSpinner);
})();
