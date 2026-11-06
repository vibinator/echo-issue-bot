// Echo VR vocabulary taken from the community tooling READMEs / release notes (EchoVR_Launcher, EchoXR,
// EchoVR-Installer, nevr-runtime, nakama, Spark / Spark-Mini, EchoVR-Haptics, Texture-Editor, cosmetic-editor,
// evr-mesh-importer, lone_echo_blender, Windows-Hosts-Resources) and the Quest install guide.
//
// TERMS      – words typos get corrected TOWARDS (and that are never "corrected" themselves).
// PROTECT    – ordinary words that sit one letter away from a term; listed so they are left alone.
// EXTRA_SYN  – different words players use for the same thing -> one canonical token.

export const TERMS = [
  // software & services
  'echoxr', 'nevr', 'echorelay', 'echovrce', 'nakama', 'spark', 'launcher', 'installer', 'plugin', 'runtime', 'steamvr', 'openxr',
  'monado', 'wivrn', 'proton', 'linux', 'windows', 'revive', 'sidequest', 'adb', 'apk', 'sideload', 'bugsplat', 'dxgi', 'vulkan',
  'discord', 'firewall', 'upnp', 'telemetry', 'headless', 'dedicated', 'tickrate', 'yaml', 'config',
  // hardware / platforms
  'quest', 'oculus', 'airlink', 'headset', 'controller', 'haptics', 'rumble', 'standalone', 'virtual',
  // game
  'lobby', 'arena', 'combat', 'matchmaking', 'spectate', 'scoreboard', 'private', 'region', 'server', 'cosmetic', 'emote',
  // install / files
  'install', 'uninstall', 'reinstall', 'update', 'download', 'permissions', 'microphone', 'storage', 'profile', 'package',
  'manifest', 'repack', 'revert', 'texture', 'emissive', 'decal', 'banner', 'mesh', 'blender', 'deadzone',
  // problems
  'crash', 'freeze', 'corrupted', 'refused', 'incompatible', 'missing', 'disconnect', 'stutter', 'latency',
];

export const PROTECT = [
  'beta', 'batch', 'catch', 'watch', 'latch', 'patch', 'match', 'meta', 'mate', 'wire', 'wine', 'link', 'lost', 'load', 'same',
  'game', 'gave', 'name', 'lane', 'late', 'less', 'loss', 'road', 'stable', 'table', 'cable', 'sound', 'round', 'found',
];

export const EXTRA_SYN = {
  quest: ['quest2', 'quest3', 'quest3s', 'questpro', 'q2', 'q3', 'standalone'],
  install: ['installing', 'installation', 'installed', 'installs', 'setup', 'reinstall', 'reinstalling', 'sideload', 'sideloading'],
  update: ['updating', 'updated', 'updates', 'upgrade', 'upgraded', 'patch', 'newest', 'latest'],
  server: ['servers', 'hosting', 'hosted', 'host', 'hosts', 'dedicated'],
  haptics: ['haptic', 'rumble', 'vibration', 'vibrate', 'vibrating', 'buzz'],
  uninstall: ['uninstalling', 'uninstalled', 'remove', 'removed'],
  crash: ['hung', 'devicehung', 'bsod', 'closing', 'shutdown', 'shuts'],
  join: ['enter', 'entering', 'enters', 'joined', 'joins', 'joining'],
  downgrade: ['revert', 'rollback', 'older', 'previous', 'undo'],
  vanish: ['disappear', 'disappears', 'disappeared', 'vanishes', 'vanished', 'gone'],
  howto: ['guide', 'tutorial', 'instructions', 'walkthrough', 'steps'],
  option: ['options', 'choose', 'chose', 'pick', 'select', 'choice'],
  talk: ['talks', 'talking', 'speak', 'speaks', 'speaking', 'say', 'saying'],
  people: ['players', 'player', 'everyone', 'others', 'person', 'users'],
  stuck: ['frozen', 'stalled', 'hanging'],
  usage: ['using', 'consumption', 'load'],
  lag: ['lagg', 'slow', 'choppy', 'sluggish', 'jittery', 'delay', 'delayed', 'laggy'],
  headset: ['headphones', 'headphone', 'earphone', 'earphones', 'earbuds', 'earbud', 'hmd'],
  texture: ['textures', 'skin', 'skins'],
};
