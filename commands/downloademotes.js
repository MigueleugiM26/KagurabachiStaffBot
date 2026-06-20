// commands/downloademotes.js

"use strict";

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const tmp = require("tmp");
const { request } = require("undici");

ffmpeg.setFfmpegPath(ffmpegStatic);

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fsSync.existsSync(DATA_DIR))
  fsSync.mkdirSync(DATA_DIR, { recursive: true });

// Helper: fetch image with timeout (same as in transferemotes)
async function fetchBuffer(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Download failed: ${err.message}`);
  }
}

// Convert an image buffer to WebP (static or animated)
async function convertToWebP(inputBuffer, isAnimated, originalExt) {
  if (isAnimated) {
    // Animated GIF or APNG -> animated WebP via ffmpeg
    const tmpInput = tmp.fileSync({ postfix: `.${originalExt}` });
    const tmpOutput = tmp.fileSync({ postfix: ".webp" });
    await fs.writeFile(tmpInput.name, inputBuffer);
    await new Promise((resolve, reject) => {
      ffmpeg(tmpInput.name)
        .outputOptions([
          "-c:v libwebp",
          "-lossless 0",
          "-compression_level 6",
          "-q:v 70",
          "-loop 0",
          "-preset default",
          "-an", // no audio
        ])
        .output(tmpOutput.name)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });
    const result = await fs.readFile(tmpOutput.name);
    tmpInput.removeCallback();
    tmpOutput.removeCallback();
    return result;
  } else {
    // Static image -> WebP using sharp
    return await sharp(inputBuffer).webp({ quality: 85 }).toBuffer();
  }
}

// Sanitise filename
function sanitise(name) {
  return name.replace(/[^a-z0-9_\-]/gi, "_");
}

// Persistence helpers (same as transferemotes, but per guild)
function getPersistedNames(guildId, type) {
  const file = path.join(DATA_DIR, `downloaded_${type}_${guildId}.json`);
  if (!fsSync.existsSync(file)) return new Set();
  try {
    const arr = JSON.parse(fsSync.readFileSync(file, "utf8"));
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function savePersistedNames(guildId, type, nameSet) {
  const file = path.join(DATA_DIR, `downloaded_${type}_${guildId}.json`);
  const arr = [...nameSet].sort();
  fsSync.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8");
}

// Core export
async function executeDownloadEmotes(client, opts) {
  let { sourceGuildId, type, staffName, staffId, replyTarget } = opts;
  type = type || "both";

  if (!["emojis", "stickers", "both"].includes(type)) {
    throw new Error(`Invalid type: ${type}. Use emojis, stickers, or both.`);
  }

  const isInteraction =
    replyTarget && typeof replyTarget.deferReply === "function";
  if (isInteraction && !replyTarget.deferred && !replyTarget.replied) {
    await replyTarget.deferReply();
  }

  const reply = (content) => {
    if (replyTarget.deferred || replyTarget.replied) {
      return replyTarget.editReply(content);
    }
    return replyTarget.reply(content);
  };

  const sourceGuild = client.guilds.cache.get(sourceGuildId);
  if (!sourceGuild) {
    return reply(
      `❌ Guild \`${sourceGuildId}\` not found — is the bot in that server?`,
    );
  }

  // Load already-downloaded names to avoid re‑downloading
  const downloadedEmojiNames = getPersistedNames(sourceGuildId, "emojis");
  const downloadedStickerNames = getPersistedNames(sourceGuildId, "stickers");

  // Fetch source assets
  let sourceEmojis = new Map(),
    sourceStickers = new Map();
  try {
    if (type === "emojis" || type === "both") {
      sourceEmojis = await sourceGuild.emojis.fetch();
    }
    if (type === "stickers" || type === "both") {
      sourceStickers = await sourceGuild.stickers.fetch();
    }
  } catch (err) {
    return reply(`❌ Failed to fetch assets: ${err.message}`);
  }

  // Prepare lists
  const emojiList = [...sourceEmojis.values()];
  const stickerList = [...sourceStickers.values()];
  const toProcessEmojis = emojiList.filter(
    (e) => !downloadedEmojiNames.has(e.name.toLowerCase()),
  );
  const toProcessStickers = stickerList.filter(
    (s) => !downloadedStickerNames.has(s.name.toLowerCase()) && s.format !== 3,
  ); // skip Lottie

  if (
    (type === "emojis" || type === "both") &&
    toProcessEmojis.length === 0 &&
    (type === "stickers" || type === "both") &&
    toProcessStickers.length === 0
  ) {
    return reply(
      "ℹ️ No new emojis or stickers to download (already downloaded before).",
    );
  }

  // Create temp directory for this job
  const tempDir = tmp.dirSync({ prefix: "discord_download_" });
  const outputZip = path.join(tempDir.name, "emotes.zip");
  const downloadDir = path.join(tempDir.name, "files");
  await fs.mkdir(downloadDir, { recursive: true });

  let progressMsg = await reply(
    `⏳ Starting download of **${toProcessEmojis.length} emojis** and **${toProcessStickers.length} stickers**...`,
  );

  const updateProgress = async (added, total, typeName) => {
    await progressMsg
      .edit(`⏳ Downloading ${typeName}: **${added}/${total}** converted...`)
      .catch(() => {});
  };

  // Process emojis
  let emojiAdded = 0;
  for (let i = 0; i < toProcessEmojis.length; i++) {
    const emoji = toProcessEmojis[i];
    const ext = emoji.animated ? "gif" : "png";
    const url = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
    try {
      const buffer = await fetchBuffer(url);
      const isAnimated = emoji.animated || ext === "gif";
      const webpBuffer = await convertToWebP(buffer, isAnimated, ext);
      const fileName = `${sanitise(emoji.name)}.webp`;
      await fs.writeFile(path.join(downloadDir, fileName), webpBuffer);
      downloadedEmojiNames.add(emoji.name.toLowerCase());
      emojiAdded++;
      await updateProgress(emojiAdded, toProcessEmojis.length, "emojis");
    } catch (err) {
      console.error(
        `[downloademotes] Failed emoji ${emoji.name}: ${err.message}`,
      );
    }
    // Rate limit delay
    await new Promise((r) => setTimeout(r, 1200));
  }
  savePersistedNames(sourceGuildId, "emojis", downloadedEmojiNames);

  // Process stickers
  let stickerAdded = 0;
  for (let i = 0; i < toProcessStickers.length; i++) {
    const sticker = toProcessStickers[i];
    const ext = sticker.format === 4 ? "gif" : "png";
    const url = `https://cdn.discordapp.com/stickers/${sticker.id}.${ext}`;
    const isAnimated = sticker.format === 4 || ext === "gif";
    try {
      const buffer = await fetchBuffer(url);
      const webpBuffer = await convertToWebP(buffer, isAnimated, ext);
      const fileName = `${sanitise(sticker.name)}.webp`;
      await fs.writeFile(path.join(downloadDir, fileName), webpBuffer);
      downloadedStickerNames.add(sticker.name.toLowerCase());
      stickerAdded++;
      await updateProgress(stickerAdded, toProcessStickers.length, "stickers");
    } catch (err) {
      console.error(
        `[downloademotes] Failed sticker ${sticker.name}: ${err.message}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  savePersistedNames(sourceGuildId, "stickers", downloadedStickerNames);

  if (emojiAdded === 0 && stickerAdded === 0) {
    await progressMsg.edit("❌ No assets could be downloaded (all failed).");
    tempDir.removeCallback();
    return;
  }

  // Create ZIP using adm-zip
  await progressMsg.edit(
    `📦 Creating ZIP archive (${emojiAdded} emojis, ${stickerAdded} stickers)...`,
  );
  const zip = new AdmZip();
  zip.addLocalFolder(downloadDir);
  const zipBuffer = zip.toBuffer();

  // Send the ZIP file
  await progressMsg.edit({
    content: `✅ **Download complete** – **${sourceGuild.name}**\n📦 **${emojiAdded} emojis** · **${stickerAdded} stickers**`,
    files: [{ attachment: zipBuffer, name: `${sourceGuild.name}_emotes.zip` }],
  });

  // Cleanup
  try {
    await fs.rm(tempDir.name, { recursive: true, force: true });
  } catch (err) {
    console.error(
      `[downloademotes] Failed to clean up temp dir: ${err.message}`,
    );
  }
}

module.exports = { executeDownloadEmotes };
