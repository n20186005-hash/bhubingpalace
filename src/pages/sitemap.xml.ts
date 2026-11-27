import type { APIRoute } from 'astro';
import { languagesList } from '../i18n/ui';

export const GET: APIRoute = () => {
  const urls = languagesList.map((lang) => `<url><loc>https://bhubingpalace.com/${lang}/</loc></url>`).join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
