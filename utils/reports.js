"use strict";

const { EmbedBuilder, Colors } = require("discord.js");
const { getAllGuildConfigs } = require("./config");
const { sendReply } = require("./helpers");

/**
 * Fetches all mod-action embeds from a user's thread in one guild's
 * reports channel.
 */
async function fetchGuildHistory(client, guild, config, user) {
  if (!config?.channelId) return null;

  const reportsChannel = await guild.channels
    .fetch(config.channelId)
    .catch(() => null);
  if (!reportsChannel) return null;

  const findThread = async () => {
    const active = await reportsChannel.threads.fetchActive().catch(() => null);
    let thread = active?.threads.find((t) => t.name.startsWith(user.id));
    if (thread) return thread;
    const archived = await reportsChannel.threads
      .fetchArchived({ fetchAll: true })
      .catch(() => null);
    return archived?.threads.find((t) => t.name.startsWith(user.id)) ?? null;
  };

  const thread = await findThread();
  if (!thread) {
    return {
      guildId: guild.id,
      guildName: guild.name,
      threadUrl: null,
      actions: [],
    };
  }

  // Paginate through all thread messages
  const allMessages = [];
  let before = undefined;
  while (true) {
    const batch = await thread.messages
      .fetch({ limit: 100, ...(before ? { before } : {}) })
      .catch(() => null);
    if (!batch || batch.size === 0) break;
    allMessages.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.last().id;
  }

  const actions = [];
  for (const msg of allMessages) {
    if (msg.author.id !== client.user.id) continue;
    for (const embed of msg.embeds) {
      if (!embed.title) continue;
      // Title format: "{emoji}  {type}  ·  {duration}"
      const titleMatch = embed.title.match(/^(.+?)\s{2}(.+?)\s{2}·\s{2}(.+)$/);
      const type = titleMatch ? titleMatch[2].trim() : embed.title;
      const duration = titleMatch ? titleMatch[3].trim() : "N/A";
      const reason =
        embed.fields.find((f) => f.name === "Reason")?.value ?? "N/A";
      const staff =
        embed.fields.find((f) => f.name === "Staff")?.value ?? "N/A";
      const server =
        embed.fields.find((f) => f.name === "Server")?.value ?? null;
      actions.push({
        type,
        duration,
        reason,
        staff,
        server,
        timestamp: msg.createdAt,
      });
    }
  }

  actions.sort((a, b) => b.timestamp - a.timestamp);
  const threadUrl = `https://discord.com/channels/${guild.id}/${thread.id}`;
  return { guildId: guild.id, guildName: guild.name, threadUrl, actions };
}

/**
 * Builds a single embed for one guild's history section.
 */
function buildGuildEmbed(
  user,
  { guildName, guildId, threadUrl, actions },
  isSource,
) {
  const title = isSource ? `📌 ${guildName} — this server` : `🌐 ${guildName}`;

  const embed = new EmbedBuilder()
    .setColor(isSource ? Colors.Blurple : Colors.Grey)
    .setTitle(title)
    .setFooter({ text: `Guild ID: ${guildId}` });

  if (threadUrl) {
    embed.setURL(threadUrl);
  }

  if (actions.length === 0) {
    embed.setDescription("No actions on record.");
    return embed;
  }

  // Each action becomes a field; Discord allows up to 25 fields per embed.
  // If there are more, truncate and note it.
  const MAX_FIELDS = 24;
  const shown = actions.slice(0, MAX_FIELDS);
  const overflow = actions.length - shown.length;

  for (const a of shown) {
    const ts = `<t:${Math.floor(a.timestamp.getTime() / 1000)}:d>`;
    const serverNote = a.server ? `\nServer: ${a.server}` : "";
    // staff is stored as "<@id> (name)" from the original embed — renders as
    // a highlight in embed field values without sending a ping.
    embed.addFields({
      name: `${a.type} · ${a.duration} · ${ts}`,
      value: `**Reason:** ${a.reason}\n**Staff:** ${a.staff}${serverNote}`,
      inline: false,
    });
  }

  if (overflow > 0) {
    embed.addFields({
      name: `…and ${overflow} more`,
      value: threadUrl
        ? `[View full thread](${threadUrl})`
        : "See the mod thread for the full history.",
      inline: false,
    });
  }

  return embed;
}

async function executeReports(
  client,
  { userId, sourceGuildId, full, replyTarget },
) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) {
    return sendReply(
      replyTarget,
      `❌ Could not find user with ID \`${userId}\`.`,
    );
  }

  const configs = getAllGuildConfigs().filter((c) => c.guildId);
  const targetConfigs = full
    ? configs
    : configs.filter((c) => c.guildId === sourceGuildId);

  // Send the header embed first
  const headerEmbed = new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(`📋 Mod history for ${user.username}`)
    .setThumbnail(user.displayAvatarURL())
    .setDescription(
      `${full ? `Checking ${targetConfigs.length} connected server(s)` : "Checking this server only"}…`,
    )
    .addFields({ name: "User ID", value: user.id, inline: true });

  await sendReply(replyTarget, { embeds: [headerEmbed] });

  const sourceConfig = targetConfigs.find((c) => c.guildId === sourceGuildId);
  const otherConfigs = targetConfigs.filter((c) => c.guildId !== sourceGuildId);
  const orderedConfigs = [
    ...(sourceConfig ? [sourceConfig] : []),
    ...otherConfigs,
  ];

  const guildEmbeds = [];
  let totalActions = 0;

  for (const c of orderedConfigs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) continue;
    const result = await fetchGuildHistory(client, guild, c, user);
    if (!result) continue;
    totalActions += result.actions.length;
    guildEmbeds.push(
      buildGuildEmbed(user, result, c.guildId === sourceGuildId),
    );
  }

  if (guildEmbeds.length === 0) {
    return replyTarget.channel
      ?.send({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Grey)
            .setDescription(
              `ℹ️ No mod history found for **${user.username}**.`,
            ),
        ],
      })
      .catch(console.error);
  }

  // Update header with final count
  const updatedHeader = EmbedBuilder.from(headerEmbed).setDescription(
    `${full ? `Across ${targetConfigs.length} connected server(s)` : "This server only"} · **${totalActions}** action(s) total`,
  );

  // Edit the first reply to show the updated header, then send guild embeds
  // Discord allows up to 10 embeds per message — send in batches
  try {
    if (replyTarget.deferred || replyTarget.replied) {
      await replyTarget.editReply({ embeds: [updatedHeader] });
    } else if (replyTarget.edit) {
      await replyTarget.edit({ embeds: [updatedHeader] });
    }
  } catch {
    // If editing fails, it's not critical
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < guildEmbeds.length; i += BATCH_SIZE) {
    const batch = guildEmbeds.slice(i, i + BATCH_SIZE);
    await replyTarget.channel?.send({ embeds: batch }).catch(console.error);
  }
}

module.exports = { executeReports };
