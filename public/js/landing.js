/* ════════════════════════════════════════════════════════════
   SenIQ — Landing page interactions (GSAP + ScrollTrigger)
   ════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  const hasGSAP = typeof window.gsap !== 'undefined';

  // Year
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // ─── Live UTC clock ──────────────────────────────────────
  const clockEl = document.getElementById('market-clock');
  if (clockEl) {
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
      const d = new Date();
      clockEl.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
    };
    tick();
    setInterval(tick, 1000);
  }

  // ─── Market % jitter ─────────────────────────────────────
  if (!reduceMotion) {
    const pcts = document.querySelectorAll('.mkt-pct[data-pct]');
    setInterval(() => {
      pcts.forEach((el) => {
        const base = parseFloat(el.dataset.pct);
        const v = base + (Math.random() - 0.5) * 0.3;
        el.textContent = (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
      });
    }, 2200);
  }

  // Disclaimer from API
  fetch('/api/config')
    .then((r) => r.json())
    .then(({ disclaimer }) => {
      if (disclaimer) document.querySelectorAll('[data-disclaimer]').forEach((el) => { el.textContent = disclaimer; });
    })
    .catch(() => {});

  // Already logged in → point every app CTA straight at the dashboard
  if (localStorage.getItem('copilot_token')) {
    document.querySelectorAll('a[href^="/app"]').forEach((a) => {
      a.setAttribute('href', '/app');
      // Relabel sign-up CTAs; leave "Sign In" links alone.
      if (/signup/.test(a.dataset.cta || '') || /start|create|get started/i.test(a.textContent)) {
        const label = a.querySelector('span:not(.prompt)');
        if (label) label.textContent = 'Go to Dashboard';
        else a.childNodes.forEach((n) => { if (n.nodeType === 3 && n.textContent.trim()) n.textContent = ' Go to Dashboard'; });
      }
    });
  }

  // ─── Sticky nav + scroll progress ────────────────────────
  const nav = document.getElementById('nav');
  const prog = document.getElementById('scroll-progress');
  const onScroll = () => {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 24);
    if (prog) {
      const h = document.documentElement;
      prog.style.width = ((h.scrollTop || document.body.scrollTop) / (h.scrollHeight - h.clientHeight) * 100) + '%';
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ─── Mobile menu ──────────────────────────────────────────
  const burger = document.getElementById('nav-burger');
  const links = document.getElementById('nav-links');
  if (burger && links) {
    burger.addEventListener('click', () => {
      const open = links.style.display === 'flex';
      if (open) { links.style.cssText = ''; return; }
      links.style.cssText = 'display:flex;position:absolute;top:100%;left:0;right:0;flex-direction:column;gap:1rem;padding:1.2rem 1.4rem;background:rgba(7,7,13,.96);border-bottom:1px solid rgba(255,255,255,.08);';
    });
    links.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => { links.style.cssText = ''; }));
  }

  // ─── Cursor glow ──────────────────────────────────────────
  const glow = document.getElementById('cursor-glow');
  if (glow && !reduceMotion && finePointer) {
    let gx = innerWidth / 2, gy = innerHeight / 2, cx = gx, cy = gy;
    addEventListener('mousemove', (e) => { gx = e.clientX; gy = e.clientY; glow.style.opacity = '1'; });
    (function loop() {
      cx += (gx - cx) * 0.12; cy += (gy - cy) * 0.12;
      glow.style.transform = `translate(${cx}px, ${cy}px) translate(-50%, -50%)`;
      requestAnimationFrame(loop);
    })();
  }

  // ─── Magnetic buttons ─────────────────────────────────────
  if (!reduceMotion && finePointer) {
    document.querySelectorAll('[data-magnetic]').forEach((el) => {
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        el.style.transform = `translate(${(e.clientX - (r.left + r.width / 2)) * 0.35}px, ${(e.clientY - (r.top + r.height / 2)) * 0.35}px)`;
      });
      el.addEventListener('mouseleave', () => { el.style.transform = ''; });
    });
  }

  // ─── 3D tilt cards ────────────────────────────────────────
  if (!reduceMotion && finePointer) {
    document.querySelectorAll('[data-tilt]').forEach((el) => {
      el.addEventListener('mousemove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5;
        const py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = `perspective(900px) rotateY(${px * 7}deg) rotateX(${-py * 7}deg) translateY(-4px)`;
      });
      el.addEventListener('mouseleave', () => { el.style.transform = ''; });
    });
  }

  // ─── No-GSAP / reduced-motion fallback ───────────────────
  if (!hasGSAP || reduceMotion) {
    document.querySelectorAll('[data-reveal], [data-hero]').forEach((el) => { el.style.opacity = '1'; el.style.transform = 'none'; });
    return;
  }

  // ════════════════════════════════════════════════════════════
  gsap.registerPlugin(ScrollTrigger);

  // ─── Hero intro timeline ──────────────────────────────────
  gsap.timeline({ defaults: { ease: 'power3.out' } })
    .from('.nav', { y: -40, opacity: 0, duration: 0.8 })
    .from('.pill', { y: 20, opacity: 0, duration: 0.6 }, '-=0.3')
    .from('.hero-title .word', { yPercent: 115, opacity: 0, duration: 0.85, stagger: 0.06 }, '-=0.3')
    .to('[data-hero]', { opacity: 1, duration: 0.01 }, '-=0.4')
    .from('.hero-sub', { y: 24, opacity: 0, duration: 0.7 }, '-=0.3')
    .from('.hero-actions', { y: 24, opacity: 0, duration: 0.7 }, '-=0.5')
    .from('.trust-bar', { y: 20, opacity: 0, duration: 0.6 }, '-=0.5')
    .from('.hero-chart-wrap', { x: 50, opacity: 0, scale: 0.94, duration: 1.1, ease: 'power4.out' }, '-=0.9')
    .from('.chart-chip', { scale: 0, opacity: 0, duration: 0.5, stagger: 0.08, ease: 'back.out(1.7)' }, '-=0.6')
    .from('.dash-badge', { y: 28, opacity: 0, duration: 0.6 }, '-=0.5')
    .from('.tchip', { scale: 0, opacity: 0, duration: 0.5, stagger: 0.06, ease: 'back.out(1.7)' }, '-=0.8');

  // ─── Floating chips + badge drift ────────────────────────
  gsap.utils.toArray('[data-float]').forEach((el, i) => {
    gsap.to(el, { y: i % 2 ? 12 : -14, x: i % 3 ? 6 : -6, duration: 3 + (i % 3), ease: 'sine.inOut', yoyo: true, repeat: -1, delay: i * 0.25 });
  });

  // Chart chips gentle float
  document.querySelectorAll('.chart-chip').forEach((el, i) => {
    gsap.to(el, { y: i % 2 ? -8 : 8, duration: 2.5 + i * 0.4, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: i * 0.3 });
  });

  // ─── Background blob parallax ─────────────────────────────
  gsap.to('.blob-1', { yPercent: 28, ease: 'none', scrollTrigger: { trigger: 'body', start: 'top top', end: 'bottom bottom', scrub: 1 } });
  gsap.to('.blob-2', { yPercent: -22, ease: 'none', scrollTrigger: { trigger: 'body', start: 'top top', end: 'bottom bottom', scrub: 1 } });
  gsap.to('.blob-3', { yPercent: 18, ease: 'none', scrollTrigger: { trigger: 'body', start: 'top top', end: 'bottom bottom', scrub: 1 } });

  // ─── Scroll reveals ───────────────────────────────────────
  gsap.utils.toArray('[data-reveal]').forEach((el) => {
    gsap.to(el, {
      opacity: 1, y: 0, duration: 0.85, ease: 'power3.out',
      scrollTrigger: { trigger: el, start: 'top 88%', toggleActions: 'play none none none' }
    });
  });

  // ─── Terminal feed rows stagger in ───────────────────────
  ScrollTrigger.create({
    trigger: '.cmd', start: 'top 80%', once: true,
    onEnter: () => {
      gsap.from('.term-row', { opacity: 0, x: -20, duration: 0.5, stagger: 0.1, ease: 'power2.out' });
      // Animate dial needle
      gsap.to('.dial-needle', { rotation: 18, duration: 1.6, ease: 'back.out(1.2)', delay: 0.3 });
    }
  });

  // ─── Smart money sparklines draw in ──────────────────────
  ScrollTrigger.create({
    trigger: '.sm-cards', start: 'top 80%', once: true,
    onEnter: () => {
      document.querySelectorAll('.sm-sparkline svg path:first-of-type').forEach((path, i) => {
        gsap.from(path, { opacity: 0, duration: 0.8, delay: i * 0.15, ease: 'power2.out' });
      });
    }
  });

  // ─── Problem cards stagger ───────────────────────────────
  ScrollTrigger.create({
    trigger: '.problem-grid', start: 'top 82%', once: true,
    onEnter: () => {
      gsap.from('.prob', { opacity: 0, y: 30, scale: 0.95, duration: 0.65, stagger: 0.1, ease: 'power3.out' });
    }
  });

  // ─── Market grid stagger ─────────────────────────────────
  ScrollTrigger.create({
    trigger: '.market-grid', start: 'top 82%', once: true,
    onEnter: () => {
      gsap.from('.mkt', { opacity: 0, y: 20, duration: 0.55, stagger: 0.08, ease: 'power2.out' });
    }
  });

  // ─── CTA glow pulse ──────────────────────────────────────
  gsap.to('.cta-glow', {
    scale: 1.15, opacity: 0.8, duration: 3, ease: 'sine.inOut', yoyo: true, repeat: -1,
    scrollTrigger: { trigger: '.cta-final', start: 'top 80%' }
  });

})();
