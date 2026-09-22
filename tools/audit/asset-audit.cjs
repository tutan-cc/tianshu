#!/usr/bin/env node
/**
 * 素材治理语义审计 —— 确定性对账（代码） + 语义判定（TypeSafe / Jev）
 *
 * 为什么需要这一层：
 *   `tools/e2e/audio-wiring.js` 验的是「代码点名的音频能不能取到」（运行时可达性），
 *   `tools/audio/*` 四层验收验的是音频本身的声学/音色/内容/感知质量。
 *   两者都**不覆盖**：清单与磁盘是否一致、文档声明是否属实、非音频素材是否被治理。
 *   本脚本只做这些「代码查不出、又必须靠语义判断」的部分，不重复上面两条链路。
 *
 * 分工（遵循 TypeSafe 的构建原则：能算的交给代码，语义才交给模型）：
 *   代码  —— 清单 ↔ 磁盘 ↔ git ↔ 验收覆盖 的精确对账（事实，零推断）
 *   Jev   —— 每一笔治理债的定性、影响面、处置建议（语义，代码无法判定）
 *
 * 用法：
 *   node tools/audit/asset-audit.cjs                # 全量
 *   node tools/audit/asset-audit.cjs --limit 3      # 只跑前 3 个审计项（试跑）
 *   node tools/audit/asset-audit.cjs --dry          # 只做对账，不调模型
 *   node tools/audit/asset-audit.cjs --concurrency 4
 *
 * 凭据：环境变量 TYPESAFE_API_KEY，或默认读取 <仓库>/../.secrets/typesafe.env
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT_JSON = path.join(ROOT, "_asset_audit.json");
const OUT_MD = path.join(ROOT, "_asset_audit_report.md");
const API = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : d;
};
const LIMIT = flag("limit", null) === null ? Infinity : Number(flag("limit", null));
const CONC = Number(flag("concurrency", 4));
const DRY = !!flag("dry", false);

/* ---------------------------------------------------------------- 凭据 */
function loadKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY.trim();
  const kf = flag("keyfile", path.join(ROOT, "..", ".secrets", "typesafe.env"));
  if (typeof kf === "string" && fs.existsSync(kf)) {
    const m = fs.readFileSync(kf, "utf8").match(/TYPESAFE_API_KEY=(.+)/);
    if (m) return m[1].trim();
  }
  throw new Error("找不到 TYPESAFE_API_KEY（环境变量或 --keyfile 指向的 .env）");
}

/* ------------------------------------------------- 第一步：确定性对账 */
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

function reconcile() {
  const manifestPath = path.join(ROOT, "媒体清单.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const files = manifest.files;

  // 清单 ↔ 磁盘
  const missingOnDisk = files.filter((f) => !fs.existsSync(path.join(ROOT, f.path))).map((f) => f.path);
  const diskAudio = walk(path.join(ROOT, "audio")).map((p) => "audio/" + p);
  const listed = new Set(files.map((f) => f.path));
  const unlisted = diskAudio.filter((p) => !listed.has(p));

  // 清单是否覆盖 art/
  const coversArt = files.some((f) => f.path.startsWith("art/"));

  // harness/dist 等非素材是否混入清单
  const nonAsset = files.filter((f) => !/^(audio|video|art)\//.test(f.path)).map((f) => f.path);

  // 验收覆盖：audio-wiring.js 的覆盖面
  const wiringRes = path.join(ROOT, "dist", "test-results", "audio-wiring-results.json");
  let wiring = null;
  if (fs.existsSync(wiringRes)) {
    try { wiring = JSON.parse(fs.readFileSync(wiringRes, "utf8")); } catch { /* 忽略坏文件 */ }
  }
  const wiringCovered = new Set(["audio/sfx", "audio/amb", "audio/bgm", "audio/mj"]);
  const audioDirs = [...new Set(diskAudio.map((p) => p.split("/").slice(0, 2).join("/")))];
  const wiringGaps = audioDirs
    .filter((d) => !wiringCovered.has(d))
    .map((d) => ({ dir: d, count: diskAudio.filter((p) => p.startsWith(d + "/")).length }))
    .filter((g) => g.count > 0);

  // SOURCES.md 的声明 vs 事实
  const sourcesTxt = fs.readFileSync(path.join(ROOT, "SOURCES.md"), "utf8");
  const artCount = walk(path.join(ROOT, "art")).filter((p) => p.endsWith(".png")).length;
  const claimedArt = (sourcesTxt.match(/`art\/\*\*`（(\d+) 个 png）/) || [])[1];
  const claimedWiring = /接线由\s*`tools\/e2e\/audio-wiring\.js`\s*逐个 URL 验可达性/.test(sourcesTxt);
  const claimedWiringDirs = (sourcesTxt.match(/本脚本覆盖：([^\n]+)/) || [])[1] || "";

  // git 跟踪情况（授权边界：第三方素材是否泄漏进公开仓库）
  // ⚠ 不能用 execFileSync 的默认管道捕获输出：在受限沙盒里 spawn + pipe 会 EPERM。
  //   改为把 stdout 重定向到文件（文件描述符而非管道），两种环境下都能工作；
  //   并且**失败必须显式记录**——绝不能静默返回空数组，那会得到一个「看起来是 0」的假事实。
  const gitTracked = (rel) => {
    const tmp = path.join(require("os").tmpdir(), `ts_git_${process.pid}_${rel.replace(/\W/g, "")}.txt`);
    let fd;
    try {
      const { execFileSync } = require("child_process");
      fd = fs.openSync(tmp, "w");
      execFileSync("git", ["-C", ROOT, "ls-files", rel], { stdio: ["ignore", fd, "ignore"] });
      fs.closeSync(fd); fd = null;
      const files = fs.readFileSync(tmp, "utf8").split("\n").filter(Boolean);
      fs.unlinkSync(tmp);
      return { ok: true, files };
    } catch (e) {
      if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, error: String(e.message || e).split("\n")[0].slice(0, 140) };
    }
  };
  const gitVideo = gitTracked("video/");
  const gitAudio = gitTracked("audio/");

  return {
    manifest, files, missingOnDisk, unlisted, coversArt, nonAsset,
    wiring, wiringGaps, artCount, claimedArt, claimedWiring, claimedWiringDirs,
    gitVideo, gitAudio,
    manifestCount: files.length, diskAudioCount: diskAudio.length,
  };
}

/* --------------------------------------------- 第二步：构造审计项 */
function buildItems(r) {
  const items = [];
  const push = (o) => items.push(o);

  // 按「所在目录」归并，并识别改名漂移（旧短名 → 新长名）
  const stem = (p) => path.posix.basename(p).replace(/\.[^.]+$/, "");
  const dirs = [...new Set([
    ...r.missingOnDisk.map((p) => path.posix.dirname(p)),
    ...r.unlisted.map((p) => path.posix.dirname(p)),
  ])].sort();

  for (const dir of dirs) {
    const miss = r.missingOnDisk.filter((p) => path.posix.dirname(p) === dir);
    const unl = r.unlisted.filter((p) => path.posix.dirname(p) === dir);
    const unlStems = unl.map(stem);

    // 旧名是新名的前缀或子串 → 判为同一素材改名（东→东风 / 白→白板 / 中→红中）
    const pairs = [], leftoverMiss = [];
    for (const p of miss) {
      const s = stem(p);
      const hit = unlStems.find((u) => u.length > s.length && (u.startsWith(s) || u.includes(s)));
      if (hit) pairs.push({ from: path.posix.basename(p), to: hit + path.posix.extname(p) });
      else leftoverMiss.push(path.posix.basename(p));
    }

    // 1) 改名漂移：缺失项全部能由未登记的新名解释
    if (pairs.length && !leftoverMiss.length) {
      push({
        id: "rename:" + dir,
        kind: "rename_drift",
        title: `素材改名未同步清单：${dir}（${pairs.length} 组）`,
        facts: [
          `媒体清单.json 登记的是旧名，磁盘上已是新名，两边对不上。`,
          `改名映射：${pairs.map((x) => `${x.from} → ${x.to}`).join("、")}`,
          `后果：清单登记的文件在磁盘上不存在（${pairs.length} 条），而磁盘上的实际文件又不在清单里（${pairs.length} 条）—— 同一批文件同时触发两类告警。`,
        ],
      });
      // 同一批文件不再重复报告为「未登记」
      const pairedTo = new Set(pairs.map((x) => x.to));
      const rest = unl.filter((p) => !pairedTo.has(path.posix.basename(p)));
      if (rest.length) pushUnlisted(dir, rest);
      continue;
    }

    // 2) 纯粹的清单缺失
    if (miss.length) {
      push({
        id: "missing:" + dir,
        kind: "manifest_missing_on_disk",
        title: `清单登记但磁盘缺失：${dir}（${miss.length} 条）`,
        facts: [
          `媒体清单.json 登记了 ${miss.length} 个文件，磁盘上不存在。`,
          `缺失的名字：${miss.map((p) => path.posix.basename(p)).join("、")}`,
          fs.existsSync(path.join(ROOT, dir))
            ? `同目录磁盘实际文件数：${walk(path.join(ROOT, dir)).length}`
            : `该目录在磁盘上不存在。`,
        ],
      });
    }

    // 3) 磁盘未登记
    if (unl.length) pushUnlisted(dir, unl);
  }

  /**
   * 同一件事会在多个目录各报一次（改名发生在 4 个座位目录、备份目录分布在 4 个子目录）。
   * 合并成一条，既省推理开销，也让报告读起来是一件事而不是四件。
   * （函数声明会提升，故定义在调用点之后依然可用。）
   */
  function mergeSameEvents(items) {
  const renamed = items.filter((i) => i.kind === "rename_drift");
  const others = items.filter((i) => i.kind !== "rename_drift");

  // 1) 改名：全项目合并为一条
  const out = [];
  if (renamed.length) {
    const allPairs = [];
    for (const it of renamed) {
      const m = it.facts[1].replace(/^改名映射：/, "").split("、");
      for (const p of m) allPairs.push(it.id.replace("rename:", "") + "/" + p);
    }
    const dirs = renamed.map((i) => i.id.replace("rename:", ""));
    const perGroup = renamed[0].facts[1].replace(/^改名映射：/, "").split("、").length;
    out.push({
      id: "rename:all",
      kind: "rename_drift",
      title: `素材改名未同步清单：${perGroup} 组 × ${renamed.length} 个目录（共 ${allPairs.length} 个文件）`,
      facts: [
        `媒体清单.json 登记的是旧短名，磁盘上已是新长名，两边对不上。`,
        `涉及的目录：${dirs.join("、")}`,
        `改名映射（每个目录各一份）：${renamed[0].facts[1].replace(/^改名映射：/, "")}`,
        `后果：清单登记的文件在磁盘上不存在（${allPairs.length} 条），磁盘上的实际文件又不在清单里（${allPairs.length} 条）—— 同一批文件同时触发两类告警。`,
      ],
    });
  }

  // 2) 未登记：把同一 `_` 前缀备份目录在各子目录下的分片合并
  const backupRoots = new Map();
  for (const it of others) {
    const dir = it.id.replace(/^unlisted:/, "");
    const seg = dir.split("/").find((s) => s.startsWith("_"));
    if (!seg) { out.push(it); continue; }
    const root = dir.slice(0, dir.indexOf(seg) + seg.length);
    if (!backupRoots.has(root)) backupRoots.set(root, []);
    backupRoots.get(root).push(it);
  }
  for (const [root, list] of backupRoots) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const total = list.reduce((a, i) => a + Number((i.title.match(/（(\d+) 个/) || [])[1] || 0), 0);
    out.push({
      id: "unlisted:" + root,
      kind: "disk_unlisted",
      title: `磁盘存在但未登记清单：${root}（${total} 个，分布在 ${list.length} 个子目录）`,
      facts: [
        `${root} 及其子目录下共 ${total} 个文件不在 媒体清单.json 中。`,
        `分布在：${list.map((i) => i.id.replace(/^unlisted:/, "")).join("、")}`,
        `目录名以下划线开头，按项目既有约定属于非正式产物（对比 tools/archive/ 的历史脚本归档）。`,
      ],
    });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

  function pushUnlisted(dir, paths) {
    // 同一条目里可能混着「在用的素材」与「历史版本」（如 audio/bf 既有 cook_* 也有 happy_v1/v3）。
    // 那会让模型被迫在互斥选项里二选一，置信度会诚实地掉下来 —— 所以先按名字族切一刀。
    const fam = (p) => {
      const b = path.posix.basename(p).replace(/\.[^.]+$/, "");
      const m = b.replace(/^_/, "").match(/^[A-Za-z\u4e00-\u9fa5]+/);
      return m ? m[0] : b;
    };
    const families = new Map();
    for (const p of paths) {
      const k = fam(p);
      if (!families.has(k)) families.set(k, []);
      families.get(k).push(p);
    }
    const big = [...families.entries()].filter(([, v]) => v.length >= 2);
    const small = [...families.entries()].filter(([, v]) => v.length < 2).flatMap(([, v]) => v);

    if (big.length > 1) {
      for (const [k, ps] of big) pushOne(dir + "（" + k + " 系）", ps);
      if (small.length) pushOne(dir + "（零散）", small);
    } else {
      pushOne(dir, paths);
    }
  }

  function pushOne(dir, paths) {
    const sample = paths.slice(0, 12).map((p) => path.posix.basename(p));
    const isMarkdown = paths.some((p) => p.endsWith(".md"));
    push({
      id: "unlisted:" + dir,
      kind: "disk_unlisted",
      title: `磁盘存在但未登记清单：${dir}（${paths.length} 个）`,
      facts: [
        `目录 ${dir} 下有 ${paths.length} 个文件不在 媒体清单.json 中。`,
        `样例：${sample.join("、")}${paths.length > sample.length ? " …" : ""}`,
        isMarkdown
          ? `注意：其中含 .md 文档（非素材文件），说明该目录里混入了非素材产物。`
          : `清单总条目 ${r.manifestCount}，磁盘 audio 文件 ${r.diskAudioCount} —— 差额说明清单已过期。`,
      ],
    });
  }

  // 3) 验收覆盖盲区
  for (const g of r.wiringGaps) {
    push({
      id: "wiring:" + g.dir,
      kind: "wiring_coverage_gap",
      title: `验收链路未覆盖：${g.dir}（${g.count} 个文件）`,
      facts: [
        `audio-wiring.js 的覆盖集是 ${r.claimedWiringDirs || "sfx/amb/bgm/mj"}，不含 ${g.dir}。`,
        `该目录有 ${g.count} 个音频文件，从未做过「运行时可达性」验证。`,
        r.wiring
          ? `现有接线结果全文为绿：${(r.wiring.checks || []).length} 项通过、${(r.wiring.errors || []).length} 项失败，但样本只含 251 个文件。`
          : `未找到 audio-wiring-results.json。`,
        `项目自身记录过同类事故：素材缺失与接线错误在断言层无法区分，导致「牌桌暗杠补杠完全没有声音」却 1542 项断言全绿。`,
      ],
    });
  }

  // 4) 文档声明与事实不符
  if (r.claimedArt && Number(r.claimedArt) !== r.artCount) {
    push({
      id: "doc:art_count",
      kind: "doc_count_mismatch",
      title: `SOURCES.md 素材计数过期：声称 ${r.claimedArt} 个 png，实际 ${r.artCount} 个`,
      facts: [
        `SOURCES.md 写「\`art/**\`（${r.claimedArt} 个 png）」。`,
        `磁盘实际 png 计数：${r.artCount}。`,
        `差额 ${r.artCount - Number(r.claimedArt)} 个，含 art/fight2/ 打斗精灵图与 art/icons/_zoom_*、_sheet_preview* 等后续新增。`,
      ],
    });
  }
  if (r.claimedWiring && r.wiringGaps.length) {
    push({
      id: "doc:wiring_claim",
      kind: "doc_claim_overreach",
      title: `SOURCES.md 的验收声明覆盖不到实际范围`,
      facts: [
        `SOURCES.md 称「接线由 \`tools/e2e/audio-wiring.js\` 逐个 URL 验可达性」，用于支撑「为什么可以放心入库」。`,
        `但该脚本的覆盖集不含 ${r.wiringGaps.map((g) => g.dir + `(${g.count})`).join("、")}，共 ${r.wiringGaps.reduce((a, b) => a + b.count, 0)} 个音频文件。`,
        `同一节还宣称「四层自动验收，1572 项断言全绿」——该数字对未覆盖目录同样不成立。`,
      ],
    });
  }
  if (!r.coversArt) {
    push({
      id: "doc:art_not_manifested",
      kind: "manifest_scope_gap",
      title: `art/ 完全不在媒体清单治理范围内`,
      facts: [
        `媒体清单.json 只含 audio/ 与 video/ 条目，无任何 art/ 条目。`,
        `art/ 有 ${r.artCount} 个 png，含 Lovart 生成素材与程序切片产物，目前只靠 SOURCES.md 散文描述治理。`,
        `SOURCES.md 对 art/ 的授权结论是「AI 生成原创，随仓库分发」，但无逐项登记（对比 audio/ 的 305 条逐项 sha256）。`,
      ],
    });
  }

  // 5) 授权边界（第三方素材是否泄漏进公开仓库）
  if (r.gitVideo && r.gitVideo.ok) {
    push({
      id: "license:video_boundary",
      kind: "license_boundary",
      title: `第三方素材的授权边界：video/ 被 git 跟踪 ${r.gitVideo.files.length} 个文件`,
      facts: [
        `SOURCES.md 声明 68 个实拍素材「授权未核实、不入库」，走带外分发。`,
        `git 实际跟踪的 video/ 文件（${r.gitVideo.files.length} 个）：${r.gitVideo.files.join("、") || "（无）"}`,
        `磁盘上 video/ 共 ${r.manifest.files.filter((f) => f.path.startsWith("video/")).length} 个条目，其中未核实的 68 个已被 .gitignore 排除，未进入版本库。`,
        `对照：audio/ 被跟踪 ${r.gitAudio && r.gitAudio.ok ? r.gitAudio.files.length : "?"} 个（自产素材，授权清晰，应当入库）。`,
      ],
    });
  } else {
    push({
      id: "license:video_boundary",
      kind: "license_boundary",
      title: `授权边界无法自动判定：git 不可用`,
      facts: [
        `无法执行 git ls-files（${(r.gitVideo && r.gitVideo.error) || "未知原因"}）。`,
        `这意味着「第三方素材是否泄漏进公开仓库」这一项**没有被验证过**，不能按「0 个」理解。`,
        `请在仓库根手工执行 git ls-files video/ 复核。`,
      ],
    });
  }

  return mergeSameEvents(items);
}

/* ------------------------------------------------- 第三步：Jev 语义判定 */
const POLICY = [
  "项目：天枢原型·重启人生。单文件 HTML 真人互动影游，零第三方依赖，公开仓库 github.com/tutan-cc/tianshu。",
  "素材治理纪律（摘自 SOURCES.md）：",
  "  · 每一项素材都要写清来源与授权状态；⚠ 标记项公开发布前必须处理。",
  "  · 授权清晰、体积小、不会反复重做的自产素材直接入库；授权未核实的实拍素材走带外分发。",
  "  · 音频共 305 个，全部自产，已随仓库入库。",
  "  · 音频的验收链路：声学（时长/响度/静音/削波）· 音色（mel 平坦度）· 内容（ASR 比对）· 感知（全模态），另有接线脚本逐个 URL 验可达性。",
  "  · 项目已知的失败模式：AudioSys 全层「有文件用文件、缺失回落合成」，这让「素材缺失」与「素材接错」在断言层面无法区分 —— 曾出现牌桌暗杠/补杠完全无声、而 1542 项断言全绿。",
].join("\n");

const QUESTIONS_FINDING = {
  impact: {
    type: "score",
    instructions:
      "这一笔素材治理债对项目的影响有多大？考虑：它是否会让问题在发布前无法被发现，是否会误导后续维护者，是否涉及授权合规或发布阻断。",
    criteria: [
      "纯记账问题：不影响玩家体验，也不影响发布，只是数字不好看",
      "文档或清单与事实不符：会误导后续维护者，但游戏照常运行",
      "治理出现盲区：缺失的自动发现手段让问题可能在发布前一直查不出来",
      "授权合规或发布阻断风险：可能导致未授权素材被分发，或公开仓库出问题",
    ],
  },
  category: {
    type: "choice",
    instructions: "这笔债最准确的归类是什么？",
    criteria: {
      doc_drift: "文档或清单数字过时，事实已变而记录未更新",
      coverage_gap: "验收/检查链路有盲区，缺少自动发现手段",
      housekeeping: "仓库里混入了备份、中间产物或调试文件，需要清理",
      rename_drift: "素材改名后清单未同步，旧名仍被登记",
      license_risk: "授权状态与分发行为之间可能不一致",
    },
  },
  blocks_release: {
    type: "noul",
    instructions: "按现状，这一问题会阻碍公开发布，或者会被玩家直接感知到吗？",
    criteria: {
      true: "会阻断发布、或已能导致玩家可见的故障、或已构成授权合规问题",
      false: "不会被玩家感知，也不阻断发布，属于内部治理质量范畴",
    },
  },
  next_action: {
    type: "choice",
    instructions: "最该做的一件事是什么？",
    criteria: {
      update_manifest: "重新生成 媒体清单.json，使其与磁盘一致",
      add_coverage: "把盲区纳入自动验收，补上缺失的发现手段",
      clean_repo: "清理或归档不应随仓库分发的文件",
      sync_docs: "修订文档中的数字与声明，使其与事实相符",
      verify_license: "人工复核授权与分发边界",
    },
  },
};

const QUESTIONS_UNLISTED = {
  disposition: {
    type: "choice",
    instructions:
      "结合文件名、目录位置与项目的素材治理纪律，这批未登记文件最可能属于哪一种？",
    criteria: {
      active_asset_needs_registration: "是游戏正在使用的素材，只是清单没登记，应补登记",
      superseded_backup: "已被新版本取代的历史备份，应归档或移出仓库",
      debug_artifact: "调试、预览或切片过程的中间产物，不应随仓库分发",
      intentional_archive: "有意保留的追溯记录，应保持现状但需在文档中注明",
    },
  },
  naming_clarity: {
    type: "score",
    instructions:
      "只靠文件名（不看内容），维护者能否判断它的用途、以及它是不是当前版本？",
    criteria: [
      "不能：名字无法判断用途，或同族文件分不清哪个是当前版本",
      "部分可以：能看出大致类别，但分不清版本新旧，需要打开文件确认",
      "可以：名字清楚表达用途与版本，维护者一眼可辨",
    ],
  },
};

/* 授权边界是「验证项」而不是「债务项」：事实若显示边界执行正确，
   就不该拿「这笔债有多大」去问它 —— 那会让模型在互斥选项里硬选，置信度会掉到 20% 上下。 */
const QUESTIONS_LICENSE = {
  boundary_enforced: {
    type: "noul",
    instructions:
      "根据给出的事实，项目的授权边界——「授权未核实的第三方素材不得进入公开版本库」——是否被正确执行了？",
    criteria: {
      true: "证据显示未核实授权的素材确实被排除在版本库之外，被跟踪的只有明确自产的素材",
      false: "证据显示有未核实授权的素材进入了版本库，或事实不足以判断边界是否生效",
    },
  },
  verification_strength: {
    type: "score",
    instructions: "这条边界目前靠什么来保证它不被破坏？",
    criteria: [
      "靠人工记忆与自觉，没有任何书面或自动的约束",
      "靠 .gitignore 等静态配置，但没有任何测试会在它被改坏时报警",
      "有自动检查覆盖，并纳入常规验收流程",
    ],
  },
  next_action: QUESTIONS_FINDING.next_action,
};

function questionsFor(item) {
  if (item.kind === "disk_unlisted") {
    return {
      disposition: QUESTIONS_UNLISTED.disposition,
      naming_clarity: QUESTIONS_UNLISTED.naming_clarity,
      impact: QUESTIONS_FINDING.impact,
    };
  }
  if (item.kind === "license_boundary") {
    return {
      boundary_enforced: QUESTIONS_LICENSE.boundary_enforced,
      verification_strength: QUESTIONS_LICENSE.verification_strength,
      next_action: QUESTIONS_LICENSE.next_action,
    };
  }
  return QUESTIONS_FINDING;
}

async function judge(key, item) {
  const state = {
    project_policy: POLICY,
    audit_finding: { title: item.title, kind: item.kind, facts: item.facts },
  };
  const t0 = Date.now();
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: MODEL, questions: questionsFor(item) }),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return { item, answers: data.answers, usage: data.usage, model: data.model, ms };
}

/* ------------------------------------------------------------------ 报告 */
const pct = (x) => (x * 100).toFixed(0) + "%";

function renderMarkdown(r, judged, totals) {
  const L = [];
  L.push("# 素材治理语义审计报告（TypeSafe / Jev）");
  L.push("");
  L.push(`> 生成时间：${new Date().toISOString()} · 模型：${judged[0] ? judged[0].model : MODEL}`);
  L.push("> 工具：`tools/audit/asset-audit.cjs`（确定性对账在代码，语义判定在 Jev）");
  L.push("");
  L.push("## 一、对账事实（代码算出，零推断）");
  L.push("");
  L.push("| 项 | 值 |");
  L.push("|---|---|");
  L.push(`| 媒体清单条目 | ${r.manifestCount} |`);
  L.push(`| 磁盘 audio 文件 | ${r.diskAudioCount} |`);
  L.push(`| 清单登记但磁盘缺失 | ${r.missingOnDisk.length} |`);
  L.push(`| 磁盘存在但未登记 | ${r.unlisted.length} |`);
  L.push(`| art/ png 实际 | ${r.artCount}（SOURCES.md 声称 ${r.claimedArt || "?"}） |`);
  L.push(`| art/ 是否在清单内 | ${r.coversArt ? "是" : "**否**"} |`);
  L.push(`| 接线验收盲区 | ${r.wiringGaps.map((g) => `${g.dir}(${g.count})`).join("、") || "无"} |`);
  L.push(`| git 跟踪 video/ 文件 | ${r.gitVideo && r.gitVideo.ok ? r.gitVideo.files.length + "（第三方素材未泄漏进公开仓库）" : "**无法判定**（git 不可用，见下）"} |`);
  L.push(`| git 跟踪 audio/ 文件 | ${r.gitAudio && r.gitAudio.ok ? r.gitAudio.files.length : "**无法判定**"} |`);
  L.push("");

  L.push("## 二、Jev 语义判定");
  L.push("");
  for (const j of judged) {
    const a = j.answers;
    L.push(`### ${j.item.title}`);
    L.push("");
    L.push(`*${j.item.kind}*`);
    L.push("");
    for (const f of j.item.facts) L.push(`- ${f}`);
    L.push("");
    const bits = [];
    if (a.impact) {
      const lvl = Math.round(a.impact.score);
      bits.push(`**影响** ${a.impact.score.toFixed(2)}/3 —— ${a.impact.legend?.[String(lvl)] || ""}（置信 ${pct(a.impact.confidence)}）`);
    }
    if (a.category) bits.push(`**归类** \`${a.category.choice}\`（置信 ${pct(a.category.confidence)}）`);
    if (a.blocks_release) bits.push(`**阻断发布** ${pct(a.blocks_release.noul)}`);
    if (a.next_action) bits.push(`**建议动作** \`${a.next_action.choice}\`（置信 ${pct(a.next_action.confidence)}）`);
    if (a.disposition) bits.push(`**处置** \`${a.disposition.choice}\`（置信 ${pct(a.disposition.confidence)}）`);
    if (a.naming_clarity) bits.push(`**命名清晰度** ${a.naming_clarity.score.toFixed(2)}/2（置信 ${pct(a.naming_clarity.confidence)}）`);
    if (a.boundary_enforced) bits.push(`**边界已正确执行** ${pct(a.boundary_enforced.noul)}`);
    if (a.verification_strength) {
      const lv = Math.round(a.verification_strength.score);
      bits.push(`**保障强度** ${a.verification_strength.score.toFixed(2)}/2 —— ${a.verification_strength.legend?.[String(lv)] || ""}（置信 ${pct(a.verification_strength.confidence)}）`);
    }
    for (const b of bits) L.push(`- ${b}`);
    L.push("");
  }

  L.push("## 三、开销");
  L.push("");
  L.push(`- 请求数：${judged.length}`);
  L.push(`- 输入 tokens：${totals.in} · 输出 tokens：${totals.out}`);
  L.push(`- 端到端：${(totals.ms / 1000).toFixed(1)} 秒（并发 ${CONC}）`);
  L.push("");
  L.push("> 阈值与处置口径需在真实数据上校准；本报告只提供判定与证据，不自动改动仓库。");
  L.push("");
  return L.join("\n");
}

/* ------------------------------------------------------------------ main */
(async () => {
  console.log("① 确定性对账…");
  const r = reconcile();
  console.log(`   清单 ${r.manifestCount} 条 | 磁盘 audio ${r.diskAudioCount} 个`);
  console.log(`   缺失 ${r.missingOnDisk.length} | 未登记 ${r.unlisted.length} | art ${r.artCount} (声称 ${r.claimedArt})`);
  console.log(`   接线盲区: ${r.wiringGaps.map((g) => g.dir + "(" + g.count + ")").join(", ") || "无"}`);

  const items = buildItems(r);
  console.log(`② 审计项 ${items.length} 个`);

  if (DRY) {
    items.forEach((it, i) => console.log(`   [${i + 1}] ${it.title}`));
    console.log("--dry：不调用模型。");
    return;
  }

  const key = loadKey();
  const queue = items.slice(0, LIMIT === Infinity ? items.length : LIMIT);
  const judged = [];
  const failures = [];
  let inTok = 0, outTok = 0, wall = 0;

  const t0 = Date.now();
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const it = queue[cursor++];
      try {
        const j = await judge(key, it);
        judged.push(j);
        inTok += (j.usage && j.usage.input_tokens) || 0;
        outTok += (j.usage && j.usage.output_tokens) || 0;
        wall = Math.max(wall, j.ms);
        console.log(`   ✓ ${it.title.slice(0, 52)}  (${j.ms}ms)`);
      } catch (e) {
        failures.push({ id: it.id, error: String(e.message || e) });
        console.log(`   ✗ ${it.id}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, worker));

  const totals = { in: inTok, out: outTok, ms: Date.now() - t0 };
  fs.writeFileSync(OUT_JSON, JSON.stringify({ reconciled: {
    manifestCount: r.manifestCount, diskAudioCount: r.diskAudioCount,
    missingOnDisk: r.missingOnDisk, unlisted: r.unlisted,
    artCount: r.artCount, claimedArt: r.claimedArt, coversArt: r.coversArt,
    wiringGaps: r.wiringGaps,
    gitVideo: r.gitVideo, gitAudio: r.gitAudio ? { ok: r.gitAudio.ok, count: r.gitAudio.ok ? r.gitAudio.files.length : null } : null,
  }, judged, failures, totals }, null, 2), "utf8");
  fs.writeFileSync(OUT_MD, renderMarkdown(r, judged, totals), "utf8");

  console.log(`③ 完成：${judged.length} 项判定，${failures.length} 项失败`);
  console.log(`   tokens in=${inTok} out=${outTok} · 端到端 ${(totals.ms / 1000).toFixed(1)}s`);
  console.log(`   → ${OUT_MD}`);
  console.log(`   → ${OUT_JSON}`);
})();
