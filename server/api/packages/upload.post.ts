export default defineEventHandler(() => {
  throw createError({ statusCode: 410, message: 'Копирование PKG отключено. Выберите папку или укажите путь — файлы останутся на месте.' })
})
