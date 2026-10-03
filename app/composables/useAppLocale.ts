import { translateText, type AppLocale } from '../utils/localization'

export function useAppLocale() {
  const cookie = useCookie<AppLocale>('packageflow-language', { default: () => 'ru', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax', path: '/' })
  const locale = useState<AppLocale>('packageflow-language', () => cookie.value === 'en' ? 'en' : 'ru')
  const formatLocale = computed(() => locale.value === 'en' ? 'en-US' : 'ru-RU')
  function setLocale(value: AppLocale) { locale.value = value; cookie.value = value }
  function t(value: unknown) { return translateText(value, locale.value) }
  return { locale, formatLocale, setLocale, t }
}
