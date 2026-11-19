/* SEREN pointer + scroll interactions: custom cursor, magnetic buttons, scroll-reactive marquee, progress line. */
(function () {
  "use strict";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (reduce || !window.gsap || !window.ScrollTrigger) return;
  const { gsap, ScrollTrigger } = window;

  /* ---------- scroll progress line ---------- */
  gsap.to("#progress", { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.3 } });

  /* ---------- marquee leans and speeds up with scroll velocity ---------- */
  const track = document.querySelector(".marquee .track");
  if (track) {
    track.style.animation = "none";
    let x = 0, boost = 0, dir = 1;
    const skew = gsap.quickTo(track, "skewX", { duration: 0.4, ease: "power3" });
    ScrollTrigger.create({
      start: 0, end: "max",
      onUpdate: (st) => {
        const v = st.getVelocity();
        dir = v < 0 ? -1 : 1;
        boost = Math.min(Math.abs(v) / 300, 14);
        skew(gsap.utils.clamp(-10, 10, -v / 250));
      },
    });
    gsap.ticker.add((t, dt) => {
      const half = track.scrollWidth / 2;
      if (!half) return;
      x -= (0.6 + boost) * dir * (dt / 16.7);
      boost *= 0.92;
      if (x <= -half) x += half;
      if (x > 0) x -= half;
      gsap.set(track, { x });
    });
    ScrollTrigger.addEventListener("scrollEnd", () => skew(0));
  }

  if (!finePointer) return;

  /* ---------- custom cursor ---------- */
  const cursor = document.getElementById("cursor");
  const label = cursor.querySelector("span");
  document.documentElement.classList.add("has-cursor");
  const cx = gsap.quickTo(cursor, "x", { duration: 0.18, ease: "power3" });
  const cy = gsap.quickTo(cursor, "y", { duration: 0.18, ease: "power3" });
  window.addEventListener("pointermove", (e) => { cx(e.clientX); cy(e.clientY); cursor.classList.add("on"); }, { passive: true });
  document.addEventListener("pointerleave", () => cursor.classList.remove("on"));

  const BIG = [
    [".add", "Add"], [".fruit-list button", "Taste"], [".ent-tabs button", "Build"], [".g-tabs button", "Scoop"],
    [".pcard .ph", "Open"], [".cookie .disc", "Bite"], [".paper .ph", "Fill"], [".bonbon .bob", "Snap"],
  ];
  document.addEventListener("pointerover", (e) => {
    const big = BIG.find(([sel]) => e.target.closest(sel));
    const link = e.target.closest("a, button, [data-pal]");
    cursor.classList.toggle("big", Boolean(big));
    cursor.classList.toggle("link", !big && Boolean(link));
    label.textContent = big ? big[1] : "";
  });

  /* ---------- magnetic buttons ---------- */
  document.querySelectorAll(".pill, .box-btn").forEach((el) => {
    const mx = gsap.quickTo(el, "x", { duration: 0.5, ease: "power3" });
    const my = gsap.quickTo(el, "y", { duration: 0.5, ease: "power3" });
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      mx((e.clientX - (r.left + r.width / 2)) * 0.3);
      my((e.clientY - (r.top + r.height / 2)) * 0.4);
    });
    el.addEventListener("pointerleave", () => { mx(0); my(0); });
  });
})();
