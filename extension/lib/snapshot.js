import { assignRef, ensureAttached, getRef, pageInfo, send } from "./cdp.js";
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

// Numeric IDs from the latest page brief, keyed by tab. Batch actions resolve
// these IDs to the same stable @e refs used by snapshot.
const briefRefs = new Map();

const TYPE_LABELS = {
  textbox: "text",
  searchbox: "search",
  combobox: "select",
  listbox: "list",
  button: "button",
  link: "link",
  checkbox: "checkbox",
  radio: "radio",
  switch: "switch",
  slider: "slider",
  spinbutton: "number",
  tab: "tab",
  menuitem: "menu",
  menuitemcheckbox: "menu-checkbox",
  menuitemradio: "menu-radio",
  option: "option",
  treeitem: "tree-item",
};

function propValue(node, name) {
  const prop = (node.properties ?? []).find((item) => item.name === name);
  return prop?.value?.value;
}

/**
 * Build the compact, numbered interactive list returned when a page is opened
 * or attached. IDs are stable for the current brief and map to snapshot refs.
 */
export async function interactiveBrief(tabId, { limit = 160, maxValue = 160 } = {}) {
  await ensureAttached(tabId);
  const response = await send(tabId, "Accessibility.getFullAXTree", {}, { timeoutMs: 60000 });
  const nodes = Array.isArray(response?.nodes) ? response.nodes.slice(0, MAX_AX_NODES) : [];
  if (nodes.length === 0) throw new Error("page brief: the page returned an empty accessibility tree");
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const seen = new Set();
  const items = [];
  let totalInteractive = 0;
  const counts = { buttons: 0, links: 0, text_fields: 0, selects: 0, checkboxes: 0, other: 0 };

  const walk = (node) => {
    if (!node) return;
    if (node.ignored) {
      for (const id of node.childIds ?? []) walk(byId.get(id));
      return;
    }
    const role = node.role?.value ?? "generic";
    if (INTERACTIVE_ROLES.has(role) && Number.isInteger(node.backendDOMNodeId)) {
      const backend = node.backendDOMNodeId;
      if (!seen.has(backend)) {
        seen.add(backend);
        totalInteractive += 1;
        if (role === "button") counts.buttons += 1;
        else if (role === "link") counts.links += 1;
        else if (role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "slider") counts.text_fields += 1;
        else if (role === "combobox" || role === "listbox") counts.selects += 1;
        else if (role === "checkbox" || role === "radio" || role === "switch") counts.checkboxes += 1;
        else counts.other += 1;

        const ref = assignRef(tabId, backend);
        if (ref) {
          const item = {
            id: items.length + 1,
            ref: `@${ref}`,
            role,
            type: TYPE_LABELS[role] ?? role,
            name: cleanText(node.name?.value, 180),
            value: cleanText(node.value?.value, maxValue),
          };
          const disabled = propValue(node, "disabled");
          const required = propValue(node, "required");
          const readonly = propValue(node, "readonly");
          const checked = propValue(node, "checked");
          const expanded = propValue(node, "expanded");
          const selected = propValue(node, "selected");
          if (disabled === true) item.disabled = true;
          if (required === true) item.required = true;
          if (readonly === true) item.readonly = true;
          if (checked !== undefined) item.checked = checked === true || checked === "true";
          if (expanded !== undefined) item.expanded = expanded === true || expanded === "true";
          if (selected !== undefined) item.selected = selected === true || selected === "true";
          if (items.length < limit) items.push(item);
        }
      }
    }
    for (const id of node.childIds ?? []) walk(byId.get(id));
  };

  const root = nodes.find((node) => !node.parentId && !node.ignored) ?? nodes.find((node) => !node.parentId) ?? nodes[0];
  walk(root);
  const info = await pageInfo(tabId).catch(() => ({}));
  const refs = new Map(items.map((item) => [item.id, item.ref.slice(1)]));
  briefRefs.set(tabId, { refs, at: Date.now() });
  return {
    url: info.url ?? "",
    title: info.title ?? "",
    counts,
    total: totalInteractive,
    interactive: items,
    ...(totalInteractive > items.length ? { truncated: true } : {}),
    quick_actions: 'batch: !1:c,2:t:"text",3:s:"option"!  (c=click, t=type, s=select, k=key, h=hover, u=upload, x=check, o=uncheck)',
  };
}

export function getBriefRef(tabId, id) {
  return briefRefs.get(tabId)?.refs.get(Number(id)) ?? null;
}

export function forgetBrief(tabId) {
  briefRefs.delete(tabId);
}
