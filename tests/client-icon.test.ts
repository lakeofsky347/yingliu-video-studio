import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoStudioIcon } from '../src/client/VideoStudioIcon.tsx';

// The sidebar places the occupant inside an inline-flex glyph slot, so the
// icon must bring its own square dimensions: a viewBox-only <svg> collapses
// to 0x0 there and the panel row shows no glyph at all.
test('sidebar icon renders the requested square instead of relying on surrounding CSS',()=>{
  const markup=renderToStaticMarkup(createElement(VideoStudioIcon,{size:16}));
  assert.match(markup,/^<svg /);
  assert.match(markup,/width="16"/);
  assert.match(markup,/height="16"/);
  assert.match(markup,/viewBox="0 0 24 24"/);
  assert.match(markup,/aria-hidden="true"/);
  assert.match(markup,/fill="currentColor"/);
});

test('collapsed sidebar rail can request the larger glyph',()=>{
  const markup=renderToStaticMarkup(createElement(VideoStudioIcon,{size:18}));
  assert.match(markup,/width="18"/);
  assert.match(markup,/height="18"/);
});

test('icon defaults to a visible square when the host omits a size',()=>{
  const markup=renderToStaticMarkup(createElement(VideoStudioIcon));
  assert.match(markup,/width="18"/);
  assert.match(markup,/height="18"/);
});
