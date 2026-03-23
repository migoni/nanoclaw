import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { transcribeAudio } from '../transcription.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts, OnAutoRegister } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Thread ID for the "main" topic in the forum group (from env). */
const MAIN_TOPIC_THREAD_ID: number | undefined = (() => {
  const envVars = readEnvFile(['TELEGRAM_MAIN_TOPIC_THREAD_ID']);
  const raw =
    process.env.TELEGRAM_MAIN_TOPIC_THREAD_ID ||
    envVars.TELEGRAM_MAIN_TOPIC_THREAD_ID ||
    '';
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
})();

/**
 * Case-insensitive regex that matches the assistant's name in Latin and Cyrillic.
 * Uses (?<!\w) and (?!\w) with the Unicode flag for proper word boundaries
 * with Cyrillic characters (JS \b only works with ASCII).
 */
const NAME_MENTION_PATTERN = new RegExp(
  `(?<=^|[^\\p{L}\\p{N}])(?:${ASSISTANT_NAME}|Томас)(?=[^\\p{L}\\p{N}]|$)`,
  'iu',
);

// ---------------------------------------------------------------------------
// JID helpers
// ---------------------------------------------------------------------------

/** Parse a Telegram JID into chatId and optional threadId. */
export function parseTelegramJid(jid: string): {
  chatId: string;
  threadId: number | undefined;
} {
  // Format: tg:CHATID or tg:CHATID:THREADID
  const withoutPrefix = jid.replace(/^tg:/, '');
  const colonIdx = withoutPrefix.lastIndexOf(':');
  // Chat IDs can be negative (e.g. -1003740826206), so we need to check
  // if the part after the last colon is a pure positive integer (thread ID).
  if (colonIdx > 0) {
    const possibleThread = withoutPrefix.slice(colonIdx + 1);
    if (/^\d+$/.test(possibleThread)) {
      return {
        chatId: withoutPrefix.slice(0, colonIdx),
        threadId: parseInt(possibleThread, 10),
      };
    }
  }
  return { chatId: withoutPrefix, threadId: undefined };
}

/** Get the base (parent group) JID without thread component. */
export function baseJid(jid: string): string {
  const { chatId } = parseTelegramJid(jid);
  return `tg:${chatId}`;
}

/** Build a Telegram JID, optionally with a thread ID. */
export function buildTelegramJid(
  chatId: string | number,
  threadId?: number,
): string {
  if (threadId !== undefined) return `tg:${chatId}:${threadId}`;
  return `tg:${chatId}`;
}

/**
 * Sanitize a topic name into a safe folder name.
 * Lowercase, replace non-alphanumeric with dashes, collapse runs, trim dashes.
 */
export function sanitizeFolderName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'topic'
  );
}

// ---------------------------------------------------------------------------

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onAutoRegister: OnAutoRegister;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Look up a group by exact JID. If not found and the JID has a thread
   * component, check the parent group and auto-register a new topic group.
   */
  private findOrAutoRegister(
    jid: string,
    topicName?: string,
  ): RegisteredGroup | undefined {
    const groups = this.opts.registeredGroups();

    // 1. Exact match
    if (groups[jid]) return groups[jid];

    // 2. If jid has a thread component, try parent group for auto-registration
    const { chatId, threadId } = parseTelegramJid(jid);
    if (threadId === undefined) return undefined;

    const parentJid = `tg:${chatId}`;
    const parent = groups[parentJid];
    if (!parent) return undefined;

    // Auto-register this topic as a new group
    const folderSuffix = topicName
      ? sanitizeFolderName(topicName)
      : `topic-${threadId}`;
    const folder = `${parent.folder}-${folderSuffix}`;
    const displayName = topicName
      ? `${parent.name} / ${topicName}`
      : `${parent.name} / Topic ${threadId}`;

    const isMainTopic =
      MAIN_TOPIC_THREAD_ID !== undefined && threadId === MAIN_TOPIC_THREAD_ID;

    const newGroup: RegisteredGroup = {
      name: displayName,
      folder,
      trigger: parent.trigger,
      added_at: new Date().toISOString(),
      containerConfig: parent.containerConfig,
      requiresTrigger: isMainTopic ? false : true,
      isMain: isMainTopic ? true : undefined,
    };

    this.opts.onAutoRegister(jid, newGroup);
    logger.info(
      { jid, folder, topicName, isMainTopic },
      'Auto-registered forum topic',
    );

    return newGroup;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const threadId = (ctx.message as any)?.message_thread_id;
      const jid = buildTelegramJid(chatId, threadId);

      ctx.reply(
        `Chat ID: \`${jid}\`\nName: ${chatName}\nType: ${chatType}${threadId ? `\nThread: ${threadId}` : ''}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      // --- Topic-aware JID ---
      const threadId = (ctx.message as any).message_thread_id as
        | number
        | undefined;
      const chatJid = buildTelegramJid(ctx.chat.id, threadId);
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat / topic name
      const groupTitle =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Extract topic name from the linked forum_topic_created service message
      const topicName: string | undefined = (ctx.message as any)
        ?.reply_to_message?.forum_topic_created?.name;
      const chatName = topicName ? `${groupTitle} / ${topicName}` : groupTitle;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // For non-main topics/groups: detect name mentions and translate to trigger format
      const isMainTopic =
        MAIN_TOPIC_THREAD_ID !== undefined && threadId === MAIN_TOPIC_THREAD_ID;
      if (
        !isMainTopic &&
        !TRIGGER_PATTERN.test(content) &&
        NAME_MENTION_PATTERN.test(content)
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Store chat metadata for both base group and topic JIDs (FK satisfaction)
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const baseGroupJid = baseJid(chatJid);
      if (baseGroupJid !== chatJid) {
        // Ensure parent group chat entry exists for FK
        this.opts.onChatMetadata(
          baseGroupJid,
          timestamp,
          groupTitle,
          'telegram',
          isGroup,
        );
      }
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups (with auto-registration)
      const group = this.findOrAutoRegister(chatJid, topicName);
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // For non-main topics/groups, only respond if trigger is present
      if (
        !isMainTopic &&
        group.requiresTrigger !== false &&
        !TRIGGER_PATTERN.test(content.trim())
      ) {
        // Store the message but don't trigger bot — it will be picked up
        // as context when a trigger eventually arrives
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
        logger.debug(
          { chatJid, chatName, sender: senderName },
          'Non-main topic message stored (no trigger)',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      // --- Topic-aware JID ---
      const threadId = ctx.message?.message_thread_id as number | undefined;
      const chatJid = buildTelegramJid(ctx.chat.id, threadId);

      const topicName: string | undefined =
        ctx.message?.reply_to_message?.forum_topic_created?.name;

      const group = this.findOrAutoRegister(chatJid, topicName);
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const baseGroupJid = baseJid(chatJid);
      if (baseGroupJid !== chatJid) {
        const groupTitle = (ctx.chat as any).title || chatJid;
        this.opts.onChatMetadata(
          baseGroupJid,
          timestamp,
          groupTitle,
          'telegram',
          isGroup,
        );
      }
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // Helper: download a Telegram file to a destination path
    const downloadFile = async (fileId: string, destPath: string): Promise<void> => {
      const file = await this.bot!.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(destPath);
        https.get(fileUrl, (res) => {
          res.pipe(out);
          out.on('finish', () => { out.close(); resolve(); });
        }).on('error', reject);
      });
    };

    // Helper: resolve the media dir for a group JID, returns null if group not found
    const getMediaDir = (chatJid: string): string | null => {
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) return null;
      const mediaDir = path.join(resolveGroupFolderPath(group.folder), 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      return mediaDir;
    };

    this.bot.on('message:photo', async (ctx) => {
      const threadId = (ctx.message as any).message_thread_id as number | undefined;
      const chatJid = buildTelegramJid(ctx.chat.id, threadId);
      const mediaDir = getMediaDir(chatJid);
      if (!mediaDir) {
        storeNonText(ctx, '[Photo]');
        return;
      }
      try {
        // Pick the largest available photo size
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const ext = 'jpg';
        const filename = `photo-${Date.now()}.${ext}`;
        const destPath = path.join(mediaDir, filename);
        await downloadFile(photo.file_id, destPath);
        const containerPath = `/workspace/group/media/${filename}`;
        storeNonText(ctx, `[Photo: ${containerPath}]`);
      } catch (err) {
        logger.warn({ err }, 'Failed to download Telegram photo, using placeholder');
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      try {
        // Download the voice file from Telegram
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const tmpPath = path.join(os.tmpdir(), `tg-voice-${Date.now()}.ogg`);

        // Download to temp file
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(tmpPath);
          https
            .get(fileUrl, (res) => {
              res.pipe(out);
              out.on('finish', () => {
                out.close();
                resolve();
              });
            })
            .on('error', reject);
        });

        // Transcribe
        const transcript = await transcribeAudio(tmpPath);

        // Clean up
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }

        if (transcript) {
          // Send transcription preview to the chat
          const threadId = (ctx.message as any).message_thread_id as
            | number
            | undefined;
          const chatJid = buildTelegramJid(ctx.chat.id, threadId);
          const { chatId, threadId: tid } = parseTelegramJid(chatJid);
          const threadOpts =
            tid !== undefined ? { message_thread_id: tid } : {};
          await sendTelegramMessage(
            this.bot!.api,
            chatId,
            `🎙 _${transcript}_`,
            threadOpts,
          );

          // Voice messages are intentional interactions — always trigger the bot
          storeNonText(ctx, `@${ASSISTANT_NAME} [Voice: ${transcript}]`);
        } else {
          storeNonText(
            ctx,
            `@${ASSISTANT_NAME} [Voice message - transcription unavailable]`,
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to process Telegram voice message');
        storeNonText(ctx, '[Voice message - transcription failed]');
      }
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
      const threadId = (ctx.message as any).message_thread_id as number | undefined;
      const chatJid = buildTelegramJid(ctx.chat.id, threadId);
      const originalName = ctx.message.document?.file_name || 'file';
      const mediaDir = getMediaDir(chatJid);
      if (!mediaDir) {
        storeNonText(ctx, `[Document: ${originalName}]`);
        return;
      }
      try {
        const fileId = ctx.message.document!.file_id;
        // Prefix with timestamp to avoid collisions
        const filename = `${Date.now()}-${originalName}`;
        const destPath = path.join(mediaDir, filename);
        await downloadFile(fileId, destPath);
        const containerPath = `/workspace/group/media/${filename}`;
        storeNonText(ctx, `[Document: ${originalName} — ${containerPath}]`);
      } catch (err) {
        logger.warn({ err, name: originalName }, 'Failed to download Telegram document, using placeholder');
        storeNonText(ctx, `[Document: ${originalName}]`);
      }
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId } = parseTelegramJid(jid);
      const options: { message_thread_id?: number } = {};
      if (threadId !== undefined) options.message_thread_id = threadId;

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, chatId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            chatId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId, threadId } = parseTelegramJid(jid);
      await this.bot.api.sendChatAction(
        chatId,
        'typing',
        threadId !== undefined ? { message_thread_id: threadId } : undefined,
      );
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
