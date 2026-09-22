import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { localizeIndexHtml, sharePathPrefix } from './src/shareMeta';

// index.html carries the English share meta; the build also emits a Chinese
// copy at /zh/index.html so Chinese invitation links preview in Chinese.
function localizedShareHtml(): Plugin {
  return {
    name: 'localized-share-html',
    enforce: 'post',
    transformIndexHtml: (html) => localizeIndexHtml(html, 'en'),
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (index?.type !== 'asset') throw new Error('Expected index.html in the build output.');
      this.emitFile({
        type: 'asset',
        fileName: `${sharePathPrefix.zh.slice(1)}index.html`,
        source: localizeIndexHtml(String(index.source), 'zh'),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localizedShareHtml()],
});
