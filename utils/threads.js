/**
 * Finds an existing thread for a user in the reports channel,
 * or creates a new one if none exists.
 *
 * Thread name format: "{userId} ({username})"
 * Searching by ID prefix ensures renames don't break lookups.
 */
async function findOrCreateThread(reportsChannel, user) {
  const threadName = `${user.id} (${user.username})`;

  // 1. Check active threads first (fastest)
  const active = await reportsChannel.threads.fetchActive();
  let thread = active.threads.find((t) => t.name.startsWith(user.id));

  // 2. Fall back to archived threads
  if (!thread) {
    const archived = await reportsChannel.threads.fetchArchived({
      fetchAll: true,
    });
    thread = archived.threads.find((t) => t.name.startsWith(user.id));

    if (thread) {
      // Unarchive so we can post to it
      await thread.setArchived(false).catch(console.error);
    }
  }

  // 3. Create a fresh thread
  if (!thread) {
    const isForum = reportsChannel.type === 15; // ChannelType.GuildForum = 15

    if (isForum) {
      // Forum channels require an initial message on creation
      const created = await reportsChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
        message: {
          content: `📁 Mod log thread for <@${user.id}> (\`${user.id}\`)`,
        },
        reason: `Mod log thread for ${user.username} (${user.id})`,
      });
      thread = created;
    } else {
      thread = await reportsChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
        reason: `Mod log thread for ${user.username} (${user.id})`,
      });
    }

    console.log(`[threads] Created new thread: ${threadName}`);
  }

  return thread;
}

module.exports = { findOrCreateThread };
