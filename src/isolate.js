'use strict';
// Injected into each live channel's page: finds the main video player, blows it up to fill
// the screen, and hides everything else (chat, menus, banners, cookie popups).

const RTV_ISOLATE = (() => {
  const css = `
    html.rtv-iso, html.rtv-iso body { background: #000 !important; overflow: hidden !important; }
    html.rtv-iso body * { visibility: hidden !important; }
    html.rtv-iso .rtv-target, html.rtv-iso .rtv-target * { visibility: visible !important; }
    html.rtv-iso .rtv-target {
      position: fixed !important; inset: 0 !important;
      width: 100vw !important; height: 100vh !important;
      max-width: none !important; max-height: none !important;
      margin: 0 !important; padding: 0 !important; border: 0 !important;
      z-index: 2147483646 !important; object-fit: contain !important;
      background: #000 !important; transform: none !important;
    }
    html.rtv-iso .rtv-anc {
      transform: none !important; filter: none !important; contain: none !important;
      will-change: auto !important; perspective: none !important;
    }
    html.rtv-iso .rtv-skip, html.rtv-iso .rtv-skip * { visibility: visible !important; }
    html.rtv-iso .rtv-skip {
      position: fixed !important; right: 3vw !important; bottom: 8vh !important; left: auto !important; top: auto !important;
      z-index: 2147483647 !important; transform: none !important;
    }
    html.rtv-iso ::-webkit-scrollbar { display: none !important; }
    * { cursor: none !important; }
  `;

  // startSelector: a site-specific button to press once, e.g. the power button on a TV page.
  function isolate(startSelector) {
    if (window.__rtv) return;
    // frame: the player lives in an iframe (e.g. YouTube), so we can't tell whether it's playing.
    const st = (window.__rtv = { found: false, playing: false, frame: false, volume: 1, muted: false });
    // Buttons that stand between us and the stream (mature-content gates). Play buttons are
    // left to the real click the app sends, since some players ignore scripted ones.
    const GATE = /^(start watching|watch now|tap to unmute|unmute)$/i;
    const t0 = performance.now();
    let target = null;
    let started = !startSelector;

    const area = (el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };
    const isPlaying = (v) => !v.paused && !v.ended && v.readyState > 2;

    function best() {
      const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0 || area(v) > 0);
      if (vids.length) {
        return vids.sort((a, b) => (isPlaying(b) ? 1e9 : 0) + area(b) - ((isPlaying(a) ? 1e9 : 0) + area(a)))[0];
      }
      const frames = [...document.querySelectorAll('iframe')].filter(
        (f) => area(f) > 40000 && /youtube|player|embed|video|twitch/i.test(f.src)
      );
      return frames.sort((a, b) => area(b) - area(a))[0] || null;
    }

    function mark(el) {
      document.querySelectorAll('.rtv-target, .rtv-anc').forEach((n) => n.classList.remove('rtv-target', 'rtv-anc'));
      el.classList.add('rtv-target');
      for (let p = el.parentElement; p; p = p.parentElement) p.classList.add('rtv-anc');
      document.documentElement.classList.add('rtv-iso');
      target = el;
    }

    function tick() {
      // Give the page a few seconds to wire up its buttons before pressing one.
      if (!started && document.readyState === 'complete' && performance.now() - t0 > 4000) {
        const btn = document.querySelector(startSelector);
        if (btn) {
          btn.click();
          started = true;
        }
      }
      const pick = best();
      if (pick && pick !== target) mark(pick);
      // Single-page sites (Pluto TV) re-render and wipe our classes; put them back.
      else if (target && !target.classList.contains('rtv-target')) mark(target);
      else if (target) document.documentElement.classList.add('rtv-iso');
      st.found = !!target && target.isConnected;
      st.frame = st.found && target.tagName === 'IFRAME';

      // YouTube ads (the watch page marks its player "ad-showing"): show the ad's whole frame
      // rather than the show's crop, and bring the Skip button above the picture. st.skip is
      // where it is, for the app to press with a real click once it can be skipped.
      const yt = document.querySelector('#movie_player');
      st.ad = !!(yt && yt.classList.contains('ad-showing'));
      st.skip = null;
      if (st.ad) {
        const btn = [...document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button')].find((b) => b.offsetParent !== null || b.getClientRects().length);
        if (btn) {
          if (!btn.classList.contains('rtv-skip')) {
            btn.classList.add('rtv-skip');
            for (let p = btn.parentElement; p; p = p.parentElement) p.classList.add('rtv-anc');
          }
          const r = btn.getBoundingClientRect();
          if (r.width && r.height) st.skip = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }

      if (target && target.tagName === 'VIDEO') {
        target.muted = st.muted;
        target.volume = st.volume;
        st.playing = isPlaying(target);
        // st.crop = { x, y, w, h } (fractions of a 16:9 frame): size the video so just that box
        // fills the screen, cutting away bars or a background around a shrunken picture.
        const c = st.crop;
        if (c && !st.ad) {
          const cw = innerWidth;
          const ch = innerHeight;
          const aspect = (c.w * 16) / (c.h * 9);
          const dw = aspect > cw / ch ? cw : ch * aspect;
          const dh = dw / aspect;
          const fw = dw / c.w;
          const fh = (fw * 9) / 16;
          const set = { left: `${(cw - dw) / 2 - c.x * fw}px`, top: `${(ch - dh) / 2 - c.y * fh}px`, width: `${fw}px`, height: `${fh}px`, right: 'auto', bottom: 'auto', 'object-fit': 'fill' };
          for (const [k, v] of Object.entries(set)) target.style.setProperty(k, v, 'important');
          st.cropped = true;
        } else if (st.cropped) {
          for (const k of ['left', 'top', 'width', 'height', 'right', 'bottom', 'object-fit']) target.style.removeProperty(k);
          st.cropped = false;
        }
      } else {
        st.playing = false;
      }

      if (!st.playing) {
        // Some players wait for a mouse to show up or a button to be pressed.
        const at = { bubbles: true, clientX: innerWidth / 2, clientY: innerHeight / 2 };
        for (const type of ['mouseover', 'mouseenter', 'mousemove']) {
          document.documentElement.dispatchEvent(new MouseEvent(type, at));
          document.body && document.body.dispatchEvent(new MouseEvent(type, at));
        }
        for (const b of document.querySelectorAll('button, [role="button"]')) {
          const label = (b.getAttribute('aria-label') || b.textContent || '').trim();
          if (GATE.test(label)) b.click();
        }
      }
    }

    setInterval(tick, 1000);
    tick();
  }

  return { css, js: (startSelector) => `(${isolate.toString()})(${JSON.stringify(startSelector || null)})` };
})();
