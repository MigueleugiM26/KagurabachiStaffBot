"use strict";

// ─── BOOSTER ROLE COMMANDS ────────────────────────────────────────────────────
// Storage:   MongoDB Atlas  (MONGODB_URI env var)
// Env:       GUILD_<id>_BOOSTER_ANCHOR_ROLE_ID  per-guild anchor role
//
// No schema setup needed — MongoDB creates the collection automatically.
// Each document looks like:
//   { guildId, userId, roleId, type, color1, color2, createdAt }
//   with a unique compound index on { guildId, userId }.
//
// Optional dep for gradient / holographic icons:
//   npm install canvas
// If canvas is not installed the role is still created — just without an
// auto-generated icon (user-uploaded images always work regardless).

const { EmbedBuilder, Colors } = require("discord.js");
const { MongoClient } = require("mongodb");

// ── MongoDB client (lazy singleton) ──────────────────────────────────────────

let _client = null;
let _db = null;

async function getCollection() {
  if (!_db) {
    _client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
    });
    await _client.connect();
    _db = _client.db(); // uses the DB name embedded in the URI
    // Ensure unique index exists (safe to call repeatedly — no-op if already there)
    await _db
      .collection("booster_roles")
      .createIndex({ guildId: 1, userId: 1 }, { unique: true });
  }
  return _db.collection("booster_roles");
}

// ── canvas is optional ────────────────────────────────────────────────────────
let createCanvas;
try {
  ({ createCanvas } = require("canvas"));
} catch {
  /* icon gen disabled */
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
    console.error("[booster:getEntry]", err.message);
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
    console.error("[booster:upsertEntry]", err.message);
    throw new Error("Failed to save booster role data.");
  }
}

async function deleteEntry(guildId, userId) {
  try {
    const col = await getCollection();
    await col.deleteOne({ guildId, userId });
  } catch (err) {
    console.error("[booster:deleteEntry]", err.message);
    throw new Error("Failed to remove booster role data.");
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const OWNER_ID = "450842915024142374";

function isBooster(member) {
  return member.premiumSinceTimestamp !== null || member.user.id === OWNER_ID;
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

// Returns the `colors` array Discord expects for role.edit({ colors })
// solid     → [c1]
// gradient  → [c1, c2]
// holographic → a fixed purple-to-teal gradient (no canvas needed)
function buildColors(type, color1, color2) {
  if (type === "holographic") return [0xb44fe8, 0x4fe8c8];
  if (type === "gradient" && color2)
    return [parseHex(color1) ?? 0x99aab5, parseHex(color2) ?? 0x99aab5];
  return [parseHex(color1) ?? 0x99aab5];
}

// Single colour for embed display
function dominantColor(type, color1) {
  if (type === "holographic") return 0xb44fe8;
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

// ─── ICON GENERATION (canvas) ────────────────────────────────────────────────

function makeGradientIcon(hex1, hex2) {
  if (!createCanvas) return null;
  try {
    const SIZE = 64;
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d");
    const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    grad.addColorStop(0, normaliseHex(hex1));
    grad.addColorStop(1, normaliseHex(hex2));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}

function makeHolographicIcon() {
  if (!createCanvas) return null;
  try {
    const SIZE = 64;
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d");

    const rainbow = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    [
      [0.0, "#ff0080"],
      [0.17, "#ff8c00"],
      [0.33, "#ffe000"],
      [0.5, "#00e676"],
      [0.67, "#00b0ff"],
      [0.83, "#7c4dff"],
      [1.0, "#ff0080"],
    ].forEach(([pos, c]) => rainbow.addColorStop(pos, c));
    ctx.fillStyle = rainbow;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.fill();

    const shimmer = ctx.createRadialGradient(
      22,
      20,
      4,
      SIZE / 2,
      SIZE / 2,
      SIZE / 2,
    );
    shimmer.addColorStop(0, "rgba(255,255,255,0.55)");
    shimmer.addColorStop(0.5, "rgba(255,255,255,0.10)");
    shimmer.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = shimmer;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.fill();

    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}

// ─── COMMAND IMPLEMENTATIONS ──────────────────────────────────────────────────

async function executeCreateBoosterRole(guild, member, opts, reply) {
  if (!isBooster(member)) {
    return reply(
      "\u274c You need to be a **server booster** to create a custom role.",
    );
  }

  const existing = await getEntry(guild.id, member.id);
  if (existing) {
    return reply(
      "\u274c You already have a booster role. Use `editBoosterColor`, `boosterRoleImage`, or `deleteBoosterRole` to manage it.",
    );
  }

  const {
    roleName,
    type = "solid",
    color1,
    color2,
    imageAttachment,
    anchorRoleId,
  } = opts;

  if (color1 && parseHex(color1) === null)
    return reply(
      "\u274c Invalid colour for **color1**. Use hex format like `FF0000` or `#FF0000`.",
    );
  if (color2 && parseHex(color2) === null)
    return reply(
      "\u274c Invalid colour for **color2**. Use hex format like `FF0000` or `#FF0000`.",
    );
  if (type === "gradient" && color1 && !color2)
    return reply(
      "\u274c Gradient type requires **two** colours. Please provide `color2` as well.",
    );

  const hasIcons = guild.features.includes("ROLE_ICONS");
  const pos = await anchorPosition(guild, anchorRoleId);

  let role;
  try {
    role = await guild.roles.create({
      name: roleName,
      colors: buildColors(type, color1, color2),
      hoist: false,
      mentionable: false,
      position: pos,
      reason: `Booster custom role for ${member.user.tag}`,
    });
  } catch (err) {
    console.error("[createBoosterRole] create error:", err.message);
    return reply(
      "\u274c Failed to create the role. Make sure the bot has the **Manage Roles** permission and is ranked above the anchor role.",
    );
  }

  let iconNote = "";
  if (hasIcons) {
    try {
      if (imageAttachment) {
        await role.setIcon(
          imageAttachment.url,
          `Booster icon for ${member.user.tag}`,
        );
      } else if (type === "gradient" && color1 && color2) {
        const buf = makeGradientIcon(color1, color2);
        if (buf) await role.setIcon(buf, "Booster gradient icon");
      } else if (type === "holographic") {
        const buf = makeHolographicIcon();
        if (buf) await role.setIcon(buf, "Booster holographic icon");
      }
    } catch (err) {
      console.warn("[createBoosterRole] icon error:", err.message);
      iconNote =
        "\n\u26a0\ufe0f Couldn't set the role icon (the image may be too large or an unsupported format).";
    }
  } else if (imageAttachment || type !== "solid") {
    iconNote =
      "\n\u26a0\ufe0f This server doesn't have the **Role Icons** feature (requires Level 2 boost).";
  }

  try {
    await member.roles.add(role, "Booster custom role assigned");
  } catch (err) {
    console.warn("[createBoosterRole] assign error:", err.message);
  }

  try {
    await upsertEntry(guild.id, member.id, {
      roleId: role.id,
      type,
      color1: color1 ? normaliseHex(color1) : null,
      color2: color2 ? normaliseHex(color2) : null,
    });
  } catch (err) {
    console.error("[createBoosterRole] persist error:", err.message);
    iconNote +=
      "\n\u26a0\ufe0f Role created, but failed to save to database. Please contact an admin.";
  }

  const embed = new EmbedBuilder()
    .setColor(dominantColor(type, color1))
    .setTitle("\u2728 Booster Role Created")
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
      text: "Use &editBoosterColor \u2022 &boosterRoleImage \u2022 &deleteBoosterRole",
    })
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

async function executeEditBoosterColor(guild, member, opts, reply) {
  if (!isBooster(member)) {
    return reply(
      "\u274c You need to be a **server booster** to use this command.",
    );
  }

  const entry = await getEntry(guild.id, member.id);
  if (!entry)
    return reply(
      "\u274c You don't have a booster role yet. Use `createBoosterRole` to create one.",
    );

  const { type = "solid", color2 } = opts;
  let { color1 } = opts;

  // Holographic uses no colours — ignore whatever was passed
  if (type === "holographic") color1 = null;

  if (type !== "holographic") {
    if (!color1) return reply("\u274c Please provide at least **color1**.");
    if (parseHex(color1) === null)
      return reply(
        "\u274c Invalid colour for **color1**. Use hex format like `FF0000` or `#FF0000`.",
      );
  }
  if (color2 && parseHex(color2) === null)
    return reply(
      "\u274c Invalid colour for **color2**. Use hex format like `FF0000` or `#FF0000`.",
    );
  if (type === "gradient" && !color2)
    return reply(
      "\u274c Gradient type requires **two** colours. Please provide `color2` as well.",
    );

  const role =
    guild.roles.cache.get(entry.roleId) ??
    (await guild.roles.fetch(entry.roleId).catch(() => null));
  if (!role)
    return reply(
      "\u274c Your booster role no longer exists. Use `deleteBoosterRole` to clean up, then `createBoosterRole` to start fresh.",
    );

  const newColor = dominantColor(type, color1);
  const hasIcons = guild.features.includes("ROLE_ICONS");
  let iconNote = "";

  try {
    await role.edit({
      colors: buildColors(type, color1, color2),
      reason: "Booster colour edit",
    });
  } catch (err) {
    console.error("[editBoosterColor] setColor error:", err.message);
    return reply("\u274c Failed to update the role colour.");
  }

  if (hasIcons) {
    try {
      if (type === "gradient" && color1 && color2) {
        const buf = makeGradientIcon(color1, color2);
        if (buf) await role.setIcon(buf, "Booster gradient icon update");
      } else if (type === "holographic") {
        const buf = makeHolographicIcon();
        if (buf) await role.setIcon(buf, "Booster holographic icon update");
        // canvas not installed — holographic icon skipped, role color still updated
      } else {
        await role
          .setIcon(null, "Booster solid colour — icon cleared")
          .catch(() => {});
      }
    } catch (err) {
      console.warn("[editBoosterColor] icon error:", err.message);
    }
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
    console.error("[editBoosterColor] persist error:", err.message);
    iconNote +=
      "\n\u26a0\ufe0f Colour updated, but failed to save to database.";
  }

  const embed = new EmbedBuilder()
    .setColor(newColor)
    .setTitle("\ud83c\udfa8 Booster Role Updated")
    .setDescription(`**${role.name}** has been updated.${iconNote}`)
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

async function executeBoosterRoleImage(guild, member, imageAttachment, reply) {
  if (!isBooster(member))
    return reply(
      "\u274c You need to be a **server booster** to use this command.",
    );

  const entry = await getEntry(guild.id, member.id);
  if (!entry)
    return reply(
      "\u274c You don't have a booster role yet. Use `createBoosterRole` to create one.",
    );
  if (!imageAttachment)
    return reply("\u274c Please attach an image to set as your role icon.");
  if (!guild.features.includes("ROLE_ICONS"))
    return reply(
      "\u274c This server doesn't have the **Role Icons** feature (requires Level 2 boost).",
    );

  const role =
    guild.roles.cache.get(entry.roleId) ??
    (await guild.roles.fetch(entry.roleId).catch(() => null));
  if (!role)
    return reply(
      "\u274c Your booster role no longer exists. Use `deleteBoosterRole` to clean up, then `createBoosterRole` to start fresh.",
    );

  try {
    await role.setIcon(
      imageAttachment.url,
      `Booster icon set by ${member.user.tag}`,
    );
  } catch (err) {
    console.error("[boosterRoleImage] error:", err.message);
    return reply(
      "\u274c Failed to set the role icon. The image may be too large or an unsupported format (use PNG/JPG under 256 KB).",
    );
  }

  return reply({
    embeds: [
      new EmbedBuilder()
        .setColor(role.color || 0x99aab5)
        .setTitle("\ud83d\uddbc\ufe0f Role Icon Updated")
        .setDescription(`The icon for **${role.name}** has been updated.`)
        .setThumbnail(imageAttachment.url)
        .setTimestamp(),
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────

async function executeDeleteBoosterRole(guild, member, reply) {
  if (!isBooster(member))
    return reply(
      "\u274c You need to be a **server booster** to use this command.",
    );

  const entry = await getEntry(guild.id, member.id);
  if (!entry) return reply("\u274c You don't have a booster role to delete.");

  let roleName = "your booster role";
  try {
    const role =
      guild.roles.cache.get(entry.roleId) ??
      (await guild.roles.fetch(entry.roleId).catch(() => null));
    if (role) {
      roleName = role.name;
      await role.delete(`Booster role deleted by ${member.user.tag}`);
    }
  } catch (err) {
    console.error("[deleteBoosterRole] delete error:", err.message);
    return reply(
      "\u274c Failed to delete the role. Make sure the bot has the **Manage Roles** permission.",
    );
  }

  try {
    await deleteEntry(guild.id, member.id);
  } catch (err) {
    console.error("[deleteBoosterRole] persist error:", err.message);
    return reply(
      "\u26a0\ufe0f Role deleted, but failed to remove from database. Please contact an admin.",
    );
  }

  return reply({
    embeds: [
      new EmbedBuilder()
        .setColor(Colors.Red)
        .setTitle("\ud83d\uddd1\ufe0f Booster Role Deleted")
        .setDescription(
          `**${roleName}** has been deleted. You can create a new one with \`createBoosterRole\`.`,
        )
        .setTimestamp(),
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * &claimBoosterRole / /claimboosterrole
 *
 * Lets a user who already has a role from Booster Bot (or any other source)
 * register it in this bot's database so they can use &editBoosterColor etc.
 *
 * Detection logic:
 *   - Role must be below the anchor role in position (the booster zone)
 *   - Role must not be bot-managed (no integration roles)
 *   - Role must not be any configured tier role
 *   - Role must not be @everyone
 *   If exactly one candidate is found it is claimed automatically.
 *   If multiple are found the user must specify a role ID or mention.
 */
async function executeClaimBoosterRole(
  guild,
  member,
  opts,
  reply,
  anchorRoleId,
) {
  if (!isBooster(member)) {
    return reply("❌ You need to be a **server booster** to use this command.");
  }

  // Already tracked?
  const existing = await getEntry(guild.id, member.id);
  if (existing) {
    return reply(
      "❌ You already have a booster role registered. Use `editBoosterColor`, `boosterRoleImage`, or `deleteBoosterRole` to manage it.",
    );
  }

  // Resolve top anchor (ceiling) and optional bottom anchor (floor)
  let topPos = null; // roles must be strictly below this
  let bottomPos = null; // roles must be strictly above this

  if (anchorRoleId) {
    try {
      const anchor =
        guild.roles.cache.get(anchorRoleId) ??
        (await guild.roles.fetch(anchorRoleId));
      if (anchor) topPos = anchor.position;
    } catch {}
  }

  const {
    bottomAnchorRoleId,
    configRoleIds = [],
    ignoredBoosterRoles = [],
  } = opts;
  if (bottomAnchorRoleId) {
    try {
      const bottom =
        guild.roles.cache.get(bottomAnchorRoleId) ??
        (await guild.roles.fetch(bottomAnchorRoleId));
      if (bottom) bottomPos = bottom.position;
    } catch {}
  }

  // All IDs to exclude
  const excludedIds = new Set([...configRoleIds, ...ignoredBoosterRoles]);

  // Find candidate roles: assigned to this member, within the booster zone, not managed, not excluded
  await guild.members.fetch(member.id);
  const candidates = member.roles.cache.filter(
    (r) =>
      r.id !== guild.id && // not @everyone
      !r.managed && // not a bot-integration role
      !excludedIds.has(r.id) && // not excluded
      (topPos === null || r.position < topPos) && // below top anchor
      (bottomPos === null || r.position > bottomPos), // above bottom anchor
  );

  // If user provided a specific role ID or mention, use that
  const { specifiedRoleId } = opts;
  if (specifiedRoleId) {
    const role = candidates.get(specifiedRoleId);
    if (!role) {
      return reply(
        "❌ That role wasn't found on your profile, or it doesn't qualify (wrong position, bot-managed, or excluded).",
      );
    }
    return _claimRole(guild, member, role, reply);
  }

  if (candidates.size === 0) {
    return reply(
      "❌ No claimable roles found. Make sure your Booster Bot role is positioned between the top and bottom anchor roles.",
    );
  }

  if (candidates.size === 1) {
    return _claimRole(guild, member, candidates.first(), reply);
  }

  // Multiple candidates — ask user to pick
  const list = candidates
    .map((r) => `• **${r.name}** (\`${r.id}\`)`)
    .join("\n");
  return reply(
    `⚠️ Multiple claimable roles found. Re-run with the role ID you want to claim:\n` +
      `\`&claimBoosterRole <roleID>\`\n\n${list}`,
  );
}

async function _claimRole(guild, member, role, reply) {
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
    console.error("[claimBoosterRole] persist error:", err.message);
    return reply("❌ Failed to save to database. Please try again.");
  }

  const embed = new EmbedBuilder()
    .setColor(role.color || 0x99aab5)
    .setTitle("🔗 Booster Role Claimed")
    .setDescription(
      `**${role.name}** has been linked to your account.\nYou can now use \`&editBoosterColor\`, \`&boosterRoleImage\`, and \`&deleteBoosterRole\` on it.`,
    )
    .setFooter({ text: "This role was imported from an external source." })
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  executeCreateBoosterRole,
  executeEditBoosterColor,
  executeBoosterRoleImage,
  executeDeleteBoosterRole,
  executeClaimBoosterRole,
};
