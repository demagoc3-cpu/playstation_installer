import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { createError } from 'h3';

type Vault = Record<string, { iv: string; tag: string; data: string }>;
const file = () => dataPath('storage-secrets.json');
function vault(): Vault {
  if (!existsSync(file())) return {};
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    throw createError({
      statusCode: 503,
      message: 'Не удалось прочитать сохранённый доступ к хранилищам',
    });
  }
}
function key() {
  const path = dataPath('storage-secrets.key');
  if (!existsSync(path)) {
    if (Object.keys(vault()).length)
      throw createError({
        statusCode: 503,
        message:
          'Ключ сохранённых подключений отсутствует. Восстановите его из резервной копии данных WEB',
      });
    mkdirSync(dataPath(), { recursive: true });
    try {
      writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const value = readFileSync(path);
  if (value.length !== 32)
    throw createError({ statusCode: 503, message: 'Ключ сохранённых подключений повреждён' });
  return value;
}
export function storageHasPassword(id: string) {
  return Boolean(vault()[id]);
}
export function readStoragePassword(id: string) {
  const item = vault()[id];
  if (!item) return '';
  try {
    const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(item.iv, 'base64'));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(Buffer.from(item.tag, 'base64'));
    return Buffer.concat([
      cipher.update(Buffer.from(item.data, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw createError({
      statusCode: 503,
      message: 'Не удалось расшифровать доступ к хранилищу. Введите пароль заново',
    });
  }
}
export function writeStoragePassword(id: string, password: string | null) {
  const values = vault();
  if (password === null) delete values[id];
  else {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key(), iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    values[id] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    };
  }
  writeDurableJson(file(), values);
  if (process.platform !== 'win32') chmodSync(file(), 0o600);
}
