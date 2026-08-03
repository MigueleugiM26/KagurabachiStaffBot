"use strict";

// ─── PREMIUM (SWORD BEARER) ROLE COMMANDS ────────────────────────────────────
// Storage:   MongoDB Atlas  (MONGODB_URI env var)
// Collection: premium_roles  { guildId, userId, roleId, type, color1, color2, createdAt }
//
// Env vars (per guild):
//   GUILD_<id>_PREMIUM_ROLE_ID            — the Sword Bearer role ID (eligibility gate)
//   GUILD_<id>_PREMIUM_ANCHOR_ROLE_ID     — top anchor: premium roles placed just below this
//   GUILD_<id>_BOTTOM_PREMIUM_ANCHOR_ROLE_ID — bottom anchor for claimPremiumRole zone
//   GUILD_<id>_IGNORED_PREMIUM_ROLES      — comma-separated role IDs to ignore during claim
//
// Monthly rotation:
//   On the 3rd of every month the scheduler checks who still holds PREMIUM_ROLE_ID.
//   Any DB entry whose owner no longer has that role has their Discord role deleted and
//   the DB entry cleared.  Guilds without PREMIUM_ROLE_ID are skipped.

const { EmbedBuilder, Colors } = require("discord.js");
const { MongoClient } = require("mongodb");

// ── MongoDB client (shared lazy singleton) ────────────────────────────────────

let _client = null;
let _db = null;

async function getDb() {
  if (!_db) {
    _client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
    });
    await _client.connect();
    _db = _client.db();
    await _db
      .collection("premium_roles")
      .createIndex({ guildId: 1, userId: 1 }, { unique: true });
  }
  return _db;
}

async function getCollection() {
  return (await getDb()).collection("premium_roles");
}

// ─── DATA LAYER ───────────────────────────────────────────────────────────────

async function getEntry(guildId, userId) {
  try {
    const col = await getCollection();
    return (
      (await col.findOne({ guildId, userId }, { projection: { _id: 0 } })) ??
      null
    );
  } catch (err) {
    console.error("[premium:getEntry]", err.message);
    return null;
  }
}

async function upsertEntry(guildId, userId, fields) {
  try {
    const col = await getCollection();
    await col.updateOne(
      { guildId, userId },
      {
        $set: { guildId, userId, ...fields },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error("[premium:upsertEntry]", err.message);
    throw new Error("Failed to save premium role data.");
  }
}

async function clearEntry(guildId, userId) {
  try {
    const col = await getCollection();
    await col.updateOne({ guildId, userId }, { $set: { roleId: null } });
  } catch (err) {
    console.error("[premium:clearEntry]", err.message);
    throw new Error("Failed to clear premium role data.");
  }
}

async function getAllEntries(guildId) {
  try {
    const col = await getCollection();
    return await col
      .find({ guildId, roleId: { $ne: null } }, { projection: { _id: 0 } })
      .toArray();
  } catch (err) {
    console.error("[premium:getAllEntries]", err.message);
    return [];
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function isPremium(member, premiumRoleId) {
  if (!premiumRoleId) return false;
  return member.roles.cache.has(premiumRoleId);
}

function parseHex(hex) {
  if (!hex) return null;
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return parseInt(clean, 16);
}

function normaliseHex(hex) {
  return hex ? `#${hex.replace(/^#/, "").toUpperCase()}` : null;
}

const HOLOGRAPHIC_COLORS = {
  primaryColor: 11127295,
  secondaryColor: 16759788,
  tertiaryColor: 16761760,
};

function buildColors(type, color1, color2) {
  if (type === "holographic") return HOLOGRAPHIC_COLORS;
  if (type === "gradient" && color2)
    return {
      primaryColor: parseHex(color1) ?? 0x99aab5,
      secondaryColor: parseHex(color2) ?? 0x99aab5,
    };
  return { primaryColor: parseHex(color1) ?? 0x99aab5 };
}

function dominantColor(type, color1) {
  if (type === "holographic") return HOLOGRAPHIC_COLORS.primaryColor;
  return parseHex(color1) ?? 0x99aab5;
}

async function anchorPosition(guild, anchorRoleId) {
  if (!anchorRoleId) return 0;
  try {
    const anchor =
      guild.roles.cache.get(anchorRoleId) ??
      (await guild.roles.fetch(anchorRoleId));
    return anchor ? anchor.position : 0;
  } catch {
    return 0;
  }
}

// ─── COMMAND IMPLEMENTATIONS ──────────────────────────────────────────────────

async function executeCreatePremiumRole(guild, member, opts, reply) {
  const { premiumRoleId, anchorRoleId } = opts;

  if (!isPremium(member, premiumRoleId)) {
    return reply(
      "❌ You need to be a **Sword Bearer** to create a custom premium role.",
    );
  }

  const existing = await getEntry(guild.id, member.id);
  if (existing?.roleId) {
    return reply(
      "❌ You already have a premium role. Use `editPremiumColor`, `premiumRoleImage`, or `deletePremiumRole` to manage it.",
    );
  }

  const { roleName, type = "solid", color1, color2, imageAttachment } = opts;

  if (color1 && parseHex(color1) === null)
    return reply(
      "❌ Invalid colour for **color1**. Use hex format like `FF0000` or `#FF0000`.",
    );
  if (color2 && parseHex(color2) === null)
    return reply(
      "❌ Invalid colour for **color2**. Use hex format like `FF0000` or `#FF0000`.",
    );
  if (type === "gradient" && color1 && !color2)
    return reply(
      "❌ Gradient type requires **two** colours. Please provide `color2` as well.",
    );

  const hasIcons = guild.features.includes("ROLE_ICONS");
  const pos = await anchorPosition(guild, anchorRoleId);

  let role;
  try {
    role = await guild.roles.create({
      name: roleName,
      colors: buildColors(type, color1, color2),
      permissions: 0n,
      hoist: false,
      mentionable: false,
      position: pos,
      reason: `Premium custom role for ${member.user.tag}`,
    });
  } catch (err) {
    console.error("[createPremiumRole] create error:", err.message);
    return reply(
      "❌ Failed to create the role. Make sure the bot has the **Manage Roles** permission and is ranked above the premium anchor role.",
    );
  }

  let iconNote = "";
  if (hasIcons && imageAttachment) {
    try {
      await role.setIcon(
        imageAttachment.url,
        `Premium icon for ${member.user.tag}`,
      );
    } catch (err) {
      console.warn("[createPremiumRole] icon error:", err.message);
      iconNote =
        "\n⚠️ Couldn't set the role icon (the image may be too large or an unsupported format).";
    }
  } else if (imageAttachment && !hasIcons) {
    iconNote =
      "\n⚠️ This server doesn't have the **Role Icons** feature (requires Level 2 boost).";
  }

  try {
    await member.roles.add(role, "Premium custom role assigned");
  } catch (err) {
    console.warn("[createPremiumRole] assign error:", err.message);
  }

  try {
    await upsertEntry(guild.id, member.id, {
      roleId: role.id,
      type,
      color1: color1 ? normaliseHex(color1) : null,
      color2: color2 ? normaliseHex(color2) : null,
    });
  } catch (err) {
    console.error("[createPremiumRole] persist error:", err.message);
    iconNote +=
      "\n⚠️ Role created, but failed to save to database. Please contact an admin.";
  }

  const embed = new EmbedBuilder()
    .setColor(dominantColor(type, color1))
    .setTitle("⚔️ Premium Role Created")
    .setDescription(
      `Your custom role **${role.name}** has been created and assigned to you!${iconNote}`,
    )
    .addFields(
      { name: "Type", value: type, inline: true },
      {
        name: "Color",
        value: color1 ? normaliseHex(color1) : "Default",
        inline: true,
      },
      ...(color2
        ? [{ name: "Color 2", value: normaliseHex(color2), inline: true }]
        : []),
    )
    .setFooter({
      text: "Use &editPremiumColor • &premiumRoleImage • &deletePremiumRole",
    })
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function executeEditPremiumColor(guild, member, opts, reply) {
  const { premiumRoleId } = opts;

  if (!isPremium(member, premiumRoleId)) {
    return reply("❌ You need to be a **Sword Bearer** to use this command.");
  }

  const entry = await getEntry(guild.id, member.id);
  if (!entry?.roleId)
    return reply(
      "❌ You don't have a premium role yet. Use `createPremiumRole` to create one, or `claimPremiumRole` to claim an existing role.",
    );

  const { type = "solid", color2 } = opts;
  let { color1 } = opts;

  if (type === "holographic") color1 = null;

  if (type !== "holographic") {
    if (!color1) return reply("❌ Please provide at least **color1**.");
    if (parseHex(color1) === null)
      return reply(
        "❌ Invalid colour for **color1**. Use hex format like `FF0000` or `#FF0000`.",
      );
  }
  if (color2 && parseHex(color2) === null)
    return reply(
      "❌ Invalid colour for **color2**. Use hex format like `FF0000` or `#FF0000`.",
    );
  if (type === "gradient" && !color2)
    return reply(
      "❌ Gradient type requires **two** colours. Please provide `color2` as well.",
    );

  const role =
    guild.roles.cache.get(entry.roleId) ??
    (await guild.roles.fetch(entry.roleId).catch(() => null));
  if (!role)
    return reply(
      "❌ Your premium role no longer exists. Use `deletePremiumRole` to clean up, then `createPremiumRole` to start fresh.",
    );

  try {
    await role.edit({
      colors: buildColors(type, color1, color2),
      reason: "Premium colour edit",
    });
  } catch (err) {
    console.error("[editPremiumColor] error:", err.message);
    return reply("❌ Failed to update the role colour.");
  }

  try {
    await upsertEntry(guild.id, member.id, {
      roleId: entry.roleId,
      type,
      color1: type === "holographic" ? null : normaliseHex(color1),
      color2:
        type === "holographic" ? null : color2 ? normaliseHex(color2) : null,
    });
  } catch (err) {
    console.error("[editPremiumColor] persist error:", err.message);
  }

  const embed = new EmbedBuilder()
    .setColor(dominantColor(type, color1))
    .setTitle("🎨 Premium Role Updated")
    .setDescription(`**${role.name}** has been updated.`)
    .addFields(
      { name: "Type", value: type, inline: true },
      ...(type !== "holographic" && color1
        ? [{ name: "Color 1", value: normaliseHex(color1), inline: true }]
        : []),
      ...(color2
        ? [{ name: "Color 2", value: normaliseHex(color2), inline: true }]
        : []),
    )
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function executePremiumRoleImage(
  guild,
  member,
  imageAttachment,
  opts,
  reply,
) {
  const { premiumRoleId } = opts;

  if (!isPremium(member, premiumRoleId))
    return reply("❌ You need to be a **Sword Bearer** to use this command.");

  const entry = await getEntry(guild.id, member.id);
  if (!entry?.roleId)
    return reply(
      "❌ You don't have a premium role yet. Use `createPremiumRole` to create one, or `claimPremiumRole` to claim an existing role.",
    );
  if (!imageAttachment)
    return reply("❌ Please attach an image to set as your role icon.");
  if (!guild.features.includes("ROLE_ICONS"))
    return reply(
      "❌ This server doesn't have the **Role Icons** feature (requires Level 2 boost).",
    );

  const role =
    guild.roles.cache.get(entry.roleId) ??
    (await guild.roles.fetch(entry.roleId).catch(() => null));
  if (!role)
    return reply(
      "❌ Your premium role no longer exists. Use `deletePremiumRole` to clean up, then `createPremiumRole` to start fresh.",
    );

  try {
    await role.setIcon(
      imageAttachment.url,
      `Premium icon set by ${member.user.tag}`,
    );
  } catch (err) {
    console.error("[premiumRoleImage] error:", err.message);
    return reply(
      "❌ Failed to set the role icon. The image may be too large or an unsupported format (use PNG/JPG under 256 KB).",
    );
  }

  return reply({
    embeds: [
      new EmbedBuilder()
        .setColor(role.color || 0x99aab5)
        .setTitle("🖼️ Premium Role Icon Updated")
        .setDescription(`The icon for **${role.name}** has been updated.`)
        .setThumbnail(imageAttachment.url)
        .setTimestamp(),
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────

async function executeDeletePremiumRole(guild, member, opts, reply) {
  const { premiumRoleId } = opts;

  if (!isPremium(member, premiumRoleId))
    return reply("❌ You need to be a **Sword Bearer** to use this command.");

  const entry = await getEntry(guild.id, member.id);
  if (!entry?.roleId)
    return reply("❌ You don't have a premium role to delete.");

  let roleName = "your premium role";
  try {
    const role =
      guild.roles.cache.get(entry.roleId) ??
      (await guild.roles.fetch(entry.roleId).catch(() => null));
    if (role) {
      roleName = role.name;
      await role.delete(`Premium role deleted by ${member.user.tag}`);
    }
  } catch (err) {
    console.error("[deletePremiumRole] delete error:", err.message);
    return reply(
      "❌ Failed to delete the role. Make sure the bot has the **Manage Roles** permission.",
    );
  }

  try {
    await clearEntry(guild.id, member.id);
  } catch (err) {
    console.error("[deletePremiumRole] persist error:", err.message);
    return reply(
      "⚠️ Role deleted, but failed to clear from database. Please contact an admin.",
    );
  }

  return reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("🗑️ Premium Role Deleted")
        .setDescription(
          `**${roleName}** has been deleted. You can create a new one with \`createPremiumRole\`.`,
        )
        .setTimestamp(),
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * &claimPremiumRole
 *
 * Lets a Sword Bearer register an existing role in the premium zone
 * so they can edit it with this bot's commands.
 */
async function executeClaimPremiumRole(guild, member, opts, reply) {
  const {
    premiumRoleId,
    anchorRoleId,
    bottomAnchorRoleId,
    ignoredPremiumRoles = [],
    configRoleIds = [],
  } = opts;

  if (!isPremium(member, premiumRoleId)) {
    return reply("❌ You need to be a **Sword Bearer** to use this command.");
  }

  const existing = await getEntry(guild.id, member.id);
  if (existing?.roleId) {
    return reply(
      "❌ You already have a premium role registered. Use `editPremiumColor`, `premiumRoleImage`, or `deletePremiumRole` to manage it.",
    );
  }

  let topPos = null;
  let bottomPos = null;

  if (anchorRoleId) {
    try {
      const anchor =
        guild.roles.cache.get(anchorRoleId) ??
        (await guild.roles.fetch(anchorRoleId));
      if (anchor) topPos = anchor.position;
    } catch {}
  }

  if (bottomAnchorRoleId) {
    try {
      const bottom =
        guild.roles.cache.get(bottomAnchorRoleId) ??
        (await guild.roles.fetch(bottomAnchorRoleId));
      if (bottom) bottomPos = bottom.position;
    } catch {}
  }

  const excludedIds = new Set([...configRoleIds, ...ignoredPremiumRoles]);

  await guild.members.fetch(member.id);
  const candidates = member.roles.cache.filter(
    (r) =>
      r.id !== guild.id &&
      !r.managed &&
      !excludedIds.has(r.id) &&
      (topPos === null || r.position < topPos) &&
      (bottomPos === null || r.position > bottomPos),
  );

  const { specifiedRoleId } = opts;
  if (specifiedRoleId) {
    const role = candidates.get(specifiedRoleId);
    if (!role) {
      return reply(
        "❌ That role wasn't found on your profile, or it doesn't qualify (wrong position, bot-managed, or excluded).",
      );
    }
    return _claimPremiumRole(guild, member, role, reply);
  }

  if (candidates.size === 0) {
    return reply(
      "❌ No claimable roles found. Make sure your role is positioned between the premium anchor roles.",
    );
  }

  if (candidates.size === 1) {
    return _claimPremiumRole(guild, member, candidates.first(), reply);
  }

  const list = candidates
    .map((r) => `• **${r.name}** (\`${r.id}\`)`)
    .join("\n");
  return reply(
    `⚠️ Multiple claimable roles found. Re-run with the role ID you want to claim:\n` +
      `\`&claimPremiumRole <roleID>\`\n\n${list}`,
  );
}

async function _claimPremiumRole(guild, member, role, reply) {
  const allMembers = await guild.members
    .fetch({ force: false })
    .catch(() => null);
  const membersWithRole = allMembers?.filter((m) => m.roles.cache.has(role.id));
  const memberCount = membersWithRole?.size ?? 0;

  if (memberCount > 1) {
    return reply(
      `⚠️ Role **${role.name}** found, but it has **${memberCount} members**. Contact a staff member to claim this role.`,
    );
  }

  if (memberCount === 1 && !membersWithRole.has(member.id)) {
    return reply(
      `⚠️ Role **${role.name}** found, but it already belongs to another user. Contact a staff member to claim this role.`,
    );
  }

  try {
    await upsertEntry(guild.id, member.id, {
      roleId: role.id,
      type: "solid",
      color1: role.color
        ? `#${role.color.toString(16).toUpperCase().padStart(6, "0")}`
        : null,
      color2: null,
    });
  } catch (err) {
    console.error("[claimPremiumRole] persist error:", err.message);
    return reply("❌ Failed to save to database. Please try again.");
  }

  const embed = new EmbedBuilder()
    .setColor(role.color || 0x99aab5)
    .setTitle("🔗 Premium Role Claimed")
    .setDescription(
      `**${role.name}** has been linked to your account.\nYou can now use \`&editPremiumColor\`, \`&premiumRoleImage\`, and \`&deletePremiumRole\` on it.`,
    )
    .setFooter({ text: "This role was imported from an external source." })
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─── MONTHLY ROTATION ─────────────────────────────────────────────────────────

/**
 * Runs on the 3rd of every month.
 * For each guild with PREMIUM_ROLE_ID configured:
 *   - Fetch all premium_roles DB entries with a roleId
 *   - For each entry whose user no longer has the premium role:
 *       1. Delete the Discord role
 *       2. Clear the roleId in DB (keeps the row for record-keeping)
 */
async function runPremiumRotation(client, guildConfigs) {
  console.log("[premium-rotation] Starting monthly premium role cleanup…");

  for (const cfg of guildConfigs) {
    const { guildId, premiumRoleId } = cfg;
    if (!premiumRoleId) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.warn(
        `[premium-rotation] Guild ${guildId} not in cache — skipping`,
      );
      continue;
    }

    const entries = await getAllEntries(guildId);
    if (entries.length === 0) continue;

    // Fetch all members to get accurate role info
    await guild.members.fetch().catch(() => null);

    let removed = 0;

    for (const entry of entries) {
      const member = guild.members.cache.get(entry.userId);

      // If member left the server OR no longer holds the premium role, clean up
      const stillPremium = member && member.roles.cache.has(premiumRoleId);
      if (stillPremium) continue;

      // Delete the Discord role
      try {
        const role =
          guild.roles.cache.get(entry.roleId) ??
          (await guild.roles.fetch(entry.roleId).catch(() => null));
        if (role) {
          await role.delete(
            "Monthly premium rotation — user no longer holds Sword Bearer role",
          );
          console.log(
            `[premium-rotation] Deleted role ${entry.roleId} for user ${entry.userId} in guild ${guildId}`,
          );
        }
      } catch (err) {
        console.error(
          `[premium-rotation] Failed to delete role ${entry.roleId} for ${entry.userId}: ${err.message}`,
        );
      }

      // Clear the roleId in DB (no owner)
      try {
        await clearEntry(guildId, entry.userId);
        removed++;
      } catch (err) {
        console.error(
          `[premium-rotation] Failed to clear DB entry for ${entry.userId}: ${err.message}`,
        );
      }
    }

    if (removed > 0) {
      console.log(
        `[premium-rotation] Guild ${guildId}: removed ${removed} expired premium role(s).`,
      );
    }
  }

  console.log("[premium-rotation] Monthly cleanup complete.");
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  executeCreatePremiumRole,
  executeEditPremiumColor,
  executePremiumRoleImage,
  executeDeletePremiumRole,
  executeClaimPremiumRole,
  runPremiumRotation,
};
