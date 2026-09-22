// Link previews (WeChat, iMessage, Slack...) read static HTML without running
// the app, so the preview language is carried by the path: Chinese invitations
// point at /zh/, which the build serves with Chinese meta tags.

export type ShareLanguage = 'en' | 'zh';

export const SITE_ORIGIN = 'https://avalon.taotao.au';

const PREVIEW_IMAGE_PATH = '/seo/avalon-phone-table.jpg';

export const sharePathPrefix: Record<ShareLanguage, string> = {
  en: '/',
  zh: '/zh/',
};

interface ShareMeta {
  htmlLang: string;
  title: string;
  description: string;
  ogDescription: string;
  ogLocale: string;
}

export const shareMeta: Record<ShareLanguage, ShareMeta> = {
  en: {
    htmlLang: 'en',
    title: 'Veiled Roundtable',
    description: 'Veiled Roundtable is an Avalon helper for in-person game nights: friends scan to join, each phone privately reveals a role, and team votes, quest cards, and scoring are handled automatically.',
    ogDescription: 'Avalon for friends at the same table: scan to join, private role reveals on every phone, automatic votes and scoring.',
    ogLocale: 'en_US',
  },
  zh: {
    htmlLang: 'zh-CN',
    title: '迷雾圆桌 · 线下阿瓦隆助手',
    description: '迷雾圆桌是给朋友线下聚会用的阿瓦隆助手：扫码入座，每部手机私密查看身份，组队投票、任务票和计分自动处理。',
    ogDescription: '朋友线下聚会，扫码开局，自动处理身份、投票和计分。',
    ogLocale: 'zh_CN',
  },
};

export function getLanguageFromPath(pathname: string): ShareLanguage | undefined {
  return pathname === '/zh' || pathname.startsWith('/zh/') ? 'zh' : undefined;
}

export function localizeIndexHtml(html: string, language: ShareLanguage): string {
  const meta = shareMeta[language];
  const replacements: Array<[string, RegExp, string]> = [
    ['html lang', /<html lang="[^"]*">/, `<html lang="${meta.htmlLang}">`],
    ['title', /<title>[^<]*<\/title>/, `<title>${escapeHtml(meta.title)}</title>`],
    ['description', /(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${escapeHtml(meta.description)}$2`],
    ['og:title', /(<meta property="og:title" content=")[^"]*(")/, `$1${escapeHtml(meta.title)}$2`],
    ['og:description', /(<meta\s+property="og:description"\s+content=")[^"]*(")/, `$1${escapeHtml(meta.ogDescription)}$2`],
    ['og:locale', /(<meta property="og:locale" content=")[^"]*(")/, `$1${meta.ogLocale}$2`],
    ['og:image', /(<meta property="og:image" content=")[^"]*(")/, `$1${SITE_ORIGIN}${PREVIEW_IMAGE_PATH}$2`],
  ];
  return replacements.reduce((current, [name, pattern, replacement]) => {
    if (!pattern.test(current)) throw new Error(`index.html is missing the ${name} tag to localize.`);
    return current.replace(pattern, replacement);
  }, html);
}

// Keeps the live page in step with the UI language, since in-app browsers such
// as WeChat build their share card from the current document.
export function applyShareMetaToDocument(language: ShareLanguage) {
  const meta = shareMeta[language];
  document.documentElement.lang = meta.htmlLang;
  document.title = meta.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', meta.description);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
