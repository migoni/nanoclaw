import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';
// Preferred languages for transcription (helps Whisper with short clips).
// Set via WHISPER_LANGUAGE env var, e.g. "ru" or "en". Empty = auto-detect.
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || '';

/**
 * Transcribe an audio file using local OpenAI Whisper (Python).
 * Returns the transcript text or null on failure.
 */
export async function transcribeAudio(
  audioPath: string,
): Promise<string | null> {
  try {
    // Whisper expects WAV/MP3/etc. Telegram voice messages are OGG/OPUS.
    // Convert to WAV first using ffmpeg.
    const tmpWav = path.join(
      os.tmpdir(),
      `whisper-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
    );

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-i',
          audioPath,
          '-ar',
          '16000', // 16kHz sample rate (Whisper expects this)
          '-ac',
          '1', // mono
          '-y', // overwrite
          tmpWav,
        ],
        { timeout: 30000 },
      );
    } catch (err) {
      logger.error({ err, audioPath }, 'ffmpeg conversion failed');
      return null;
    }

    // Run whisper transcription.
    // Two-pass: first detect language, then transcribe with the detected language
    // constrained to supported languages only (prevents misdetection on short clips).
    const supportedLangs = (WHISPER_LANGUAGE || 'en,ru')
      .split(',')
      .map((l) => l.trim());
    const { stdout } = await execFileAsync(
      'python3',
      [
        '-c',
        `import whisper, json
model = whisper.load_model("${WHISPER_MODEL}")
audio = whisper.load_audio("${tmpWav.replace(/"/g, '\\"')}")
audio_trimmed = whisper.pad_or_trim(audio)
mel = whisper.log_mel_spectrogram(audio_trimmed).to(model.device)
_, probs = model.detect_language(mel)
supported = ${JSON.stringify(supportedLangs)}
best = max(supported, key=lambda l: probs.get(l, 0))
result = model.transcribe("${tmpWav.replace(/"/g, '\\"')}", language=best)
print(json.dumps({"text": result["text"].strip(), "language": best}))`,
      ],
      { timeout: 120000 },
    ); // 2 min timeout for transcription

    // Clean up temp file
    try {
      fs.unlinkSync(tmpWav);
    } catch {
      /* ignore */
    }

    const result = JSON.parse(stdout.trim());
    logger.info(
      { language: result.language, length: result.text.length },
      'Transcribed voice message',
    );
    return result.text || null;
  } catch (err) {
    logger.error({ err, audioPath }, 'Whisper transcription failed');
    return null;
  }
}
