const UA_RULES = [
  [/Edg\/([\d.]+)/, "Microsoft Edge"],
  [/OPR\/([\d.]+)/, "Opera"],
  [/Vivaldi\/([\d.]+)/, "Vivaldi"],
  [/Brave\/([\d.]+)/, "Brave"],
  [/HeadlessChrome\/([\d.]+)/, "Chrome (headless)"],
  [/Chromium\/([\d.]+)/, "Chromium"],
  [/Chrome\/([\d.]+)/, "Chrome"],
  [/Firefox\/([\d.]+)/, "Firefox"],
  [/Version\/([\d.]+).*Safari/, "Safari"],
];

export function parseUserAgent(value = "") {
  const ua = String(value ?? "");
  let name = "Unknown browser";
  let version = "";

  for (const [pattern, label] of UA_RULES) {
    const match = pattern.exec(ua);
    if (match) {
      name = label;
      version = match[1];
      break;
    }
  }

  let platform = "unknown";
  if (/CrOS/.test(ua)) platform = "chromeos";
  else if (/Android/.test(ua)) platform = "android";
  else if (/iPhone|iPad|iPod/.test(ua)) platform = "ios";
  else if (/Windows NT/.test(ua)) platform = "windows";
  else if (/Mac OS X/.test(ua)) platform = "macos";
  else if (/Linux|X11/.test(ua)) platform = "linux";

  let engine = "unknown";
  if (/Firefox\//.test(ua)) engine = "gecko";
  else if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(ua)) engine = "webkit";
  else if (/Chrome\/|Chromium\/|Edg\/|OPR\/|Vivaldi\//.test(ua)) engine = "chromium";

  return {
    name,
    version,
    platform,
    engine,
    headless: /HeadlessChrome|Headless/.test(ua),
  };
}

export function mergeBrowser(fallback, candidate) {
  const base = fallback && typeof fallback === "object" ? { ...fallback } : {};
  if (!candidate || typeof candidate !== "object") return base;
  for (const key of ["name", "version", "platform", "arch", "engine"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim() && value.length <= 80) {
      base[key] = value.trim();
    }
  }
  if (typeof candidate.headless === "boolean") base.headless = candidate.headless;
  return base;
}

export function browserLabel(browser) {
  if (!browser?.name) return "unknown browser";
  return browser.version ? `${browser.name} ${browser.version}` : browser.name;
}
