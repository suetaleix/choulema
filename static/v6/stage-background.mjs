// Skin backgrounds share one lifecycle; adding a skin does not change the game shell.
export const STAGE_BACKGROUNDS = Object.freeze({
  classic: { center: '#345b73', mid: '#142d46', edge: '#091426', accent: '#487b91' },
  cosmic: { center: '#554d73', mid: '#242b4b', edge: '#101529', accent: '#786aa0' },
});

export function coverTexture(imageWidth, imageHeight, width, height) {
  const imageAspect = imageWidth / Math.max(1, imageHeight);
  const aspect = width / Math.max(1, height);
  const x = Math.min(1, aspect / imageAspect), y = Math.min(1, imageAspect / aspect);
  return { x, y, offsetX: (1 - x) / 2, offsetY: (1 - y) / 2 };
}

export function createBackgroundController({ themeTexture, loadTexture, apply, dispose }) {
  let key = '', version = 0, custom = null, stopped = false;
  return {
    update({ theme = 'classic', backdrop = '' } = {}) {
      const skin = STAGE_BACKGROUNDS[theme] ? theme : 'classic';
      const next = `${skin}\0${backdrop}`;
      if (stopped || next === key) return;
      key = next;
      const request = ++version;
      apply(themeTexture(skin));
      if (custom) { dispose(custom); custom = null; }
      if (!backdrop) return;
      loadTexture(backdrop).then(texture => {
        if (stopped || request !== version) { dispose(texture); return; }
        custom = texture;
        apply(texture);
      }).catch(() => { /* Keep the selected skin if an uploaded image cannot load. */ });
    },
    dispose() {
      stopped = true; ++version;
      if (custom) { dispose(custom); custom = null; }
    },
  };
}
