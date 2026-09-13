import zh from './zh.json';
import en from './en.json';
import my from './my.json';
import shn from './shn.json';
import mnw from './mnw.json';
import ja from './ja.json';
import ko from './ko.json';
import th from './th.json';

export const defaultLang = 'th';
export const languagesList = ['zh', 'en', 'my', 'shn', 'mnw', 'ja', 'ko', 'th'] as const;

export const languages: Record<string, string> = {
  zh: '中文',
  en: 'English',
  my: 'မြန်မာ',
  shn: 'တႆး',
  mnw: 'ဘာသာမန်',
  ja: '日本語',
  ko: '한국어',
  th: 'ไทย',
};

const ui: Record<string, any> = { zh, en, my, shn, mnw, ja, ko, th };

export function getLangFromUrl(url: URL): string {
  const seg = url.pathname.split('/').filter(Boolean);
  const lang = seg[0];
  return (languagesList as readonly string[]).includes(lang) ? lang : defaultLang;
}

/**
 * Look up a locale directly. Needed by server islands, whose `Astro.url`
 * points at `/_server-islands/<Component>` rather than the page being viewed,
 * so the language has to travel in as a prop.
 */
export function getMessages(lang: string | undefined) {
  const resolved = lang && lang in ui ? lang : defaultLang;
  const messages = ui[resolved];
  const t = (key: string): string => {
    const found = key
      .split('.')
      .reduce<any>((o, i) => (o == null ? undefined : o[i]), messages);
    return found ?? '';
  };
  return { lang: resolved, messages, t };
}

export function getI18n(url: URL) {
  return getMessages(getLangFromUrl(url));
}

export function buildAlternates(path = ''): Record<string, string> {
  const base = 'https://bhubingpalace.com';
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  // Always emit the trailing-slash form so the canonical matches the URL the
  // static file is actually served from (`/en/index.html` -> `/en/`).
  const mk = (l: string) => `${base}/${l}/${clean ? clean + '/' : ''}`;
  return {
    zh: mk('zh'),
    en: mk('en'),
    my: mk('my'),
    shn: mk('shn'),
    mnw: mk('mnw'),
    ja: mk('ja'),
    ko: mk('ko'),
    th: mk('th'),
    xDefault: mk('th'),
  };
}

export function htmlLangAttr(lang: string): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'th') return 'th-TH';
  return lang;
}
