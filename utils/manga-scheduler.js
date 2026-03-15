"use strict";

/**
 * Manga update scheduler.
 *
 * For every guild that has MANGAPLUS_PAGE + MANGA_RELEASE_TIME configured,
 * this module sets up a cron job that:
 *   1. Fetches the latest chapter from MangaPlus
 *   2. Checks whether it was already announced in the channel (break-week guard)
 *   3. Posts the configured message template if it's genuinely new
 *
 * Template files live in:  messages/{guildId}_{MangaName}.txt
 * Placeholders:  {role}  {mangaName}  {chapterName}  {chapterLink}
 *
 * Requires:  npm install node-cron
 */

const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const { fetchLatestChapter } = require("./manga");

// ─── ERROR REPORTING ──────────────────────────────────────────────────────────

/**
 * Sends an @here alert to the guild's ERRORS_CHANNEL_ID.
 * Fails silently so error reporting never causes a second crash.
 */
async function postError(client, guildConfig, message) {
  const { guildId, errorsChannelId } = guildConfig;
  if (!errorsChannelId) return;

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const channel = await guild.channels
      .fetch(errorsChannelId)
      .catch(() => null);
    if (!channel) return;

    await channel.send(`@here ⚠️ **Manga scheduler error** — ${message}`);
  } catch (err) {
    console.error(
      `[manga] Failed to post error to errors channel: ${err.message}`,
    );
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const DAY_MAP = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Parses a human-friendly release time string into a node-cron expression.
 *
 * Accepted format:  "DayName HH:MM IANA/Timezone"
 * Examples:
 *   "Sunday 12:00 America/Sao_Paulo"
 *   "Wednesday 00:00 Asia/Tokyo"
 *   "Sunday 15:00 UTC"
 */
function parseMangaReleaseTime(str) {
  const parts = str.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`Expected "Day HH:MM [Timezone]", got: "${str}"`);
  }

  const [dayStr, timeStr, ...tzParts] = parts;

  const dayNum = DAY_MAP[dayStr.toLowerCase()];
  if (dayNum === undefined) throw new Error(`Unknown day: "${dayStr}"`);

  const [hourStr, minuteStr = "0", secondStr = "0"] = timeStr.split(":");

  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const second = parseInt(secondStr, 10);

  if (isNaN(hour) || isNaN(minute) || isNaN(second)) {
    throw new Error(`Invalid time: "${timeStr}"`);
  }

  const timezone = tzParts.join(" ") || "UTC";
  const cronExpr = `${second} ${minute} ${hour} * * ${dayNum}`;

  return { cronExpr, timezone };
}

/**
 * Loads the message template for a guild.
 * Falls back to a sensible default if no file exists.
 */
function loadTemplate(messagesDir, guildId, mangaName) {
  const filePath = path.join(messagesDir, `${guildId}_${mangaName}.txt`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8").trim();
  }
  // Default template — good enough until a custom file is created
  return (
    `{role} **{mangaName}** ({chapterName}) is out now on MangaPlus!\n` +
    `{chapterLink}`
  );
}

/**
 * Replaces all recognised placeholders in a template string.
 */
function applyTemplate(
  template,
  { role, mangaName, chapterName, chapterLink },
) {
  return template
    .replace(/\{role\}/g, role ?? "")
    .replace(/\{mangaName\}/g, mangaName ?? "")
    .replace(/\{chapterName\}/g, chapterName ?? "")
    .replace(/\{chapterLink\}/g, chapterLink ?? "");
}

// ─── CORE LOGIC ───────────────────────────────────────────────────────────────

/**
 * Checks MangaPlus and posts to Discord if a new chapter is available.
 * Safe to call manually (e.g., via /mangacheck).
 *
 * @returns {object|null}  The chapter data if a new post was made, null otherwise.
 */
async function checkAndPost(client, guildConfig, messagesDir) {
  const {
    guildId,
    mangaplusId,
    mangaUpdatesChannel,
    mangaUpdatesRole,
    mangaName,
  } = guildConfig;

  if (!mangaplusId || !mangaUpdatesChannel || !mangaName) return null;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.warn(
      `[manga] Guild ${guildId} not in cache — is the bot in this server?`,
    );
    return null;
  }

  const channel = await guild.channels
    .fetch(mangaUpdatesChannel)
    .catch(() => null);
  if (!channel) {
    console.warn(
      `[manga] Channel ${mangaUpdatesChannel} not found in guild ${guildId}`,
    );
    return null;
  }

  // ── 1. Fetch latest chapter ──────────────────────────────────────────────
  let latest;
  try {
    latest = await fetchLatestChapter(mangaplusId);
    console.log(
      `[manga] Latest for ${mangaName} (guild ${guildId}): ` +
        `${latest.chapterName} → ${latest.chapterLink}`,
    );
  } catch (err) {
    const msg = `Failed to fetch latest chapter for **${mangaName}**: ${err.message}`;
    console.error(`[manga] ${msg} (guild ${guildId})`);
    await postError(client, guildConfig, msg);
    return null;
  }

  // ── 2. Break-week guard ───────────────────────────────────────────────────
  // Look for the chapter link in the last 50 bot messages in this channel.
  // If found, the chapter was already announced → skip.
  const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (recent) {
    const alreadyPosted = recent.some(
      (m) =>
        m.author.id === client.user.id &&
        m.content.includes(latest.chapterLink),
    );
    if (alreadyPosted) {
      console.log(
        `[manga] ${mangaName} chapter ${latest.chapterId} already posted ` +
          `in guild ${guildId} — skipping (break week or duplicate run)`,
      );
      return null;
    }
  }

  // ── 3. Build message from template ───────────────────────────────────────
  const template = loadTemplate(messagesDir, guildId, mangaName);
  const roleMention = mangaUpdatesRole ? `<@&${mangaUpdatesRole}>` : "";
  const message = applyTemplate(template, {
    role: roleMention,
    mangaName,
    chapterName: latest.chapterName,
    chapterLink: latest.chapterLink,
  });

  // ── 4. Post ───────────────────────────────────────────────────────────────
  await channel
    .send(message)
    .catch((err) =>
      console.error(`[manga] Send failed in guild ${guildId}: ${err.message}`),
    );

  console.log(
    `[manga] ✅ Posted ${mangaName} "${latest.chapterName}" in guild ${guildId}`,
  );
  return latest;
}

// ─── SCHEDULER INIT ───────────────────────────────────────────────────────────

/**
 * Reads all guild configs, sets up cron jobs for those with manga settings,
 * and returns a { manualCheck } helper for slash command use.
 *
 * @param {Client}   client       - discord.js client (must be ready)
 * @param {object[]} configs      - array from getAllGuildConfigs()
 * @param {string}   messagesDir  - absolute path to the messages/ directory
 */
function initMangaSchedulers(client, configs, messagesDir) {
  // Ensure messages directory exists so template files have a home
  if (!fs.existsSync(messagesDir)) {
    fs.mkdirSync(messagesDir, { recursive: true });
    console.log(`[manga] Created messages directory at ${messagesDir}`);
  }

  const scheduledConfigs = [];

  for (const config of configs) {
    if (!config.mangaplusId || !config.mangaReleaseTime) continue;

    let cronExpr, timezone;
    try {
      ({ cronExpr, timezone } = parseMangaReleaseTime(config.mangaReleaseTime));
    } catch (err) {
      console.error(
        `[manga] Bad MANGA_RELEASE_TIME for guild ${config.guildId}: ${err.message}`,
      );
      continue;
    }

    if (!cron.validate(cronExpr)) {
      console.error(
        `[manga] Computed cron expression "${cronExpr}" is invalid ` +
          `for guild ${config.guildId}`,
      );
      continue;
    }

    cron.schedule(
      cronExpr,
      () => {
        checkAndPost(client, config, messagesDir).catch((err) => {
          const msg = `Unhandled error in scheduled check for **${config.mangaName}**: ${err.message}`;
          console.error(`[manga] ${msg} (guild ${config.guildId})`);
          postError(client, config, msg).catch(console.error);
        });
      },
      { scheduled: true, timezone },
    );

    console.log(
      `[manga] 📅 Scheduled ${config.mangaName} for guild ${config.guildId}: ` +
        `${cronExpr} (${timezone})`,
    );
    scheduledConfigs.push(config);
  }

  return {
    /**
     * Manually trigger a chapter check for a specific guild.
     * Used by the /mangacheck slash command.
     */
    manualCheck(guildId) {
      const config =
        scheduledConfigs.find((c) => c.guildId === guildId) ??
        configs.find((c) => c.guildId === guildId);
      if (!config?.mangaplusId) {
        return Promise.reject(
          new Error("No manga configuration found for this server"),
        );
      }
      return checkAndPost(client, config, messagesDir);
    },
  };
}

module.exports = { initMangaSchedulers };
