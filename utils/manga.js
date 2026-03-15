"use strict";

const axios = require("axios");
const protobuf = require("protobufjs");

const MANGAPLUS_API = "https://jumpg-webapi.tokyo-cdn.com/api";

const PROTO_SCHEMA = `
  syntax = "proto3";

  message Chapter {
    uint32 title_id         = 1;
    uint32 chapter_id       = 2;
    string chapter_number   = 3;
    string chapter_title    = 4;
    string thumbnail_url    = 5;
    uint32 start_timestamp  = 6;
    uint32 end_timestamp    = 7;
  }

  message ChapterGroup {
    string            label    = 1;
    repeated Chapter  ch_free  = 2;
    repeated Chapter  ch_mid   = 3;
    repeated Chapter  ch_last  = 4;
  }

  message Title {
    uint32 title_id = 1;
    string name     = 2;
  }

  message TitleDetailView {
    Title                 title          = 1;
    repeated ChapterGroup chapter_groups = 28;
  }

  message SuccessResult {
    TitleDetailView title_detail_view = 8;
  }

  message Response {
    SuccessResult success = 1;
  }
`;

let _root = null;
async function getProtoRoot() {
  if (_root) return _root;
  _root = protobuf.parse(PROTO_SCHEMA, { keepCase: true }).root;
  return _root;
}

async function fetchLatestChapter(mangaplusId) {
  if (!mangaplusId) throw new Error("No MangaPlus title ID provided");

  const root = await getProtoRoot();
  const Response = root.lookupType("Response");

  const res = await axios.get(`${MANGAPLUS_API}/title_detailV3`, {
    params: { title_id: mangaplusId, lang: "eng" },
    responseType: "arraybuffer",
    timeout: 20_000,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KagurabachiStaffBot/1.0)",
      Referer: "https://mangaplus.shueisha.co.jp/",
      Origin: "https://mangaplus.shueisha.co.jp",
      "Secret-Key": "zMjaFxBCEGSHpFRMEXAiJA==",
    },
  });

  const decoded = Response.decode(new Uint8Array(res.data));
  const groups = decoded?.success?.title_detail_view?.chapter_groups ?? [];
  if (groups.length === 0)
    throw new Error("No chapter groups in MangaPlus response");

  // Collect all chapters across all groups and all sub-lists,
  // then pick the one with the highest start_timestamp (= most recent release).
  const allChapters = groups.flatMap((g) => [
    ...(g.ch_free ?? []),
    ...(g.ch_mid ?? []),
    ...(g.ch_last ?? []),
  ]);

  if (allChapters.length === 0)
    throw new Error("No chapters found in response");

  const latest = allChapters.reduce((best, ch) =>
    (ch.start_timestamp ?? 0) > (best.start_timestamp ?? 0) ? ch : best,
  );

  const chNum = latest.chapter_number
    ? `Chapter ${latest.chapter_number.replace(/^#/, "")}`
    : "Chapter ?";
  const chTitle = latest.chapter_title;
  const chapterName = chTitle
    ? chTitle.includes(chNum)
      ? chTitle
      : `${chNum}: ${chTitle}`
    : chNum;
  const chapterLink = `https://mangaplus.shueisha.co.jp/viewer/${latest.chapter_id}`;

  return {
    chapterName,
    chapterLink,
    chapterId: String(latest.chapter_id),
  };
}

module.exports = { fetchLatestChapter };
