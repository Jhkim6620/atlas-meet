const paths = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  view: '<path d="M9 4H5a1 1 0 0 0-1 1v4m11-5h4a1 1 0 0 1 1 1v4M4 15v4a1 1 0 0 0 1 1h4m11-5v4a1 1 0 0 1-1 1h-4"/><circle cx="12" cy="12" r="2.5"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-3 0h6"/>',
  'mic-off':
    '<path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.7-1.3M5 10v2a7 7 0 0 0 12 4.9m2-4.9v-2M12 19v3m-3 0h6M3 3l18 18"/>',
  video: '<rect x="2.5" y="5" width="13" height="14" rx="2.5"/><path d="m15.5 10 6-3v10l-6-3"/>',
  'camera-off':
    '<path d="M8 5h5a2.5 2.5 0 0 1 2.5 2.5V10l6-3v10l-4-2M3 5.5a2.5 2.5 0 0 0-.5 1.5v9.5A2.5 2.5 0 0 0 5 19h8a2.5 2.5 0 0 0 2.4-1.8M2 2l20 20"/>',
  link: '<path d="m10 13 4-4m-4.5 6.5-2 2a3.6 3.6 0 0 1-5.1-5.1l4-4a3.6 3.6 0 0 1 5.1 0m1 7.2a3.6 3.6 0 0 0 5.1 0l4-4a3.6 3.6 0 0 0-5.1-5.1l-2 2" transform="rotate(-6 12 12)"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  audio: '<path d="M3 10v4m4-8v12m5-16v20m5-16v12m4-8v4"/>',
  arrow: '<path d="M4 12h15m-6-7 7 7-7 7"/>',
  back: '<path d="m13 5-7 7 7 7m-7-7h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  text: '<path d="M5 3h11l4 4v14H5zM8 10h8m-8 4h8m-8 4h5"/>',
  history: '<path d="M3 10a9 9 0 1 1 1.5 7M3 4v6h6m3-4v6l3.8 2.2"/>',
  people:
    '<circle cx="9" cy="8" r="3.1"/><path d="M2.5 20v-2a6.5 6.5 0 0 1 13 0v2m0-15a3.2 3.2 0 0 1 .2 6.3m2.2 2.9c2.8.6 3.6 2.3 3.6 5.8"/>',
  search: '<circle cx="10" cy="10" r="6.7"/><path d="m15 15 6 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  hangup:
    '<path d="M3 16c-1 .2-1.5-.6-1.2-1.6C3 10 7.3 8 12 8s9 2 10.2 6.4c.3 1-.2 1.8-1.2 1.6l-4-.7-.6-3.2a13 13 0 0 0-8.8 0L7 15.3z"/>',
  volume: '<path d="m3 10 4 0 5-5v14l-5-5H3zm12-1c2 1.5 2 4.5 0 6m2-9c4.5 3.6 4.5 8.4 0 12"/>',
};
export function icon(name) {
  const node = document.createElement('i');
  node.dataset.i = name;
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = '<svg viewBox="0 0 24 24" focusable="false">' + (paths[name] || '') + '</svg>';
  return node;
}
export function hydrateIcons() {
  for (const node of document.querySelectorAll('i[data-i]')) node.replaceWith(icon(node.dataset.i));
}

// A static, woven sound wave serves as the camera-off cover. The separate input meter uses real audio.
export function mountCover(canvas) {
  function paint() {
    const { width: w, height: h } = canvas.getBoundingClientRect();
    if (!w || !h) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#19223e');
    bg.addColorStop(0.55, '#101b35');
    bg.addColorStop(1, '#152842');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(173,191,230,.19)';
    const grid = 19;
    for (let x = (w % grid) / 2; x < w; x += grid)
      for (let y = (h % grid) / 2; y < h; y += grid) ctx.fillRect(x, y, 1, 1);
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    for (const [n, color] of [
      [0, '#6685ef'],
      [0.18, '#91a9ff'],
      [0.34, '#b194ff'],
      [0.52, '#777bf9'],
      [0.66, '#67c3fc'],
      [0.84, '#7de1df'],
      [1, '#3e94bd'],
    ])
      gradient.addColorStop(n, color);
    ctx.lineWidth = Math.max(0.7, Math.min(1.15, w / 700));
    ctx.strokeStyle = gradient;
    // Each line wraps around a common spine, exposing folds where the wave crosses itself.
    for (let strand = 0; strand < 74; strand++) {
      const phase = (strand / 73) * Math.PI * 1.65;
      ctx.beginPath();
      for (let px = -1; px <= w + 2; px += 2) {
        const u = px / w;
        const amp =
          0.07 +
          0.24 * Math.exp(-(((u - 0.35) / 0.18) ** 2)) +
          0.17 * Math.exp(-(((u - 0.72) / 0.16) ** 2));
        const wave =
          amp *
          (0.77 * Math.sin(3.65 * Math.PI * u + phase + 0.7) +
            0.23 * Math.sin(7 * Math.PI * u + phase * 0.7));
        const spine = 0.035 * Math.sin(2 * Math.PI * u - 0.7) + 0.045 * Math.sin(5 * Math.PI * u);
        const y = h * (0.52 + spine + wave);
        if (px === -1) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.globalAlpha = 0.35 + 0.56 * Math.abs(Math.sin(phase * 0.87));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  new ResizeObserver(paint).observe(canvas);
  paint();
}
