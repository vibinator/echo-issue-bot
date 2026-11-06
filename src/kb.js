// Known problems & fixes for Echo VR, used to answer common errors before a report is filed.
// Written from the public READMEs / release notes of the community projects below. Edit freely as the
// community tooling changes â€“ each entry is { id, title, symptoms, pattern?, fix, source }.
//   symptoms: typical player wording (fuzzy-matched, typo tolerant)
//   pattern:  optional exact error signature (regex) that always matches
import { rankSimilar } from './similarity.js';

const LAUNCHER = 'EchoVR_Launcher release notes';
const INSTALLER = 'EchoVR-Installer README';
const NEVR = 'nevr-runtime README';
const XR = 'EchoXR README';

export const KB = [
  {
    id: 'gpu_hang', title: 'GPU hang while the lobby loads (D3D device removed)',
    symptoms: 'game crashes while lobby loading d3d device has been removed device hung gpu hang pc steamvr black screen loading lobby',
    pattern: /DXGI_ERROR_DEVICE_HUNG|d3d device (has been )?removed|device hung/i,
    fix: 'â€¢ Update the **Echo VR Launcher** and **EchoXR**.\nâ€¢ This was fixed in EchoXR 0.6.1, with a further fix in EchoXR 0.6.4 (launcher 0.13.12) for the newest Echo VR build.\nâ€¢ If it still happens, use the launcher\'s **Upload logs** button and mention it in your report.',
    source: LAUNCHER,
  },
  {
    id: 'apk_newer', title: 'Quest refused the APK: "Newer"',
    symptoms: 'quest refused the apk newer install failed echo vr installed in another profile',
    pattern: /refused the apk/i,
    fix: 'â€¢ This happens when Echo VR is installed in a different Quest profile.\nâ€¢ Update the **Echo VR Launcher** (0.13.6+ installs to the main profile) and try the install again.',
    source: LAUNCHER,
  },
  {
    id: 'different_build', title: '"The Echo VR already on this headset is a different build"',
    symptoms: 'echo vr already on this headset is a different build install installer android will not overwrite',
    pattern: /different build/i,
    fix: 'â€¢ Another Echo VR build is installed and Android won\'t overwrite it.\nâ€¢ **Uninstall Echo VR** on the headset, then run the installer again.',
    source: INSTALLER,
  },
  {
    id: 'download_corrupted', title: '"Download was corrupted"',
    symptoms: 'download was corrupted corrupt download installer game data quest',
    pattern: /download (was )?corrupt/i,
    fix: 'â€¢ Tap the download button again to restart the download.\nâ€¢ If it keeps failing, restart the headset or switch Wi-Fi networks.',
    source: INSTALLER,
  },
  {
    id: 'download_fails', title: 'Downloads won\'t start or keep failing on Quest',
    symptoms: 'downloads do not work download stuck failed quest installer game data wifi network connection download error',
    fix: 'â€¢ Restart the headset or switch to a different Wi-Fi network, then retry.\nâ€¢ Failed launcher downloads usually mean a connection problem â€“ check your connection first.',
    source: INSTALLER,
  },
  {
    id: 'quest_launch_crash', title: 'Quest: game crashes on first launch after installing',
    symptoms: 'quest game crashes on launch right after install first launch crash permissions microphone storage game data missing',
    fix: 'â€¢ You most likely opened the game before granting permissions or downloading game data.\nâ€¢ Grant **Microphone** and **storage** permissions, download the game data (about 940 MB), then **restart the headset**.\nâ€¢ Still crashing? Uninstall and reinstall Echo VR.',
    source: INSTALLER,
  },
  {
    id: 'beta_to_stable', title: 'Switched from Beta to Stable but nothing changed',
    symptoms: 'switched from beta to stable nothing changed still on beta downgrade older version quest channel',
    fix: 'â€¢ Android can\'t install an older build over a newer one.\nâ€¢ In the **Echo VR Launcher** use **Reinstall** (0.13.11+) to go from a newer Beta back to Stable â€“ it restores your data afterwards.',
    source: LAUNCHER,
  },
  {
    id: 'idle_cpu', title: 'Launcher uses lots of CPU/GPU while idle',
    symptoms: 'launcher high cpu gpu usage idle background video fans loud hot noisy overheating laggy launcher',
    fix: 'â€¢ Update the launcher to **0.13.13 or newer** â€“ the background video now pauses after 30 seconds without input.\nâ€¢ You can also switch off **Settings â†’ Animated background**.',
    source: LAUNCHER,
  },
  {
    id: 'server_plugin_old', title: 'Stuck on an old Server host plugin',
    symptoms: 'server host plugin old version stuck not updating plugin dev code launcher',
    fix: 'â€¢ Restart the launcher, then go to **Plugins â†’ Server host â†’ Update**. Your servers and settings are kept.',
    source: LAUNCHER,
  },
  {
    id: 'linux_not_downloaded', title: 'Linux/Steam: "EchoXR isn\'t downloaded"',
    symptoms: 'linux steam echoxr is not downloaded after update start from steam proton',
    pattern: /echoxr isn'?t downloaded/i,
    fix: 'â€¢ Fixed in launcher **0.13.6** â€“ update the launcher, then start from Steam again.',
    source: LAUNCHER,
  },
  {
    id: 'echoxr_exit', title: 'EchoXR won\'t start (no OpenXR runtime / no headset)',
    symptoms: 'echoxr will not start exits immediately no openxr runtime no headset detected steamvr not running monado wivrn headset asleep exit code',
    pattern: /openxr runtime|no headset detected/i,
    fix: 'â€¢ **5** â€“ no OpenXR runtime answered (or, under Proton, its VR service isn\'t running): start **SteamVR** (or Monado / WiVRn) *before* launching.\nâ€¢ **6** â€“ the runtime has no headset: connect it and wake it up (asleep for more than 15 s counts as missing).\nâ€¢ **2** â€“ `EchoXR.exe` isn\'t next to `echovr.exe` in `bin\\win10`.\nâ€¢ **3** â€“ `EchoXR\\LibOVRRT64_1.dll` or `openxr_loader.dll` is missing.\nâ€¢ **4** â€“ `echovr_openxr.exe` couldn\'t be made Â· **7** â€“ Echo couldn\'t be started.\nâ€¢ Check `EchoXR\\launcher.log` and `runtime.log` and attach them to your report.',
    source: XR,
  },
  {
    id: 'echoxr_build', title: 'EchoXR refuses the game binary',
    symptoms: 'echoxr refuses echovr exe wrong build version not supported patch bytes do not match unsupported build size',
    fix: 'â€¢ EchoXR only patches the Echo VR build whose `echovr.exe` is **35,397,120 bytes** (May 2023) and refuses anything else instead of breaking the game.\nâ€¢ Install/repair the supported build with the Echo VR Launcher, then start EchoXR again. The five event builds (Halloween/Christmas 2017 & 2018, Summer 2019) go in `bin\\win7`.',
    source: XR,
  },
  {
    id: 'echoxr_logs', title: 'Which logs to send with a report',
    symptoms: 'where are the logs which logs should i send log files echoxr launcher log runtime log platform log r14logs bug report crash logs',
    fix: 'â€¢ **EchoXR:** `bin\\win10\\EchoXR\\launcher.log`, `runtime.log` and `platform.log`.\nâ€¢ **Echo VR itself:** `_local\\r14logs\\*.log`.\nâ€¢ **Launcher:** use **Upload logs** (it collects Quest logs automatically).\nâ€¢ **Linux:** `~/.local/share/echoxr/echoxr-linux.log` (set `ECHOXR_DEBUG=1` for Proton/OpenXR loader logs).\nAdd them to your report with **Add screenshots / logs** after reporting.',
    source: XR,
  },
  {
    id: 'pc_install_howto', title: 'How to install Echo VR on PC',
    symptoms: 'how do i install echo vr on pc windows installer download install button where to download how to play echo vr computer',
    fix: '1. Download the Echo VR installer and run it, going through its install steps.\n2. On the main page click **Install** on the left, then the big green **install** button.\n3. Wait for it to finish, then play.\nðŸ“º Video guide: https://www.youtube.com/watch?v=6v6J5gfLlek',
    source: 'Echo VR PC install guide',
  },
  {
    id: 'quest_install_howto', title: 'How to install Echo VR on Quest',
    symptoms: 'how do i install echo vr on quest installer cannot find installer unknown sources package installer oculus browser downloads file location install echovr headset standalone',
    fix: '1. In the **Oculus Browser** (inside VR) open the install guide and download the installer.\n2. Click the â¬‡ icon â†’ **See all downloads** â†’ â‹¯ next to the Echo VR installer â†’ **Open File Location**.\n3. In the Files app click â‹¯ â†’ **Open with â†’ Package Installer**, allow the permission it asks for, then **Install** â†’ **Open**. (If you pressed Cancel, find the installer again under *Unknown sources* in your games and apps.)\n4. In the installer pick **Install EchoVR**, then **Download game data**, wait for it to finish and press **Play**.\nðŸ“º Video: https://www.youtube.com/watch?v=hGPEQAGB148\nHelp: Echo VR Lounge Discord â†’ #quest-install',
    source: 'Echo VR Quest install guide',
  },
  {
    id: 'quest_install_vanishes', title: 'Quest: tapping Install does nothing (popup vanishes)',
    symptoms: 'quest game will not install cancel or install popup vanishes click install nothing happens installer does nothing alt account other profile owned echo before shutdown',
    fix: 'If the **Cancel / Install** popup disappears and nothing happens:\nâ€¢ If you **owned Echo VR before the shutdown**, install it through **Meta** (the store), then uninstall it with the **installer app** itself and retry.\nâ€¢ If you didn\'t own it, you probably have an **alt account** on the headset â€“ sign in to each account and **uninstall Echo VR on all of them**.\nâ€¢ Then go back to your **main account** and install Echo VR again.',
    source: 'Echo VR community support (Quest)',
  },
  {
    id: 'quest_parse_package', title: 'Quest: "There was a problem parsing the package"',
    symptoms: 'quest error whilst parsing the package problem parsing the package apk install failed files app permission package installer',
    pattern: /problem parsing the package|error whilst parsing the package/i,
    fix: 'This happens when the **Files** app doesn\'t have permission to install APKs.\n1. In the Files app, tap **Quest 3 / 3s / 2** on the left.\n2. Open the **Downloads** folder and find **EchoVR Installer**.\n3. Tap â‹¯ â†’ **Open with â†’ Package Installer**.\n4. **Grant the permission** it asks for, then install.',
    source: 'Echo VR community support (Quest)',
  },
  {
    id: 'quest_data_stuck', title: 'Quest: game data download looks stuck',
    symptoms: 'quest game data download stuck frozen not moving progress bar stopped download game data stays at same percent slow',
    fix: '1. **Wait a few extra minutes** â€“ it can look stuck while it is still working.\n2. If it still doesn\'t move, **restart your Wi-Fi or the headset** and try again.\n3. If that doesn\'t work, the connection is most likely **down or blocked** (for example by a router, firewall or network filter).',
    source: 'Echo VR community support (Quest)',
  },
  {
    id: 'quest_installer_conflict', title: 'Quest: installer won\'t update ("conflicts with an existing package")',
    symptoms: 'quest installer will not update conflicts with an existing package app not installed conflict update installer fails existing package',
    pattern: /conflicts? with an existing package/i,
    fix: '1. Go to **Unknown sources** on your headset, find the **EchoVR installer** and tap â‹¯ â†’ **Uninstall**.\n2. **Reinstall the installer from EchoVRCE.**\n3. Open the installer.',
    source: 'Echo VR community support (Quest)',
  },
  {
    id: 'failed_to_load_level', title: 'PC: "Failed To Load Level" (Windows 11 Smart App Control)',
    symptoms: 'pc failed to load level error windows 11 smart app control blocks echo vr game wont start antivirus blocking exclusion defender',
    pattern: /failed to load level/i,
    fix: 'This is caused by Windows 11 **Smart App Control**.\n**1. Turn it off:** Start â†’ **Settings â†’ Privacy & security â†’ Windows Security â†’ App & browser control â†’ Smart App Control settings â†’ Off** (confirm if asked).\n\n**2. Still failing? Add Echo VR to your antivirus exclusions:** Start â†’ *Windows Security* â†’ **Virus & threat protection â†’ Manage settings â†’ Add or remove exclusions â†’ + Add an exclusion**, then choose the Echo VR **folder** (or the `.exe` file / process). Confirm the UAC prompt.\n\n_Note: turning protection off lowers your PC\'s security, so only do this for software you trust._',
    source: 'Echo VR community support (PC)',
  },
  {
    id: 'steam_players', title: 'Playing on Steam (PC): which option to choose',
    symptoms: 'steam player pc how to play echo vr on steam which option echoxr hands finger tracking hand tracking mods section launcher steamvr',
    fix: 'â€¢ If you play on **Steam**, choose the **EchoXR** option in the Echo VR Launcher.\nâ€¢ It comes with **EchoXR Hands**: full **finger tracking**, which other players with the mod can see. Find it in the **Mods** section on the left of the launcher.',
    source: 'Echo VR community support (PC)',
  },
  {
    id: 'quest_mic_permission', title: 'Quest: microphone doesn\'t work in Echo VR',
    symptoms: 'quest microphone not working no mic in echo vr cannot talk nobody can hear me mic permission grant permissions installer',
    fix: 'â€¢ Open the Echo VR **installer** app and tap **Grant EchoVR permissions**, then allow microphone access.\nâ€¢ Restart Echo VR afterwards.',
    source: 'Echo VR Quest install guide',
  },
  {
    id: 'quest_uninstall', title: 'How to uninstall Echo VR on Quest',
    symptoms: 'how to uninstall echo vr quest remove echo vr completely delete game uninstall installer',
    fix: 'â€¢ Open the Echo VR installer app and tap **Uninstall Echo VR** â€“ this removes it entirely.',
    source: 'Echo VR Quest install guide',
  },
  {
    id: 'spark_windows', title: 'Spark Mini on Windows',
    symptoms: 'spark mini not working on windows pc spark app which spark to use',
    fix: 'â€¢ **Spark Mini** is the lighter app for **non-Windows** devices. On Windows use the main **Spark** app, which has the larger feature set.',
    source: 'Spark-Mini README',
  },
  {
    id: 'cosmetic_quest_access', title: 'Cosmetic editor can\'t read/write Quest game files',
    symptoms: 'cosmetic editor quest cannot access game files all files access permission adb repack apply fails android data',
    fix: 'â€¢ The Quest build needs **All files access** to read and write the game files. It can be granted from a PC with **ADB**.\nâ€¢ Quest mode only **repacks** (extraction isn\'t supported there).',
    source: 'cosmetic-editor README',
  },
  {
    id: 'cosmetic_mod_refused', title: 'Cosmetic editor refuses a mod zip',
    symptoms: 'cosmetic editor mod zip refused wrong platform quest pc mod not applying repack staged cosmetics missing database',
    fix: 'â€¢ A mod built for the **other platform** (PC vs Quest) is refused.\nâ€¢ A mod\'s own cosmetic database is skipped on purpose â€“ the editor writes its own on every **Repack & Apply**.\nâ€¢ **Revert** restores the original manifest and removes only the chunks the editor added.',
    source: 'cosmetic-editor README',
  },
  {
    id: 'texture_editor_quest', title: 'Texture editor with Quest standalone',
    symptoms: 'texture editor quest standalone data decompress compress cosmetic texture not working quest data zip',
    fix: 'â€¢ For Quest standalone the editor needs the Quest data download (`_data.zip`). Use the in-app **tutorial** (top left) if you get stuck; `Examples.zip` has every cosmetic texture as a reference.',
    source: 'EchoVR-Texture-Editor README',
  },
  {
    id: 'mesh_parts_vanish', title: 'Mesh parts disappear at a distance (Blender export)',
    symptoms: 'blender mesh export parts disappear far away chassis bone lod culling vertex groups model vanishes distance evr mesh importer',
    fix: 'â€¢ Detail bones are disabled at distance on chassis models. Delete the vertex groups, create one group named **`Bone.000`** and assign every vertex to it at weight **1.0**.\nâ€¢ Exports may exceed the original file size, up to 65,535 vertices per submesh.',
    source: 'evr-mesh-importer README',
  },
  {
    id: 'lone_echo_import', title: 'Lone Echo import looks doubled or too bright',
    symptoms: 'lone echo blender import duplicate geometry stacked lods too bright double lit lights opaque materials missing textures corpus index',
    fix: 'â€¢ Import **LOD 0** only â€“ "All levels" stacks duplicate geometry.\nâ€¢ Lights are off by default; importing all of them is ~7Ã— too bright (the baked lightmap isn\'t auto-wired).\nâ€¢ If materials look opaque, generate the corpus indexes once from your install.',
    source: 'lone_echo_blender README',
  },
  {
    id: 'linux_ovr_dll', title: 'Linux: EchoXR ignored because of LibOVRPlatform64_1.dll',
    symptoms: 'linux echoxr proton libovrplatform dll in bin win10 oculus platform dll not working',
    pattern: /LibOVRPlatform64_1\.dll/i,
    fix: 'â€¢ Delete any existing `LibOVRPlatform64_1.dll` from `bin/win10` â€“ it gets used instead of EchoXR\'s copy.\nâ€¢ Then run `echoxr-linux.sh --check` and start it again without `--check`.',
    source: XR,
  },
  {
    id: 'nevr_78', title: 'Game exits with code 78 (nEVR runtime)',
    symptoms: 'game exits with code 78 runtime failed to load after attach nevr',
    pattern: /(exit|code)\D{0,15}\b78\b/i,
    fix: 'â€¢ Code 78 means the nEVR runtime failed to load after it attached to the game. Check the runtime log for the cause and include it in your report.',
    source: NEVR,
  },
  {
    id: 'nevr_64', title: 'Game exits with code 64 (config file)',
    symptoms: 'game exits with code 64 config file missing unreadable config-file flag nevr',
    pattern: /(exit|code)\D{0,15}\b64\b/i,
    fix: 'â€¢ Code 64 means the file passed with `-config-file` is missing or unreadable. Check the path, or remove the flag to use the default `config.yaml`.',
    source: NEVR,
  },
  {
    id: 'nevr_refused', title: 'echovr.exe is refused',
    symptoms: 'echovr exe refused wrong game image damaged corrupted game files nevr install',
    pattern: /echovr\.exe.{0,30}refused|refused.{0,30}echovr\.exe/i,
    fix: 'â€¢ The game image is wrong or damaged. **Verify / repair the game files** (launcher or Steam), then install the runtime again.',
    source: NEVR,
  },
  {
    id: 'proton8', title: 'Crash in dxgi.dll on Proton 8.0',
    symptoms: 'proton 8.0 crashes dxgi dll linux steam deck wine crash on start',
    pattern: /dxgi\.dll|proton 8/i,
    fix: 'â€¢ Proton 8.0 (8.0-103) crashes in `dxgi.dll`. Switch to **Proton Experimental** (or a recent Wine) â€“ these are the versions reported to work.',
    source: NEVR,
  },
  {
    id: 'quest_incompatible', title: 'Quest: INSTALL_FAILED_UPDATE_INCOMPATIBLE',
    symptoms: 'install failed update incompatible adb install apk quest community installer',
    pattern: /INSTALL_FAILED_UPDATE_INCOMPATIBLE/i,
    fix: 'â€¢ After using the community installer, uninstall the existing app once (`com.readyatdawn.r15`), then run `adb install` on the new APK.',
    source: NEVR,
  },
  {
    id: 'quest_data_missing', title: 'Quest: "Echo VR game data is missing"',
    symptoms: 'echo vr game data is missing quest nevr apk start game no data',
    pattern: /game data is missing/i,
    fix: 'â€¢ Install Echo VR with the **Echo Launcher** first so the game data is present, then start the game again.',
    source: NEVR,
  },
  {
    id: 'server_config', title: 'Dedicated server stops right after starting',
    symptoms: 'dedicated server stops at start closes immediately malformed config yaml server never stops no config',
    fix: 'â€¢ A malformed `config.yaml` stops dedicated servers. Check the file for YAML mistakes (or move it aside to start with defaults).',
    source: NEVR,
  },
  {
    id: 'haptics', title: 'No haptics / rumble on Oculus headsets',
    symptoms: 'no haptics rumble vibration controllers not vibrating oculus meta rift quest link haptic feedback missing',
    fix: 'â€¢ The Meta app ignores Echo VR\'s haptic output. The **Haptics Fix** release in `heisthecat31/EchoVR-Haptics` translates it into something Meta accepts â€“ download it and run **RUN-ME.bat**.',
    source: 'EchoVR-Haptics releases',
  },
  {
    id: 'host_not_registering', title: 'Hosted servers won\'t launch or register',
    symptoms: 'server host servers will not start not registering not showing hosting instances failed approve sync windows firewall',
    fix: 'â€¢ Open the **Doctor** tab in the launcher\'s hosting menu for diagnostics and fixes.\nâ€¢ Allow the **Windows Firewall** prompts when servers start.\nâ€¢ Approval/sync can take a few minutes â€“ retry the approval button.',
    source: 'EchoVR-Windows-Hosts-Resources README',
  },
  {
    id: 'login', title: 'Can\'t sign in to the community service',
    symptoms: 'cannot login sign in failed discord login not working account authentication error echovrce',
    fix: 'â€¢ The community service uses **Discord sign-in**. In the Echo VR Launcher open **Community** and sign in to **EchoVRCE** with your Discord account, then start the game again.',
    source: LAUNCHER,
  },
  {
    id: 'quest_gaps', title: 'Quest: friends list / party "Invite Members" missing',
    symptoms: 'quest friends list not working main menu party invite members not working cannot invite friends party tab',
    fix: 'â€¢ These are **known gaps** on Quest in nEVR (the main-menu friends list and the party tab\'s Invite Members) and are already tracked as nevr-runtime issues #391 and #318. No fix is available yet.',
    source: NEVR,
  },
];

// Tuned on a set of realistic player sentences (typos, loose wording, and look-alike non-matches). A match only
// re-orders the "is it one of these?" menu and never blocks anyone, so a slightly generous cut-off is safe.
export const KB_THRESHOLD = 0.2;      // built-in answers
export const ARTICLE_THRESHOLD = 0.2; // developer-written articles

/**
 * Suggested answers for a report, best first (at most `max`).
 * `custom` = the server's enabled knowledge articles from the database.
 * Each suggestion: { id ('kb:<id>' | 'a:<id>'), title, fix, source, score, custom }.
 */
/** Built-in answers about installing / updating / downloading (hidden from "Bug in game" reports). */
const INSTALL_IDS = new Set([
  'apk_newer', 'different_build', 'download_corrupted', 'download_fails', 'quest_launch_crash', 'beta_to_stable', 'quest_incompatible',
  'quest_data_missing', 'pc_install_howto', 'quest_install_howto', 'quest_install_vanishes', 'quest_parse_package', 'quest_data_stuck',
  'quest_installer_conflict', 'quest_uninstall', 'quest_mic_permission',
]);

// Platform words: someone asking about Quest should not be pointed at the PC guide, and the other way round.
const PLATFORM_WORDS = { quest: /\b(quest\d?|oculus|meta|headset|standalone|apk|sideload|adb)\b/, pc: /\b(pc|windows|steam|steamvr|computer|desktop|exe)\b/, linux: /\b(linux|proton|wine|deck)\b/ };
const platformsIn = (t) => new Set(Object.entries(PLATFORM_WORDS).filter(([, re]) => re.test(t.toLowerCase())).map(([p]) => p));

/**
 * `boost`: optional Map(id -> multiplier) learned from how players reacted (see index.js): answers that often fix the
 * problem rank a little higher, ones players keep calling "not my problem" a little lower.
 */
export function suggest(text, custom = [], max = 3, kind = null, boost = new Map()) {
  const lower = text.toLowerCase();
  const asked = platformsIn(text);
  const pool = [
    ...KB.filter((e) => !(kind === 'bug' && INSTALL_IDS.has(e.id))).map((e) => ({
      id: `kb:${e.id}`, title: e.title, fix: e.fix, source: e.source, custom: false, threshold: KB_THRESHOLD,
      text: `${e.title} ${e.symptoms}`, exact: e.pattern ? e.pattern.test(text) : false,
    })),
    ...custom.map((a) => ({
      id: `a:${a.id}`, title: a.title, fix: a.link ? `${a.body}\n\nðŸ”— ${a.link}` : a.body, source: 'Server knowledge base',
      custom: true, threshold: ARTICLE_THRESHOLD, text: `${a.title} ${a.symptoms}`,
      exact: (a.phrases ?? '').split('\n').map((p) => p.trim().toLowerCase()).some((p) => p.length >= 4 && lower.includes(p)),
    })),
  ];
  const scores = new Map(rankSimilar(text, pool.map((p) => ({ id: p.id, text: p.text }))).map((r) => [r.id, r.score]));
  const adjust = (p, score) => {
    if (p.exact) return 1;
    let s = score * (boost.get(p.id) ?? 1);
    if (asked.size) { // the player named a platform: favour answers for it, demote answers only for another one
      const mine = platformsIn(p.text);
      if (mine.size) s *= [...mine].some((x) => asked.has(x)) ? 1.15 : 0.6;
    }
    return Math.min(1, s);
  };
  return pool
    .map((p) => ({ p, score: adjust(p, scores.get(p.id) ?? 0) }))
    .filter(({ p, score }) => score >= p.threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ p, score }) => ({ id: p.id, title: p.title, fix: p.fix, source: p.source, score, custom: p.custom }));
}

/**
 * The "is it one of these?" list shown before a ticket form opens: every answer that fits the ticket type,
 * the server's own articles first. Same shape as suggest() results.
 */
export function faqEntries(kind, custom = []) {
  const mine = custom.map((a) => ({
    id: `a:${a.id}`, title: a.title, fix: a.link ? `${a.body}\n\nðŸ”— ${a.link}` : a.body, source: 'Server knowledge base', custom: true,
  }));
  const builtIn = KB.filter((e) => (kind === 'install') === INSTALL_IDS.has(e.id))
    .map((e) => ({ id: `kb:${e.id}`, title: e.title, fix: e.fix, source: e.source, custom: false }));
  return [...mine, ...builtIn];
}

/** Best built-in match only: { entry, score } or null. (Kept for simple callers and tests.) */
export function matchKb(text) {
  const best = suggest(text, [], 1)[0];
  return best ? { entry: KB.find((e) => `kb:${e.id}` === best.id), score: best.score } : null;
}
