/**
 * Автобэкап SQLite БД бота.
 *
 * Стратегия:
 *   1. VACUUM INTO — атомарный SQLite snapshot. Это правильный способ
 *      бэкапить активную БД: SQLite сам гарантирует консистентность,
 *      а простой fs.copyFileSync рискует получить corrupt-файл если
 *      попадёт между write-транзакциями.
 *   2. gzip сверху — bot.db обычно сжимается в 5-10 раз (много текста
 *      в JSON-полях типа infoCache).
 *   3. Локальная папка ./backups — последние 7 дней, потом авточистка.
 *      Бэкапы старше 7 дней есть в TG-чате админа (TG не удаляет
 *      файлы), так что локально хранить дольше нет смысла.
 *
 * Защита от concurrent: in-memory флаг backupInProgress. Если кто-то
 * (cron + админ через /backup одновременно) пытается параллельно —
 * второй вызов сразу падает с понятной ошибкой, не корраптя файл.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { db } from './db';

const gzipAsync = promisify(zlib.gzip);

/**
 * Папка для локальных бэкапов. Резолвим относительно cwd процесса —
 * на VPS это /opt/setpow-bot, поэтому /opt/setpow-bot/backups/.
 * Не делаем env-переменную: для одного бота это overengineering,
 * один путь всегда.
 */
const BACKUP_DIR = path.resolve('./backups');

/** Сколько дней хранить локальные бэкапы. */
const RETAIN_DAYS = 7;

/**
 * Защита от параллельных бэкапов. VACUUM INTO держит read-lock на
 * исходной БД, и параллельный VACUUM INTO в тот же файл может
 * отказать или дать частичный результат. Проще явно сериализовать.
 */
let backupInProgress = false;

export interface BackupResult {
  /** Полный путь к gzip-файлу на локальном диске. */
  gzPath: string;
  /** Размер сжатого файла в байтах. */
  size: number;
  /** Имя файла без пути (для caption в TG). */
  fileName: string;
}

/**
 * Создать новый бэкап. Возвращает путь к .db.gz файлу на диске.
 * Бросает Error если уже идёт другой бэкап.
 */
export async function createBackup(): Promise<BackupResult> {
  if (backupInProgress) {
    throw new Error('Бэкап уже выполняется, попробуй через минуту.');
  }
  backupInProgress = true;
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    // ISO-таймштамп без микросекунд и без двоеточий — безопасно для
    // имени файла на любой ОС. Пример: 2026-05-22T04-00-00
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `setpow-${ts}.db.gz`;
    const tmpDbPath = path.join(BACKUP_DIR, `setpow-${ts}.db`);
    const gzPath = path.join(BACKUP_DIR, fileName);

    // VACUUM INTO принимает только литерал, не bind-параметр.
    // SQLite ждёт одинарные кавычки для строкового литерала; внутри
    // одинарных удваиваем апостроф (классический SQL escape).
    const sqlPath = tmpDbPath.replace(/'/g, "''");
    await db.$executeRawUnsafe(`VACUUM INTO '${sqlPath}'`);

    // Читаем, сжимаем, пишем .gz, удаляем сырой .db.
    const raw = await fs.readFile(tmpDbPath);
    const gz = await gzipAsync(raw);
    await fs.writeFile(gzPath, gz);
    await fs.unlink(tmpDbPath);

    return { gzPath, size: gz.length, fileName };
  } finally {
    backupInProgress = false;
  }
}

/**
 * Удалить локальные бэкапы старше RETAIN_DAYS. Возвращает количество
 * удалённых. Не падает если папки нет (первый запуск).
 */
export async function cleanupOldBackups(): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(BACKUP_DIR);
  } catch (e) {
    // ENOENT — папки ещё нет, ничего удалять.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }

  const cutoffMs = Date.now() - RETAIN_DAYS * 86_400_000;
  let deleted = 0;
  for (const name of entries) {
    // Защита: не удаляем чужие файлы из этой папки. Только наши
    // setpow-*.db.gz.
    if (!name.startsWith('setpow-') || !name.endsWith('.db.gz')) continue;
    const fp = path.join(BACKUP_DIR, name);
    const stat = await fs.stat(fp);
    if (stat.mtimeMs < cutoffMs) {
      await fs.unlink(fp);
      deleted++;
    }
  }
  return deleted;
}

/**
 * Форматирование размера для человека: "12.3 KB" / "4.5 MB".
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
