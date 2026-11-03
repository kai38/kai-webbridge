import { assignRef, ensureAttached, evaluate, getRef, pageInfo, send } from "./cdp.js";
import { clamp, cleanText } from "./util.js";

const MAX_AX_NODES = 20000;
const MAX_RENDER_NODES = 15000;
const MAX_JSON_NODES = 3000;
const MAX_DEPTH = 40;

const SKIP_ROLES = new Set(["InlineTextBox", "LineBreak"]);
const TEXT_ROLES = new Set(["StaticText"]);
const CONTAINER_ROLES = new Set(["generic", "none", "presentation", "RootWebArea"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const NAME_FROM_TEXT_ROLES = new Set([
  "button",
  "link",
  "heading",
  "menuitem",
  "option",
  "tab",
  "treeitem",
]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

export async function capture(tabId, args = {}, tab = null) {
  await ensureAttached(tabId);
  const format = args.format === "aria" ? "aria" : "json";
  const maxChars = clamp(args.max_chars ?? 60000, 1, 60000);
  const interactiveOnly = args.interactive === true;

  const response = await send(tabId, "Accessibility.getFullAXTree", {}, { timeoutMs: 60000 });
  let nodes = response?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("snapshot: the page returned an empty accessibility tree");
  }
  const nodeLimitHit = nodes.length > MAX_AX_NODES;
  if (nodeLimitHit) nodes = nodes.slice(0, MAX_AX_NODES);

  const byId = new Map();
  for (const node of nodes) byId.set(node.nodeId, node);
  const childrenOf = (node) => (node.childIds ?? []).map((id) => byId.get(id)).filter(Boolean);

  let root = null;
  if (args.ref !== undefined) {
    const ref = String(args.ref).replace(/^@/, "");
    const info = getRef(tabId, ref);
    if (!info) throw new Error(`snapshot: unknown ref "${ref}". Run snapshot without ref first.`);
    root = nodes.find((node) => node.backendDOMNodeId === info.backendNodeId) ?? null;
    if (!root) throw new Error(`snapshot: ref "${ref}" no longer exists on the page. Run snapshot again.`);
  } else {
    root = nodes.find((node) => !node.parentId && !node.ignored) ?? nodes.find((node) => !node.parentId) ?? nodes[0];
  }

  const budget = { nodes: 0 };
  const info = await pageInfo(tabId).catch(() => ({}));
  const url = info.url || tab?.url || "";
  const title = info.title || tab?.title || "";

  if (format === "aria") {
    const renderer = { lines: [], length: 0, truncated: false, nodeBudget: 0 };
    walk(root, 0, renderer, { tabId, childrenOf, interactiveOnly, maxChars }, "");
    const truncated = renderer.truncated;
    return {
      url,
      title,
      tree_text: renderer.lines.join("\n"),
      ref_policy: "stable-node",
      ...(truncated || nodeLimitHit ? { truncated: true } : {}),
    };
  }

  const tree = jsonNodes(root, 0, budget, { tabId, childrenOf, interactiveOnly });
  return {
    url,
    title,
    tree,
    ref_policy: "stable-node",
    ...(budget.nodes >= MAX_JSON_NODES || nodeLimitHit ? { truncated: true } : {}),
  };
}

function describe(node, tabId, interactiveOnly) {
  const role = node.role?.value ?? "generic";
  const name = cleanText(node.name?.value, 180);
  const value = cleanText(node.value?.value, 120);
  const interactive = INTERACTIVE_ROLES.has(role);
  if (interactiveOnly && !interactive) {
    return { role, name, value, ref: null, interactive, text: TEXT_ROLES.has(role), valueRelevant: VALUE_ROLES.has(role) };
  }
  let ref = null;
  if (Number.isInteger(node.backendDOMNodeId) && (interactive || name)) {
    ref = assignRef(tabId, node.backendDOMNodeId);
  }
  return {
    role,
    name,
    value,
    ref,
    interactive,
    text: TEXT_ROLES.has(role),
    valueRelevant: VALUE_ROLES.has(role),
  };
}

function walk(node, depth, renderer, context, hideTextForName = "") {
  if (!node || renderer.truncated) return;
  renderer.nodeBudget += 1;
  if (renderer.nodeBudget > MAX_RENDER_NODES) {
    renderer.truncated = true;
    return;
  }
  if (depth > MAX_DEPTH) return;

  if (node.ignored) {
    for (const child of context.childrenOf(node)) walk(child, depth, renderer, context, hideTextForName);
    return;
  }

  const role = node.role?.value ?? "generic";
  if (SKIP_ROLES.has(role)) return;
  const described = describe(node, context.tabId, context.interactiveOnly);
  const { name, value, ref } = described;
  const isText = described.text;
  let printed = false;

  if (isText) {
    if (!context.interactiveOnly && name && name !== hideTextForName) {
      printed = push(renderer, `- text: ${name}`, depth, context.maxChars);
    }
    return; // InlineTextBox children duplicate the same text.
  }

  if (context.interactiveOnly) {
    if (ref) {
      printed = push(
        renderer,
        `- ${role}${name ? ` "${name}"` : ""}${value && described.valueRelevant ? ` value="${value}"` : ""} [ref=${ref}]`,
        depth,
        context.maxChars,
      );
    }
  } else if (CONTAINER_ROLES.has(role)) {
    // Containers are only interesting when they carry an accessible name.
    if (name && role !== "RootWebArea") {
      printed = push(renderer, `- ${role} "${name}"${ref ? ` [ref=${ref}]` : ""}`, depth, context.maxChars);
    }
  } else if (name || ref || described.valueRelevant || role === "heading" || role === "img") {
    const suffix = value && described.valueRelevant ? ` value="${value}"` : "";
    const label = name ? ` "${name}"` : "";
    printed = push(renderer, `- ${role}${label}${suffix}${ref ? ` [ref=${ref}]` : ""}`, depth, context.maxChars);
  }

  const childDepth = printed ? depth + 1 : depth;
  const childHide = printed && NAME_FROM_TEXT_ROLES.has(role) ? name : "";
  for (const child of context.childrenOf(node)) {
    walk(child, childDepth, renderer, context, childHide);
  }
}

function push(renderer, line, depth, maxChars) {
  if (renderer.truncated) return false;
  const text = `${"  ".repeat(Math.min(depth, MAX_DEPTH))}${line}`;
  if (renderer.length + text.length + 1 > maxChars) {
    renderer.truncated = true;
    return false;
  }
  renderer.lines.push(text);
  renderer.length += text.length + 1;
  return true;
}

function jsonNodes(node, depth, budget, context) {
  if (!node || depth > MAX_DEPTH || budget.nodes >= MAX_JSON_NODES) return [];
  if (node.ignored) {
    return context.childrenOf(node).flatMap((child) => jsonNodes(child, depth, budget, context));
  }
  const role = node.role?.value ?? "generic";
  if (SKIP_ROLES.has(role)) return [];
  const described = describe(node, context.tabId, context.interactiveOnly);
  const isText = described.text;
  const hasRef = Boolean(described.ref);
  if (context.interactiveOnly && !hasRef) {
    return context.childrenOf(node).flatMap((child) => jsonNodes(child, depth, budget, context));
  }
  if (role === "RootWebArea") {
    return context.childrenOf(node).flatMap((child) => jsonNodes(child, depth, budget, context));
  }
  budget.nodes += 1;
  const entry = { role: isText ? "text" : role };
  if (described.name) entry.name = described.name;
  if (described.value && described.valueRelevant) entry.value = described.value;
  if (described.ref) entry.ref = `@${described.ref}`;
  const children = context.childrenOf(node).flatMap((child) => jsonNodes(child, depth + 1, budget, context));
  if (children.length > 0) entry.children = children;
  return [entry];
}

// Numeric IDs from the latest page brief, keyed by tab. Targets are CSS
// selectors (`[data-kai-wb="N"]`) so batch actions do not depend on the slower
// accessibility tree.
const briefTargets = new Map();

const DOM_BRIEF = String.raw`(() => {
  const MAX = 160;
  const items = [];
  const counts = { buttons: 0, links: 0, text_fields: 0, selects: 0, checkboxes: 0, other: 0 };
  let total = 0;
  const seen = new Set();
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };
  const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const labelFor = (el) => {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (ids.length) {
      const label = ids.map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
      if (label) return label;
    }
    const labels = el.labels ? [...el.labels] : [];
    if (labels.length) return labels.map((label) => label.innerText || "").join(" ").trim();
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label) return label.innerText || "";
    }
    const parent = el.closest("label");
    return parent ? parent.innerText || "" : "";
  };
  const roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").trim();
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (el.isContentEditable) return "textbox";
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "file") return "button";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    return "";
  };
  const typeOf = (el, role) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (role === "textbox" || role === "searchbox") return type === "password" ? "password" : type === "search" ? "search" : "text";
    if (role === "combobox") return "select";
    return role;
  };
  const candidates = document.querySelectorAll(
    'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="listbox"],[role="slider"],[role="spinbutton"],[role="tab"],[role="menuitem"],[role="option"],[contenteditable="true"],[contenteditable=""]'
  );
  for (const el of candidates) {
    if (seen.has(el) || !isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && ["hidden", "image"].includes((el.type || "").toLowerCase())) continue;
    if (tag === "input" && ["submit", "button", "reset"].includes((el.type || "").toLowerCase()) && !(el.value || el.getAttribute("aria-label"))) continue;
    seen.add(el);
    const role = roleOf(el);
    if (!role) continue;
    total += 1;
    const type = typeOf(el, role);
    if (role === "button") counts.buttons += 1;
    else if (role === "link") counts.links += 1;
    else if (["textbox", "searchbox", "spinbutton", "slider"].includes(role)) counts.text_fields += 1;
    else if (["combobox", "listbox"].includes(role)) counts.selects += 1;
    else if (["checkbox", "radio", "switch"].includes(role)) counts.checkboxes += 1;
    else counts.other += 1;
    if (items.length >= MAX) continue;
    const id = items.length + 1;
    const target = '[data-kai-wb="' + id + '"]';
    el.setAttribute("data-kai-wb", String(id));
    const label = labelFor(el) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("alt") || el.getAttribute("title") || (["button", "link", "tab", "menuitem", "option"].includes(role) ? el.innerText : "") || el.getAttribute("name") || (tag === "input" ? el.value : "") || "";
    const item = {
      id,
      target,
      role,
      type,
      name: text(label, 180),
      value: "",
      tag,
    };
    if (role === "combobox" || role === "listbox") {
      item.value = text(el.options?.[el.selectedIndex]?.textContent ?? el.value ?? "", 160);
    } else if (role === "checkbox" || role === "radio" || role === "switch") {
      item.checked = el.checked === true || el.getAttribute("aria-checked") === "true";
      item.value = text(el.value ?? el.getAttribute("aria-checked") ?? "", 160);
    } else if (["textbox", "searchbox", "spinbutton", "slider"].includes(role)) {
      item.value = type === "password" ? (el.value ? "••••••" : "") : text(el.value ?? "", 160);
    } else {
      item.value = text(el.value ?? "", 160);
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    if (el.required || el.getAttribute("aria-required") === "true") item.required = true;
    if (el.readOnly) item.readonly = true;
    if (el.multiple) item.multiple = true;
    if (el.getAttribute("aria-expanded")) item.expanded = el.getAttribute("aria-expanded") === "true";
    items.push(item);
  }
  return {
    url: location.href,
    title: document.title,
    counts,
    total,
    truncated: total > items.length,
    interactive: items,
    quick_actions: 'batch: !1:c,2:t:"text",3:s:"option"!  (c=click, t=type, s=select, k=key, h=hover, u=upload, x=check, o=uncheck)',
  };
})()`;

export async function interactiveBrief(tabId, { limit = 160 } = {}) {
  await ensureAttached(tabId);
  const value = (await evaluate(tabId, DOM_BRIEF, { timeoutMs: 12000 })).value;
  if (!value || !Array.isArray(value.interactive)) throw new Error("page brief: could not read the page");
  const interactive = value.interactive.slice(0, Math.max(1, Math.min(Number(limit) || 160, 200)));
  const targets = new Map(interactive.map((item) => [item.id, item.target]));
  briefTargets.set(tabId, { targets, at: Date.now() });
  return {
    url: value.url ?? "",
    title: value.title ?? "",
    counts: value.counts ?? {},
    total: value.total ?? interactive.length,
    interactive,
    ...(value.truncated ? { truncated: true } : {}),
    quick_actions: value.quick_actions,
  };
}

export function getBriefRef(tabId, id) {
  return briefTargets.get(tabId)?.targets.get(Number(id)) ?? null;
}

export function forgetBrief(tabId) {
  briefTargets.delete(tabId);
}
