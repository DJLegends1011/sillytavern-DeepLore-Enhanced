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

  It inherits text color when you set color="currentColor", respects
  prefers-reduced-motion, and is fully self-contained (shadow DOM + its own
  SVG goo filter, so multiple instances never collide).
*/
(function () {
  if (customElements.get('goo-spinner')) return;

  class GooSpinner extends HTMLElement {
    static get observedAttributes() { return ['size', 'color', 'count', 'core', 'blob']; }

    connectedCallback() {
      if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
      this._build();
      this._running = true;
      this._raf = requestAnimationFrame(this._tick);
    }
    disconnectedCallback() {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
    }
    attributeChangedCallback() {
      if (this.shadowRoot && this.isConnected) this._build();
    }

    _num(a, d) { const v = parseFloat(this.getAttribute(a)); return isFinite(v) ? v : d; }

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

      if (this._ring) this._ring.style.setProperty('--gs-spd', speed);

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
