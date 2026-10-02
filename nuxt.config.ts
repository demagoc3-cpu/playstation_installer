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
        // Wallets for "Поддержать". Empty addresses hide the corresponding cards.
        // Runtime overrides: NUXT_PUBLIC_DONATION_BTC / NUXT_PUBLIC_DONATION_USDT_TRC20.
        btc: '17jXaJmM4jki1gwQmzo4ep9U4Sb6iiZXWG',
        usdtTrc20: 'TRMH7kJxydeBxjbyu2FRmraoDzkx6mRa9v'
      }
    }
  },
  nitro: {
    routeRules: {
      '/api/packages/file': { cors: true }
    }
  }
})
