"use strict";

const { EmbedBuilder, Colors } = require("discord.js");
const { COMMAND_CATALOG } = require("./config");

/**
 * Builds an embed (or pair of embeds) for the help command.
 *
 * @param {string|null} commandName  — specific command to look up, or null for all
 * @param {object|null} config       — guild config (used to resolve role names)
 * @param {Guild|null}  guild        — discord.js Guild (used to resolve role names)
 * @returns {{ embeds: EmbedBuilder[] }}  — ready to pass to channel.send() / interaction.reply()
 */
function buildHelpPayload(commandName, config, guild = null) {
  // ── Role resolution ───────────────────────────────────────────────────────
  // Collects all roles that can access this tier (own tier + higher tiers).
  // Uses <@&id> so Discord renders them as role highlights in the embed.
  const rolesForTier = (tier) => {
    if (tier === 0) return null; // handled separately — just show "Everyone"
    if (!config) return "*(no role set)*";
    const mentions = [];
    for (let t = tier; t <= 3; t++) {
      for (const id of config[`tier${t}Roles`] ?? []) {
        mentions.push(`<@&${id}>`);
      }
    }
    return mentions.length > 0 ? mentions.join(", ") : "*(no role set)*";
  };

  const tierLabel = (tier) =>
    ["Everyone", "Tier 1", "Tier 2", "Tier 3"][tier] ?? "Tier ?";

  const fieldName = (tier) => {
    const roles = rolesForTier(tier);
    return roles ? `${tierLabel(tier)} — ${roles}` : tierLabel(tier);
  };

  // ── Single command view ───────────────────────────────────────────────────
  if (commandName) {
    const entry = COMMAND_CATALOG.find((c) => c.name === commandName);
    if (!entry) {
      return {
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Red)
            .setDescription(
              `❌ Unknown command \`${commandName}\`.\nUse \`&help\` to see all available commands.`,
            ),
        ],
      };
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Blurple)
      .setTitle(`📖 ${entry.name}`)
      .setDescription(entry.description)
      .addFields(
        { name: "Usage", value: `\`${entry.usage}\``, inline: false },
        {
          name: "Access",
          value: `${tierLabel(entry.tier)}${rolesForTier(entry.tier) ? ` — ${rolesForTier(entry.tier)}` : ""}`,
          inline: false,
        },
      );

    if (entry.args.length > 0) {
      embed.addFields({
        name: "Arguments",
        value: entry.args.map((a) => `• ${a}`).join("\n"),
        inline: false,
      });
    }

    return { embeds: [embed] };
  }

  // ── Full list view ────────────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle("📋 Bot Commands")
    .setFooter({
      text: 'Use "&help <command>" or "/help command:<name>" for details. Commands marked "/" are slash-only.',
    });

  // Shorten a description to fit nicely in the list view.
  // Also strips leading emoji + "Boosters only — " / "Sword Bearers only — " prefixes.
  const short = (desc) => {
    const cleaned = desc.replace(/^[^\w\/&]+(?:\w[\w\s]*only\s*[—-]\s*)?/u, "");
    return cleaned.length > 60 ? cleaned.slice(0, 57) + "…" : cleaned;
  };

  for (const tier of [0, 1, 2, 3]) {
    const cmds = COMMAND_CATALOG.filter((c) => c.tier === tier);
    if (cmds.length === 0) continue;

    if (tier === 0) {
      // Split tier 0 into three focused fields to stay under Discord's 1024-char limit.
      const utilNames = new Set(["help", "contact", "policy", "serverlist"]);
      const boosterNames = new Set([
        "createboosterrole",
        "editboostercolor",
        "boosterroleimage",
        "deleteboosterrole",
        "claimboosterrole",
        "auditboosterroles",
        "pruneboosterroles",
      ]);

      const util = cmds.filter((c) => utilNames.has(c.name));
      const booster = cmds.filter((c) => boosterNames.has(c.name));
      const premium = cmds.filter(
        (c) => !utilNames.has(c.name) && !boosterNames.has(c.name),
      );

      if (util.length > 0) {
        embed.addFields({
          name: "Everyone — Utility",
          value: util
            .map((c) => `\`${c.name}\` — ${short(c.description)}`)
            .join("\n"),
          inline: false,
        });
      }
      if (booster.length > 0) {
        embed.addFields({
          name: "Everyone — 🚀 Booster Roles",
          value: booster
            .map((c) => `\`${c.name}\` — ${short(c.description)}`)
            .join("\n"),
          inline: false,
        });
      }
      if (premium.length > 0) {
        embed.addFields({
          name: "Everyone — ⚔️ Premium Roles",
          value: premium
            .map((c) => `\`${c.name}\` — ${short(c.description)}`)
            .join("\n"),
          inline: false,
        });
      }
      continue;
    }

    const roles = rolesForTier(tier);
    const roleline = roles ? `*${roles}*\n` : "";
    const value =
      roleline +
      cmds.map((c) => `\`${c.name}\` — ${short(c.description)}`).join("\n");

    embed.addFields({
      name: fieldName(tier),
      value,
      inline: false,
    });
  }

  return { embeds: [embed] };
}

module.exports = { buildHelpPayload };
