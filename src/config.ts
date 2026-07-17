export const siteConfig = {
  name: 'Bhubing Palace',
  baseUrl: 'https://bhubingpalace.com',
  slug: 'bhubing-palace',
  locales: ['zh', 'en', 'my', 'shn', 'mnw', 'ja', 'ko'] as const,
};

export const ogLocale: Record<string, string> = {
  zh: 'zh_CN',
  en: 'en_US',
  my: 'my',
  shn: 'shn',
  mnw: 'mnw',
  ja: 'ja_JP',
  ko: 'ko_KR',
};
