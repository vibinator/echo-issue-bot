// Known problems & fixes for Echo VR, used to answer common errors before a report is filed.
// Written from the public READMEs / release notes of the community projects below. Edit freely as the
// community tooling changes – each entry is { id, title, symptoms, pattern?, fix, source }.
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
    fix: '• Update the **Echo VR Launcher** and **EchoXR**.\n• This was fixed in EchoXR 0.6.1, with a further fix in EchoXR 0.6.4 (launcher 0.13.12) for the newest Echo VR build.\n• If it still happens, use the launcher\'s **Upload logs** button and mention it in your report.',
    source: LAUNCHER,
  },
  {
    id: 'apk_newer', title: 'Quest refused the APK: "Newer"',
    symptoms: 'quest refused the apk newer install failed echo vr installed in another profile',
    pattern: /refused the apk/i,
    fix: '• This happens when Echo VR is installed in a different Quest profile.\n• Update the **Echo VR Launcher** (0.13.6+ installs to the main profile) and try the install again.',
    source: LAUNCHER,
  },
  {
    id: 'different_build', title: '"The Echo VR already on this headset is a different build"',
    symptoms: 'echo vr already on this headset is a different build install installer android will not overwrite',
    pattern: /different build/i,
    fix: '• Another Echo VR build is installed and Android won\'t overwrite it.\n• **Uninstall Echo VR** on the headset, then run the installer again.',
    source: INSTALLER,
  },
  {
    id: 'download_corrupted', title: '"Download was corrupted"',
    symptoms: 'download was corrupted corrupt download installer game data quest',
    pattern: /download (was )?corrupt/i,
    fix: '• Tap the download button again to restart the download.\n• If it keeps failing, restart the headset or switch Wi-Fi networks.',
    source: INSTALLER,
  },
  {
    id: 'download_fails', title: 'Downloads won\'t start or keep failing on Quest',
    symptoms: 'downloads do not work download stuck failed quest installer game data wifi network connection download error',
    fix: '• Restart the headset or switch to a different Wi-Fi network, then retry.\n• Failed launcher downloads usually mean a connection problem – check your connection first.',
    source: INSTALLER,
  },
  {
    id: 'quest_launch_crash', title: 'Quest: game crashes on first launch after installing',
    symptoms: 'quest game crashes on launch right after install first launch crash permissions microphone storage game data missing',
    fix: '• You most likely opened the game before granting permissions or downloading game data.\n• Grant **Microphone** and **storage** permissions, download the game data (about 940 MB), then **restart the headset**.\n• Still crashing? Uninstall and reinstall Echo VR.',
    source: INSTALLER,
  },
  {
    id: 'beta_to_stable', title: 'Switched from Beta to Stable but nothing changed',
    symptoms: 'switched from beta to stable nothing changed still on beta downgrade older version quest channel',
    fix: '• Android can\'t install an older build over a newer one.\n• In the **Echo VR Launcher** use **Reinstall** (0.13.11+) to go from a newer Beta back to Stable – it restores your data afterwards.',
    source: LAUNCHER,
  },
  {
    id: 'idle_cpu', title: 'Launcher uses lots of CPU/GPU while idle',
    symptoms: 'launcher high cpu gpu usage idle background video fans loud laggy launcher',
    fix: '• Update the launcher to **0.13.13 or newer** – the background video now pauses after 30 seconds without input.\n• You can also switch off **Settings → Animated background**.',
    source: LAUNCHER,
  },
  {
    id: 'server_plugin_old', title: 'Stuck on an old Server host plugin',
    symptoms: 'server host plugin old version stuck not updating plugin dev code launcher',
    fix: '• Restart the launcher, then go to **Plugins → Server host → Update**. Your servers and settings are kept.',
    source: LAUNCHER,
  },
  {
    id: 'linux_not_downloaded', title: 'Linux/Steam: "EchoXR isn\'t downloaded"',
    symptoms: 'linux steam echoxr is not downloaded after update start from steam proton',
    pattern: /echoxr isn'?t downloaded/i,
    fix: '• Fixed in launcher **0.13.6** – update the launcher, then start from Steam again.',
    source: LAUNCHER,
  },
  {
    id: 'echoxr_exit', title: 'EchoXR won\'t start (no OpenXR runtime / no headset)',
    symptoms: 'echoxr will not start exits immediately no openxr runtime no headset detected steamvr not running monado wivrn headset asleep exit code',
    pattern: /openxr runtime|no headset detected/i,
    fix: '• **Exit code 5** – no OpenXR runtime answered: start **SteamVR** (or Monado / WiVRn on Linux) *before* launching.\n• **Exit code 6** – no headset detected: connect it and wake it up, and check it works in SteamVR first.\n• **Codes 2, 3, 4, 7** – install problem: check `bin/win10/EchoXR/launcher.log` and `runtime.log`.',
    source: XR,
  },
  {
    id: 'linux_ovr_dll', title: 'Linux: EchoXR ignored because of LibOVRPlatform64_1.dll',
    symptoms: 'linux echoxr proton libovrplatform dll in bin win10 oculus platform dll not working',
    pattern: /LibOVRPlatform64_1\.dll/i,
    fix: '• Delete any existing `LibOVRPlatform64_1.dll` from `bin/win10` – it gets used instead of EchoXR\'s copy.\n• Then run `echoxr-linux.sh --check` and start it again without `--check`.',
    source: XR,
  },
  {
    id: 'nevr_78', title: 'Game exits with code 78 (nEVR runtime)',
    symptoms: 'game exits with code 78 runtime failed to load after attach nevr',
    pattern: /(exit|code)\D{0,15}\b78\b/i,
    fix: '• Code 78 means the nEVR runtime failed to load after it attached to the game. Check the runtime log for the cause and include it in your report.',
    source: NEVR,
  },
  {
    id: 'nevr_64', title: 'Game exits with code 64 (config file)',
    symptoms: 'game exits with code 64 config file missing unreadable config-file flag nevr',
    pattern: /(exit|code)\D{0,15}\b64\b/i,
    fix: '• Code 64 means the file passed with `-config-file` is missing or unreadable. Check the path, or remove the flag to use the default `config.yaml`.',
    source: NEVR,
  },
  {
    id: 'nevr_refused', title: 'echovr.exe is refused',
    symptoms: 'echovr exe refused wrong game image damaged corrupted game files nevr install',
    pattern: /echovr\.exe.{0,30}refused|refused.{0,30}echovr\.exe/i,
    fix: '• The game image is wrong or damaged. **Verify / repair the game files** (launcher or Steam), then install the runtime again.',
    source: NEVR,
  },
  {
    id: 'proton8', title: 'Crash in dxgi.dll on Proton 8.0',
    symptoms: 'proton 8.0 crashes dxgi dll linux steam deck wine crash on start',
    pattern: /dxgi\.dll|proton 8/i,
    fix: '• Proton 8.0 (8.0-103) crashes in `dxgi.dll`. Switch to **Proton Experimental** (or a recent Wine) – these are the versions reported to work.',
    source: NEVR,
  },
  {
    id: 'quest_incompatible', title: 'Quest: INSTALL_FAILED_UPDATE_INCOMPATIBLE',
    symptoms: 'install failed update incompatible adb install apk quest community installer',
    pattern: /INSTALL_FAILED_UPDATE_INCOMPATIBLE/i,
    fix: '• After using the community installer, uninstall the existing app once (`com.readyatdawn.r15`), then run `adb install` on the new APK.',
    source: NEVR,
  },
  {
    id: 'quest_data_missing', title: 'Quest: "Echo VR game data is missing"',
    symptoms: 'echo vr game data is missing quest nevr apk start game no data',
    pattern: /game data is missing/i,
    fix: '• Install Echo VR with the **Echo Launcher** first so the game data is present, then start the game again.',
    source: NEVR,
  },
  {
    id: 'server_config', title: 'Dedicated server stops right after starting',
    symptoms: 'dedicated server stops at start closes immediately malformed config yaml server never stops no config',
    fix: '• A malformed `config.yaml` stops dedicated servers. Check the file for YAML mistakes (or move it aside to start with defaults).',
    source: NEVR,
  },
  {
    id: 'haptics', title: 'No haptics / rumble on Oculus headsets',
    symptoms: 'no haptics rumble vibration controllers not vibrating oculus meta rift quest link haptic feedback missing',
    fix: '• The Meta app ignores Echo VR\'s haptic output. The **Haptics Fix** release in `heisthecat31/EchoVR-Haptics` translates it into something Meta accepts – download it and run **RUN-ME.bat**.',
    source: 'EchoVR-Haptics releases',
  },
  {
    id: 'host_not_registering', title: 'Hosted servers won\'t launch or register',
    symptoms: 'server host servers will not start not registering not showing hosting instances failed approve sync windows firewall',
    fix: '• Open the **Doctor** tab in the launcher\'s hosting menu for diagnostics and fixes.\n• Allow the **Windows Firewall** prompts when servers start.\n• Approval/sync can take a few minutes – retry the approval button.',
    source: 'EchoVR-Windows-Hosts-Resources README',
  },
  {
    id: 'login', title: 'Can\'t sign in to the community service',
    symptoms: 'cannot login sign in failed discord login not working account authentication error echovrce',
    fix: '• The community service uses **Discord sign-in**. In the Echo VR Launcher open **Community** and sign in to **EchoVRCE** with your Discord account, then start the game again.',
    source: LAUNCHER,
  },
  {
    id: 'quest_gaps', title: 'Quest: friends list / party "Invite Members" missing',
    symptoms: 'quest friends list not working main menu party invite members not working cannot invite friends party tab',
    fix: '• These are **known gaps** on Quest in nEVR (the main-menu friends list and the party tab\'s Invite Members) and are already tracked as nevr-runtime issues #391 and #318. No fix is available yet.',
    source: NEVR,
  },
];

export const KB_THRESHOLD = 0.35;

/** Returns { entry, score } for the best-matching known problem, or null. */
export function matchKb(text) {
  for (const e of KB) if (e.pattern?.test(text)) return { entry: e, score: 1 };
  const best = rankSimilar(text, KB.map((e) => ({ id: e.id, text: `${e.title} ${e.symptoms}` })))[0];
  if (best && best.score >= KB_THRESHOLD) return { entry: KB.find((e) => e.id === best.id), score: best.score };
  return null;
}
