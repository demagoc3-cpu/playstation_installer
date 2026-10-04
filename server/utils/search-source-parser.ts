import { load } from 'cheerio'
import type { SearchDetails } from '../../shared/types/search'

export function publicWebUrl(value: string, base?: string) {
  if (!value.trim()) return undefined
  try {
    const url = new URL(value, base)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined
    if ([...url.searchParams.keys()].some(key => /^(apikey|api_key|token|passkey|auth)$/i.test(key))) return undefined
    return url.toString()
  } catch { return undefined }
}

export function htmlText(html: string, limit = 24000) {
  const $ = load(html)
  $('script, style, iframe, form, noscript, svg, button').remove()
  $('br, hr').replaceWith('\n')
  $('p, div, li, h1, h2, h3, h4, tr').append('\n')
  return $.root().text().replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit)
}

export function parseSearchSource(html: string, pageUrl: string): SearchDetails {
  const $ = load(html)
  const post = $('.post_body, .postbody, .message-body').first()
  const ogImage = $('meta[property="og:image"]').attr('content')
  const postImage = post.find('img.postImgAligned, img.postImg, img').first()
  const lazyImage = post.find('var.postImg').first().attr('title')
  const cover = publicWebUrl(postImage.attr('src') || postImage.attr('data-src') || lazyImage || ogImage || '', pageUrl)
  let description: string | undefined
  if (post.length) {
    post.find('.sp-wrap').each((_, el) => {
      if (/скриншот|screenshots|видео|video/i.test($(el).find('.sp-head').first().text())) $(el).remove()
    })
    description = htmlText(post.html() || '') || undefined
  } else {
    description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '').trim().slice(0, 24000) || undefined
    // Login and challenge pages often have generic metadata, not release details.
    if (/captcha|cloudflare|just a moment|вход|авторизац|login|sign in/i.test($('title').text())) return { status: 'unavailable', fields: [], message: 'Источник требует входа или временно недоступен. Откройте страницу раздачи.' }
  }
  const fields: SearchDetails['fields'] = []
  const labels = ['Год выпуска', 'Жанр', 'Разработчик', 'Издательство', 'Код диска', 'Регион', 'Версия игры', 'Минимальная версия прошивки', 'Язык интерфейса игры', 'Язык озвучки', 'Перевод', 'Мультиплеер']
  for (const label of labels) {
    const match = description?.match(new RegExp(`(?:^|\n)${label}\\s*:\\s*([^\n]+)`))
    if (match) fields.push({ label, value: match[1]!.trim().slice(0, 500) })
  }
  // The structured release facts are shown separately from the synopsis.
  const synopsis = description?.match(/(?:^|\n)Описание\s*:\s*([\s\S]+)/i)?.[1]?.trim()
  return description || cover ? { status: 'available', description: synopsis || description, cover, fields } : { status: 'unavailable', fields: [], message: 'Источник не передал описание и обложку. Данные раздачи доступны ниже.' }
}
