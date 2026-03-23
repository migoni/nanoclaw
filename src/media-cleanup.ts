import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete media files older than 30 days from all group media directories.
 * Only touches `{group}/media/` subdirectories — never the group root.
 */
export function cleanOldMediaFiles(): void {
  const now = Date.now();
  let deleted = 0;
  let errors = 0;

  let groupEntries: string[];
  try {
    groupEntries = fs.readdirSync(GROUPS_DIR);
  } catch {
    return; // GROUPS_DIR doesn't exist yet — nothing to clean
  }

  for (const groupFolder of groupEntries) {
    const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
    if (!fs.existsSync(mediaDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(mediaDir);
    } catch (err) {
      logger.warn({ err, mediaDir }, 'Media cleanup: failed to read directory');
      errors++;
      continue;
    }

    for (const file of files) {
      const filePath = path.join(mediaDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs > THIRTY_DAYS_MS) {
          fs.unlinkSync(filePath);
          deleted++;
          logger.debug({ filePath }, 'Media cleanup: deleted old file');
        }
      } catch (err) {
        logger.warn({ err, filePath }, 'Media cleanup: failed to delete file');
        errors++;
      }
    }
  }

  if (deleted > 0 || errors > 0) {
    logger.info({ deleted, errors }, 'Media cleanup complete');
  }
}

/**
 * Run media cleanup once immediately, then every 24 hours.
 */
export function startMediaCleanup(): void {
  cleanOldMediaFiles();
  setInterval(cleanOldMediaFiles, CLEANUP_INTERVAL_MS).unref();
}
