"use strict";

const fs = require("fs");
const path = require("path");
const { request } = require("undici"); // built‑in in Node 18+, but we'll use fetch with timeout
const LOTTIE_FORMAT = 3;

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Persistence helpers (by name) ──────────────────────────────────────
function getPersistedEmojiNames(targetGuildId) {
  const file = path.join(DATA_DIR, `transferred_emojis_${targetGuildId}.json`);
  if (!fs.existsSync(file)) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(
      `[transferemotes] Loaded ${arr.length} persisted emoji names from ${file}`,
    );
    return new Set(arr);
  } catch (err) {
    console.error(
      `[transferemotes] Failed to load persisted emoji names: ${err.message}`,
    );
    return new Set();
  }
}

function savePersistedEmojiNames(targetGuildId, nameSet) {
  const file = path.join(DATA_DIR, `transferred_emojis_${targetGuildId}.json`);
  const arr = [...nameSet].sort();
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8");
  console.log(`[transferemotes] Saved ${arr.length} emoji names to ${file}`);
}

function getPersistedStickerNames(targetGuildId) {
  const file = path.join(
    DATA_DIR,
    `transferred_stickers_${targetGuildId}.json`,
  );
  if (!fs.existsSync(file)) return new Set();
  try {
    const arr = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(
      `[transferemotes] Loaded ${arr.length} persisted sticker names from ${file}`,
    );
    return new Set(arr);
  } catch (err) {
    console.error(
      `[transferemotes] Failed to load persisted sticker names: ${err.message}`,
    );
    return new Set();
  }
}

function savePersistedStickerNames(targetGuildId, nameSet) {
  const file = path.join(
    DATA_DIR,
    `transferred_stickers_${targetGuildId}.json`,
  );
  const arr = [...nameSet].sort();
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8");
  console.log(`[transferemotes] Saved ${arr.length} sticker names to ${file}`);
}

// ─── Helper: fetch image with timeout ───────────────────────────────────
async function fetchImageAsBuffer(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    console.log(`[transferemotes] Downloading image from ${url}`);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    console.log(`[transferemotes] Downloaded ${buffer.length} bytes`);
    return buffer;
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Image download failed: ${err.message}`);
  }
}

// ─── Helper: promise with timeout ───────────────────────────────────────
function withTimeout(promise, ms, name) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Operation timed out after ${ms}ms: ${name}`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeoutId),
  );
}

// ─── Main transfer function ─────────────────────────────────────────────
async function executeTransferEmotes(client, opts) {
  let { sourceGuildId, targetGuildId, staffName, staffId, replyTarget, type } =
    opts;
  if (!type) type = "both";

  console.log(
    `[transferemotes] Called with source=${sourceGuildId} target=${targetGuildId} type=${type}`,
  );

  if (!["emojis", "stickers", "both"].includes(type)) {
    throw new Error(
      `Invalid transfer type: ${type}. Use emojis, stickers, or both.`,
    );
  }

  const isInteraction =
    replyTarget && typeof replyTarget.deferReply === "function";
  if (isInteraction && !replyTarget.deferred && !replyTarget.replied) {
    console.log(`[transferemotes] Deferring interaction reply...`);
    await replyTarget.deferReply();
  }

  const reply = (content) => {
    if (replyTarget.deferred || replyTarget.replied) {
      return replyTarget.editReply(content);
    }
    return replyTarget.reply(content);
  };

  console.log(`[transferemotes] Resolving guilds...`);
  const sourceGuild = client.guilds.cache.get(sourceGuildId);
  const targetGuild = client.guilds.cache.get(targetGuildId);

  if (!sourceGuild)
    return reply(
      `❌ Source guild \`${sourceGuildId}\` not found — is the bot in that server?`,
    );
  if (!targetGuild)
    return reply(
      `❌ Target guild \`${targetGuildId}\` not found — is the bot in that server?`,
    );
  if (sourceGuildId === targetGuildId)
    return reply("❌ Source and target guilds must be different.");

  console.log(
    `[transferemotes] Source guild: ${sourceGuild.name} (${sourceGuild.id})`,
  );
  console.log(
    `[transferemotes] Target guild: ${targetGuild.name} (${targetGuild.id})`,
  );

  const progress = await reply(
    `⏳ Starting transfer (${type}) from **${sourceGuild.name}** → **${targetGuild.name}**…`,
  );
  const edit = (content) => {
    if (replyTarget.deferred || replyTarget.replied) {
      return replyTarget.editReply(content);
    }
    return progress?.edit?.(content);
  };

  // Fetch source assets
  let sourceEmojis = new Map(),
    sourceStickers = new Map();
  try {
    if (type === "emojis" || type === "both") {
      console.log(`[transferemotes] Fetching source emojis...`);
      sourceEmojis = await sourceGuild.emojis.fetch();
      console.log(
        `[transferemotes] Fetched ${sourceEmojis.size} emojis from source`,
      );
    }
    if (type === "stickers" || type === "both") {
      console.log(`[transferemotes] Fetching source stickers...`);
      sourceStickers = await sourceGuild.stickers.fetch();
      console.log(
        `[transferemotes] Fetched ${sourceStickers.size} stickers from source`,
      );
    }
  } catch (err) {
    return edit(`❌ Failed to fetch assets from source guild: ${err.message}`);
  }

  // Fetch target assets (to seed names and also for existence checks)
  let targetEmojis = new Map(),
    targetStickers = new Map();
  try {
    if (type === "emojis" || type === "both") {
      console.log(`[transferemotes] Fetching target emojis...`);
      targetEmojis = await targetGuild.emojis.fetch();
      console.log(
        `[transferemotes] Fetched ${targetEmojis.size} emojis from target`,
      );
    }
    if (type === "stickers" || type === "both") {
      console.log(`[transferemotes] Fetching target stickers...`);
      targetStickers = await targetGuild.stickers.fetch();
      console.log(
        `[transferemotes] Fetched ${targetStickers.size} stickers from target`,
      );
    }
  } catch (err) {
    return edit(`❌ Failed to fetch assets from target guild: ${err.message}`);
  }

  // Build a case‑insensitive name map for target emojis (to check exact name collisions)
  const targetEmojiNameMap = new Map();
  for (const emoji of targetEmojis.values()) {
    targetEmojiNameMap.set(emoji.name.toLowerCase(), emoji.name); // store original case
  }

  // Seed persisted names from current target assets
  const persistedEmojiNames = getPersistedEmojiNames(targetGuildId);
  let addedExistingEmojis = 0;
  for (const emoji of targetEmojis.values()) {
    const lower = emoji.name.toLowerCase();
    if (!persistedEmojiNames.has(lower)) {
      persistedEmojiNames.add(lower);
      addedExistingEmojis++;
    }
  }
  if (addedExistingEmojis > 0)
    savePersistedEmojiNames(targetGuildId, persistedEmojiNames);

  const persistedStickerNames = getPersistedStickerNames(targetGuildId);
  let addedExistingStickers = 0;
  for (const sticker of targetStickers.values()) {
    const lower = sticker.name.toLowerCase();
    if (!persistedStickerNames.has(lower)) {
      persistedStickerNames.add(lower);
      addedExistingStickers++;
    }
  }
  if (addedExistingStickers > 0)
    savePersistedStickerNames(targetGuildId, persistedStickerNames);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function withRateLimit(fn, actionName) {
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const isRateLimit =
          err.status === 429 ||
          err.code === 429 ||
          (err.message && err.message.includes("rate limit"));
        if (isRateLimit && attempt < MAX_RETRIES) {
          const wait = err.retryAfter ?? 10_000;
          console.warn(
            `[transferemotes] Rate limited on ${actionName} — waiting ${Math.ceil(wait / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await sleep(wait + 500);
        } else {
          throw err;
        }
      }
    }
  }

  let lastProgressEdit = 0;
  async function editProgress(content) {
    const now = Date.now();
    if (now - lastProgressEdit < 4_000) return;
    lastProgressEdit = now;
    console.log(
      `[transferemotes] Progress update: ${content.replace(/\n/g, " ")}`,
    );
    await edit(content).catch((e) =>
      console.error(`[transferemotes] Failed to edit progress: ${e.message}`),
    );
  }

  // ─── TRANSFER EMOJIS ─────────────────────────────────────────────────────
  const emojiResults = { added: [], skipped: [], failed: [] };
  const emojiList = [...sourceEmojis.values()];
  const emojiTotal = emojiList.filter(
    (e) => !persistedEmojiNames.has(e.name.toLowerCase()),
  ).length;
  console.log(
    `[transferemotes] Emojis to process: ${emojiTotal} out of ${emojiList.length} total source emojis`,
  );

  if ((type === "emojis" || type === "both") && emojiTotal > 0) {
    console.log(`[transferemotes] Starting emoji transfer loop...`);
    for (let idx = 0; idx < emojiList.length; idx++) {
      const emoji = emojiList[idx];
      const lowerName = emoji.name.toLowerCase();
      if (persistedEmojiNames.has(lowerName)) {
        console.log(
          `[transferemotes] Skipping emoji ${emoji.name} - name already persisted`,
        );
        emojiResults.skipped.push(`${emoji.name} (name exists)`);
        continue;
      }

      // Additional check: if exact name (case‑sensitive) already exists in target, skip to avoid API error
      if (targetEmojiNameMap.has(lowerName)) {
        console.log(
          `[transferemotes] Skipping emoji ${emoji.name} - exact name already in target guild (${targetEmojiNameMap.get(lowerName)})`,
        );
        emojiResults.skipped.push(
          `${emoji.name} (already in target with same name)`,
        );
        // Also add to persisted set so we don't try again later
        persistedEmojiNames.add(lowerName);
        savePersistedEmojiNames(targetGuildId, persistedEmojiNames);
        continue;
      }

      const ext = emoji.animated ? "gif" : "png";
      const url = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
      console.log(`[transferemotes] Adding emoji ${emoji.name} from ${url}`);

      try {
        // Download image as buffer first
        const imageBuffer = await fetchImageAsBuffer(url, 15000);

        // Create emoji using file buffer
        const createPromise = withRateLimit(
          () =>
            targetGuild.emojis.create({
              attachment: imageBuffer,
              name: emoji.name,
              reason: `Transferred by ${staffName} (${staffId})`,
            }),
          `create emoji ${emoji.name}`,
        );
        await withTimeout(createPromise, 60000, `Emoji ${emoji.name}`);

        console.log(`[transferemotes] ✅ Added emoji ${emoji.name}`);
        emojiResults.added.push(emoji.name);
        persistedEmojiNames.add(lowerName);
        savePersistedEmojiNames(targetGuildId, persistedEmojiNames);
      } catch (err) {
        console.error(
          `[transferemotes] ❌ Failed to add emoji ${emoji.name}: ${err.message}`,
        );
        emojiResults.failed.push(`${emoji.name} (${err.message})`);
      }

      await editProgress(
        `⏳ Transferring emojis… **${emojiResults.added.length}/${emojiTotal}** done` +
          (emojiResults.failed.length
            ? ` · ${emojiResults.failed.length} failed`
            : ""),
      );
      console.log(
        `[transferemotes] Sleeping 1.2s after emoji ${idx + 1}/${emojiList.length}`,
      );
      await sleep(1_200);
    }
  }

  // ─── TRANSFER STICKERS (similar) ────────────────────────────────────────
  const stickerResults = { added: [], skipped: [], failed: [] };
  const stickerList = [...sourceStickers.values()];
  const stickerTotal = stickerList.filter(
    (s) =>
      s.format !== LOTTIE_FORMAT &&
      !persistedStickerNames.has(s.name.toLowerCase()),
  ).length;
  console.log(
    `[transferemotes] Stickers to process: ${stickerTotal} out of ${stickerList.length} total source stickers`,
  );

  if ((type === "stickers" || type === "both") && stickerTotal > 0) {
    console.log(`[transferemotes] Starting sticker transfer loop...`);
    for (let idx = 0; idx < stickerList.length; idx++) {
      const sticker = stickerList[idx];
      const lowerName = sticker.name.toLowerCase();
      if (sticker.format === LOTTIE_FORMAT) {
        stickerResults.skipped.push(`${sticker.name} (Lottie — unsupported)`);
        continue;
      }
      if (persistedStickerNames.has(lowerName)) {
        console.log(
          `[transferemotes] Skipping sticker ${sticker.name} - name already persisted`,
        );
        stickerResults.skipped.push(`${sticker.name} (name exists)`);
        continue;
      }
      const ext = sticker.format === 4 ? "gif" : "png";
      const url = `https://cdn.discordapp.com/stickers/${sticker.id}.${ext}`;
      console.log(
        `[transferemotes] Adding sticker ${sticker.name} from ${url}`,
      );
      try {
        const stickerBuffer = await fetchImageAsBuffer(url, 15000);
        const createPromise = withRateLimit(
          () =>
            targetGuild.stickers.create({
              file: stickerBuffer,
              name: sticker.name,
              tags: sticker.tags || sticker.name.slice(0, 200),
              description: sticker.description || "",
              reason: `Transferred by ${staffName} (${staffId})`,
            }),
          `create sticker ${sticker.name}`,
        );
        await withTimeout(createPromise, 60000, `Sticker ${sticker.name}`);
        console.log(`[transferemotes] ✅ Added sticker ${sticker.name}`);
        stickerResults.added.push(sticker.name);
        persistedStickerNames.add(lowerName);
        savePersistedStickerNames(targetGuildId, persistedStickerNames);
      } catch (err) {
        console.error(
          `[transferemotes] ❌ Failed to add sticker ${sticker.name}: ${err.message}`,
        );
        stickerResults.failed.push(`${sticker.name} (${err.message})`);
      }
      await editProgress(
        `⏳ Emojis done ✅ — transferring stickers… **${stickerResults.added.length}/${stickerTotal}** done` +
          (stickerResults.failed.length
            ? ` · ${stickerResults.failed.length} failed`
            : ""),
      );
      await sleep(1_200);
    }
  }

  // Build summary
  const lines = [
    `✅ **Transfer complete** (${type}) — **${sourceGuild.name}** → **${targetGuild.name}**`,
    "",
  ];
  if (type === "emojis" || type === "both") {
    lines.push(
      `**Emojis**`,
      `• Added: ${emojiResults.added.length}`,
      `• Skipped (name exists): ${emojiResults.skipped.length}`,
      `• Failed: ${emojiResults.failed.length}`,
    );
    if (emojiResults.failed.length) {
      lines.push(
        `  ↳ ${emojiResults.failed.slice(0, 5).join(", ")}${emojiResults.failed.length > 5 ? ` (+${emojiResults.failed.length - 5} more)` : ""}`,
      );
    }
    lines.push("");
  }
  if (type === "stickers" || type === "both") {
    lines.push(
      `**Stickers**`,
      `• Added: ${stickerResults.added.length}`,
      `• Skipped (name exists or Lottie): ${stickerResults.skipped.length}`,
      `• Failed: ${stickerResults.failed.length}`,
    );
    if (stickerResults.failed.length) {
      lines.push(
        `  ↳ ${stickerResults.failed.slice(0, 5).join(", ")}${stickerResults.failed.length > 5 ? ` (+${stickerResults.failed.length - 5} more)` : ""}`,
      );
    }
  }
  console.log(
    `[transferemotes] Transfer finished. Added ${emojiResults.added.length} emojis, ${stickerResults.added.length} stickers.`,
  );
  return edit(lines.join("\n"));
}

module.exports = { executeTransferEmotes };
