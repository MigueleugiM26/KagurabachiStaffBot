"use strict";

// ─── PURGE HELPERS ────────────────────────────────────────────────────────────

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Deletes every message in a channel.
 *
 * Strategy:
 *  - Fetches up to 100 messages at a time.
 *  - Messages < 14 days old → bulkDelete (fast, single API call per batch).
 *  - Messages ≥ 14 days old → deleted individually (bulkDelete rejects them).
 *  - A short delay between batches avoids Discord rate-limits.
 *
 * @param {import("discord.js").TextChannel} channel
 * @param {(deleted: number) => void} [onProgress]  — called after each batch
 * @returns {Promise<{ deleted: number }>}
 */
async function purgeChannel(channel, onProgress) {
  let totalDeleted = 0;

  while (true) {
    const messages = await channel.messages.fetch({ limit: 100 });
    if (messages.size === 0) break;

    const now = Date.now();
    const recent = messages.filter(
      (m) => now - m.createdTimestamp < FOURTEEN_DAYS_MS,
    );
    const old = messages.filter(
      (m) => now - m.createdTimestamp >= FOURTEEN_DAYS_MS,
    );

    // bulkDelete requires at least 2 messages
    if (recent.size >= 2) {
      try {
        const deleted = await channel.bulkDelete(recent, true);
        totalDeleted += deleted.size;
      } catch (err) {
        if (err.code === 50013) throw err; // Missing Permissions — bubble up immediately
        // Other transient errors (e.g. unknown message) — keep going
      }
    } else if (recent.size === 1) {
      try {
        await recent.first().delete();
        totalDeleted += 1;
      } catch (err) {
        if (err.code === 50013) throw err;
      }
    }

    for (const msg of old.values()) {
      try {
        await msg.delete();
        totalDeleted += 1;
      } catch (err) {
        if (err.code === 50013) throw err;
        // already deleted or other transient error — skip
      }
    }

    if (onProgress) onProgress(totalDeleted);

    // Stop if this was the last batch
    if (messages.size < 100) break;

    // Small pause between batches to stay within rate limits
    await new Promise((r) => setTimeout(r, 1200));
  }

  return { deleted: totalDeleted };
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

/**
 * Execute the purgeall command.
 *
 * @param {object} opts
 * @param {import("discord.js").TextChannel} opts.channel         — channel to purge
 * @param {string[]}                         opts.allowedChannels — IDs allowed to be purged
 * @param {string}                           opts.staffName
 * @param {string}                           opts.staffId
 * @param {Function}                         opts.editProgressFn  — async (content: string) => void
 */
async function executePurgeAll({
  channel,
  allowedChannels,
  staffName,
  staffId,
  editProgressFn,
}) {
  // ── Allowlist check ───────────────────────────────────────────────────────
  if (!allowedChannels.includes(channel.id)) {
    return editProgressFn(
      `❌ <#${channel.id}> is not in the purge allowlist.\n` +
        `Ask a bot admin to add \`${channel.id}\` to \`GUILD_<id>_PURGE_CHANNELS\`.`,
    );
  }

  const start = Date.now();
  let lastProgressUpdate = 0;

  try {
    const { deleted } = await purgeChannel(channel, (count) => {
      const now = Date.now();
      if (now - lastProgressUpdate > 2000) {
        lastProgressUpdate = now;
        editProgressFn(
          `🗑️ Purging <#${channel.id}>… **${count}** message${count !== 1 ? "s" : ""} deleted so far.`,
        ).catch(() => {});
      }
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return editProgressFn(
      `✅ Purge complete!\n` +
        `Deleted **${deleted}** message${deleted !== 1 ? "s" : ""} from <#${channel.id}> in **${elapsed}s**.\n` +
        `— Executed by ${staffName} (\`${staffId}\`)`,
    );
  } catch (err) {
    const isMissingPerms = err.code === 50013;
    return editProgressFn(
      isMissingPerms
        ? `❌ Missing Permissions — the bot needs **Manage Messages** in <#${channel.id}>.`
        : `❌ Purge failed: ${err.message}`,
    );
  }
}

module.exports = { executePurgeAll };
