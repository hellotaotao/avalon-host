import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import { getLanguageFromPath, localizeIndexHtml, shareMeta } from './shareMeta';

describe('share meta', () => {
  it('rewrites the page title, description, and Open Graph summary into Chinese', () => {
    const html = localizeIndexHtml(indexHtml, 'zh');

    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain(`<title>${shareMeta.zh.title}</title>`);
    expect(html).toContain(`name="description"\n      content="${shareMeta.zh.description}"`);
    expect(html).toContain(`<meta property="og:title" content="${shareMeta.zh.title}" />`);
    expect(html).toContain(`content="${shareMeta.zh.ogDescription}"`);
    expect(html).toContain('<meta property="og:locale" content="zh_CN" />');
    expect(html).not.toContain(shareMeta.en.ogDescription);
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  it('keeps the English page consistent with the shared meta source', () => {
    const html = localizeIndexHtml(indexHtml, 'en');

    expect(html).toContain('<html lang="en">');
    expect(html).toContain(`<title>${shareMeta.en.title}</title>`);
    expect(html).toContain(`content="${shareMeta.en.ogDescription}"`);
    expect(localizeIndexHtml(html, 'en')).toBe(html);
  });

  it('uses an absolute preview image on the production domain', () => {
    expect(localizeIndexHtml(indexHtml, 'zh')).toContain('<meta property="og:image" content="https://avalon.taotao.au/seo/avalon-phone-table.jpg" />');
  });

  it('fails loudly when the page template no longer has a tag to localize', () => {
    expect(() => localizeIndexHtml('<html lang="en"><head></head></html>', 'zh')).toThrow(/title/);
  });

  it('reads the share language from the path', () => {
    expect(getLanguageFromPath('/zh/')).toBe('zh');
    expect(getLanguageFromPath('/zh')).toBe('zh');
    expect(getLanguageFromPath('/')).toBeUndefined();
    expect(getLanguageFromPath('/zhx/')).toBeUndefined();
  });
});
