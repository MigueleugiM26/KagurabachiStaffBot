"use strict";

// ─── BOOSTER ROLE COMMANDS ────────────────────────────────────────────────────
// Requires:  BOOSTER_ANCHOR_ROLE_ID env var  (roles are placed just below it)
// Data file: booster-roles.json  (auto-created next to index.js)
//
// Optional dep for gradient / holographic icons:
//   npm install canvas
// If canvas is not installed the role is still created — just without an
// auto-generated icon (user-uploaded images always work regardless).

const { EmbedBuilder, Colors } = require("discord.js");
const fs = require("fs");
const path = require("path");

// ── canvas is optional ────────────────────────────────────────────────────────
let createCanvas;
try {
  ({ createCanvas } = require("canvas"));
} catch {
  /* no canvas — icon gen disabled */
}

// ─── DATA PERSISTENCE ─────────────────────────────────────────────────────────

const DATA_PATH = path.join(__dirname, "..", "booster-roles.json");

function loadData() {
  try {
    if (fs.existsSync(DATA_PATH))
      return JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch {}
  return {};
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("[booster] Failed to save data:", e.message);
  }
}

/** Returns the nested guild object, creating it if absent. */
function guildData(data, guildId) {
  if (!data[guildId]) data[guildId] = {};
  return data[guildId];
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const OWNER_ID = "450842915024142374";

function isBooster(member) {
  return member.premiumSinceTimestamp !== null || member.user.id === OWNER_ID;
}

/**
 * Parses a hex string like "FF0000" or "#FF0000".
 * Returns the integer value, or null if invalid.
 */
function parseHex(hex) {
  if (!hex) return null;
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return parseInt(clean, 16);
}

function normaliseHex(hex) {
  return hex ? `#${hex.replace(/^#/, "").toUpperCase()}` : null;
}

/** Returns the integer color best representing a role config. */
function dominantColor(type, color1, color2) {
  if (type === "holographic") return 0xb44fe8; // purple-ish default
  return parseHex(color1) ?? 0x99aab5; // Discord "default grey"
}

/**
 * Finds the position just below the guild's configured anchor role.
 * Returns 0 (bottom of list) if no anchor is configured or role isn't found.
 */
async function anchorPosition(guild, anchorRoleId) {
  if (!anchorRoleId) return 0;
  try {
    const anchor =
      guild.roles.cache.get(anchorRoleId) ??
      (await guild.roles.fetch(anchorRoleId));
    return anchor ? Math.max(0, anchor.position - 1) : 0;
  } catch {
    return 0;
  }
}

// ─── ICON GENERATION (canvas) ────────────────────────────────────────────────

/** Draws a circular 64×64 gradient PNG buffer. Returns null if canvas missing. */
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

/** Draws a rainbow holographic circular 64×64 PNG buffer. */
function makeHolographicIcon() {
  if (!createCanvas) return null;
  try {
    const SIZE = 64;
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d");

    // Rainbow base
    const rainbow = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    const stops = [
      [0.0, "#ff0080"],
      [0.17, "#ff8c00"],
      [0.33, "#ffe000"],
      [0.5, "#00e676"],
      [0.67, "#00b0ff"],
      [0.83, "#7c4dff"],
      [1.0, "#ff0080"],
    ];
    stops.forEach(([pos, c]) => rainbow.addColorStop(pos, c));
    ctx.fillStyle = rainbow;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.fill();

    // Shimmer overlay
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

/**
 * &createBoosterRole / /createboosterrole
 *
 * @param {Guild}      guild
 * @param {GuildMember} member
 * @param {object}     opts  – { roleName, type, color1, color2, imageAttachment, anchorRoleId }
 * @param {Function}   reply – async (content) => void
 */
async function executeCreateBoosterRole(guild, member, opts, reply) {
  if (!isBooster(member)) {
    return reply(
      "❌ You need to be a **server booster** to create a custom role.",
    );
  }

  const data = loadData();
  const gd = guildData(data, guild.id);

  if (gd[member.id]) {
    return reply(
      "❌ You already have a booster role. Use `editBoosterColor`, `boosterRoleImage`, or `deleteBoosterRole` to manage it.",
    );
  }

  // ── Validate colours ──
  const {
    roleName,
    type = "solid",
    color1,
    color2,
    imageAttachment,
    anchorRoleId,
  } = opts;

  if (color1 && parseHex(color1) === null) {
    return reply(
      "❌ Invalid colour for **color1**. Use hex format like `FF0000` or `#FF0000`.",
    );
  }
  if (color2 && parseHex(color2) === null) {
    return reply(
      "❌ Invalid colour for **color2**. Use hex format like `FF0000` or `#FF0000`.",
    );
  }
  if (type === "gradient" && color1 && !color2) {
    return reply(
      "❌ Gradient type requires **two** colours. Please provide `color2` as well.",
    );
  }

  const roleColor = dominantColor(type, color1, color2);
  const hasIcons = guild.features.includes("ROLE_ICONS");
  const pos = await anchorPosition(guild, anchorRoleId);

  // ── Create the role ──
  let role;
  try {
    role = await guild.roles.create({
      name: roleName,
      color: roleColor,
      hoist: false,
      mentionable: false,
      position: pos,
      reason: `Booster custom role for ${member.user.tag}`,
    });
  } catch (err) {
    console.error("[createBoosterRole] create error:", err.message);
    return reply(
      "❌ Failed to create the role. Make sure the bot has the **Manage Roles** permission and is ranked above the anchor role.",
    );
  }

  // ── Set icon ──
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
        if (buf) await role.setIcon(buf, `Booster gradient icon`);
        else if (!createCanvas)
          iconNote = "\n⚠️ Install `canvas` to auto-generate gradient icons.";
      } else if (type === "holographic") {
        const buf = makeHolographicIcon();
        if (buf) await role.setIcon(buf, `Booster holographic icon`);
        else if (!createCanvas)
          iconNote =
            "\n⚠️ Install `canvas` to auto-generate holographic icons.";
      }
    } catch (err) {
      console.warn("[createBoosterRole] icon error:", err.message);
      iconNote =
        "\n⚠️ Couldn't set the role icon (the image may be too large or an unsupported format).";
    }
  } else {
    if (imageAttachment || type !== "solid") {
      iconNote =
        "\n⚠️ This server doesn't have the **Role Icons** feature (requires Level 2 boost).";
    }
  }

  // ── Assign role ──
  try {
    await member.roles.add(role, "Booster custom role assigned");
  } catch (err) {
    console.warn("[createBoosterRole] assign error:", err.message);
  }

  // ── Persist ──
  gd[member.id] = {
    roleId: role.id,
    type,
    color1: color1 ? normaliseHex(color1) : null,
    color2: color2 ? normaliseHex(color2) : null,
    createdAt: new Date().toISOString(),
  };
  saveData(data);

  const embed = new EmbedBuilder()
    .setColor(roleColor)
    .setTitle("✨ Booster Role Created")
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
      text: "Use &editBoosterColor • &boosterRoleImage • &deleteBoosterRole",
    })
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * &editBoosterColor / /editboostercolor
 * Updates the role colour (and icon for gradient/holographic).
 */
async function executeEditBoosterColor(guild, member, opts, reply) {
  if (!isBooster(member)) {
    return reply("❌ You need to be a **server booster** to use this command.");
  }

  const data = loadData();
  const gd = guildData(data, guild.id);
  const entry = gd[member.id];

  if (!entry) {
    return reply(
      "❌ You don't have a booster role yet. Use `createBoosterRole` to create one.",
    );
  }

  const { type = "solid", color1, color2 } = opts;

  if (!color1) {
    return reply("❌ Please provide at least **color1**.");
  }
  if (parseHex(color1) === null) {
    return reply(
      "❌ Invalid colour for **color1**. Use hex format like `FF0000` or `#FF0000`.",
    );
  }
  if (color2 && parseHex(color2) === null) {
    return reply(
      "❌ Invalid colour for **color2**. Use hex format like `FF0000` or `#FF0000`.",
    );
  }
  if (type === "gradient" && !color2) {
    return reply(
      "❌ Gradient type requires **two** colours. Please provide `color2` as well.",
    );
  }

  const role =
    guild.roles.cache.get(entry.roleId) ??
    (await guild.roles.fetch(entry.roleId).catch(() => null));
  if (!role) {
    return reply(
      "❌ Your booster role no longer exists. Use `deleteBoosterRole` to clean up, then `createBoosterRole` to start fresh.",
    );
  }

  const newColor = dominantColor(type, color1, color2);
  const hasIcons = guild.features.includes("ROLE_ICONS");
  let iconNote = "";

  try {
    await role.setColor(newColor, "Booster colour edit");
  } catch (err) {
    console.error("[editBoosterColor] setColor error:", err.message);
    return reply("❌ Failed to update the role colour.");
  }

  if (hasIcons) {
    try {
      if (type === "gradient" && color1 && color2) {
        const buf = makeGradientIcon(color1, color2);
        if (buf) await role.setIcon(buf, "Booster gradient icon update");
        else if (!createCanvas)
          iconNote = "\n⚠️ Install `canvas` to auto-generate gradient icons.";
      } else if (type === "holographic") {
        const buf = makeHolographicIcon();
        if (buf) await role.setIcon(buf, "Booster holographic icon update");
        else if (!createCanvas)
          iconNote =
            "\n⚠️ Install `canvas` to auto-generate holographic icons.";
      } else {
        // solid — clear any existing icon
        await role
          .setIcon(null, "Booster solid colour — icon cleared")
          .catch(() => {});
      }
    } catch (err) {
      console.warn("[editBoosterColor] icon error:", err.message);
    }
  }

  // ── Persist ──
  entry.type = type;
  entry.color1 = normaliseHex(color1);
  entry.color2 = color2 ? normaliseHex(color2) : null;
  saveData(data);

  const embed = new EmbedBuilder()
    .setColor(newColor)
    .setTitle("🎨 Booster Role Updated")
    .setDescription(`**${role.name}** has been updated.${iconNote}`)
    .addFields(
      { name: "Type", value: type, inline: true },
      { name: "Color 1", value: normaliseHex(color1), inline: true },
      ...(color2
        ? [{ name: "Color 2", value: normaliseHex(color2), inline: true }]
        : []),
    )
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * &boosterRoleImage / /boosterroleimage
 * Sets the role icon from an attached image.
 */
async function executeBoosterRoleImage(guild, member, imageAttachment, reply) {
  if (!isBooster(member)) {
    return reply("❌ You need to be a **server booster** to use this command.");
  }

  const data = loadData();
  const gd = guildData(data, guild.id);
  const entry = gd[member.id];

  if (!entry) {
    return reply(
      "❌ You don't have a booster role yet. Use `createBoosterRole` to create one.",
    );
  }
  if (!imageAttachment) {
    return reply("❌ Please attach an image to set as your role icon.");
  }
  if (!guild.features.includes("ROLE_ICONS")) {
    return reply(
      "❌ This server doesn't have the **Role Icons** feature (requires Level 2 boost).",
    );
  }

  const role =
    guild.roles.cache.get(entry.roleId) ??
    (await guild.roles.fetch(entry.roleId).catch(() => null));
  if (!role) {
    return reply(
      "❌ Your booster role no longer exists. Use `deleteBoosterRole` to clean up, then `createBoosterRole` to start fresh.",
    );
  }

  try {
    await role.setIcon(
      imageAttachment.url,
      `Booster icon set by ${member.user.tag}`,
    );
  } catch (err) {
    console.error("[boosterRoleImage] error:", err.message);
    return reply(
      "❌ Failed to set the role icon. The image may be too large or an unsupported format (use PNG/JPG under 256 KB).",
    );
  }

  const embed = new EmbedBuilder()
    .setColor(role.color || 0x99aab5)
    .setTitle("🖼️ Role Icon Updated")
    .setDescription(`The icon for **${role.name}** has been updated.`)
    .setThumbnail(imageAttachment.url)
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * &deleteBoosterRole / /deleteboosterrole
 * Deletes the role from the guild and removes it from the JSON.
 */
async function executeDeleteBoosterRole(guild, member, reply) {
  if (!isBooster(member)) {
    return reply("❌ You need to be a **server booster** to use this command.");
  }

  const data = loadData();
  const gd = guildData(data, guild.id);
  const entry = gd[member.id];

  if (!entry) {
    return reply("❌ You don't have a booster role to delete.");
  }

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
      "❌ Failed to delete the role. Make sure the bot has the **Manage Roles** permission.",
    );
  }

  delete gd[member.id];
  saveData(data);

  const embed = new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle("🗑️ Booster Role Deleted")
    .setDescription(
      `**${roleName}** has been deleted. You can create a new one with \`createBoosterRole\`.`,
    )
    .setTimestamp();

  return reply({ embeds: [embed] });
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  executeCreateBoosterRole,
  executeEditBoosterColor,
  executeBoosterRoleImage,
  executeDeleteBoosterRole,
};
