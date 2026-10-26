import type { SceneSource } from '../shared/types.js';

/** A real editable fallback scene; generated scenes may replace every part of it. */
export function defaultSceneSource():SceneSource {
  return {
    html:`<section class="vs-scene"><div class="vs-copy"><div class="vs-mark" aria-hidden="true"></div><h1 data-role="title"></h1><p data-role="subtitle"></p></div><p class="vs-caption" data-role="portrait-caption"></p></section>`,
    css:`.vs-scene { position:absolute; inset:0; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--foreground); overflow:hidden; }
.vs-copy { position:absolute; left:7%; top:var(--copy-top,50%); width:var(--copy-width,52%); transform:translateY(-50%); }
.vs-mark { width:64px; height:8px; margin-bottom:32px; background:var(--accent); border-radius:8px; }
.vs-copy h1 { font-size:var(--font-size,72px); font-weight:760; line-height:1.18; margin:0 0 28px; white-space:pre-wrap; overflow-wrap:anywhere; }
.vs-copy p,.vs-caption { font-size:calc(var(--font-size,72px) * .39); line-height:1.55; margin:0; opacity:.76; white-space:pre-wrap; overflow-wrap:anywhere; }
.vs-copy p { display:var(--inline-subtitle,block); }
.vs-caption { display:var(--caption-display,none); position:absolute; left:7%; right:7%; bottom:7%; }`,
    js:`export async function ready(ctx) {
  // The host has decoded ctx.assets[].image and awaited its fonts.
  if (!ctx.root.querySelector('[data-role="title"]')) throw new Error('Default scene title element missing');
}
export function render(ctx) {
  const { root, ctx2d:g, params:p, width:w, height:h } = ctx;
  const clamp = n => Math.max(0, Math.min(1, n));
  const reveal = clamp(ctx.time / .45);
  const ease = 1 - Math.pow(1-reveal, 3);
  const motion = p.motion || 'none';
  const portrait=h>w;
  root.style.setProperty('--foreground', String(p.foreground || '#f9fafb'));
  root.style.setProperty('--accent', String(p.accent || '#a3e635'));
  root.style.setProperty('--font-size', ((Number(p.fontSize)||72)*Math.min(w,h)/1080) + 'px');
  const imageAsset = ctx.assets.find(a => a.kind==='image' && a.image);
  root.style.setProperty('--copy-width', portrait||!imageAsset ? '84%' : '48%');
  root.style.setProperty('--copy-top', portrait ? '20%' : '50%');
  root.style.setProperty('--inline-subtitle', portrait ? 'none' : 'block');
  root.style.setProperty('--caption-display', portrait ? 'block' : 'none');
  root.querySelector('[data-role="title"]').textContent = String(p.text || '');
  root.querySelector('[data-role="subtitle"]').textContent = String(p.subtitle || '');
  root.querySelector('[data-role="portrait-caption"]').textContent = String(p.subtitle || '');
  const layer = root.querySelector('.vs-copy');
  layer.style.opacity = String(motion==='fade'||motion==='slide' ? .12+.88*ease : 1);
  layer.style.transform = 'translateY(-50%) translateX(' + (motion==='slide' ? (1-ease)*w*.035 : 0) + 'px)';
  g.save(); g.setTransform(1,0,0,1,0,0); g.globalAlpha=1;
  if (!ctx.hasVideo) { g.fillStyle=String(p.background || '#111827'); g.fillRect(0,0,w,h); }
  if (imageAsset) {
    const image=imageAsset.image;
    const scale=Math.max(.05,Number(p.imageScale)||1);
    const zoom=motion==='zoom' ? .92+.08*ease : 1;
    const boxW=w*(portrait?.42:.40)*scale*zoom, boxH=h*(portrait?.32:.72)*scale*zoom;
    const centerX=w*(Number.isFinite(Number(p.imageX))?Number(p.imageX):74)/100;
    const centerY=h*(Number.isFinite(Number(p.imageY))?Number(p.imageY):50)/100;
    const ratio=p.imageFit==='cover' ? Math.max(boxW/image.naturalWidth,boxH/image.naturalHeight) : Math.min(boxW/image.naturalWidth,boxH/image.naturalHeight);
    const dw=image.naturalWidth*ratio,dh=image.naturalHeight*ratio;
    g.beginPath();g.rect(centerX-boxW/2,centerY-boxH/2,boxW,boxH);g.clip();
    g.globalAlpha=motion==='fade' ? .12+.88*ease : 1;
    g.drawImage(image,centerX-dw/2,centerY-dh/2,dw,dh);
  }
  g.restore();
}`,
  };
}
