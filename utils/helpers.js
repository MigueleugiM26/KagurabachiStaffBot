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
}) {
  const staffValue = staffId ? `<@${staffId}> (${staffName})` : staffName;

  const embed = new EmbedBuilder()
    .setTitle(`${emoji}  ${type}  ·  ${duration}`)
    .setColor(color)
    .addFields(
      { name: "Reason", value: reason },
      { name: "Staff", value: staffValue },
    )
    .setTimestamp();

  if (sourceGuild) {
    embed.addFields({
      name: "Server",
      value: `${sourceGuild.name} (\`${sourceGuild.id}\`)`,
      inline: false,
    });
  }

  if (extraField) embed.addFields(extraField);
  if (imageUrl) embed.setImage(imageUrl);
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
};
