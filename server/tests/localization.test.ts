import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translateText } from '../../app/utils/localization.ts'
import english from '../../app/locales/en.json' with { type: 'json' }

test('Russian is preserved and English covers labels and package types', () => {
  assert.equal(translateText('Очередь установки', 'ru'), 'Очередь установки')
  assert.equal(translateText('Очередь установки', 'en'), 'Installation queue')
  assert.equal(translateText('Бэкпорт', 'en'), 'Backport')
  assert.equal(translateText('512 КБ', 'en'), '512 KB')
})

test('saved API results translate with their counters and error codes intact', () => {
  assert.equal(translateText('Ошибка установки PKG на PS4: 0x80990004', 'en'), 'PS4 PKG installation error: 0x80990004')
  assert.equal(translateText('Очередь завершена: PS4 подтвердила 0 пак., с ошибкой — 2, без подтверждения — 3, пропущено — 0. Причины указаны у пакетов.', 'en'),
    'Queue completed: PS4 confirmed 0 packages, failed — 2, unconfirmed — 3, skipped — 0. Reasons are shown next to packages.')
  assert.equal(translateText('Перенос в корзину · Завершено', 'en'), 'Moving to trash · Completed')
  assert.equal(translateText('POST /api/ps4/files/install → 400 Этот тип PKG нельзя установить через файловый менеджер', 'en'),
    'POST /api/ps4/files/install → 400 This PKG type cannot be installed through the file manager')
})

test('unknown messages and user file data are not guessed or rewritten', () => {
  for (const value of ['Пример.txt', '/data/Мои игры/Игра.pkg', 'TRMH7kJxydeBxjbyu2FRmraoDzkx6mRa9v', 'Unknown diagnostic 0xDEADBEEF', 'Неизвестный ответ демона CE-36244-9']) {
    assert.equal(translateText(value, 'en'), value)
  }
  assert.equal(translateText('Просканирована папка /data/Мои игры: найдено пакетов — 5', 'en'), 'Folder /data/Мои игры scanned: 5 packages found')
})

test('translation placeholders retain all source fields', () => {
  const fields = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort()
  for (const [source, target] of Object.entries(english)) {
    assert.ok(target.trim(), source)
    assert.deepEqual(fields(target), fields(source), source)
  }
})
