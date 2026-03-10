"use strict";

/**
 * Chapter fetcher — MangaDex API.
 *
 * MangaDex tracks all official MangaPlus releases and stores
 * the MangaPlus viewer URL directly in chapter.attributes.externalUrl,
 * so we get the real link without ever needing to auth with MangaPlus.
 *
 * API docs: https://api.mangadex.org/docs/
 * Requires:  npm install axios  (already a dependency)
 */

const axios = require("axios");

const MANGADEX_API = "https://api.mangadex.org";
// Official MangaPlus scanlation group on MangaDex
const MANGAPLUS_GROUP_ID = "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb";

/**
 * Fetches the latest available official English chapter from MangaDex.
 *
 * @param {string} mangadexId  UUID for the manga on MangaDex
 * @returns {{ chapterName: string, chapterLink: string, chapterId: string }}
 */
async function fetchLatestChapter(mangadexId) {
  if (!mangadexId) throw new Error("No MangaDex manga ID provided");

  // Fetch latest English chapters, sorted newest first.
  // includesgroup lets us filter for MangaPlus official only.
  const res = await axios.get(`${MANGADEX_API}/manga/${mangadexId}/feed`, {
    timeout: 20_000,
    params: {
      "translatedLanguage[]": "en",
      "order[chapter]": "desc",
      limit: 10,
      "includes[]": "scanlation_group",
    },
    headers: {
      "User-Agent": "KagurabachiStaffBot/1.0 (Discord bot; contact via server)",
    },
  });

  const chapters = res.data?.data;
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new Error("No chapters returned from MangaDex");
  }

  // Prefer chapters from the official MangaPlus group that have an externalUrl
  // (these are the simulpub releases with a direct MangaPlus viewer link).
  // Fall back to any chapter with a MangaPlus externalUrl if needed.
  const isOfficial = (ch) => {
    const groups =
      ch.relationships?.filter((r) => r.type === "scanlation_group") ?? [];
    return groups.some((g) => g.id === MANGAPLUS_GROUP_ID);
  };

  let chapter =
    chapters.find((ch) => isOfficial(ch) && ch.attributes?.externalUrl) ??
    chapters.find((ch) => ch.attributes?.externalUrl?.includes("mangaplus")) ??
    chapters.find((ch) => isOfficial(ch)) ??
    chapters[0]; // last resort: just the newest chapter

  const attrs = chapter.attributes;
  const chNum = attrs.chapter ? `Chapter ${attrs.chapter}` : "Chapter ?";
  const chTitle = attrs.title;
  const chapterName = chTitle ? `${chNum}: ${chTitle}` : chNum;

  // Use the MangaPlus viewer URL if available, otherwise fall back to MangaDex reader
  const chapterLink =
    attrs.externalUrl ?? `https://mangadex.org/chapter/${chapter.id}`;

  return {
    chapterName,
    chapterLink,
    chapterId: chapter.id,
  };
}

module.exports = { fetchLatestChapter };
