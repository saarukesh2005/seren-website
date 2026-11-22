/* SEREN section animations. Content is fully visible without this file; it only adds movement. */
(function () {
  "use strict";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nav = document.getElementById("nav");
  const hero = document.getElementById("hero");

  // Nav turns solid once the hero is behind us (works even without GSAP).
  const navObs = new IntersectionObserver(([e]) => nav.classList.toggle("solid", !e.isIntersecting), { rootMargin: "-80px 0px 0px 0px" });
  navObs.observe(hero);

  if (reduce || !window.gsap || !window.ScrollTrigger) return;
  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);

  /* ---------- smooth scroll ---------- */
  if (window.Lenis) {
    const lenis = new window.Lenis({ lerp: 0.1, smoothWheel: true });
    window.serenLenis = lenis;
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    document.querySelectorAll('a[href^="#"]').forEach((a) =>
      a.addEventListener("click", (e) => {
        const id = a.getAttribute("href");
        const el = id.length > 1 && document.querySelector(id);
        if (el) { e.preventDefault(); lenis.scrollTo(el, { offset: -10, duration: 1.4 }); }
      }));
    // The page behind the order box must not scroll while it is open.
    document.addEventListener("seren:drawer", (e) => (e.detail.open ? lenis.stop() : lenis.start()));
  }

  /* ---------- hero ---------- */
  function heroIntro() {
    const letters = gsap.utils.toArray(".hero-word span");
    const arrow = document.getElementById("heroArrow");
    const len = arrow.getTotalLength();
    gsap.set(arrow, { strokeDasharray: len, strokeDashoffset: len });
    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.from(".hero .half.l", { yPercent: -100, duration: 1.1 })
      .from(".hero .half.r", { yPercent: 100, duration: 1.1 }, "<")
      .from(letters, { yPercent: 110, rotate: (i) => (i % 2 ? 6 : -6), duration: 1.1, stagger: 0.07 }, "-=0.55")
      .to(arrow, { strokeDashoffset: 0, duration: 1.2, ease: "power2.inOut" }, "-=0.6")
      .from(".hero .floater img", { scale: 0, duration: 0.9, stagger: 0.08, ease: "back.out(2)" }, "-=1")
      .from(".hero .tag, .hero .burst, .hero .cta", { autoAlpha: 0, y: 16, duration: 0.8, stagger: 0.05 }, "-=0.8");

    // Scroll away: the word splits along the seam, like the cover pulled apart.
    // Each floater has three layers so the three motions never fight:
    // .floater = scroll, .fl-p = pointer, img = idle bob + intro.
    const out = gsap.timeline({ scrollTrigger: { trigger: hero, start: "top top", end: "bottom top", scrub: true } });
    const left = Number(document.querySelector(".hero-word").dataset.left || 2); // SE|REN in English, செ|ரென் in Tamil
    out.to(letters.slice(0, left), { xPercent: -40, ease: "none" }, 0)
      .to(letters.slice(left), { xPercent: 40, ease: "none" }, 0)
      .to(".hero .half.l", { xPercent: -30, ease: "none" }, 0)
      .to(".hero .half.r", { xPercent: 30, ease: "none" }, 0)
      .to(".hero .floater", { y: (i) => -120 - i * 60, rotate: (i) => (i % 2 ? 30 : -30), ease: "none" }, 0);

    const floaters = gsap.utils.toArray(".hero .floater").map((el) => {
      const inner = el.querySelector(".fl-p");
      return { d: Number(el.dataset.depth || 1), x: gsap.quickTo(inner, "x", { duration: 0.9, ease: "power3" }), y: gsap.quickTo(inner, "y", { duration: 0.9, ease: "power3" }) };
    });
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5, ny = (e.clientY - r.top) / r.height - 0.5;
      floaters.forEach((f) => { f.x(nx * 60 * f.d); f.y(ny * 50 * f.d); });
    });
    gsap.utils.toArray(".hero .floater img").forEach((im, i) =>
      gsap.to(im, { rotate: i % 2 ? 10 : -10, y: -10, yoyo: true, repeat: -1, duration: 2.4 + i * 0.3, ease: "sine.inOut", delay: 1.6 + i * 0.2 }));

    wobble(letters);
  }

  /* letters squash and spring back when the pointer touches them */
  function wobble(els) {
    els.forEach((el) => el.addEventListener("pointerenter", () => {
      gsap.fromTo(el, { scaleY: 0.82, scaleX: 1.12 }, { scaleY: 1, scaleX: 1, duration: 0.9, ease: "elastic.out(1.2,0.35)", overwrite: "auto" });
    }));
  }

  // Splits text into whole letters as people see them (a Tamil letter with its vowel sign stays together).
  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const graphemes = (s) => (segmenter ? [...segmenter.segment(s)].map((x) => x.segment) : [...s]);

  /* ---------- big headings rise letter by letter (whole words never split across lines) ---------- */
  function headings() {
    document.querySelectorAll(".head h2.display").forEach((h) => {
      const label = h.textContent.replace(/\s+/g, " ").trim();
      const walk = (node) => {
        [...node.childNodes].forEach((n) => {
          if (n.nodeType === 3) {
            const frag = document.createDocumentFragment();
            n.textContent.split(/(\s+)/).forEach((word) => {
              if (!word) return;
              if (!word.trim()) { frag.appendChild(document.createTextNode(" ")); return; }
              const w = document.createElement("span"); w.className = "wd";
              graphemes(word).forEach((ch) => { const s = document.createElement("span"); s.className = "ch"; s.style.display = "inline-block"; s.textContent = ch; w.appendChild(s); });
              frag.appendChild(w);
            });
            n.replaceWith(frag);
          } else if (n.nodeType === 1 && n.tagName !== "BR") walk(n);
        });
      };
      walk(h);
      h.setAttribute("aria-label", label);
      [...h.children].forEach((c) => c.setAttribute("aria-hidden", "true"));
      gsap.from(h.querySelectorAll(".ch"), {
        yPercent: 100, opacity: 0, rotate: 8, duration: 0.9, ease: "expo.out", stagger: 0.025,
        scrollTrigger: { trigger: h, start: "top 85%" },
      });
    });
  }

  /* ---------- intro: words light up as you read, numbers count up ---------- */
  function intro() {
    const p = document.querySelector("[data-words]");
    const words = [];
    [...p.childNodes].forEach((n) => {
      if (n.nodeType !== 3) { n.classList.add("w"); words.push(n); return; }
      const frag = document.createDocumentFragment();
      n.textContent.split(/(\s+)/).forEach((part) => {
        if (!part.trim()) { frag.appendChild(document.createTextNode(part)); return; }
        const s = document.createElement("span"); s.className = "w"; s.textContent = part; frag.appendChild(s); words.push(s);
      });
      n.replaceWith(frag);
    });
    p.classList.add("js-words");
    ScrollTrigger.create({
      trigger: p, start: "top 80%", end: "bottom 45%", scrub: true,
      onUpdate: (st) => { const k = Math.round(st.progress * words.length); words.forEach((w, i) => w.classList.toggle("on", i < k)); },
    });
    gsap.from(".intro .meta div", { y: 30, opacity: 0, stagger: 0.08, duration: 0.8, ease: "expo.out", scrollTrigger: { trigger: ".intro .meta", start: "top 90%" } });
    document.querySelectorAll("[data-count]").forEach((el) => {
      const n = { v: 0 }, end = Number(el.dataset.count);
      gsap.to(n, { v: end, duration: 1.6, ease: "power2.out", onUpdate: () => { el.textContent = String(Math.round(n.v)); }, scrollTrigger: { trigger: el, start: "top 92%" } });
    });
  }

  /* ---------- bomboloni: horizontal pinned rail ---------- */
  function bomboloni() {
    const mm = gsap.matchMedia();
    mm.add("(min-width: 761px)", () => {
      const rail = document.getElementById("bombRail");
      const dist = () => rail.scrollWidth - window.innerWidth;
      const move = gsap.to(rail, {
        x: () => -dist(), ease: "none",
        scrollTrigger: { trigger: "#bombPin", start: "top top", end: () => `+=${dist()}`, pin: true, scrub: 0.6, invalidateOnRefresh: true, anticipatePin: 1 },
      });
      gsap.from("#bombRail .paper", { y: 120, rotate: (i) => (i % 2 ? 6 : -6), opacity: 0, stagger: 0.08, duration: 1, ease: "expo.out", scrollTrigger: { trigger: "#bombPin", start: "top 70%" } });
      // Cards sway gently as the rail travels.
      gsap.utils.toArray("#bombRail .paper").forEach((card, i) =>
        gsap.fromTo(card, { y: i % 2 ? -18 : 18 }, { y: i % 2 ? 18 : -18, ease: "none", scrollTrigger: { trigger: card, containerAnimation: move, start: "left right", end: "right left", scrub: true } }));
    });
  }

  /* ---------- cookies roll in and keep turning ---------- */
  function cookies() {
    gsap.utils.toArray(".cookie").forEach((c, i) => {
      const disc = c.querySelector(".disc");
      gsap.from(c, { y: 80, opacity: 0, duration: 1, ease: "expo.out", delay: (i % 4) * 0.08, scrollTrigger: { trigger: c, start: "top 92%" } });
      gsap.fromTo(disc, { rotate: -90 + i * 20 }, { rotate: 90 + i * 20, ease: "none", scrollTrigger: { trigger: c, start: "top bottom", end: "bottom top", scrub: true } });
    });
  }

  /* ---------- illusory fruit: a knife slices across, the new fruit spins in ---------- */
  function spinRing() {
    gsap.killTweensOf("#fruitView .ring");
    gsap.to("#fruitView .ring", { rotate: 360, duration: 40, repeat: -1, ease: "none" });
  }
  function fruitIn() {
    const v = document.getElementById("fruitView");
    const slice = document.createElement("div"); slice.className = "slice"; v.appendChild(slice);
    const tl = gsap.timeline({ onComplete: () => slice.remove() });
    tl.fromTo(slice, { xPercent: -120 }, { xPercent: 120, duration: 0.7, ease: "power3.inOut" })
      .from(v.querySelector("img, .blob"), { scale: 0.4, rotate: -120, opacity: 0, duration: 1, ease: "back.out(1.6)" }, 0.15)
      .from(v.querySelectorAll(".layers li"), { y: 16, opacity: 0, stagger: 0.1, duration: 0.6, ease: "expo.out" }, "-=0.5");
  }
  function fruit() {
    gsap.from("#fruitView", { scale: 0.85, opacity: 0, duration: 1.2, ease: "expo.out", scrollTrigger: { trigger: "#fruitView", start: "top 80%", onEnter: fruitIn } });
    spinRing();
    gsap.from("#fruitList button", { x: 60, opacity: 0, stagger: 0.05, duration: 0.8, ease: "expo.out", scrollTrigger: { trigger: "#fruitList", start: "top 85%" } });
    document.addEventListener("seren:fruit", () => { fruitIn(); spinRing(); });
  }

  /* ---------- entremets stack from the base up ---------- */
  function stackCake() {
    const layers = gsap.utils.toArray("#cakeStack .layer").reverse();
    gsap.from(layers, { y: -260, opacity: 0, duration: 0.9, ease: "bounce.out", stagger: 0.16 });
    gsap.from("#cakeStack .layer span", { x: 30, opacity: 0, duration: 0.5, stagger: 0.12, delay: 0.5 });
  }
  function entremets() {
    ScrollTrigger.create({ trigger: "#cake", start: "top 75%", once: true, onEnter: stackCake });
    gsap.to("#cakeStack", { rotateX: 4, rotateY: -8, scrollTrigger: { trigger: "#entremets", start: "top bottom", end: "bottom top", scrub: true } });
    document.addEventListener("seren:cake", stackCake);
  }

  /* ---------- photos uncover like a lid lifting, then drift as you scroll ---------- */
  function pastry() {
    gsap.utils.toArray(".pcard").forEach((card, i) => {
      gsap.from(card.querySelector(".ph"), { clipPath: "inset(100% 0% 0% 0% round 14px)", duration: 1.2, ease: "expo.inOut", delay: (i % 3) * 0.1, scrollTrigger: { trigger: card, start: "top 88%" } });
    });
    gsap.utils.toArray(".pcard .ph img:not(.alt), .slab-card .ph img").forEach((im) =>
      gsap.fromTo(im, { "--py": "-20px" }, { "--py": "20px", ease: "none", scrollTrigger: { trigger: im.parentElement, start: "top bottom", end: "bottom top", scrub: true } }));
  }

  /* ---------- gelato scoops drop onto cones ---------- */
  function scoopsIn() {
    gsap.from("#scoops .drop", { y: -140, scale: 0.6, duration: 0.8, ease: "bounce.out", stagger: 0.06, clearProps: "transform" });
    gsap.from("#scoops .cone, #scoops h3, #scoops .add", { opacity: 0, y: 20, duration: 0.5, stagger: 0.03 });
  }
  function gelato() {
    ScrollTrigger.create({ trigger: "#scoops", start: "top 80%", once: true, onEnter: scoopsIn });
    document.addEventListener("seren:scoops", () => { if (ScrollTrigger.isInViewport(document.getElementById("scoops"))) scoopsIn(); });
    gsap.from(".g-facts div", { y: 40, opacity: 0, stagger: 0.1, duration: 0.8, ease: "expo.out", scrollTrigger: { trigger: ".g-facts", start: "top 90%" } });
  }

  /* ---------- chocolates float, drips stretch as they arrive ---------- */
  function chocolates() {
    gsap.from(".bonbon", { y: 120, opacity: 0, rotate: (i) => (i % 2 ? 20 : -20), stagger: 0.1, duration: 1.1, ease: "expo.out", scrollTrigger: { trigger: "#bonbons", start: "top 85%" } });
    gsap.utils.toArray(".bonbon .bob").forEach((im, i) => gsap.to(im, { y: -14, duration: 2 + i * 0.3, yoyo: true, repeat: -1, ease: "sine.inOut", delay: i * 0.2 }));
    gsap.from(".truffle", { y: 60, opacity: 0, stagger: 0.15, duration: 1, ease: "expo.out", scrollTrigger: { trigger: "#truffles", start: "top 88%" } });
    gsap.utils.toArray(".drip svg").forEach((svg) =>
      gsap.fromTo(svg, { scaleY: 0.35, transformOrigin: "50% 0%" }, { scaleY: 1.15, ease: "none", scrollTrigger: { trigger: svg.closest("section"), start: "top bottom", end: "top 30%", scrub: true } }));
  }

  /* ---------- kitchen ---------- */
  function kitchen() {
    gsap.from(".slab-card", { y: 90, opacity: 0, rotate: (i) => (i % 2 ? 2 : -2), stagger: 0.1, duration: 1, ease: "expo.out", scrollTrigger: { trigger: "#slabs", start: "top 85%" } });
    gsap.from("#kmenu li", { x: -30, opacity: 0, stagger: 0.025, duration: 0.6, ease: "expo.out", scrollTrigger: { trigger: "#kmenu", start: "top 85%" } });
  }

  /* ---------- footer letters bounce up and wobble on hover ---------- */
  function footer() {
    const letters = gsap.utils.toArray("footer .big span");
    gsap.from(letters, { yPercent: 90, duration: 1, ease: "back.out(1.8)", stagger: 0.06, scrollTrigger: { trigger: "footer", start: "top 85%" } });
    wobble(letters);
  }

  heroIntro(); headings(); intro(); bomboloni(); cookies(); fruit(); entremets(); pastry(); gelato(); chocolates(); kitchen(); footer();

  // Re-measure trigger points once images have loaded and changed the page height.
  let refreshTimer;
  const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => ScrollTrigger.refresh(), 200); };
  document.querySelectorAll("img").forEach((im) => { if (!im.complete) im.addEventListener("load", refreshSoon, { once: true }); });
  window.addEventListener("load", refreshSoon);
})();
