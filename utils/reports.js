"use strict";

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

function formatGuildHistory(
  { guildName, guildId, threadUrl, actions },
  isSource,
) {
  const header = isSource
    ? `📌 **${guildName}** (\`${guildId}\`) — *this server*`
    : `🌐 **${guildName}** (\`${guildId}\`)`;
  const link = threadUrl ? ` — [View Thread](${threadUrl})` : "";

  if (actions.length === 0) {
    return `${header}${link}\n  ↳ No actions on record.`;
  }

  const lines = actions.map((a) => {
    const ts = `<t:${Math.floor(a.timestamp.getTime() / 1000)}:d>`;
    const serverNote = a.server ? ` *(from ${a.server})*` : "";
    return `  • **${a.type}** — ${a.duration} — ${ts}\n    Reason: ${a.reason} | Staff: ${a.staff}${serverNote}`;
  });

  return `${header}${link}\n${lines.join("\n")}`;
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

  await sendReply(
    replyTarget,
    `🔍 Fetching mod history for **${user.username}** (\`${userId}\`)${full ? ` across ${targetConfigs.length} server(s)` : ""}...`,
  );

  const sourceConfig = targetConfigs.find((c) => c.guildId === sourceGuildId);
  const otherConfigs = targetConfigs.filter((c) => c.guildId !== sourceGuildId);
  const orderedConfigs = [
    ...(sourceConfig ? [sourceConfig] : []),
    ...otherConfigs,
  ];

  const sections = [];
  for (const c of orderedConfigs) {
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) {
      sections.push(`⚠️ **${c.guildId}** — bot not in guild cache`);
      continue;
    }
    const result = await fetchGuildHistory(client, guild, c, user);
    if (!result) continue;
    sections.push(formatGuildHistory(result, c.guildId === sourceGuildId));
  }

  if (sections.length === 0) {
    return sendReply(
      replyTarget,
      `ℹ️ No mod history found for **${user.username}**.`,
    );
  }

  const totalActions = sections.join("").split("•").length - 1;
  const header =
    `📋 **Mod history for ${user.username}** (\`${userId}\`)\n` +
    `${full ? "Showing all connected servers" : "Showing this server only"} · **${totalActions}** action(s) total\n` +
    `${"─".repeat(40)}\n`;

  const body = sections.join(`\n${"─".repeat(40)}\n`);
  const fullMessage = header + body;

  if (fullMessage.length <= 2000) {
    return sendReply(replyTarget, fullMessage);
  }

  // Split into chunks under 2000 chars
  const chunks = [];
  let current = header;
  for (const section of sections) {
    const separator = `\n${"─".repeat(40)}\n`;
    const candidate = current + (current === header ? "" : separator) + section;
    if (candidate.length > 2000) {
      chunks.push(current);
      current = section;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await sendReply(replyTarget, chunks[i]);
    } else {
      await replyTarget.channel?.send(chunks[i]).catch(console.error);
    }
  }
}

module.exports = { executeReports };
