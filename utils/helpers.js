"use strict";

const { EmbedBuilder } = require("discord.js");

// ─── DISCORD REPLY HELPERS ────────────────────────────────────────────────────

async function sendReply(target, content) {
  if (!target) return null;
  if (target.deferred || target.replied) return target.editReply(content);
  return target.reply(content);
}

async function editReply(target, progressMsg, content) {
  if (!target) return;
  try {
    if (target.deferred || target.replied) {
      await target.editReply(content);
    } else if (progressMsg?.edit) {
      await progressMsg.edit(content);
    }
  } catch (err) {
    console.error("[editReply] Error:", err.message);
  }
}

// ─── SAPPHIRE REASON PARSER ───────────────────────────────────────────────────
//
// Sapphire writes audit log reasons in this format:
//   [HfA5Rgy] 23/09/2026 - 14:48 @.miguelindo (5 minutes): testing
//
// Fields:
//   [HfA5Rgy]        — internal audit ID (discarded)
//   23/09/2026        — date DD/MM/YYYY (reformatted to YYYY-MM-DD)
//   14:48             — time HH:MM
//   @.miguelindo      — staff username (no @. prefix)
//   (5 minutes)       — duration string (used only if bot didn't compute one)
//   testing           — actual reason text
//
// Returns null if the string doesn't match the expected format, so the caller
// can fall back to using the raw reason string as-is.

function parseSapphireReason(raw) {
  if (!raw) return null;

  // Full pattern — all groups optional-ish so partial matches still work
  const match = raw.match(
    /^\[[\w]+\]\s+(\d{2})\/(\d{2})\/(\d{4})\s+-\s+(\d{2}:\d{2})\s+@\.(\S+)\s+\(([^)]+)\):\s*([\s\S]*)$/,
  );
  if (!match) return null;

  const [, dd, mm, yyyy, time, staffName, sapphireDuration, reason] = match;

  return {
    staffName:         staffName,                          // "miguelindo"
    date:              `${yyyy}-${mm}-${dd}`,              // "2026-09-23"
    time,                                                  // "14:48"
    sapphireDuration:  sapphireDuration,                   // "5 minutes"
    reason:            reason.trim() || "No reason provided",
  };
}

// ─── EMBED BUILDER ────────────────────────────────────────────────────────────

function buildEmbed({
  type,
  emoji,
  color,
  reason,
  duration,
  staffName,
  staffId,
  imageUrl,
  sourceGuild,
  extraField,
  // parsed fields from parseSapphireReason (all optional)
  parsedStaffName,  // string — overrides staffName/staffId display if present
  actionDate,       // "YYYY-MM-DD"
  actionTime,       // "HH:MM"
}) {
  // Staff display: prefer parsedStaffName (from Sapphire reason string) over
  // staffId mention, since the Sapphire username is more readable and the
  // staffId mention already appears in the audit log.
  const staffValue = parsedStaffName
    ? `@${parsedStaffName}${staffId ? ` (<@${staffId}>)` : ""}`
    : staffId
      ? `<@${staffId}> (${staffName})`
      : (staffName ?? "Unknown");

  // Date/time footer: prefer parsed values from Sapphire reason, fall back to
  // Discord's own timestamp (setTimestamp()).
  const footerText = actionDate && actionTime
    ? `${actionDate} at ${actionTime} (server local time)`
    : null;

  const embed = new EmbedBuilder()
    .setTitle(`${emoji}  ${type}  ·  ${duration}`)
    .setColor(color)
    .addFields(
      { name: "Reason", value: reason || "No reason provided" },
      { name: "Staff",  value: staffValue },
    )
    .setTimestamp();

  if (footerText) embed.setFooter({ text: footerText });

  if (sourceGuild) {
    embed.addFields({
      name: "Server",
      value: `${sourceGuild.name} (\`${sourceGuild.id}\`)`,
      inline: false,
    });
  }

  if (extraField) embed.addFields(extraField);
  if (imageUrl)   embed.setImage(imageUrl);
  return embed;
}

// ─── MISC ─────────────────────────────────────────────────────────────────────

function buildServerList(results, actionType) {
  const lines = results.map((r) => `${r.status}  |  ${r.name}  (${r.id})`);
  const timestamp = new Date().toUTCString();
  return `${actionType} — Server Report\nGenerated: ${timestamp}\n${"─".repeat(50)}\n${lines.join("\n")}`;
}

function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(s|m|h|d|w)$/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000,
  };
  return n * multipliers[unit];
}

module.exports = {
  sendReply,
  editReply,
  buildEmbed,
  buildServerList,
  parseDuration,
  parseSapphireReason,
};
