// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  app: {
    head: {
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }]
    }
  },
  devServer: {
    host: '0.0.0.0'
  },
  runtimeConfig: {
    public: {
      donation: {
        // Bitcoin address for the "Поддержать" section. Empty hides the section.
        // Can be overridden at runtime: NUXT_PUBLIC_DONATION_BTC=bc1...
        btc: '17jXaJmM4jki1gwQmzo4ep9U4Sb6iiZXWG'
      }
    }
  },
  nitro: {
    routeRules: {
      '/api/packages/file': { cors: true }
    }
  }
})
